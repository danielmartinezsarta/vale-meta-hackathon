// Chain of Meta response ids across voice turns, one lane per client.
// The server holds it in memory: no transcripts, no audio, just the last id.
// Keyed by stable client identity (never by connection: every tap opens a
// new socket, and serverless instances do not share module state).
// A bare "sí" confirms the pending write because the next request reuses it.
// Any failed turn drops the chain so the next tap starts clean.
// Growth cap: at most MAX_TURNS chained turns, then a fresh turn (keeps ttft
// flat; measured locally, see the builder report). A completed write also
// restarts the chain: the next turn chains only while business stays open.

const DEFAULT_MAX_TURNS = 4;

/** Single-user default; voice paths pass their own client key. */
export const LOCAL_CHAIN_KEY = "local";

function maxTurns(): number {
  const parsed = Number(process.env.VALE_CHAIN_MAX_TURNS);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_TURNS;
  return parsed;
}

interface ChainLane {
  id: string | null;
  turns: number;
}

const lanes = new Map<string, ChainLane>();

function laneFor(key: string): ChainLane {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { id: null, turns: 0 };
    lanes.set(key, lane);
  }
  return lane;
}

/** Id to attach to the next turn, if the previous one succeeded. */
export function nextPreviousResponseId(
  key: string = LOCAL_CHAIN_KEY,
): string | undefined {
  const lane = laneFor(key);
  if (lane.id === null) return undefined;
  if (lane.turns >= maxTurns()) {
    lane.id = null;
    lane.turns = 0;
    return undefined;
  }
  return lane.id;
}

/**
 * A successful turn continues the chain only while business stays open
 * (no tool, or a tool reporting doubt). A completed write or an empty id
 * drops it.
 */
export function chainSucceeded(
  responseId: string,
  keep: boolean,
  key: string = LOCAL_CHAIN_KEY,
): void {
  const lane = laneFor(key);
  if (responseId === "" || !keep) {
    lane.id = null;
    lane.turns = 0;
    return;
  }
  lane.turns = lane.id === null ? 1 : lane.turns + 1;
  lane.id = responseId;
}

/** A failed turn breaks the chain; the next tap starts clean. */
export function chainFailed(key: string = LOCAL_CHAIN_KEY): void {
  const lane = laneFor(key);
  lane.id = null;
  lane.turns = 0;
}
