// Name gate: Vale only obeys when spoken to. Before the agent, on both
// voice paths: a transcript naming Vale executes and opens an attention
// window; inside the same client's window it executes without the name;
// otherwise it is silently discarded (no model, no board, ignored:true log).
// Garbage never touches the previous_response_id chain.

import type { ValeLanguage } from "./vale-language";

// The one name list: exact "vale" plus its accepted ASR spellings. Only
// these wake her; anything else that sounds close ("balle", "veil") stays
// chatter until a run proves otherwise.
const DEFAULT_WAKE_WORDS = ["vale", "bale", "bali", "ballet", "valley", "ballot"];

/** Exact word: wakes at any sentence start, and everywhere a variant wakes. */
const EXACT_WAKE_WORD = "vale";

/** Openers that hand the turn to a following name ("hey Vale"). */
const OPENER_WORDS = new Set(["hey", "ok", "okay", "thanks"]);

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
 * Lowercase with accents folded 1:1, punctuation kept: offsets stay valid
 * against the original transcript for the canonical splice below.
 */
function cleanWakeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[áàäâ]/g, "a")
    .replace(/[éèëê]/g, "e")
    .replace(/[íìïî]/g, "i")
    .replace(/[óòöô]/g, "o")
    .replace(/[úùüû]/g, "u")
    .replace(/ñ/g, "n");
}

interface WakeMatch {
  /** Offset of the name word in the transcript. */
  start: number;
  end: number;
}

/**
 * First positional name match, if any: exact "vale" at any sentence start,
 * or the exact word or a variant right after hey/ok/okay/thanks, or followed
 * by a comma or period. A bare sentence-start variant ("Bali nails are so
 * trendy") never matches, and neither does a mid-sentence mention with no
 * punctuation ("the Vale shop").
 */
function findWakeMatch(transcript: string, words: string[]): WakeMatch | null {
  const exact = words.includes(EXACT_WAKE_WORD) ? EXACT_WAKE_WORD : null;
  const known = new Set(words);
  const text = cleanWakeText(transcript);
  // Exact word at the start of any sentence.
  if (exact !== null) {
    for (const sentence of text.matchAll(/[^.!?…\n]+/g)) {
      const word = /[a-z]+/.exec(sentence[0]);
      if (word !== null && word[0] === exact) {
        const start = (sentence.index ?? 0) + word.index;
        return { start, end: start + word[0].length };
      }
    }
  }
  // Opener or trailing comma/period, anywhere in the turn.
  const tokens: { word: string; start: number; after: string }[] = [];
  for (const match of text.matchAll(/([a-z]+)([,.;:!?…]*)/g)) {
    tokens.push({
      word: match[1],
      start: match.index ?? 0,
      after: match[2].charAt(0) ?? "",
    });
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.word !== exact && !known.has(token.word)) continue;
    if (token.after === "," || token.after === ".")
      return { start: token.start, end: token.start + token.word.length };
    const prev = i > 0 ? tokens[i - 1].word : null;
    if (prev !== null && OPENER_WORDS.has(prev))
      return { start: token.start, end: token.start + token.word.length };
  }
  return null;
}

/**
 * The name activates on position, not vocabulary: exact "vale" at the start
 * of any sentence, or the exact word or a variant right after
 * hey/ok/okay/thanks, or followed by a comma or period ("Ballet, remind
 * me", "Thanks, Bali."). "Bali nails…" and "bale broke…" never activate,
 * and neither does a bare mention ("the Vale shop").
 */
export function namesVale(transcript: string, words: string[] = wakeWords()): boolean {
  return findWakeMatch(transcript, words) !== null;
}

/**
 * Canonical wake word for the model and the tools: the triggering name —
 * exact or variant — becomes "Vale" so a substitution never rides into tool
 * args as a service or client ("Ballet, open a session" once filed service
 * "Ballet"). Turns with no positional match ride through unchanged.
 */
export function canonicalizeWakeWord(
  transcript: string,
  words: string[] = wakeWords(),
): string {
  const match = findWakeMatch(transcript, words);
  if (match === null) return transcript;
  return `${transcript.slice(0, match.start)}Vale${transcript.slice(match.end)}`;
}

/**
 * Live words before an unnamed phrase is cut client-side (~2 s of speech).
 * Past this many words the ASR revision risk is low: the opening words the
 * server gate reads are already stable.
 */
export const EARLY_CUT_WORDS = 6;

/**
 * Client-side twin of the server wake gate for unaddressed chatter: with no
 * session open and the attention window closed, a phrase that runs past the
 * opening words without naming Vale is cut now instead of riding to the
 * model. A phrase that names her is never cut, however long it runs, and a
 * session or an open window disables the cut entirely.
 */
export function shouldCutPhrase(options: {
  text: string;
  sessionOpen: boolean;
  windowOpen: boolean;
}): boolean {
  if (options.sessionOpen || options.windowOpen) return false;
  const words = options.text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length < EARLY_CUT_WORDS) return false;
  // Anywhere, not just the opening words: a long order that names her late
  // stays on the wire and the server gate (which owns the true window)
  // decides. Only chatter that never names her is cut here.
  const tokens = normalizeWakeText(options.text)
    .split(" ")
    .filter((token) => token !== "");
  const known = new Set(wakeWords());
  return !tokens.some((token) => known.has(token));
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
 * A bare name call: the turn holds only the wake word ("Vale", "valley"),
 * cut off mid-thought before the pause. Vale stays silent and keeps
 * listening in the same turn instead of answering: answering here drops
 * the words that follow (trial 9.1).
 */
export function isBareNameCall(transcript: string): boolean {
  const tokens = normalizeWakeText(transcript)
    .split(" ")
    .filter((token) => token !== "");
  if (tokens.length === 0 || tokens.length > 2) return false;
  const bare = wakeWords();
  return tokens.every((token) => bare.includes(token));
}

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

export type WakeGate = "nombre" | "ventana" | "ignorado" | "idioma" | "cierre" | "typed" | "audio";

export interface WakeVerdict {
  execute: boolean;
  namedVale: boolean;
  gate: WakeGate;
  /** Seconds since Vale's last reply (the previous executed turn). */
  sinceReplyS: number | null;
}

/** Close verbs, either language; attached pronouns count as the same word. */
const CLOSE_SHEET_VERBS = new Set([
  "close",
  "cierra",
  "cierrala",
  "cierralo",
  "cierre",
]);
/** Bare determiners between the verb and the sheet noun. */
const CLOSE_SHEET_ARTICLES = new Set([
  "this",
  "that",
  "the",
  "a",
  "an",
  "de",
  "la",
  "las",
  "los",
  "el",
  "mi",
  "my",
]);

/**
 * A short order to close the open sheet: no model, no spoken reply. Longer
 * turns ride to the model untouched, so a compound order that mentions
 * closing among other asks is never swallowed here. The session is never
 * a sheet: ending it opens the summary through the agent instead.
 */
export const CLOSE_SHEET_WORDS = 8;

export function isCloseSheetIntent(transcript: string): boolean {
  const words = transcript
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0 || words.length > CLOSE_SHEET_WORDS) return false;
  const flat = ` ${normalizeWakeText(transcript)} `;
  // The apostrophe never survives normalization ("don't" reads "dont").
  if (
    flat.includes(" dont close") ||
    flat.includes(" do not close") ||
    flat.includes(" no cierres") ||
    flat.includes(" no la cierres") ||
    flat.includes(" no lo cierres")
  ) {
    return false;
  }
  if (/\bsessions?\b/.test(flat) || /\bsesion(es)?\b/.test(flat)) return false;
  // Apostrophes never survive normalization ("that's" reads "thats").
  if (
    flat.includes(" thats all ") ||
    flat.includes(" thats it ") ||
    flat.includes(" eso es todo ")
  ) {
    return true;
  }
  const tokens = flat
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  const verbAt = tokens.findIndex((token) => CLOSE_SHEET_VERBS.has(token));
  if (verbAt === -1) return false;
  const rest = tokens
    .slice(verbAt + 1)
    .filter((token) => !CLOSE_SHEET_ARTICLES.has(token));
  return rest.length > 0;
}

/**
 * Sliding attention window: naming Vale opens it, every executed turn and
 * her real last word restart it, and a sheet she opened holds it open
 * behind the reading, so any request inside runs without the name. Empty
 * transcripts bypass the gate: the existing silence path handles them.
 * Ignored turns neither read nor write the model or the chain.
 */
export function checkWake(
  transcript: string,
  clientId: string,
  now: number = Date.now(),
  sessionOpen = false,
  language: ValeLanguage = "en",
  sheetOpen = false,
): WakeVerdict {
  const since = attentionSince.get(clientId);
  const inWindow =
    sheetOpen || (since !== undefined && now - since < windowMs(sessionOpen));
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
