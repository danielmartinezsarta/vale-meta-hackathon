import WebSocket from "ws";
import { AGENT_MODEL, runAgentTurn } from "./agent";
import { getDb, recentTurns, recordTurn, type HistoryTurn } from "./db";
import { getBoard } from "./board";
import {
  canonicalizeWakeWord,
  checkWake,
  isBareNameCall,
  noteAttention,
  sanitizeClientId,
  type WakeVerdict,
} from "./wake";
import { ASR_ENCODING, ASR_MODEL, ASR_URL } from "./asr";
import { emitTurnLog, estimateCost, modelElapsedMs, vlog } from "./turn-log";
import { isMutedJunkTurn, saveTurnWav } from "./turn-audio";
import {
  clearPendingAction,
  isConfirmYes,
  isRefusalNo,
  peekPendingAction,
  quoteAcceptSessionId,
  runPendingActions,
  takePendingAction,
} from "./pending-action";
import { getSlots } from "./slot-memory";
import { getOpenSession, rejectQuote } from "./vale-tools";
import { buildWidget, type Widget } from "./widget";
import {
  clarifyText,
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
  cachedInputTokens?: number;
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
    turn?: string;
  }) => Promise<BridgeAgentResult>;
  now?: () => number;
  turnTimeoutMs?: number;
  /** Key for the wake attention window; defaults to the socket peer. */
  clientId?: string;
}

// Browser text frames may arrive as Buffer: try JSON first; never forward a control frame as audio.
/** What the client saw this turn: input peak, VAD ms, muted ms, her state. */
export interface TurnClientStats {
  peakLevel: number | null;
  voicedMs: number | null;
  mutedMs: number | null;
  valeState: string | null;
  /** Blocks lost under load (wall vs frames) and source blocks spanned. */
  lostBlocks: number | null;
  srcBlocks: number | null;
  engine: "worklet" | "script" | null;
  sheetOpen: boolean | null;
  visible: string | null;
  actualRate: number | null;
  ctxState: string | null;
  rebuilds: number | null;
}

function parseClientStats(message: {
  peakLevel?: unknown;
  voicedMs?: unknown;
  mutedMs?: unknown;
  valeState?: unknown;
  lostBlocks?: unknown;
  srcBlocks?: unknown;
  engine?: unknown;
  sheetOpen?: unknown;
  visible?: unknown;
  actualRate?: unknown;
  ctxState?: unknown;
  rebuilds?: unknown;
}): TurnClientStats {
  const num = (value: unknown, max: number): number | null =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
      ? value
      : null;
  const int = (value: unknown, max: number): number | null =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
      ? value
      : null;
  const state =
    typeof message.valeState === "string" && message.valeState.length <= 16
      ? message.valeState
      : null;
  return {
    peakLevel: num(message.peakLevel, 1),
    voicedMs: num(message.voicedMs, 3600000),
    mutedMs: num(message.mutedMs, 3600000),
    valeState: state,
    lostBlocks: int(message.lostBlocks, 3600000),
    srcBlocks: int(message.srcBlocks, 3600000),
    engine:
      message.engine === "worklet" || message.engine === "script"
        ? message.engine
        : null,
    sheetOpen: typeof message.sheetOpen === "boolean" ? message.sheetOpen : null,
    visible: typeof message.visible === "string" ? message.visible : null,
    actualRate:
      typeof message.actualRate === "number" &&
      Number.isFinite(message.actualRate)
        ? message.actualRate
        : null,
    ctxState: typeof message.ctxState === "string" ? message.ctxState : null,
    rebuilds: int(message.rebuilds, 3600000),
  };
}

/** Shared turn id from the client (t042); anything else rides as "-". */
export function parseTurnTag(value: unknown): string | null {
  return typeof value === "string" && /^t\d{1,6}$/.test(value) ? value : null;
}

export function tryParseControl(
  data: unknown,
):
  | {
      type: "endStream";
      stats: TurnClientStats;
      language: ValeLanguage | null;
      turn: string | null;
    }
  | { type: "language"; language: ValeLanguage }
  | { type: "client"; client: string }
  | { type: "wake" }
  | { type: "client-state"; state: Record<string, unknown> }
  | { type: "vote"; vote: "yes" | "no"; turn: string | null }
  | { type: "dismiss"; transcript: string | null; turn: string | null }
  | { type: "spoken" }
  | { type: "sheet-closed" }
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
      turn?: unknown;
      language?: unknown;
      client?: unknown;
      state?: unknown;
      transcript?: unknown;
      vote?: unknown;
      peakLevel?: unknown;
      voicedMs?: unknown;
      mutedMs?: unknown;
      valeState?: unknown;
      lostBlocks?: unknown;
      srcBlocks?: unknown;
      engine?: unknown;
      sheetOpen?: unknown;
      visible?: unknown;
      actualRate?: unknown;
      ctxState?: unknown;
      rebuilds?: unknown;
    };
    if (message.type === "endStream")
      return {
        type: "endStream",
        stats: parseClientStats(message),
        language:
          message.language === "en" || message.language === "es"
            ? message.language
            : null,
        turn: parseTurnTag(message.turn),
      };
    if (message.type === "wake") return { type: "wake" };
    // Her real last word: the window counts from here, not the send time.
    if (message.type === "spoken") return { type: "spoken" };
    if (message.type === "sheet-closed") return { type: "sheet-closed" };
    if (
      message.type === "vote" &&
      (message.vote === "yes" || message.vote === "no")
    ) {
      return {
        type: "vote",
        vote: message.vote,
        turn: parseTurnTag(message.turn),
      };
    }
    if (message.type === "dismiss") {
      return {
        type: "dismiss",
        transcript:
          typeof message.transcript === "string" ? message.transcript : null,
        turn: parseTurnTag(message.turn),
      };
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
  /** Shared turn id from the latest endStream/dismiss/vote frame. */
  let turnTag: string | null = null;
  let audioProcessedMs: number | null = null;
  let bufferedBytes = 0;
  const pendingAudio: Buffer[] = [];
  /** This turn's mic PCM for the WAV evidence file; freed at turn end. */
  const wavChunks: Buffer[] = [];
  /** WAV path + client stats for the turn now completing. */
  let turnWav: string | null = null;
  let wavSaved = false;
  let turnSeq = 0;
  let turnStats: TurnClientStats = {
    peakLevel: null,
    voicedMs: null,
    mutedMs: null,
    valeState: null,
    lostBlocks: null,
    srcBlocks: null,
    engine: null,
    sheetOpen: null,
    visible: null,
    actualRate: null,
    ctxState: null,
    rebuilds: null,
  };
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
    turnTag = null;
    audioProcessedMs = null;
    bufferedBytes = 0;
    pendingAudio.length = 0;
    wavChunks.length = 0;
    turnWav = null;
    wavSaved = false;
    turnSeq += 1;
    turnStats = {
      peakLevel: null,
      voicedMs: null,
      mutedMs: null,
      valeState: null,
      lostBlocks: null,
      srcBlocks: null,
      engine: null,
      sheetOpen: null,
      visible: null,
      actualRate: null,
      ctxState: null,
      rebuilds: null,
    };
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
      language: turnLanguage,
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
    turn?: string | null;
    language: ValeLanguage;
    transcript: string;
    ttftMs: number | null;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number | null;
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
    junk?: boolean;
  }) => {
    // One WAV per turn from whatever the mic sent: the first log call with
    // audio persists it, later calls for the turn reuse the path. Saved
    // once, then freed, so a long session never grows past one turn.
    if (!wavSaved && wavChunks.length > 0) {
      wavSaved = true;
      turnWav = saveTurnWav(`${clientId}-${turnSeq}`, wavChunks);
      wavChunks.length = 0;
    }
    emitTurnLog({
      ...fields,
      turn: fields.turn ?? turnTag,
      wav: turnWav,
      peakLevel: turnStats.peakLevel,
      voicedMs: turnStats.voicedMs,
      mutedMs: turnStats.mutedMs,
      valeState: turnStats.valeState,
      lostBlocks: turnStats.lostBlocks,
      srcBlocks: turnStats.srcBlocks,
      engine: turnStats.engine,
      sheetOpen: turnStats.sheetOpen,
      visible: turnStats.visible,
      actualRate: turnStats.actualRate,
      ctxState: turnStats.ctxState,
      rebuilds: turnStats.rebuilds,
      costUsd: estimateCost(
        {
          inputTokens: fields.inputTokens,
          outputTokens: fields.outputTokens,
          cachedInputTokens: fields.cachedInputTokens ?? 0,
        },
        fields.audioSeconds,
      ),
    });
  };
  const slotSnapshot = () => {
    const slots = getSlots(clientId);
    return slots.client !== undefined || slots.service !== undefined
      ? slots
      : null;
  };

  // Every screen payload also lands in the JSONL recording with its turn,
  // so replay sees exactly what the screen showed.
  const sendBoard = () => {
    const board = getBoard(getDb());
    sendJson(browser, { type: "board", board });
    vlog({
      turn: turnTag ?? "-",
      process: "DB",
      status: "ok",
      detail: { board: true },
      extra: { board },
    });
  };

  const sendWidget = (widget: Widget | null) => {
    sendJson(browser, { type: "widget", widget });
    vlog({
      turn: turnTag ?? "-",
      process: "VOICE",
      status: "ok",
      detail: { widget: widget === null ? "none" : widget.kind },
      content: widget === null ? null : widget.title,
      extra: { widget },
    });
  };

  let browserGone = false;
  let timer: ReturnType<typeof setTimeout>;
  /** Conversation sockets idle between turns: arm the timeout on audio. */
  let timerArmed = false;
  const onTurnTimeout = () => {
    if (settled) return;
    logTurn({
      language: turnLanguage,
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
    logTurn({
      language: turnLanguage,
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

  // Spoken sheet close: the in-flight Meta turn is dropped before any
  // reply, and the turn logs as a close (gate cierre), never as an error.
  // A reply that already ran wins: its done already moved the turn on.
  const dismissTurn = (transcript: string): void => {
    if (settled || agentRan) return;
    metaGen += 1;
    try {
      meta.close();
    } catch {
      /* already closed */
    }
    clearRetry();
    clearTimeout(timer);
    logTurn({
      language: turnLanguage,
      ts: new Date().toISOString(),
      transcript,
      ttftMs: null,
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: bufferedBytes / 48000,
      tool: null,
      modelSkipped: true,
      error: null,
      ignored: true,
      asrMs: null,
      chain: "none",
      key: clientId,
      slots: slotSnapshot(),
      gate: "cierre",
      sinceReplyS: null,
      totalMs: null,
    });
    sendJson(browser, { type: "ignored" });
    sendJson(browser, { type: "done" });
    if (conversation) {
      beginNextTurn();
      return;
    }
    finish(1000, "turn-complete");
  };

  // A no on the quote sheet rejects it: the sheet stays open waiting
  // for the spoken amount, and the session stays open too. Shared by the
  // touch vote and the spoken no.
  const answerQuoteReject = async (
    sessionId: number,
    heard: string,
    audioSeconds: number,
    asrMs: number | null,
    gate: WakeVerdict["gate"] | null,
    sinceReplyS: number | null,
  ): Promise<void> => {
    const at = now();
    const ts = new Date(at).toISOString();
    const rejected = rejectQuote(getDb(), sessionId, turnLanguage);
    recordTurn(getDb(), clientId, "user", heard);
    recordTurn(getDb(), clientId, "vale", rejected.message, "session_quote");
    sendJson(browser, { type: "reply", text: rejected.message });
    noteAttention(clientId);
    sendBoard();
    sendWidget(
      buildWidget(
        "quote_price",
        {},
        (rejected as { data?: unknown }).data ?? null,
      ),
    );
    logTurn({
      language: turnLanguage,
      ts,
      transcript: heard,
      ttftMs: Date.now() - at,
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds,
      tool: "session_quote",
      modelSkipped: true,
      error: null,
      ignored: false,
      asrMs,
      chain: "none",
      key: clientId,
      slots: slotSnapshot(),
      gate,
      sinceReplyS,
      totalMs: Date.now() - at,
    });
    sendJson(browser, { type: "done" });
    finish(1000, "turn-complete");
  };

  // Touch on a confirm card: the exact equivalent of a spoken yes/no.
  // No model, no ASR: yes runs the stored writes, no declines them, and a
  // yes with nothing stored clarifies (never repeats the last write).
  const answerVote = async (vote: "yes" | "no"): Promise<void> => {
    const at = now();
    const ts = new Date(at).toISOString();
    const answerCanned = (transcript: string, said: string) => {
      recordTurn(getDb(), clientId, "user", transcript);
      recordTurn(getDb(), clientId, "vale", said, null);
      sendJson(browser, { type: "reply", text: said });
      noteAttention(clientId);
      sendBoard();
      sendWidget(null);
      logTurn({
        language: turnLanguage,
        ts,
        transcript,
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
    if (vote === "yes") {
      const actions = takePendingAction(clientId);
      if (!actions) {
        await answerCanned("yes", clarifyText(turnLanguage));
        return;
      }
      const executed = runPendingActions(getDb(), clientId, actions, turnLanguage);
      recordTurn(getDb(), clientId, "user", "yes");
      recordTurn(getDb(), clientId, "vale", executed.text, executed.toolUsed);
      sendJson(browser, { type: "reply", text: executed.text });
      noteAttention(clientId);
      sendBoard();
      // The proposal is decided: the card goes away.
      sendWidget(null);
      logTurn({
        language: turnLanguage,
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
    // A no on the quote sheet rejects it; any other no declines.
    const stored = takePendingAction(clientId);
    const quoteSession = quoteAcceptSessionId(stored ?? []);
    if (quoteSession !== null) {
      await answerQuoteReject(quoteSession, "no", 0, null, null, null);
      return;
    }
    await answerCanned("no", declineText(turnLanguage));
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
          sendBoard();
          logTurn({
            language: turnLanguage,
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
      // A no to Vale's pending proposal discards it at once: the card goes
      // away with a short decline, no model, no second question. A no on
      // the quote sheet rejects it instead and waits for the amount.
      if (isRefusalNo(transcript) && peekPendingAction(clientId)) {
        const stored = takePendingAction(clientId);
        const quoteSession = quoteAcceptSessionId(stored ?? []);
        if (quoteSession !== null) {
          await answerQuoteReject(
            quoteSession,
            transcript,
            audioProcessedMs !== null
              ? audioProcessedMs / 1000
              : bufferedBytes / 48000,
            asrMs,
            verdict.gate,
            verdict.sinceReplyS,
          );
          return;
        }
        const declined = declineText(turnLanguage);
        recordTurn(getDb(), clientId, "vale", declined, null);
        sendJson(browser, { type: "reply", text: declined });
        noteAttention(clientId);
        sendBoard();
        sendWidget(null);
        logTurn({
          language: turnLanguage,
          ts,
          transcript,
          ttftMs: Date.now() - speechEndAt,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds:
            audioProcessedMs !== null
              ? audioProcessedMs / 48000
              : bufferedBytes / 48000,
          tool: null,
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
      const result = await runAgent(
        {
          key,
          transcript,
          history,
          startedAt: speechEndAt,
          onDelta: (text) => sendJson(browser, { type: "reply-delta", text }),
          language: turnLanguage,
          slotKey: clientId,
          turn: turnTag ?? undefined,
        },
      );
      if (!browserGone) recordTurn(getDb(), clientId, "vale", result.text, result.toolUsed);
      vlog({
        turn: turnTag ?? "-",
        process: "AGENT",
        model: AGENT_MODEL,
        durationMs: modelElapsedMs(result.firstTokenMs, speechEndAt),
        status: "ok",
        detail: { tool: result.toolUsed },
        content: result.text,
      });
      sendJson(browser, { type: "reply", text: result.text });
      // Her reply restarts the window: the next turn counts from here.
      noteAttention(clientId);
      sendBoard();
      if (result.widget) {
        sendWidget(result.widget);
      }
      logTurn({
        language: turnLanguage,
        ts,
        transcript,
        ttftMs: result.firstTokenMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedInputTokens: result.usage.cachedInputTokens,
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
        language: turnLanguage,
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
        finalText = message.transcript;
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
        vlog({
          turn: turnTag ?? "-",
          process: "ASR",
          model: ASR_MODEL,
          durationMs: asrMs,
          status: "ok",
          content: finalText,
        });
        // Canonical wake word for the gate and the model: a substitution
        // never rides past here into tool args. The ASR row above keeps
        // the raw spelling for the record.
        finalText = canonicalizeWakeWord(finalText);
        // A bare name call stays silent and keeps listening in the same
        // turn: answering here drops the words that follow (trial 9.1).
        if (isBareNameCall(finalText)) {
          noteAttention(clientId);
          // Retire this Meta turn first: its close lands after the final
          // and must not fail the turn we are still listening in.
          metaGen += 1;
          try {
            meta.close();
          } catch {
            /* a fresh dial replaces it when the rest arrives */
          }
          gotFinal = false;
          finalText = "";
          audioProcessedMs = null;
          endStreamAt = null;
          bufferedBytes = 0;
          pendingAudio.length = 0;
          pendingEnd = false;
          metaOpen = false;
          metaDialPending = false;
          sendJson(browser, {
            type: "transcript",
            transcript: message.transcript,
            final: false,
          });
          return;
        }
        if (finalText.trim() === "") {
          finishEmptyTurn(
            audioProcessedMs !== null
              ? audioProcessedMs / 1000
              : bufferedBytes / 48000,
            asrMs,
          );
          return;
        }
        {
          // Muted-start junk first: the mic spent the turn muted and what
          // arrived is flat room tone, not Daniel. Discard before the wake
          // gate and the model; the ASR pennies are already spent by live
          // streaming, but nothing else is.
          const audioMs =
            (audioProcessedMs !== null
              ? audioProcessedMs / 1000
              : bufferedBytes / 48000) * 1000;
          const pcmBytes = Buffer.concat(wavChunks);
          const pcm = new Int16Array(
            pcmBytes.buffer,
            pcmBytes.byteOffset,
            Math.floor(pcmBytes.length / 2),
          );
          // Voice beats mute accounting: the VAD counted more voiced audio
          // than the turn contains (incident 23:04:27Z: 4320 ms of voice
          // in 2800 ms of audio beside 8836 ms of her mute time on the
          // clock), which proves the mute span leaked in from her reply.
          // Only mute-dominant room tone is junk; a voice-majority turn
          // always reaches the wake gate, which owns the window.
          const voicedMs = turnStats.voicedMs ?? 0;
          const voiceMajority = voicedMs > audioMs;
          if (!voiceMajority && isMutedJunkTurn(pcm, turnStats.mutedMs, audioMs)) {
            logTurn({
              language: turnLanguage,
              ts: new Date(speechEndAt).toISOString(),
              transcript: finalText,
              ttftMs: null,
              inputTokens: 0,
              outputTokens: 0,
              audioSeconds: audioMs / 1000,
              tool: null,
              modelSkipped: true,
              error: null,
              ignored: true,
              asrMs,
              chain: "none",
              key: clientId,
              slots: slotSnapshot(),
              gate: null,
              sinceReplyS: null,
              totalMs: Date.now() - speechEndAt,
              junk: true,
            });
            sendJson(browser, { type: "ignored" });
            sendJson(browser, { type: "done" });
            finish(1000, "turn-complete");
            return;
          }
          const sessionOpen = getOpenSession(getDb()) !== null;
          const verdict = checkWake(
            finalText,
            clientId,
            Date.now(),
            sessionOpen,
            turnLanguage,
            turnStats.sheetOpen === true,
          );
          if (!verdict.execute) {
            // Background chatter without the name: silent discard.
            logTurn({
              language: turnLanguage,
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
        vlog({
          turn: turnTag ?? "-",
          process: "ASR",
          model: ASR_MODEL,
          status: "error",
          detail: { code: "E-ASR" },
          content: message.message ?? "unknown",
        });
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
      vlog({
        turn: turnTag ?? "-",
        process: "ASR",
        model: ASR_MODEL,
        status: "error",
        detail: { code: "E-ASR" },
        content: "connection closed before final transcript",
      });
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
      // The tap announces the mic, nothing more: it must not open the
      // window, or the first unnamed phrase of a fresh conversation would
      // execute. The phrase earns the window by naming her (or a reply
      // opens it), and the gate below judges the rest.
      if (control.type === "wake") {
        return;
      }
      // Her voice really ended: the attention window counts from here.
      if (control.type === "spoken") {
        noteAttention(clientId);
        return;
      }
      // Field diagnostics: capture, AudioContext, tab visibility, speech
      // and echo-hold state. Logged, never answered, never a turn.
      if (control.type === "client-state") {
        vlog({
          turn: turnTag ?? "-",
          process: "VOICE",
          status: "ok",
          detail: { client: clientId },
          content: JSON.stringify(control.state),
        });
        return;
      }
      // Touch on a confirm card: the exact equivalent of a spoken yes/no.
      if (control.type === "vote") {
        turnTag = control.turn;
        void answerVote(control.vote);
        return;
      }
      // Spoken sheet close ("close it", "cierra la agenda"): the card goes
      // away with no model call and no spoken reply. Closing restarts the
      // window like any executed turn.
      if (control.type === "dismiss") {
        turnTag = control.turn;
        noteAttention(clientId);
        dismissTurn(control.transcript ?? "");
        return;
      }
      // The X on a sheet Vale opened: closing restarts the window too.
      if (control.type === "sheet-closed") {
        noteAttention(clientId);
        return;
      }
      // Only endStream reaches here: keep what the client saw this turn.
      // The language rides along so a switch that raced the handshake
      // still applies from the first speech of the session.
      if (control.type === "endStream") {
        turnStats = control.stats;
        if (control.language !== null) turnLanguage = control.language;
        turnTag = control.turn;
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
      wavChunks.push(chunk);
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
  // The screen opens on the truth: an already-running session shows at
  // once instead of hiding until the first executed turn.
  sendBoard();
}
