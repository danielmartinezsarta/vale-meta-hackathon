// Single-user chain of Meta response ids across voice turns.
// The server holds it in memory: no transcripts, no audio, just the last id.
// A bare "sí" confirms the pending write because the next request reuses it.
// Any failed turn drops the chain so the next tap starts clean.
// Growth cap: at most MAX_TURNS chained turns, then a fresh turn (keeps ttft
// flat; measured locally, see the builder report). A completed write also
// restarts the chain: the next turn chains only while business stays open.

const DEFAULT_MAX_TURNS = 4;

function maxTurns(): number {
  const parsed = Number(process.env.VALE_CHAIN_MAX_TURNS);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_TURNS;
  return parsed;
}

let previousResponseId: string | null = null;
let chainedTurns = 0;

/** Id to attach to the next turn, if the previous one succeeded. */
export function nextPreviousResponseId(): string | undefined {
  if (previousResponseId === null) return undefined;
  if (chainedTurns >= maxTurns()) {
    previousResponseId = null;
    chainedTurns = 0;
    return undefined;
  }
  return previousResponseId;
}

/**
 * A successful turn continues the chain only while business stays open
 * (no tool, or a tool reporting doubt). A completed write or an empty id
 * drops it.
 */
export function chainSucceeded(responseId: string, keep: boolean): void {
  if (responseId === "" || !keep) {
    previousResponseId = null;
    chainedTurns = 0;
    return;
  }
  chainedTurns = previousResponseId === null ? 1 : chainedTurns + 1;
  previousResponseId = responseId;
}

/** A failed turn breaks the chain; the next tap starts clean. */
export function chainFailed(): void {
  previousResponseId = null;
  chainedTurns = 0;
}
