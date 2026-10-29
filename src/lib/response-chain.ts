// Single-user chain of Meta response ids across voice turns.
// The server holds it in memory: no transcripts, no audio, just the last id.
// A bare "sí" confirms the pending write because the next request reuses it.
// Any failed turn drops the chain so the next tap starts clean.
let previousResponseId: string | null = null;

/** Id to attach to the next turn, if the previous one succeeded. */
export function nextPreviousResponseId(): string | undefined {
  return previousResponseId ?? undefined;
}

/** A successful turn continues the chain; an empty id drops it. */
export function chainSucceeded(responseId: string): void {
  previousResponseId = responseId === "" ? null : responseId;
}

/** A failed turn breaks the chain; the next tap starts clean. */
export function chainFailed(): void {
  previousResponseId = null;
}
