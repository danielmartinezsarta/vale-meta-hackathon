import WebSocket from "ws";
import { runAgentTurn } from "./agent";
import { getDb } from "./db";
import { getBoard } from "./board";
import {
  chainFailed,
  chainSucceeded,
  nextPreviousResponseId,
} from "./response-chain";
import { checkWake } from "./wake";
import { ASR_ENCODING, ASR_MODEL, ASR_URL } from "./asr";
import { estimateCost, formatTurnLog } from "./turn-log";
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
): { type: "endStream" } | { type: "language"; language: ValeLanguage } | null {
  let text: string | null = null;
  if (typeof data === "string") {
    text = data;
  } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    text = data.toString("utf8");
  } else {
    return null;
  }
  try {
    const message = JSON.parse(text) as { type?: unknown; language?: unknown };
    if (message.type === "endStream") return { type: "endStream" };
    if (message.type === "language") {
      return { type: "language", language: parseLanguage(message.language) };
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

  const clientId =
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

  let browserGone = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    chainFailed();
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
    try {
      const result = await runAgent(
        {
          key,
          transcript,
          previousResponseId: nextPreviousResponseId(),
          startedAt: speechEndAt,
          onDelta: (text) => sendJson(browser, { type: "reply-delta", text }),
          language: turnLanguage,
          slotKey: clientId,
        },
      );
      if (!browserGone) chainSucceeded(result.responseId, result.chainNext);
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      chainFailed();
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
        finalText = message.transcript;
        audioProcessedMs =
          typeof message.audioProcessedMs === "number"
            ? message.audioProcessedMs
            : null;
        const speechEndAt = now();
        sendJson(browser, {
          type: "transcript",
          transcript: message.transcript,
          final: true,
          audioProcessedMs,
        });
        if (message.transcript.trim() === "") {
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
          });
          sendJson(browser, { type: "done" });
          finish(1000, "turn-complete");
        } else if (!checkWake(message.transcript, clientId).execute) {
          // Background chatter without the name: silent discard.
          logTurn({
            ts: new Date(speechEndAt).toISOString(),
            transcript: message.transcript,
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
          });
          sendJson(browser, { type: "ignored" });
          sendJson(browser, { type: "done" });
          finish(1000, "turn-complete");
        } else {
          void answerTranscript(message.transcript, speechEndAt);
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
    chainFailed();
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
