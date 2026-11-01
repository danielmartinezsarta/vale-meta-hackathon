// Name gate: Vale only obeys when spoken to. Before the agent, on both
// voice paths: a transcript naming Vale executes and opens an attention
// window; inside the same client's window it executes without the name;
// otherwise it is silently discarded (no model, no board, ignored:true log).
// Garbage never touches the previous_response_id chain.

import type { ValeLanguage } from "./vale-language";

// Measured ASR spellings of "Vale", including Bale (Daniel's call, 30/10:
// heard in negatives, position rule below carries the risk).
const DEFAULT_WAKE_WORDS = ["vale", "balle", "bali", "bale", "veil", "vail"];

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

export function wakeWords(): string[] {
  const words = (process.env.VALE_WAKE_WORDS ?? "")
    .split(",")
    .map((word) => normalizeWakeText(word.trim()))
    .filter((word) => word !== "");
  return words.length > 0 ? words : DEFAULT_WAKE_WORDS;
}

/** Open service session on the table: the window stretches to 90 s. */
export const SESSION_WINDOW_S = 90;

/** Sliding window, longer while a service session is open on the table. */
export function windowMs(sessionOpen = false): number {
  const seconds = Number(process.env.VALE_ATTENTION_WINDOW_S);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return (sessionOpen ? SESSION_WINDOW_S : DEFAULT_WINDOW_S) * 1000;
  }
  return seconds * 1000;
}

/**
 * The name activates in any of the first three words, in either language,
 * with no opener or greeting lists ("Hola Vale", "Oye Vale", "Buenas Vale"
 * all count). A bare first-word client mention ("Bale broke a nail")
 * still wakes: that is the accepted cost of a purely positional rule.
 */
export function namesVale(transcript: string, words: string[] = wakeWords()): boolean {
  const tokens = normalizeWakeText(transcript)
    .split(" ")
    .filter((token) => token !== "");
  return tokens
    .slice(0, 3)
    .some((token) => words.includes(normalizeWakeText(token)));
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

/** Bare greeting, optionally naming Vale: never a data request. */
export function isGreetingOnly(transcript: string): boolean {
  const words = normalizeWakeText(transcript)
    .split(" ")
    .filter((word) => word !== "" && word !== "vale");
  if (words.length === 0) return false;
  return GREETING_ONLY.test(words.join(" "));
}

/** Content words that only show up in Spanish transcripts (accents stripped). */
const SPANISH_MARKERS = new Set(
  "que una para gracias hola estoy estas estamos tienes tiene quiere quiero abre abro sesion cita manana ficha esmaltado insumo insumos manicurista donde cuando porque quien este esta estos".split(
    " ",
  ),
);

/** Content words that only show up in English transcripts. */
const ENGLISH_MARKERS = new Set(
  "the is are you your what with how book booking appointment session open save goal goals today price prices list card service client next hello thanks please done time".split(
    " ",
  ),
);

/**
 * The transcript speaks the other language: the selector owns the language
 * end to end, never the transcript. A bare name call still opens the window:
 * only content past the name can mismatch.
 */
export function languageMismatch(
  transcript: string,
  language: ValeLanguage = "en",
): boolean {
  const tokens = normalizeWakeText(transcript)
    .split(" ")
    .filter((word) => word !== "");
  const words = wakeWords();
  // The name itself says nothing about the language: drop it everywhere
  // ("thanks, Vale" is English; "vale, gracias" is Spanish).
  const content = tokens.filter((token) => !words.includes(token));
  if (content.length === 0) return false;
  if (/[¿¡]/.test(transcript)) return language !== "es";
  const markers = language === "es" ? ENGLISH_MARKERS : SPANISH_MARKERS;
  return content.some((token) => markers.has(token));
}

export type WakeGate = "nombre" | "ventana" | "ignorado" | "idioma";

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
  sessionOpen = false,
  language: ValeLanguage = "en",
): WakeVerdict {
  const since = attentionSince.get(clientId);
  const inWindow = since !== undefined && now - since < windowMs(sessionOpen);
  const sinceReplyS = since === undefined ? null : (now - since) / 1000;
  // A phrase that names Vale is never discarded for language: the name
  // itself says nothing about the language, and the selector owns the
  // reply language end to end. Only unnamed content in the other language
  // is silently discarded (no model, no writes, gate:idioma).
  const named = namesVale(transcript);
  if (!named && languageMismatch(transcript, language)) {
    return { execute: false, namedVale: false, gate: "idioma", sinceReplyS };
  }
  if (named) {
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
