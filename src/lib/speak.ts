/**
 * Voice output: browser speech synthesizer by default, Seamless TTS by switch.
 * Silent no-op without the web APIs; the text always stays on screen.
 */

import { DEFAULT_LANGUAGE, type ValeLanguage } from "./vale-language";

const VOICE_PRIORITY: Record<ValeLanguage, string[]> = {
  es: ["es-CO", "es-419", "es-MX"],
  en: ["en-US", "en"],
};
/** Daniel's order: Premium first, then Enhanced, then the plain ones. */
const VOICE_NAME_ORDER = [
  "Ava (Premium)",
  "Zoe (Premium)",
  "Ava (Enhanced)",
  "Zoe (Enhanced)",
  "Samantha (Enhanced)",
  "Samantha",
  "Google US English",
];
/** macOS novelty voices: never a reply voice, even when en-US. */
const JOKE_VOICES = new Set(
  [
    "Albert",
    "Bad News",
    "Bahh",
    "Bells",
    "Boing",
    "Bubbles",
    "Cellos",
    "Good News",
    "Jester",
    "Organ",
    "Superstar",
    "Trinoids",
    "Whisper",
    "Wobble",
    "Zarvox",
  ].map((name) => name.toLowerCase()),
);
const FALLBACK_LANG: Record<ValeLanguage, string> = { es: "es-CO", en: "en-US" };
export const SEAMLESS_SPEAKER = 10;
const SEAMLESS_MAX_CHARS = 500;
const SEAMLESS_CHUNK_CHARS = 400;
const VOICES_WAIT_MS = 1000;

export type VoiceEngine = "browser" | "seamless";

let engine: VoiceEngine = "browser";

/** Daniel's runtime voice controls: one voice per language, shared speed and pitch. Persisted, no reload. */
export interface VoicePrefs {
  /** Exact English voice name, or null for the automatic pick (Ava Premium). */
  voiceEn: string | null;
  /** Exact Spanish voice name, or null for the automatic pick. */
  voiceEs: string | null;
  /** 0.8 (slow) to 1.3 (fast). */
  rate: number;
  /** 0.8 (low) to 1.2 (high). */
  pitch: number;
}

export const RATE_MIN = 0.8;
export const RATE_MAX = 1.3;
export const RATE_DEFAULT = 0.9;
export const PITCH_MIN = 0.8;
export const PITCH_MAX = 1.2;
export const PITCH_DEFAULT = 0.9;
const PREFS_KEY = "vale-voice";

const clamp = (value: unknown, lo: number, hi: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(hi, Math.max(lo, value))
    : fallback;

function cleanName(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function loadVoicePrefs(): VoicePrefs {
  const fallback: VoicePrefs = {
    voiceEn: null,
    voiceEs: null,
    rate: RATE_DEFAULT,
    pitch: PITCH_DEFAULT,
  };
  try {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<VoicePrefs> & {
      voice?: unknown;
    };
    // Legacy single-voice prefs become the English choice.
    const legacy = cleanName(parsed.voice);
    return {
      voiceEn: cleanName(parsed.voiceEn) ?? legacy,
      voiceEs: cleanName(parsed.voiceEs),
      rate: clamp(parsed.rate, RATE_MIN, RATE_MAX, RATE_DEFAULT),
      pitch: clamp(parsed.pitch, PITCH_MIN, PITCH_MAX, PITCH_DEFAULT),
    };
  } catch {
    return fallback;
  }
}

let voicePrefs: VoicePrefs | null = null;

/** Current prefs; the next spoken sentence picks them up without a reload. */
export function getVoicePrefs(): VoicePrefs {
  if (!voicePrefs) voicePrefs = loadVoicePrefs();
  return { ...voicePrefs };
}

/** Merge, clamp, persist and log the new choice. */
export function setVoicePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
  const current = getVoicePrefs();
  voicePrefs = {
    voiceEn: patch.voiceEn !== undefined ? patch.voiceEn : current.voiceEn,
    voiceEs: patch.voiceEs !== undefined ? patch.voiceEs : current.voiceEs,
    rate: clamp(patch.rate ?? current.rate, RATE_MIN, RATE_MAX, RATE_DEFAULT),
    pitch: clamp(patch.pitch ?? current.pitch, PITCH_MIN, PITCH_MAX, PITCH_DEFAULT),
  };
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(voicePrefs));
    }
  } catch {
    /* persistence is best-effort; the turn still uses the new prefs */
  }
  logVoiceChoice();
  return { ...voicePrefs };
}

/** Save the picked voice for one language; the other language keeps hers. */
export function setVoiceForLanguage(
  language: ValeLanguage,
  voice: string | null,
): VoicePrefs {
  return setVoicePrefs(
    language === "es" ? { voiceEs: voice } : { voiceEn: voice },
  );
}

/** The saved voice for one language, or null for the automatic pick. */
export function preferredVoice(language: ValeLanguage): string | null {
  const prefs = getVoicePrefs();
  return language === "es" ? prefs.voiceEs : prefs.voiceEn;
}

/** Browser voices in the active language, jokes excluded. English keeps Daniel's order first. */
export function availableVoices(
  voices: readonly SpeechSynthesisVoice[],
  language: ValeLanguage = "en",
): { name: string; lang: string }[] {
  const order = (name: string): number => {
    const index = VOICE_NAME_ORDER.findIndex(
      (ordered) => ordered.toLowerCase() === (name ?? "").toLowerCase(),
    );
    return index === -1 ? VOICE_NAME_ORDER.length : index;
  };
  const prefix = language === "es" ? "es" : "en";
  return voices
    .filter(
      (voice) =>
        (voice.lang ?? "").toLowerCase().startsWith(prefix) &&
        !isJokeVoice(voice),
    )
    .map((voice) => ({ name: voice.name ?? "", lang: voice.lang ?? "" }))
    .filter((voice) => voice.name !== "")
    .sort(
      (a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name),
    );
}

/** Voice list for the page selector; empty without the web APIs. */
export function getBrowserVoices(
  language: ValeLanguage = "en",
): Promise<{ name: string; lang: string }[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);
  return ensureVoices(s).then((voices) => availableVoices(voices, language));
}

/** One-line field log of the voice in use, for the by-ear test. */
function logVoiceChoice(): void {
  const prefs = getVoicePrefs();
  try {
    console.log(
      `[voice] using: en=${prefs.voiceEn ?? "automatic"} es=${prefs.voiceEs ?? "automatic"} rate=${prefs.rate.toFixed(1)} pitch=${prefs.pitch.toFixed(1)}`,
    );
  } catch {
    /* logging must never break speech */
  }
}

/** Switch the output engine at runtime; switch back with "browser". */
export function setVoiceEngine(next: VoiceEngine): void {
  engine = next;
  stopSeamlessSpeech();
}

export function voiceEngine(): VoiceEngine {
  return engine;
}

function isJokeVoice(voice: SpeechSynthesisVoice): boolean {
  return JOKE_VOICES.has((voice.name ?? "").trim().toLowerCase());
}

export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  language: ValeLanguage = DEFAULT_LANGUAGE,
  preferredName: string | null = null,
): SpeechSynthesisVoice | null {
  if (preferredName !== null && preferredName !== "") {
    const chosen = voices.find(
      (voice) =>
        (voice.name ?? "").toLowerCase() === preferredName.toLowerCase() &&
        !isJokeVoice(voice),
    );
    if (chosen) return chosen;
  }
  if (language === "en") {
    for (const name of VOICE_NAME_ORDER) {
      const found = voices.find(
        (voice) =>
          (voice.name ?? "").toLowerCase() === name.toLowerCase() &&
          !isJokeVoice(voice),
      );
      if (found) return found;
    }
    return (
      voices.find(
        (voice) =>
          voice.lang.toLowerCase().startsWith("en-us") &&
          !isJokeVoice(voice),
      ) ??
      voices.find(
        (voice) =>
          voice.lang.toLowerCase().startsWith("en") && !isJokeVoice(voice),
      ) ??
      null
    );
  }
  for (const prefix of VOICE_PRIORITY[language]) {
    const found = voices.find((voice) =>
      voice.lang.toLowerCase().startsWith(prefix.toLowerCase()),
    );
    if (found) return found;
  }
  return (
    voices.find((voice) => voice.lang.toLowerCase().startsWith("es")) ?? null
  );
}

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

/**
 * Browser voices load asynchronously: the first getVoices() is often empty
 * or partial, which used to give the first phrase the wrong voice. Wait for
 * voiceschanged before choosing; after it fired once the list is trusted.
 */
let voicesSettled = false;
let voicesWatching = false;
function ensureVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const available = synth.getVoices();
  if (available.length > 0 && voicesSettled) return Promise.resolve(available);
  return new Promise((resolve) => {
    let done = false;
    const finish = (settled: boolean) => {
      if (done) return;
      done = true;
      if (settled) voicesSettled = true;
      resolve(synth.getVoices());
    };
    const timer = setTimeout(() => finish(false), VOICES_WAIT_MS);
    try {
      if (!voicesWatching) {
        voicesWatching = true;
        synth.addEventListener("voiceschanged", () => {
          voicesSettled = true;
        });
      }
      synth.addEventListener(
        "voiceschanged",
        () => {
          clearTimeout(timer);
          finish(true);
        },
        { once: true },
      );
    } catch {
      clearTimeout(timer);
      finish(false);
    }
  });
}

/**
 * The reply text is written to be read, not spoken: strip markdown, list
 * bullets, link targets, and emoji so the voice never reads them aloud.
 */
const EMOJI_RE = new RegExp(
  "[\\p{Extended_Pictographic}\\uFE0F\\u200D\\u20E3\\u00A9\\u00AE\\u2122\\u2190-\\u21FF]",
  "gu",
);

export function cleanSpokenText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`#>]/g, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(EMOJI_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What the speaker says: markdown stripped, and in English her name is
 * spelled out so it lands as Vah-leh. The screen and the logs always keep
 * the Vale spelling; only the spoken audio changes.
 */
export function spokenText(text: string, language: ValeLanguage): string {
  const clean = cleanSpokenText(text);
  if (language === "en") return clean.replace(/\bVale\b/g, "Vah-leh");
  return clean;
}

/**
 * Reply split for sentence-by-sentence output: the first sentence reaches
 * the speaker while the rest still synthesizes. Splits on . ! ? …, keeps
 * the punctuation, and breaks overlong chunks on commas before hard-cutting.
 */
export function splitSentences(text: string): string[] {
  const raw =
    text.match(/[^.!?…]+[.!?…]+["»”)]?|.+$/g)?.map((part) => part.trim()) ??
    [];
  const sentences: string[] = [];
  for (const part of raw) {
    if (part === "") continue;
    if (part.length <= SEAMLESS_CHUNK_CHARS) {
      sentences.push(part);
      continue;
    }
    const sub =
      part
        .match(/[^,;:]+[,;:]+|.+$/g)
        ?.map((piece) => piece.trim())
        .filter((piece) => piece !== "") ?? [part];
    for (const piece of sub) {
      if (piece.length <= SEAMLESS_CHUNK_CHARS) {
        sentences.push(piece);
      } else {
        for (let at = 0; at < piece.length; at += SEAMLESS_CHUNK_CHARS) {
          sentences.push(piece.slice(at, at + SEAMLESS_CHUNK_CHARS).trim());
        }
      }
    }
  }
  return sentences.filter((sentence) => sentence !== "");
}

let seamlessAudio: HTMLAudioElement | null = null;
let seamlessPlayId = 0;

export function stopSeamlessSpeech(): void {
  seamlessPlayId += 1;
  try {
    seamlessAudio?.pause();
  } catch {
    /* nothing playing or nothing to stop */
  }
  seamlessAudio = null;
}

async function playSentence(
  playId: number,
  sentence: string,
  language: ValeLanguage,
  onDone: () => void,
): Promise<void> {
  const said = spokenText(sentence, language);
  if (said === "") {
    onDone();
    return;
  }
  let response: Response;
  try {
    response = await fetch(
      `/api/seamless-voice?speaker=${SEAMLESS_SPEAKER}&text=${encodeURIComponent(said.slice(0, SEAMLESS_MAX_CHARS))}`,
    );
  } catch {
    sayBrowserFallback(sentence, language);
    onDone();
    return;
  }
  if (!response.ok || playId !== seamlessPlayId) {
    if (!response.ok && playId === seamlessPlayId) {
      sayBrowserFallback(sentence, language);
    }
    onDone();
    return;
  }
  try {
    const blob = await response.blob();
    if (playId !== seamlessPlayId) {
      onDone();
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    seamlessAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (seamlessAudio === audio) seamlessAudio = null;
      onDone();
    };
    await audio.play();
  } catch {
    if (playId === seamlessPlayId) sayBrowserFallback(sentence, language);
    onDone();
  }
}

/**
 * Sentence by sentence: the first sentence fetches and plays at once, each
 * ending cues the next. First audio no longer waits for the whole reply.
 */
function playSeamless(
  text: string,
  language: ValeLanguage = DEFAULT_LANGUAGE,
): void {
  stopSeamlessSpeech();
  const playId = seamlessPlayId;
  const sentences = splitSentences(text);
  if (sentences.length === 0) return;
  let index = 0;
  const next = (): void => {
    if (playId !== seamlessPlayId) return;
    if (index >= sentences.length) return;
    const sentence = sentences[index];
    index += 1;
    void playSentence(playId, sentence, language, next);
  };
  next();
}

/** Seamless failed: the browser voice says it instead of silence. */
function sayBrowserFallback(
  text: string,
  language: ValeLanguage = DEFAULT_LANGUAGE,
): void {
  const s = synth();
  if (!s) return;
  const sentences = splitSentences(text);
  if (sentences.length === 0) return;
  try {
    s.cancel();
  } catch {
    /* voice output is best-effort; the text stays on screen */
  }
  void ensureVoices(s).then((late) =>
    queueBrowserSentences(s, sentences, late, language),
  );
}

/**
 * Streaming speech: reply fragments arrive before the full text, so each
 * complete sentence speaks at once and the tail flushes on finish. The
 * browser queue appends without cancelling; Seamless still needs the whole
 * text, so it buffers and plays once.
 */
let streamPending = "";
let streamLanguage: ValeLanguage = DEFAULT_LANGUAGE;

/** The chosen voice, logged once per page load for the field test. */
let voiceLogged = false;

function queueBrowserSentences(
  s: SpeechSynthesis,
  sentences: string[],
  voices: readonly SpeechSynthesisVoice[],
  language: ValeLanguage,
): void {
  try {
    const prefs = getVoicePrefs();
    const preferred = language === "es" ? prefs.voiceEs : prefs.voiceEn;
    const voice = pickVoice(voices, language, preferred);
    if (voice && !voiceLogged) {
      voiceLogged = true;
      try {
        console.log(`[voice] using: ${voice.name ?? "default"} ${voice.lang}`);
      } catch {
        /* logging must never break speech */
      }
    }
    for (const sentence of sentences) {
      const clean = spokenText(sentence, language);
      if (clean === "") continue;
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.rate = prefs.rate;
      utterance.pitch = prefs.pitch;
      utterance.lang = voice?.lang ?? FALLBACK_LANG[language];
      if (voice) utterance.voice = voice;
      s.speak(utterance);
    }
  } catch {
    /* voice output is best-effort; the text stays on screen */
  }
}

export function speakStream(
  chunk: string,
  language: ValeLanguage = DEFAULT_LANGUAGE,
): void {
  streamPending += chunk;
  streamLanguage = language;
  if (engine === "seamless") return;
  const sentences = splitSentences(streamPending);
  if (sentences.length <= 1) return;
  const s = synth();
  if (!s) return;
  streamPending = sentences[sentences.length - 1];
  const ready = sentences.slice(0, -1);
  void ensureVoices(s).then((late) =>
    queueBrowserSentences(s, ready, late, language),
  );
}

export function finishStream(): void {
  const tail = streamPending;
  const language = streamLanguage;
  streamPending = "";
  streamLanguage = DEFAULT_LANGUAGE;
  if (tail.trim() === "") return;
  if (engine === "seamless") {
    playSeamless(tail, language);
    return;
  }
  const s = synth();
  if (!s) return;
  const sentences = splitSentences(tail);
  if (sentences.length === 0) return;
  void ensureVoices(s).then((late) =>
    queueBrowserSentences(s, sentences, late, language),
  );
}

export function speak(
  text: string,
  language: ValeLanguage = DEFAULT_LANGUAGE,
): void {
  if (text.trim() === "") return;
  if (engine === "seamless") {
    // The demo speaker is fixed; the reply text itself stays in the
    // selected language, so Seamless never invents another one.
    playSeamless(text, language);
    return;
  }
  sayBrowserFallback(text, language);
}

/** Page Test button: hear the picked voice at the picked speed and pitch. */
export function previewVoice(language: ValeLanguage = "en"): void {
  sayBrowserFallback(
    language === "es"
      ? "Hola, soy Vale. Dime qué necesitas."
      : "Hi, I'm Vale. Tell me what you need.",
    language,
  );
}

export function stopSpeaking(reason: string): void {
  // Every stop carries its cause so the next field test can read in the
  // browser console which tap or voice event cut the reply.
  try {
    console.debug(`[voice-out] stop: ${reason}`);
  } catch {
    /* logging must never break the stop */
  }
  stopSeamlessSpeech();
  try {
    synth()?.cancel();
  } catch {
    /* nothing playing or nothing to stop */
  }
}

/** True while a reply is audible: browser queue or Seamless audio. */
export function isSpeaking(): boolean {
  try {
    if (seamlessAudio !== null) return true;
    return synth()?.speaking ?? false;
  } catch {
    return false;
  }
}
