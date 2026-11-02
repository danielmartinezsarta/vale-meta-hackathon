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
  gate?: "nombre" | "ventana" | "ignorado" | "idioma" | null;
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
  /** Blocks lost under load and source blocks spanned (client accounting). */
  lostBlocks?: number | null;
  srcBlocks?: number | null;
  /** Audio thread feeding the VAD, and whether a sheet was open at end. */
  engine?: "worklet" | "script" | null;
  sheetOpen?: boolean | null;
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
  return `[voice-turn] ${JSON.stringify(fields)}`;
}

/**
 * One brief line per Meta model call, for the demo video evidence:
 * which model ran, how long it took, what text it got.
 */
export function formatModelLog(
  model: string,
  responseMs: number | null,
  content: string,
): string {
  const flat = content.replace(/[\r\n]+/g, " ");
  const clipped = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
  const safe = clipped.replace(/"/g, "'");
  const response = responseMs === null ? "-" : `${Math.round(responseMs)}ms`;
  return `[vale-model] content="${safe}" model="${model}" response=${response}`;
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

/** Console-only: demo evidence, never persisted to the turn log. */
export function emitModelLog(
  model: string,
  responseMs: number | null,
  content: string,
): void {
  console.log(formatModelLog(model, responseMs, content));
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

/** Console plus persistent log in one call. */
export function emitTurnLog(fields: TurnLogFields): void {
  const line = formatTurnLog(fields);
  console.log(line);
  persistTurnLog(line);
}
