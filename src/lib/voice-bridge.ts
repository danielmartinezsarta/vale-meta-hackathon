import WebSocket from "ws";
import { runAgentTurn } from "./agent";
import { getDb } from "./db";
import { getBoard } from "./board";
import {
  chainFailed,
  chainSucceeded,
  nextPreviousResponseId,
} from "./response-chain";
import {
  checkWake,
  clearQuestion,
  collapseEcho,
  isGreetingOnly,
  markQuestionAsked,
  sanitizeClientId,
} from "./wake";
import { ASR_ENCODING, ASR_MODEL, ASR_URL } from "./asr";
import { estimateCost, formatTurnLog } from "./turn-log";
import {
  isConfirmYes,
  runPendingActions,
  takePendingAction,
} from "./pending-action";
import { getSlots } from "./slot-memory";
import {
  DEFAULT_LANGUAGE,
  parseLanguage,
  turnErrorText,
  type ValeLanguage,
  type VoiceErrorKind,
} from "./vale-language";

export const BRIDGE_TURN_TIMEOUT_MS = 120000;
/** Cap for audio buffered before the Meta handshake ack (~40 s). */
const MAX_BUFFERED_BYTES = 2_000_000;

export interface BridgeAgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface BridgeAgentResult {
  text: string;
  usage: BridgeAgentUsage;
  toolUsed: string | null;
  firstTokenMs: number | null;
  responseId: string;
  /** False after a completed write: the next turn starts the chain fresh. */
  chainNext: boolean;
  /** Vale asked something: the answer may arrive without the name. */
  askedQuestion: boolean;
}

export interface VoiceBridgeOptions {
  /** Browser side of the upgraded Vercel socket, one per turn. */
  browser: WebSocket;
  key: string;
  metaUrl?: string;
  createMetaSocket?: (url: string) => WebSocket;
  runAgent?: (args: {
    key: string;
    transcript: string;
    startedAt: number;
    onDelta: (text: string) => void;
    previousResponseId?: string;
    language?: ValeLanguage;
    slotKey?: string;
  }) => Promise<BridgeAgentResult>;
  now?: () => number;
  turnTimeoutMs?: number;
  /** Key for the wake attention window; defaults to the socket peer. */
  clientId?: string;
}

// Browser text frames may arrive as Buffer: try JSON first; never forward a control frame as audio.
export function tryParseControl(
  data: unknown,
):
  | { type: "endStream" }
  | { type: "language"; language: ValeLanguage }
  | { type: "client"; client: string }
  | null {
  let text: string | null = null;
  if (typeof data === "string") {
    text = data;
  } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    text = data.toString("utf8");
  } else {
    return null;
  }
  try {
    const message = JSON.parse(text) as {
      type?: unknown;
      language?: unknown;
      client?: unknown;
    };
    if (message.type === "endStream") return { type: "endStream" };
    if (message.type === "language") {
      return { type: "language", language: parseLanguage(message.language) };
    }
    if (message.type === "client") {
      const client = sanitizeClientId(message.client);
      return client === null ? null : { type: "client", client };
    }
    return null;
  } catch {
    return null;
  }
}

function sendJson(browser: WebSocket, payload: unknown): void {
  try {
    if (browser.readyState === 1) browser.send(JSON.stringify(payload));
  } catch {
    /* browser went away; the close handler cleans up */
  }
}

// One live turn: browser <--WS--> Vercel <--WS--> Meta (PUSH_TO_TALK); the client reconnects, Meta has no resume.
export function attachVoiceBridge(options: VoiceBridgeOptions): void {
  const {
    browser,
    key,
    metaUrl = ASR_URL,
    createMetaSocket,
    runAgent = (args) => runAgentTurn(args),
    now = () => Date.now(),
    turnTimeoutMs = Math.max(
      1,
      Number(process.env.VOICE_TURN_TIMEOUT_MS) || BRIDGE_TURN_TIMEOUT_MS,
    ),
  } = options;

  let settled = false;
  let metaOpen = false;
  let gotFinal = false;
  let finalText = "";
  let audioProcessedMs: number | null = null;
  let bufferedBytes = 0;
  const pendingAudio: Buffer[] = [];
  let pendingEnd = false;
  let agentRan = false;
  /** Screen selector language; Spanish until the browser sends its frame. */
  let turnLanguage: ValeLanguage = DEFAULT_LANGUAGE;
  const err = (kind: VoiceErrorKind): string =>
    turnErrorText(kind, turnLanguage);

  const finish = (code: number, reason: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      meta.close();
    } catch {
      /* already closed */
    }
    try {
      browser.close(code, reason);
    } catch {
      /* already closed */
    }
  };

  const failTurn = (message: string, code: string) => {
    if (settled) return;
    sendJson(browser, { type: "error", message, code });
    sendJson(browser, { type: "done" });
    finish(1011, "turn-failed");
  };

  // The browser announces its stable id in a {type:"client"} frame (the
  // upgrade carries no query string); the socket peer is the fallback.
  let clientId =
    options.clientId ??
    (browser as unknown as { _socket?: { remoteAddress?: string } })._socket
      ?.remoteAddress ??
    "unknown";
  const logTurn = (fields: {
    ts: string;
    transcript: string;
    ttftMs: number | null;
    inputTokens: number;
    outputTokens: number;
    audioSeconds: number;
    tool: string | null;
    modelSkipped: boolean;
    error: string | null;
    ignored: boolean;
    asrMs?: number | null;
    chain?: "hit" | "miss" | "none";
    key?: string;
    slots?: { client?: string; service?: string } | null;
  }) => {
    console.log(
      formatTurnLog({
        ...fields,
        costUsd: estimateCost(
          { inputTokens: fields.inputTokens, outputTokens: fields.outputTokens },
          fields.audioSeconds,
        ),
      }),
    );
  };
  const slotSnapshot = () => {
    const slots = getSlots(clientId);
    return slots.client !== undefined || slots.service !== undefined
      ? slots
      : null;
  };

  let browserGone = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    chainFailed(clientId);
    logTurn({
      ts: new Date().toISOString(),
      transcript: finalText,
      ttftMs: null,
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: 0,
      tool: null,
      modelSkipped: !agentRan,
      error: "timeout",
      ignored: false,
      asrMs: null,
      chain: "none",
      key: clientId,
      slots: slotSnapshot(),
    });
    failTurn(err("timeout"), "E-NET");
  }, turnTimeoutMs);

  const flushPending = () => {
    for (const chunk of pendingAudio.splice(0)) {
      try {
        meta.send(chunk);
      } catch {
        /* socket died mid-flush; close handler reports it */
      }
    }
    if (pendingEnd) {
      pendingEnd = false;
      try {
        meta.send(JSON.stringify({ type: "endStream" }));
      } catch {
        /* socket died mid-flush; close handler reports it */
      }
    }
  };

  const answerTranscript = async (transcript: string, speechEndAt: number) => {
    agentRan = true;
    const ts = new Date(speechEndAt || now()).toISOString();
    const chainedId = nextPreviousResponseId(clientId);
    const chainState = chainedId === undefined ? "miss" : "hit";
    try {
      // A yes to Vale's pending proposal runs the stored writes at once:
      // no model, no questions, no chain needed.
      if (isConfirmYes(transcript)) {
        const actions = takePendingAction(clientId);
        if (actions) {
          const executed = runPendingActions(getDb(), clientId, actions);
          chainFailed(clientId);
          clearQuestion(clientId);
          sendJson(browser, { type: "reply", text: executed.text });
          sendJson(browser, { type: "board", board: getBoard(getDb()) });
          logTurn({
            ts,
            transcript,
            ttftMs: Date.now() - speechEndAt,
            inputTokens: 0,
            outputTokens: 0,
            audioSeconds:
              audioProcessedMs !== null
                ? audioProcessedMs / 1000
                : bufferedBytes / 48000,
            tool: executed.toolUsed,
            modelSkipped: true,
            error: null,
            ignored: false,
            asrMs: null,
            chain: "none",
            key: clientId,
            slots: slotSnapshot(),
          });
          sendJson(browser, { type: "done" });
          finish(1000, "turn-complete");
          return;
        }
      }
      const result = await runAgent(
        {
          key,
          transcript,
          previousResponseId: chainedId,
          startedAt: speechEndAt,
          onDelta: (text) => sendJson(browser, { type: "reply-delta", text }),
          language: turnLanguage,
          slotKey: clientId,
        },
      );
      if (!browserGone) chainSucceeded(result.responseId, result.chainNext, clientId);
      if (result.askedQuestion && !isGreetingOnly(transcript)) {
        markQuestionAsked(clientId, speechEndAt);
      } else {
        clearQuestion(clientId);
      }
      sendJson(browser, { type: "reply", text: result.text });
      sendJson(browser, { type: "board", board: getBoard(getDb()) });
      logTurn({
        ts,
        transcript,
        ttftMs: result.firstTokenMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        audioSeconds:
          audioProcessedMs !== null
            ? audioProcessedMs / 1000
            : bufferedBytes / 48000,
        tool: result.toolUsed,
        modelSkipped: false,
        error: null,
        ignored: false,
        asrMs: null,
        chain: chainState,
        key: clientId,
        slots: slotSnapshot(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      chainFailed(clientId);
      logTurn({
        ts,
        transcript,
        ttftMs: null,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds:
          audioProcessedMs !== null
            ? audioProcessedMs / 1000
            : bufferedBytes / 48000,
        tool: null,
        modelSkipped: false,
        error: message,
        ignored: false,
        asrMs: null,
        chain: chainState,
        key: clientId,
        slots: slotSnapshot(),
      });
      sendJson(browser, {
        type: "error",
        message: err("model"),
        code: "E-MODEL",
      });
    }
    sendJson(browser, { type: "done" });
    finish(1000, "turn-complete");
  };

  const handleMetaMessage = (data: unknown) => {
    let message: {
      type?: string;
      sessionId?: string;
      transcript?: string;
      final?: boolean;
      audioProcessedMs?: number;
      message?: string;
    };
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      return;
    }
    if (message.sessionId && !message.type) {
      metaOpen = true;
      flushPending();
      return;
    }
    if (message.type === "transcript" && typeof message.transcript === "string") {
      if (message.final) {
        if (gotFinal) return;
        gotFinal = true;
        finalText = collapseEcho(message.transcript);
        audioProcessedMs =
          typeof message.audioProcessedMs === "number"
            ? message.audioProcessedMs
            : null;
        const speechEndAt = now();
        sendJson(browser, {
          type: "transcript",
          transcript: finalText,
          final: true,
          audioProcessedMs,
        });
        if (finalText.trim() === "") {
          sendJson(browser, {
            type: "notice",
            message: err("vad-continue"),
            code: "E-VAD",
          });
          logTurn({
            ts: new Date(speechEndAt).toISOString(),
            transcript: "",
            ttftMs: null,
            inputTokens: 0,
            outputTokens: 0,
            audioSeconds:
              audioProcessedMs !== null
                ? audioProcessedMs / 1000
                : bufferedBytes / 48000,
            tool: null,
            modelSkipped: true,
            error: null,
            ignored: false,
            asrMs: null,
            chain: "none",
            key: clientId,
            slots: null,
          });
          sendJson(browser, { type: "done" });
          finish(1000, "turn-complete");
        } else if (!checkWake(finalText, clientId).execute) {
          // Background chatter without the name: silent discard.
          logTurn({
            ts: new Date(speechEndAt).toISOString(),
            transcript: finalText,
            ttftMs: null,
            inputTokens: 0,
            outputTokens: 0,
            audioSeconds:
              audioProcessedMs !== null
                ? audioProcessedMs / 1000
                : bufferedBytes / 48000,
            tool: null,
            modelSkipped: true,
            error: null,
            ignored: true,
            asrMs: null,
            chain: "none",
            key: clientId,
            slots: slotSnapshot(),
          });
          sendJson(browser, { type: "ignored" });
          sendJson(browser, { type: "done" });
          finish(1000, "turn-complete");
        } else {
          void answerTranscript(finalText, speechEndAt);
        }
      } else {
        sendJson(browser, {
          type: "transcript",
          transcript: message.transcript,
          final: false,
          audioProcessedMs:
            typeof message.audioProcessedMs === "number"
              ? message.audioProcessedMs
              : null,
        });
      }
      return;
    }
    if (message.type === "error") {
      if (!settled) {
        console.error(
          `[voice-asr] transcription error: ${message.message ?? "unknown"}`,
        );
        failTurn(err("lost"), "E-ASR");
      }
    }
  };

  let meta: WebSocket;
  try {
    meta = createMetaSocket ? createMetaSocket(metaUrl) : new WebSocket(metaUrl);
  } catch {
    failTurn(err("lost"), "E-NET");
    return;
  }

  meta.on("open", () => {
    try {
      meta.send(
        JSON.stringify({
          authorization: { accessToken: `Bearer ${key}` },
          audioEncoding: ASR_ENCODING,
          model: ASR_MODEL,
          mode: "PUSH_TO_TALK",
        }),
      );
    } catch {
      failTurn(err("lost"), "E-NET");
    }
  });

  meta.on("message", (data: unknown) => handleMetaMessage(data));

  meta.on("error", () => {
    if (!settled && !metaOpen) {
      failTurn(err("lost"), "E-NET");
    }
  });

  meta.on("close", () => {
    if (settled) return;
    if (gotFinal) return; // Meta closes after the final; the reply is on its way.
    console.error("[voice-asr] connection closed before final transcript");
    failTurn(err("lost"), "E-ASR");
  });

  browser.on("message", (data: unknown) => {
    if (settled) return;
    const control = tryParseControl(data);
    if (control !== null) {
      // The screen selector rides along: language only, never audio.
      if (control.type === "language") {
        turnLanguage = control.language;
        return;
      }
      // The stable browser id keys slots, pending actions and chain lanes.
      if (control.type === "client") {
        clientId = control.client;
        return;
      }
      if (metaOpen) {
        try {
          meta.send(JSON.stringify({ type: "endStream" }));
        } catch {
          failTurn(err("lost"), "E-NET");
        }
      } else {
        pendingEnd = true;
      }
      return;
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
      const chunk = data as Buffer;
      bufferedBytes += chunk.length;
      if (bufferedBytes > MAX_BUFFERED_BYTES) {
        failTurn(err("lost"), "E-NET");
        return;
      }
      if (metaOpen) {
        try {
          meta.send(chunk);
        } catch {
          failTurn(err("lost"), "E-NET");
        }
      } else {
        pendingAudio.push(chunk);
      }
    }
    // Only Buffer audio and JSON control frames are part of the protocol.
  });

  const onBrowserGone = () => {
    if (settled) return;
    settled = true;
    browserGone = true;
    chainFailed(clientId);
    clearTimeout(timer);
    try {
      meta.close();
    } catch {
      /* already closed */
    }
  };
  browser.on("close", onBrowserGone);
  browser.on("error", onBrowserGone);

  sendJson(browser, { type: "bridge", state: "open" });
}
