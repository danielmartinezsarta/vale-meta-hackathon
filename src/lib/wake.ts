// Name gate: Vale only obeys when spoken to. Before the agent, on both
// voice paths: a transcript naming Vale executes and opens an attention
// window; inside the same client's window it executes without the name;
// otherwise it is silently discarded (no model, no board, ignored:true log).
// Garbage never touches the previous_response_id chain.

// Measured ASR spellings of "Vale", including Bale (Daniel's call, 30/10:
// heard in negatives, position rule below carries the risk).
const DEFAULT_WAKE_WORDS = ["vale", "balle", "bali", "bale", "veil", "vail"];

// The name counts only first, or right after an opener: mid-sentence
// mentions of a client ("Bale broke a nail") must not wake Vale.
const OPENER_PREFIX = /^(?:hey|okay|ok|thanks)\b[\s,]*/;
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

export function windowMs(): number {
  const seconds = Number(process.env.VALE_ATTENTION_WINDOW_S);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return DEFAULT_WINDOW_S * 1000;
  }
  return seconds * 1000;
}

export function namesVale(transcript: string, words: string[] = wakeWords()): boolean {
  const head = ` ${normalizeWakeText(transcript).replace(OPENER_PREFIX, "")} `;
  return words.some((word) => {
    const needle = normalizeWakeText(word);
    return needle !== "" && head.startsWith(` ${needle} `);
  });
}

/** Client key for the attention window: first forwarded IP or direct peer. */
export function requestClientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first === undefined || first === "" ? "unknown" : first;
}

/** Browser-generated ids are lowercase alnum with dashes (at most 64 chars). */
export function sanitizeClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) ? id : null;
}

/**
 * Stable key for slots, pending actions and chain lanes: the explicit
 * browser id wins, the IP is the fallback (shared behind one NAT).
 */
export function requestClientId(request: Request): string {
  return (
    sanitizeClientId(new URL(request.url).searchParams.get("client")) ??
    requestClientIp(request)
  );
}

const attentionSince = new Map<string, number>();

/** Tapping talk opens the window like naming Vale does. */
export function noteAttention(clientId: string, now: number = Date.now()): void {
  attentionSince.set(clientId, now);
}

/** Undo intent: deshazlo / undo it, with or without the name. */
export function isUndoIntent(transcript: string): boolean {
  return /\b(deshaz\w*|undo(\s+it)?)\b/.test(` ${normalizeWakeText(transcript)} `);
}

const GREETING_ONLY =
  /^(hola|hey|buenas|buenos dias|buenas tardes|buenas noches|alo|oiga|oigame)$/;

/**
 * Collapse ASR stutters before the gate: adjacent repeats ("mí? mí?",
 * "la la") and glued halves ("Hola,Hola", "abre sesión abre sesión").
 * Compares lowercase without trailing punctuation, keeps the first form.
 */
export function collapseEcho(transcript: string): string {
  const tokens = transcript.split(/[\s,]+/).filter((token) => token !== "");
  if (tokens.length === 0) return "";
  const keyOf = (token: string): string =>
    token.toLowerCase().replace(/[?!.¡¿;:'"]+$/g, "");
  const single: string[] = [];
  let collapsed = false;
  for (const token of tokens) {
    const prev = single[single.length - 1];
    const key = keyOf(token);
    if (prev !== undefined && key !== "" && key === keyOf(prev)) {
      collapsed = true;
      continue;
    }
    single.push(token);
  }
  if (single.length >= 2 && single.length % 2 === 0) {
    const half = single.length / 2;
    const first = single.slice(0, half).map(keyOf);
    const second = single.slice(half).map(keyOf);
    if (first.every((key, i) => key !== "" && key === second[i])) {
      return single.slice(0, half).join(" ");
    }
  }
  // No repeat removed: keep the original untouched, punctuation included.
  return collapsed ? single.join(" ") : transcript;
}

/** Bare greeting, optionally naming Vale: never a data request. */
export function isGreetingOnly(transcript: string): boolean {
  const words = normalizeWakeText(transcript)
    .split(" ")
    .filter((word) => word !== "" && word !== "vale");
  if (words.length === 0) return false;
  return GREETING_ONLY.test(words.join(" "));
}

export type WakeGate = "nombre" | "ventana" | "ignorado";

export interface WakeVerdict {
  execute: boolean;
  namedVale: boolean;
  gate: WakeGate;
  /** Seconds since Vale's last reply (the previous executed turn). */
  sinceReplyS: number | null;
}

/**
 * Sliding attention window: naming Vale opens it, and every executed turn
 * restarts it, so any request inside the window runs without the name.
 * Empty transcripts bypass the gate: the existing silence path handles them.
 * Ignored turns neither read nor write the model or the chain.
 */
export function checkWake(
  transcript: string,
  clientId: string,
  now: number = Date.now(),
): WakeVerdict {
  const since = attentionSince.get(clientId);
  const inWindow = since !== undefined && now - since < windowMs();
  const sinceReplyS = since === undefined ? null : (now - since) / 1000;
  if (namesVale(transcript)) {
    attentionSince.set(clientId, now);
    return { execute: true, namedVale: true, gate: "nombre", sinceReplyS };
  }
  if (transcript.trim() === "") {
    return {
      execute: true,
      namedVale: false,
      gate: inWindow ? "ventana" : "ignorado",
      sinceReplyS,
    };
  }
  if (inWindow) {
    attentionSince.set(clientId, now);
    return { execute: true, namedVale: false, gate: "ventana", sinceReplyS };
  }
  return { execute: false, namedVale: false, gate: "ignorado", sinceReplyS };
}
