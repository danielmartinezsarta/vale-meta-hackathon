import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentUsage } from "./agent";
import type { ValeLanguage } from "./vale-language";

// Public Model API list prices (Standard tier), per 1M tokens.
const INPUT_USD_PER_M = 1.25;
const OUTPUT_USD_PER_M = 4.25;
// Realtime transcription, per audio hour, billed down to whole seconds.
const ASR_USD_PER_SECOND = 0.18 / 3600;

export interface TurnLogFields {
  /** End-of-speech timestamp (ISO). */
  ts: string;
  /** Shared turn id (t042) from the client; "-" or absent off-turn. */
  turn?: string | null;
  /** Screen language on the connection when the turn ran. */
  language: ValeLanguage;
  transcript: string;
  /** ms from end of speech to first reply token (null when no model call). */
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Prefix-cache hits inside input_tokens; absent on paths that never reach the agent. */
  cachedInputTokens?: number | null;
  costUsd: number;
  audioSeconds: number;
  tool: string | null;
  modelSkipped: boolean;
  error: string | null;
  /** Discarded by the wake gate: no model call, no board. */
  ignored: boolean;
  /**
   * Per-turn diagnostics (all optional, absent on paths that never
   * reach the agent): ASR time, whether a chained id rode along,
   * the client key, and the slot snapshot at log time.
   */
  asrMs?: number | null;
  chain?: "hit" | "miss" | "none";
  key?: string;
  slots?: { client?: string; service?: string } | null;
  /** Sliding-gate verdict, seconds since Vale's last reply, turn wall time. */
  gate?: "nombre" | "ventana" | "ignorado" | "idioma" | "cierre" | null;
  sinceReplyS?: number | null;
  totalMs?: number | null;
  /**
   * Per-turn audio evidence: WAV path on disk plus what the client saw —
   * peak input level 0-1, VAD-voiced ms, ms muted while she spoke, and her
   * state when speech ended. Null on paths without audio or an old client.
   */
  wav?: string | null;
  peakLevel?: number | null;
  voicedMs?: number | null;
  mutedMs?: number | null;
  valeState?: string | null;
  /**
   * Client accounting in mixed units: lostBlocks counts 40 ms VAD frames
   * against the wall clock, srcBlocks counts 5.33 ms worklet quanta.
   * Never divide one by the other; read lostPct instead.
   */
  lostBlocks?: number | null;
  srcBlocks?: number | null;
  /** Real fraction of audio missing: lost over lost plus src/7.5. */
  lostPct?: number | null;
  /** Audio thread feeding the VAD, and whether a sheet was open at end. */
  engine?: "worklet" | "script" | null;
  sheetOpen?: boolean | null;
  /** Tab visibility at end (occluded tabs get throttled) + context rate/state. */
  visible?: string | null;
  actualRate?: number | null;
  ctxState?: string | null;
  /** Clock-watchdog context rebuilds during the turn; null when none ran. */
  rebuilds?: number | null;
  /** Muted-start room tone discarded before the gate and the model. */
  junk?: boolean;
}

export function estimateCost(
  usage: AgentUsage,
  audioSeconds: number,
): number {
  return (
    (usage.inputTokens * INPUT_USD_PER_M +
      usage.outputTokens * OUTPUT_USD_PER_M) /
      1_000_000 +
    Math.floor(Math.max(0, audioSeconds)) * ASR_USD_PER_SECOND
  );
}

/** One JSON log line per turn. */
export function formatTurnLog(fields: TurnLogFields): string {
  const { lostBlocks = null, srcBlocks = null } = fields;
  const delivered = srcBlocks === null ? null : srcBlocks / 7.5;
  const lostPct =
    lostBlocks === null || delivered === null || lostBlocks + delivered <= 0
      ? null
      : Math.round((lostBlocks / (lostBlocks + delivered)) * 1000) / 1000;
  return `[voice-turn] ${JSON.stringify({ ...fields, lostPct })}`;
}

/**
 * Agent reply time: time to first token when the model streamed, otherwise
 * the elapsed time since the turn's speech ended.
 */
export function modelElapsedMs(
  firstTokenMs: number | null | undefined,
  sinceMs: number,
): number {
  return firstTokenMs ?? Date.now() - sinceMs;
}

/**
 * Secret scrubber for anything that reaches a log: Bearer-looking values
 * and JSON key/token/secret fields become [redacted]. No length cap here;
 * callers that need one (provider error bodies) slice after.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /"(api_?key|token|secret)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"',
    );
}

/** Processes that can own a unified log line; ERROR is server-lifecycle only. */
export type VLogProcess =
  | "ASR"
  | "AGENT"
  | "TOOL"
  | "VOICE"
  | "IMAGE"
  | "SAM"
  | "GLIMMER"
  | "DB"
  | "ERROR";

/** Turn outcome from the screen's point of view. */
export type VLogStatus = "ok" | "ignored" | "error" | "timeout";

export interface VLogEvent {
  /** Shared turn id (t042) from the client; "-" off-turn. */
  turn: string;
  process: VLogProcess;
  /** Exact model id, or "-" when the event is not a model call. */
  model?: string | null;
  durationMs?: number | null;
  status: VLogStatus;
  /** Typed key=value pairs for the console detail column. */
  detail?: Record<string, string | number | boolean | null | undefined>;
  /** Console: flattened and clipped; JSONL: full. */
  content?: string | null;
  /** Full payloads for the JSONL recording only: tool args, widget, board. */
  extra?: Record<string, unknown> | null;
}

/**
 * Deep secret scrub for recording payloads: strings are scrubbed before
 * JSON encoding, because after it the quotes are escaped and the key
 * pattern no longer matches. Keys ride along; they are code constants.
 */
function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = scrubValue(entry);
    return out;
  }
  return value;
}

/**
 * Fits the short model id exactly; longer ids overflow the column rather
 * than wrap the row, and are never clipped (the recording keeps them whole).
 * A full-width column here costs 10+ spaces on every non-ASR row.
 */
const VLOG_MODEL_WIDTH = 14;
/** Console content budget; the JSONL recording keeps the full text. */
const VLOG_CONTENT_WIDTH = 64;

function vlogDetail(detail: VLogEvent["detail"]): string {
  if (!detail) return "-";
  const pairs = Object.entries(detail).flatMap(([key, value]) =>
    value === null || value === undefined ? [] : [`${key}=${value}`],
  );
  return pairs.length > 0 ? scrubSecrets(pairs.join(" ")) : "-";
}

function vlogContent(content: VLogEvent["content"]): string {
  if (!content) return "-";
  const flat = scrubSecrets(content.replace(/[\r\n]+/g, " "));
  return flat.length > VLOG_CONTENT_WIDTH
    ? `${flat.slice(0, VLOG_CONTENT_WIDTH)}…`
    : flat;
}

/**
 * One aligned console line per event: time | turn | process | model |
 * duration | status | key=value detail | content (clipped, last). Time is
 * UTC, matching the turn timestamps the harness reads from the log files.
 */
export function formatVlog(event: VLogEvent): string {
  const time = new Date().toISOString().slice(11, 23);
  const turn = (event.turn || "-").padEnd(5);
  const process = event.process.padEnd(7);
  const model = (event.model ?? "-").padEnd(VLOG_MODEL_WIDTH);
  const duration =
    event.durationMs === null || event.durationMs === undefined
      ? "-".padStart(8)
      : `${Math.round(event.durationMs)}ms`.padStart(8);
  const status = event.status.padEnd(7);
  return `${time} | ${turn} | ${process} | ${model} | ${duration} | ${status} | ${vlogDetail(event.detail)} | ${vlogContent(event.content)}`;
}

/**
 * Daily JSONL recording for replay (HACK-024): every vlog event with full
 * content plus tool args and widget/sheet payloads. VALE_EVENTLOG_PATH
 * points it elsewhere; otherwise eval turns (VALE_TURNS_PATH) keep their
 * recording next to their turns file, and live turns land in data/logs/.
 */
export function eventLogFile(day: Date = new Date()): string {
  const override = process.env.VALE_EVENTLOG_PATH?.trim();
  if (override) return override;
  const date = day.toISOString().slice(0, 10);
  const turnsOverride = process.env.VALE_TURNS_PATH?.trim();
  if (turnsOverride)
    return join(dirname(turnsOverride), `events-${date}.jsonl`);
  return join(process.cwd(), "data", "logs", `${date}.jsonl`);
}

/** Append one recording line; logging never breaks a turn. */
export function persistEventLog(line: string): void {
  try {
    const file = eventLogFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`);
  } catch {
    /* the console line already went out; a full disk must not fail the turn */
  }
}

/**
 * Unified server log in one call: aligned console columns for the live
 * demo plus the full event (text, tool args, widget/sheet payloads) in the
 * daily JSONL recording. Errors and timeouts go to stderr.
 */
export function vlog(event: VLogEvent): void {
  const line = formatVlog(event);
  if (event.status === "error" || event.status === "timeout")
    console.error(line);
  else console.log(line);
  try {
    persistEventLog(
      JSON.stringify({
        ts: new Date().toISOString(),
        turn: event.turn || "-",
        process: event.process,
        model: event.model ?? "-",
        durationMs: event.durationMs ?? null,
        status: event.status,
        detail: scrubValue(event.detail ?? {}),
        content: scrubSecrets(event.content ?? ""),
        ...(scrubValue(event.extra ?? {}) as Record<string, unknown>),
      }),
    );
  } catch {
    /* console already shows it; the recording must not fail the turn */
  }
}

/**
 * Persistent ear log: every [voice-turn] line lands in data/turns.jsonl,
 * ignored turns with their gate included. VALE_TURNS_PATH overrides the file
 * (evals point it elsewhere so test turns never mix into Daniel's log).
 */
export function turnsLogFile(): string {
  const override = process.env.VALE_TURNS_PATH?.trim();
  if (override) return override;
  return join(process.cwd(), "data", "turns.jsonl");
}

/** Append one formatted line; logging never breaks a turn. */
export function persistTurnLog(line: string): void {
  try {
    const file = turnsLogFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`);
  } catch {
    // The console line already went out; a full disk must not fail the turn.
  }
}

/**
 * Console plus persistent logs in one call: the console shows the aligned
 * turn row, while the full [voice-turn] JSON lands in data/turns.jsonl
 * (kept until replay replaces it) for the harness to read.
 */
export function emitTurnLog(fields: TurnLogFields): void {
  const line = formatTurnLog(fields);
  vlog({
    turn: fields.turn ?? "-",
    process: "VOICE",
    durationMs: fields.totalMs ?? null,
    status:
      fields.error === "timeout"
        ? "timeout"
        : fields.error !== null
          ? "error"
          : fields.ignored
            ? "ignored"
            : "ok",
    detail: { gate: fields.gate, tool: fields.tool },
    content: fields.transcript,
    // The recording keeps the whole turn (stats, slots, cost) for replay;
    // the console row above carries only the screen-level columns.
    // (turnFields, not turn: turn is the shared id on every row.)
    extra: { turnFields: { ...fields } },
  });
  persistTurnLog(line);
}
