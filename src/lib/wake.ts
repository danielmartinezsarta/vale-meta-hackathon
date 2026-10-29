// Name gate: Vale only obeys when spoken to. Before the agent, on both
// voice paths: a transcript naming Vale executes and opens an attention
// window; inside the same client's window it executes without the name;
// otherwise it is silently discarded (no model, no board, ignored:true log).
// Garbage never touches the previous_response_id chain.

const DEFAULT_WAKE_WORDS = ["vale"];
const DEFAULT_WINDOW_S = 45;

export function normalizeWakeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wakeWords(): string[] {
  const words = (process.env.VALE_WAKE_WORDS ?? "")
    .split(",")
    .map((word) => normalizeWakeText(word.trim()))
    .filter((word) => word !== "");
  return words.length > 0 ? words : DEFAULT_WAKE_WORDS;
}

function windowMs(): number {
  const seconds = Number(process.env.VALE_ATTENTION_WINDOW_S);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return DEFAULT_WINDOW_S * 1000;
  }
  return seconds * 1000;
}

export function namesVale(transcript: string, words: string[] = wakeWords()): boolean {
  const haystack = ` ${normalizeWakeText(transcript)} `;
  return words.some((word) => {
    const needle = normalizeWakeText(word);
    return needle !== "" && haystack.includes(` ${needle} `);
  });
}

/** Client key for the attention window: first forwarded IP or direct peer. */
export function requestClientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first === undefined || first === "" ? "unknown" : first;
}

const attentionSince = new Map<string, number>();

export interface WakeVerdict {
  execute: boolean;
  namedVale: boolean;
}

/**
 * Empty transcripts bypass the gate: the existing silence path handles them.
 * Ignored turns neither read nor write the response chain.
 */
export function checkWake(
  transcript: string,
  clientId: string,
  now: number = Date.now(),
): WakeVerdict {
  if (transcript.trim() === "") return { execute: true, namedVale: false };
  if (namesVale(transcript)) {
    attentionSince.set(clientId, now);
    return { execute: true, namedVale: true };
  }
  const since = attentionSince.get(clientId);
  if (since !== undefined && now - since < windowMs()) {
    return { execute: true, namedVale: false };
  }
  return { execute: false, namedVale: false };
}
