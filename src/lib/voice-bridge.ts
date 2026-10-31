import WebSocket from "ws";
import { runAgentTurn } from "./agent";
import { getDb, recentTurns, recordTurn, type HistoryTurn } from "./db";
import { getBoard } from "./board";
import {
  checkWake,
  collapseEcho,
  noteAttention,
  sanitizeClientId,
  type WakeVerdict,
} from "./wake";
import { ASR_ENCODING, ASR_MODEL, ASR_URL } from "./asr";
import { isEchoOfReply } from "./echo";
import { estimateCost, formatTurnLog } from "./turn-log";
import {
  clearPendingAction,
  isConfirmYes,
  runPendingActions,
  takePendingAction,
} from "./pending-action";
import { getSlots } from "./slot-memory";
import { getOpenSession } from "./vale-tools";
import type { Widget } from "./widget";
import {
  declineText,
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
  /** Screen card derived from the tool call, never from reply text. */
  widget?: Widget | null;
}

/**
 * Wiring for the single-process server: the Meta key authenticates upstream,
 * the socket peer only names the conversation until the browser sends its
 * stable client frame. Mixing them up authenticates Meta with an IP address
 * and every turn dies as E-ASR (Daniel's "connection dropped" on tap).
 */
export function bridgeOptionsForUpgrade(
  peer: string,
  apiKey: string,
  asrUrl?: string,
): Pick<VoiceBridgeOptions, "key" | "clientId" | "conversation" | "metaUrl"> {
  return {
    key: apiKey,
    clientId: peer,
    conversation: true,
    metaUrl: asrUrl,
  };
}

export interface VoiceBridgeOptions {
  /** Browser side of the socket: one per turn, or one per conversation. */
  browser: WebSocket;
  /** One socket carries the whole conversation: turns reset, Meta redials. */
  conversation?: boolean;
  key: string;
  metaUrl?: string;
  /** Redial backoff after a failed turn (conversation sockets only). */
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxConsecutiveFailures?: number;
  createMetaSocket?: (url: string) => WebSocket;
  runAgent?: (args: {
    key: string;
    transcript: string;
    history: HistoryTurn[];
    startedAt: number;
    onDelta: (text: string) => void;
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
  | { type: "wake" }
  | { type: "client-state"; state: Record<string, unknown> }
  | { type: "vote"; vote: "yes" | "no" }
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
      state?: unknown;
      vote?: unknown;
    };
    if (message.type === "endStream") return { type: "endStream" };
    if (message.type === "wake") return { type: "wake" };
    if (
      message.type === "vote" &&
      (message.vote === "yes" || message.vote === "no")
    ) {
      return { type: "vote", vote: message.vote };
    }
    if (
      message.type === "client-state" &&
      message.state !== null &&
      typeof message.state === "object" &&
      !Array.isArray(message.state)
    ) {
      return {
        type: "client-state",
        state: message.state as Record<string, unknown>,
      };
    }
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

// browser <--WS--> server <--WS--> Meta (PUSH_TO_TALK). One socket spans one
// turn by default; in conversation mode it spans the whole conversation while
// every turn still redials Meta, which has no resume.
export function attachVoiceBridge(options: VoiceBridgeOptions): void {
  const {
    browser,
    conversation = false,
    key,
    metaUrl = ASR_URL,
    createMetaSocket,
    runAgent = (args) => runAgentTurn(args),
    now = () => Date.now(),
    turnTimeoutMs = Math.max(
      1,
      Number(process.env.VOICE_TURN_TIMEOUT_MS) || BRIDGE_TURN_TIMEOUT_MS,
    ),
    maxConsecutiveFailures = 5,
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
  /** Stale Meta sockets from earlier turns must not fail the current one. */
  let metaGen = 0;
  /** Straight failed turns on this browser socket; a final resets it. */
  let failedTurns = 0;
  let lastCountedGen = -1;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** A Meta dial is in flight: later audio just buffers behind it. */
  let metaDialPending = false;
  /** When this turn's voice ended: final minus this is the real ASR time. */
  let endStreamAt: number | null = null;
  const clearRetry = () => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };
  /** Screen selector language; Spanish until the browser sends its frame. */
  let turnLanguage: ValeLanguage = DEFAULT_LANGUAGE;
  const err = (kind: VoiceErrorKind): string =>
    turnErrorText(kind, turnLanguage);

  const finish = (code: number, reason: string) => {
    if (settled) return;
    clearTimeout(timer);
    metaGen += 1;
    try {
      meta.close();
    } catch {
      /* already closed */
    }
    if (conversation && !browserGone && browser.readyState === 1) {
      beginNextTurn();
      return;
    }
    settled = true;
    try {
      browser.close(code, reason);
    } catch {
      /* already closed */
    }
  };

  // Meta dials on first voice, never idly: an open socket with no ingress
  // dies fast upstream ("slower than real-time"), and a pre-dialed socket
  // would loop failures on a silent user. Buffered audio replays on open.
  const ensureMetaOpen = () => {
    if (metaOpen || metaDialPending || settled || browserGone) return;
    metaDialPending = true;
    openMetaTurn();
  };

  // Next turn on the same socket: fresh flags, same window. No dial here:
  // the next audio frames open it, so silence never holds a Meta socket.
  const beginNextTurn = () => {
    metaOpen = false;
    metaDialPending = false;
    endStreamAt = null;
    gotFinal = false;
    finalText = "";
    audioProcessedMs = null;
    bufferedBytes = 0;
    pendingAudio.length = 0;
    pendingEnd = false;
    agentRan = false;
    timerArmed = false;
    clearTimeout(timer);
  };

  // An ASR outage never kills the conversation: the turn is discarded
  // silently and the next voice redials Meta at once. The user only sees an
  // error after maxConsecutiveFailures straight failures, then the socket
  // closes with a clear reason. One browser socket = visible alert only then.
  const failTurn = (message: string, code: string) => {
    if (settled) return;
    if (!conversation) {
      sendJson(browser, { type: "error", message, code });
      sendJson(browser, { type: "done" });
      finish(1011, "turn-failed");
      return;
    }
    // One outage fires several Meta handlers; count the turn once.
    if (lastCountedGen !== metaGen) {
      lastCountedGen = metaGen;
      failedTurns += 1;
    }
    clearTimeout(timer);
    metaGen += 1;
    try {
      meta.close();
    } catch {
      /* already closed */
    }
    clearRetry();
    if (failedTurns >= maxConsecutiveFailures) {
      // No silent redial loop: the browser sees the error below, then this.
      sendJson(browser, { type: "error", message, code });
      sendJson(browser, { type: "done" });
      settled = true;
      try {
        browser.close(1011, "meta-unavailable");
      } catch {
        /* already closed */
      }
      return;
    }
    // Silent discard: the next voice redials Meta; no visible error.
    logTurn({
      ts: new Date().toISOString(),
      transcript: finalText,
      ttftMs: null,
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: bufferedBytes / 48000,
      tool: null,
      modelSkipped: true,
      error: code,
      ignored: true,
      asrMs: null,
      chain: "none",
      key: clientId,
      slots: slotSnapshot(),
      gate: null,
      sinceReplyS: null,
      totalMs: null,
    });
    sendJson(browser, { type: "ignored" });
    sendJson(browser, { type: "done" });
    beginNextTurn();
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
    gate?: WakeVerdict["gate"] | null;
    sinceReplyS?: number | null;
    totalMs?: number | null;
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
  let timer: ReturnType<typeof setTimeout>;
  /** Conversation sockets idle between turns: arm the timeout on audio. */
  let timerArmed = false;
  const onTurnTimeout = () => {
    if (settled) return;
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
      gate: null,
      sinceReplyS: null,
      totalMs: null,
    });
    failTurn(err("timeout"), "E-NET");
  };

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

  // Heard nothing: same gentle notice with or without a Meta round trip.
  const finishEmptyTurn = (audioSeconds: number, asrMs: number | null = null) => {
    const at = now();
    sendJson(browser, {
      type: "transcript",
      transcript: "",
      final: true,
      audioProcessedMs: null,
    });
    sendJson(browser, {
      type: "notice",
      message: err("vad-continue"),
      code: "E-VAD",
    });
    logTurn({
      ts: new Date(at).toISOString(),
      transcript: "",
      ttftMs: null,
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds,
      tool: null,
      modelSkipped: true,
      error: null,
      ignored: false,
      asrMs,
      chain: "none",
      key: clientId,
      slots: null,
      gate: null,
      sinceReplyS: null,
      totalMs: 0,
    });
    sendJson(browser, { type: "done" });
    finish(1000, "turn-complete");
  };

  /** Latest thing Vale said to this client: the echo test compares against it. */
  const lastValeReply = (): string | null => {
    try {
      const turns = recentTurns(getDb(), clientId);
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].role === "vale" && turns[i].text.trim() !== "")
          return turns[i].text;
      }
    } catch {
      /* a DB hiccup must never execute a turn: no echo without proof */
    }
    return null;
  };

  // Touch on a confirm card: the exact equivalent of a spoken yes/no.
  // No model, no ASR: yes runs the stored writes, no declines them.
  const answerVote = async (vote: "yes" | "no"): Promise<void> => {
    const at = now();
    const ts = new Date(at).toISOString();
    if (vote === "yes") {
      const actions = takePendingAction(clientId);
      if (actions) {
        const executed = runPendingActions(getDb(), clientId, actions, turnLanguage);
        recordTurn(getDb(), clientId, "user", "yes");
        recordTurn(getDb(), clientId, "vale", executed.text, executed.toolUsed);
        sendJson(browser, { type: "reply", text: executed.text });
        noteAttention(clientId);
        sendJson(browser, { type: "board", board: getBoard(getDb()) });
        // The proposal is decided: the card goes away.
        sendJson(browser, { type: "widget", widget: null });
        logTurn({
          ts,
          transcript: "yes",
          ttftMs: Date.now() - at,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: 0,
          tool: executed.toolUsed,
          modelSkipped: true,
          error: null,
          ignored: false,
          asrMs: null,
          chain: "none",
          key: clientId,
          slots: slotSnapshot(),
          gate: null,
          sinceReplyS: null,
          totalMs: Date.now() - at,
        });
        sendJson(browser, { type: "done" });
        finish(1000, "turn-complete");
        return;
      }
    }
    // No proposal, or a no: nothing writes, the card goes away.
    clearPendingAction(clientId);
    const said = declineText(turnLanguage);
    recordTurn(getDb(), clientId, "user", "no");
    recordTurn(getDb(), clientId, "vale", said, null);
    sendJson(browser, { type: "reply", text: said });
    noteAttention(clientId);
    sendJson(browser, { type: "board", board: getBoard(getDb()) });
    sendJson(browser, { type: "widget", widget: null });
    logTurn({
      ts,
      transcript: "no",
      ttftMs: Date.now() - at,
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: 0,
      tool: null,
      modelSkipped: true,
      error: null,
      ignored: false,
      asrMs: null,
      chain: "none",
      key: clientId,
      slots: slotSnapshot(),
      gate: null,
      sinceReplyS: null,
      totalMs: Date.now() - at,
    });
    sendJson(browser, { type: "done" });
    finish(1000, "turn-complete");
  };

  const answerTranscript = async (
    transcript: string,
    speechEndAt: number,
    verdict: WakeVerdict,
    asrMs: number | null,
  ) => {
    agentRan = true;
    const ts = new Date(speechEndAt || now()).toISOString();
    // Explicit memory: history first, then record this user turn.
    const history = recentTurns(getDb(), clientId);
    recordTurn(getDb(), clientId, "user", transcript);
    try {
      // A yes to Vale's pending proposal runs the stored writes at once:
      // no model, no questions, no chain needed.
      if (isConfirmYes(transcript)) {
        const actions = takePendingAction(clientId);
        if (actions) {
          const executed = runPendingActions(getDb(), clientId, actions, turnLanguage);
          recordTurn(getDb(), clientId, "vale", executed.text, executed.toolUsed);
          sendJson(browser, { type: "reply", text: executed.text });
          // Her reply restarts the window: the next turn counts from here.
          noteAttention(clientId);
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
            asrMs,
            chain: "none",
            key: clientId,
            slots: slotSnapshot(),
            gate: verdict.gate,
            sinceReplyS: verdict.sinceReplyS,
            totalMs: Date.now() - speechEndAt,
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
          history,
          startedAt: speechEndAt,
          onDelta: (text) => sendJson(browser, { type: "reply-delta", text }),
          language: turnLanguage,
          slotKey: clientId,
        },
      );
      if (!browserGone) recordTurn(getDb(), clientId, "vale", result.text, result.toolUsed);
      sendJson(browser, { type: "reply", text: result.text });
      // Her reply restarts the window: the next turn counts from here.
      noteAttention(clientId);
      sendJson(browser, { type: "board", board: getBoard(getDb()) });
      if (result.widget) {
        sendJson(browser, { type: "widget", widget: result.widget });
      }
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
        asrMs,
        chain: "none",
        key: clientId,
        slots: slotSnapshot(),
        gate: verdict.gate,
        sinceReplyS: verdict.sinceReplyS,
        totalMs: Date.now() - speechEndAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
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
        asrMs,
        chain: "none",
        key: clientId,
        slots: slotSnapshot(),
        gate: verdict.gate,
        sinceReplyS: verdict.sinceReplyS,
        totalMs: Date.now() - speechEndAt,
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
      metaDialPending = false;
      flushPending();
      return;
    }
    if (message.type === "transcript" && typeof message.transcript === "string") {
      if (message.final) {
        if (gotFinal) return;
        gotFinal = true;
        failedTurns = 0;
        lastCountedGen = metaGen;
        clearRetry();
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
        const asrMs = endStreamAt === null ? null : speechEndAt - endStreamAt;
        if (finalText.trim() === "") {
          finishEmptyTurn(
            audioProcessedMs !== null
              ? audioProcessedMs / 1000
              : bufferedBytes / 48000,
            asrMs,
          );
          return;
        }
        if (isEchoOfReply(finalText, lastValeReply())) {
          // Her own reply through the mic: no Spark call, no writes,
          // no window move. Logged so the field test can count echoes.
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
            asrMs,
            chain: "none",
            key: clientId,
            slots: slotSnapshot(),
            gate: "eco",
            sinceReplyS: null,
            totalMs: Date.now() - speechEndAt,
          });
          sendJson(browser, { type: "ignored" });
          sendJson(browser, { type: "done" });
          finish(1000, "turn-complete");
          return;
        }
        {
          const sessionOpen = getOpenSession(getDb()) !== null;
          const verdict = checkWake(finalText, clientId, Date.now(), sessionOpen);
          if (!verdict.execute) {
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
              asrMs,
              chain: "none",
              key: clientId,
              slots: slotSnapshot(),
              gate: verdict.gate,
              sinceReplyS: verdict.sinceReplyS,
              totalMs: Date.now() - speechEndAt,
            });
            sendJson(browser, { type: "ignored" });
            sendJson(browser, { type: "done" });
            finish(1000, "turn-complete");
          } else {
            void answerTranscript(finalText, speechEndAt, verdict, asrMs);
          }
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

  // Every turn redials Meta: a stale socket must never fail the next turn.
  function openMetaTurn(): void {
    metaGen += 1;
    const gen = metaGen;
    const current = () => gen === metaGen;
    let fresh: WebSocket;
    try {
      fresh = createMetaSocket ? createMetaSocket(metaUrl) : new WebSocket(metaUrl);
    } catch {
      failTurn(err("lost"), "E-NET");
      return;
    }
    meta = fresh;

    fresh.on("open", () => {
      if (!current()) {
        try {
          fresh.close();
        } catch {
          /* superseded */
        }
        return;
      }
      try {
        fresh.send(
          JSON.stringify({
            authorization: { accessToken: `Bearer ${key}` },
            audioEncoding: ASR_ENCODING,
            model: ASR_MODEL,
            mode: "PUSH_TO_TALK",
            // Pin listening to the screen language (names, not tags).
            languageBias: [turnLanguage === "es" ? "Spanish" : "English"],
          }),
        );
      } catch {
        failTurn(err("lost"), "E-NET");
      }
    });

    fresh.on("message", (data: unknown) => {
      if (current()) handleMetaMessage(data);
    });

    fresh.on("error", () => {
      if (current() && !settled && !metaOpen) {
        metaDialPending = false;
        failTurn(err("lost"), "E-NET");
      }
    });

    fresh.on("close", () => {
      if (!current()) return;
      if (settled) return;
      if (gotFinal) return; // Meta closes after the final; the reply is on its way.
      metaDialPending = false;
      console.error("[voice-asr] connection closed before final transcript");
      failTurn(err("lost"), "E-ASR");
    });
  }

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
      // Tapping talk opens the window like naming Vale does.
      if (control.type === "wake") {
        noteAttention(clientId);
        return;
      }
      // Field diagnostics: capture, AudioContext, tab visibility, speech
      // and echo-hold state. Logged, never answered, never a turn.
      if (control.type === "client-state") {
        console.log(
          `[client-state] client=${clientId} ${JSON.stringify(control.state).slice(0, 500)}`,
        );
        return;
      }
      // Touch on a confirm card: the exact equivalent of a spoken yes/no.
      if (control.type === "vote") {
        void answerVote(control.vote);
        return;
      }
      // Nothing ever voiced: answer locally instead of dialing Meta for it.
      if (!metaOpen && bufferedBytes === 0 && pendingAudio.length === 0) {
        finishEmptyTurn(0);
        return;
      }
      // Voice ended here: the final arriving later sets the real ASR time.
      endStreamAt = now();
      if (metaOpen) {
        try {
          meta.send(JSON.stringify({ type: "endStream" }));
        } catch {
          failTurn(err("lost"), "E-NET");
        }
      } else {
        pendingEnd = true;
      }
      ensureMetaOpen();
      return;
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
      const chunk = data as Buffer;
      bufferedBytes += chunk.length;
      if (conversation && !timerArmed) {
        timerArmed = true;
        clearTimeout(timer);
        timer = setTimeout(onTurnTimeout, turnTimeoutMs);
      }
      if (bufferedBytes > MAX_BUFFERED_BYTES) {
        failTurn(err("lost"), "E-NET");
        return;
      }
      ensureMetaOpen();
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
    clearTimeout(timer);
    clearRetry();
    try {
      meta.close();
    } catch {
      /* already closed */
    }
  };
  browser.on("close", onBrowserGone);
  browser.on("error", onBrowserGone);

  timer = setTimeout(onTurnTimeout, turnTimeoutMs);
  timerArmed = true;
  // No Meta dial here: the first audio frames open it (dial-on-voice), so a
  // tap with no speech never holds an upstream socket that idles out.
  sendJson(browser, { type: "bridge", state: "open" });
}
