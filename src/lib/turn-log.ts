import type { AgentUsage } from "./agent";

// Public Model API list prices (Standard tier), per 1M tokens.
const INPUT_USD_PER_M = 1.25;
const OUTPUT_USD_PER_M = 4.25;
// Realtime transcription, per audio hour, billed down to whole seconds.
const ASR_USD_PER_SECOND = 0.18 / 3600;

export interface TurnLogFields {
  /** End-of-speech timestamp (ISO). */
  ts: string;
  transcript: string;
  /** ms from end of speech to first reply token (null when no model call). */
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  audioSeconds: number;
  tool: string | null;
  modelSkipped: boolean;
  error: string | null;
  /** Discarded by the wake gate: no model call, no board. */
  ignored: boolean;
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
