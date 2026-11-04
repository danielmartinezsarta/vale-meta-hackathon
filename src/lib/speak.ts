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
/** Daniel's Spanish order: Paulina (es-MX), then Marisol (es-ES). Siri voices do not exist on the web; never look for them. */
const VOICE_NAME_ORDER_ES = ["Paulina (Enhanced)", "Marisol (Premium)"];
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

const ENGINE_KEY = "vale-engine";

/** Browser default: a saved pick wins, anything else falls back. */
function loadEngine(): VoiceEngine {
  try {
    if (typeof window === "undefined") return "browser";
    return window.localStorage.getItem(ENGINE_KEY) === "seamless" ? "seamless" : "browser";
  } catch {
    return "browser";
  }
}

let engine: VoiceEngine = loadEngine();

/** Daniel's runtime voice controls: voice, speed and pitch per language. Switching language loads hers. Persisted, no reload. */
export interface VoicePrefs {
  /** Exact English voice name, or null for the automatic pick (Ava Premium). */
  voiceEn: string | null;
  /** Exact Spanish voice name, or null for the automatic pick (Paulina). */
  voiceEs: string | null;
  /** English speed 0.8 (slow) to 1.3 (fast). */
  rateEn: number;
  /** English pitch 0.8 (low) to 1.2 (high). */
  pitchEn: number;
  /** Spanish speed 0.8 (slow) to 1.3 (fast). */
  rateEs: number;
  /** Spanish pitch 0.8 (low) to 1.2 (high). */
  pitchEs: number;
}

/** Speed and pitch for one language. */
export function prosodyFor(language: ValeLanguage): { rate: number; pitch: number } {
  const prefs = getVoicePrefs();
  return language === "es"
    ? { rate: prefs.rateEs, pitch: prefs.pitchEs }
    : { rate: prefs.rateEn, pitch: prefs.pitchEn };
}

/**
 * Tuned prosody is only for Ava and Paulina: any other voice would sound
 * off at their rate and pitch, so it gets the neutral 1.0/1.0 instead.
 */
const TUNED_VOICES = [/^ava\b/i, /^paulina\b/i];

export function isTunedVoice(voice: { name?: string | null } | null): boolean {
  const name = (voice?.name ?? "").trim();
  return TUNED_VOICES.some((pattern) => pattern.test(name));
}

/** Speed and pitch for the picked voice: tuned for Ava/Paulina, neutral otherwise. */
export function prosodyForVoice(
  voice: SpeechSynthesisVoice | null,
  language: ValeLanguage,
): { rate: number; pitch: number } {
  if (!isTunedVoice(voice)) return { rate: 1, pitch: 1 };
  return prosodyFor(language);
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
    rateEn: RATE_DEFAULT,
    pitchEn: PITCH_DEFAULT,
    rateEs: RATE_DEFAULT,
    pitchEs: PITCH_DEFAULT,
  };
  try {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<VoicePrefs> & {
      voice?: unknown;
      rate?: unknown;
      pitch?: unknown;
    };
    // Legacy prefs merge: the single voice and prosody become English.
    const legacy = cleanName(parsed.voice);
    const legacyRate = clamp(parsed.rate, RATE_MIN, RATE_MAX, RATE_DEFAULT);
    const legacyPitch = clamp(parsed.pitch, PITCH_MIN, PITCH_MAX, PITCH_DEFAULT);
    return {
      voiceEn: cleanName(parsed.voiceEn) ?? legacy,
      voiceEs: cleanName(parsed.voiceEs),
      rateEn: clamp(parsed.rateEn ?? legacyRate, RATE_MIN, RATE_MAX, RATE_DEFAULT),
      pitchEn: clamp(parsed.pitchEn ?? legacyPitch, PITCH_MIN, PITCH_MAX, PITCH_DEFAULT),
      rateEs: clamp(parsed.rateEs ?? legacyRate, RATE_MIN, RATE_MAX, RATE_DEFAULT),
      pitchEs: clamp(parsed.pitchEs ?? legacyPitch, PITCH_MIN, PITCH_MAX, PITCH_DEFAULT),
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
    rateEn: clamp(patch.rateEn ?? current.rateEn, RATE_MIN, RATE_MAX, RATE_DEFAULT),
    pitchEn: clamp(patch.pitchEn ?? current.pitchEn, PITCH_MIN, PITCH_MAX, PITCH_DEFAULT),
    rateEs: clamp(patch.rateEs ?? current.rateEs, RATE_MIN, RATE_MAX, RATE_DEFAULT),
    pitchEs: clamp(patch.pitchEs ?? current.pitchEs, PITCH_MIN, PITCH_MAX, PITCH_DEFAULT),
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
  const named = language === "es" ? VOICE_NAME_ORDER_ES : VOICE_NAME_ORDER;
  const order = (name: string): number => {
    const index = named.findIndex(
      (ordered) => ordered.toLowerCase() === (name ?? "").toLowerCase(),
    );
    return index === -1 ? named.length : index;
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
      `[voice] using: en=${prefs.voiceEn ?? "automatic"} es=${prefs.voiceEs ?? "automatic"} rateEn=${prefs.rateEn.toFixed(1)} pitchEn=${prefs.pitchEn.toFixed(1)} rateEs=${prefs.rateEs.toFixed(1)} pitchEs=${prefs.pitchEs.toFixed(1)}`,
    );
  } catch {
    /* logging must never break speech */
  }
}

/** Switch the output engine at runtime; switch back with "browser". */
export function setVoiceEngine(next: VoiceEngine): void {
  engine = next;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(ENGINE_KEY, next);
  } catch {
    /* private mode: the pick lasts the session */
  }
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
  for (const name of VOICE_NAME_ORDER_ES) {
    const found = voices.find(
      (voice) =>
        (voice.name ?? "").toLowerCase() === name.toLowerCase() &&
        (voice.lang ?? "").toLowerCase().startsWith("es") &&
        !isJokeVoice(voice),
    );
    if (found) return found;
  }
  for (const prefix of VOICE_PRIORITY[language]) {
    const found = voices.find(
      (voice) =>
        voice.lang.toLowerCase().startsWith(prefix.toLowerCase()) &&
        !isJokeVoice(voice),
    );
    if (found) return found;
  }
  return (
    voices.find(
      (voice) =>
        voice.lang.toLowerCase().startsWith("es") && !isJokeVoice(voice),
    ) ?? null
  );
}

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

/**
 * iOS unlock: speechSynthesis.speak() and HTMLAudioElement.play() stay
 * muted unless first called inside a user gesture. The wake tap already
 * resumes the capture context in-gesture; prime both speech paths there
 * too, so the later out-of-gesture speak()/play() calls produce sound.
 * The unlock is page-scoped, so priming any element unlocks the
 * per-sentence elements playSentence() creates later.
 */
export function primeSpokenAudio(): void {
  try {
    const s = synth();
    if (s) {
      // Clear any wedge an earlier prime left before queueing ours.
      try {
        s.cancel();
      } catch {
        /* nothing queued or nothing to clear */
      }
      const warm = new SpeechSynthesisUtterance(" ");
      warm.volume = 0;
      let warmEnded = false;
      const markEnded = (): void => {
        warmEnded = true;
      };
      warm.onend = markEnded;
      warm.onerror = markEnded;
      s.speak(warm);
      // A blank utterance that never ends would wedge speaking forever
      // (isSpeaking reads the synth flag and the warm owes no estimate):
      // clear it so the mic reopens.
      setTimeout(() => {
        if (!warmEnded) {
          try {
            s.cancel();
          } catch {
            /* already clear */
          }
        }
      }, 2000);
    }
  } catch {
    /* voice output is best-effort */
  }
  try {
    // 20 ms of 8 kHz 16-bit mono silence behind a minimal WAV header.
    const samples = 160;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const ascii = (offset: number, text: string): void => {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(offset + index, text.charCodeAt(index));
      }
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, samples * 2, true);
    const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    const silent = new Audio(url);
    silent.volume = 0;
    silent.onended = () => URL.revokeObjectURL(url);
    void silent.play().catch(() => {
      URL.revokeObjectURL(url);
    });
  } catch {
    /* voice output is best-effort */
  }
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
/** A seamless sentence chain is playing: browser utterance ends defer. */
let seamlessChainActive = false;
/** No chain sentence fell back to the browser voice mid-reply. */
let seamlessClean = true;

export function stopSeamlessSpeech(): void {
  seamlessPlayId += 1;
  seamlessChainActive = false;
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
    seamlessClean = false;
    sayBrowserFallback(sentence, language, false);
    onDone();
    return;
  }
  if (!response.ok || playId !== seamlessPlayId) {
    if (!response.ok && playId === seamlessPlayId) {
      seamlessClean = false;
      sayBrowserFallback(sentence, language, false);
    }
    onDone();
    return;
  }
  let clearSentenceAudio = (): void => {};
  try {
    const blob = await response.blob();
    if (playId !== seamlessPlayId) {
      onDone();
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    seamlessAudio = audio;
    let audioDone = false;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    clearSentenceAudio = (): void => {
      if (audioDone) return;
      audioDone = true;
      clearTimeout(watchdog);
      if (progressTimer !== undefined) clearInterval(progressTimer);
      try {
        audio.pause();
      } catch {
        /* already stopped */
      }
      URL.revokeObjectURL(url);
      if (seamlessAudio === audio) seamlessAudio = null;
    };
    // Mid-play freeze (element stops advancing with no event): a few
    // seconds of still audio ends the sentence instead of holding it.
    // A pause never counts as stillness; the end watchdog caps the total.
    let playStarted = false;
    let lastTime = 0;
    let stillCount = 0;
    progressTimer = setInterval(() => {
      if (audioDone || !playStarted) return;
      try {
        if (audio.ended || audio.seeking || audio.paused) {
          stillCount = 0;
          lastTime = audio.currentTime;
          return;
        }
        if (audio.readyState < 2) return;
        if (audio.currentTime === lastTime) stillCount += 1;
        else {
          stillCount = 0;
          lastTime = audio.currentTime;
        }
        if (stillCount >= 3) {
          emitSpeechEvent("sentence-still", `t=${lastTime.toFixed(1)}`);
          endSentence();
        }
      } catch {
        /* read-only probe, never breaks playback */
      }
    }, 1000);
    // iOS can drop onended: without this the reply holds the mic
    // forever (mute clears it, which is why mute unblocked the field).
    // next() ignores a stale playId, so forcing the end is safe.
    const watchdog = setTimeout(() => {
      emitSpeechEvent("sentence-timeout", `t=${audio.currentTime.toFixed(1)}`);
      clearSentenceAudio();
      onDone();
    }, estimateSpeechMs(sentence, 1) + SEAMLESS_SENTENCE_GRACE_MS);
    const endSentence = (): void => {
      clearSentenceAudio();
      onDone();
    };
    audio.onended = () => {
      emitSpeechEvent("sentence-event", `t=${audio.currentTime.toFixed(1)}`);
      endSentence();
    };
    audio.onerror = () => {
      emitSpeechEvent("sentence-error", `t=${audio.currentTime.toFixed(1)}`);
      endSentence();
    };
    await audio.play();
    playStarted = true;
  } catch {
    emitSpeechEvent("sentence-fetch-fail");
    clearSentenceAudio();
    if (playId === seamlessPlayId) {
      seamlessClean = false;
      sayBrowserFallback(sentence, language, false);
    }
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
  beginSpeechBatch();
  seamlessChainActive = true;
  seamlessClean = true;
  expectSpeech(text, 1);
  const playId = seamlessPlayId;
  const sentences = splitSentences(text);
  if (sentences.length === 0) return;
  let index = 0;
  const next = (): void => {
    if (playId !== seamlessPlayId) return;
    if (index >= sentences.length) {
      // The last audio ended: settle at the real end. A chain with a
      // browser fallback still owes its voice, so it settles itself.
      seamlessChainActive = false;
      if (seamlessClean) noteSpeechEnd();
      return;
    }
    const sentence = sentences[index];
    index += 1;
    void playSentence(playId, sentence, language, next);
  };
  next();
}

/**
 * Seamless failed: the browser voice says it instead of silence. A
 * fallback continues the same reply; only a fresh call starts a batch.
 */
function sayBrowserFallback(
  text: string,
  language: ValeLanguage = DEFAULT_LANGUAGE,
  fresh = true,
): void {
  const s = synth();
  if (!s) return;
  const sentences = splitSentences(text);
  if (sentences.length === 0) return;
  if (!fresh) {
    void ensureVoices(s).then((late) =>
      queueBrowserSentences(s, sentences, late, language),
    );
    return;
  }
  beginSpeechBatch();
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
    const prosody = prosodyForVoice(voice, language);
    for (const sentence of sentences) {
      const clean = spokenText(sentence, language);
      if (clean === "") continue;
      expectSpeech(clean, prosody.rate);
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.rate = prosody.rate;
      utterance.pitch = prosody.pitch;
      utterance.lang = voice?.lang ?? FALLBACK_LANG[language];
      if (voice) utterance.voice = voice;
      // The real end settles the mic: each utterance releases once, and a
      // cancelled batch never settles the reply that replaced it.
      const gen = speechGen;
      let owed = true;
      const release = (): void => {
        if (!owed || gen !== speechGen) return;
        owed = false;
        pendingUtterances = Math.max(0, pendingUtterances - 1);
        if (pendingUtterances === 0 && !seamlessChainActive) noteSpeechEnd();
      };
      utterance.onend = release;
      utterance.onerror = release;
      // iOS pauses speech on session interruptions with no end event:
      // reclaim it at once instead of holding the queue behind it.
      utterance.onpause = () => {
        try {
          s.resume();
        } catch {
          /* best-effort; the timeout watchdog still frees accounting */
        }
      };
      pendingUtterances += 1;
      s.speak(utterance);
      // iOS can cut an utterance with no event: the queue stalls behind
      // it and the mic stays shut. Past estimate + grace the accounting
      // releases (never the audio itself), so the rest still speaks.
      setTimeout(() => {
        if (!owed || gen !== speechGen) return;
        emitSpeechEvent("utterance-timeout");
        release();
      }, estimateSpeechMs(clean, prosody.rate) + SEAMLESS_SENTENCE_GRACE_MS);
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
  beginSpeechBatch();
  stopSeamlessSpeech();
  try {
    synth()?.cancel();
  } catch {
    /* nothing playing or nothing to stop */
  }
  // A cut voice is a real end too: the mic reopens at once.
  noteSpeechEnd();
}

/**
 * Speech-end estimate from the reply length: real TTS lands near 70-80
 * ms/char, so 150 ms/char plus margin never cuts real speech — it only
 * releases a mic stuck on a voice that never reports its end (missing
 * onend, a wedged queue). Unit-tested; the field proves it per turn.
 */
export const SPEECH_MS_PER_CHAR = 150;
export const SPEECH_END_MARGIN_MS = 2500;
/** Per-sentence grace past the estimate before a missing onended is forced. */
export const SEAMLESS_SENTENCE_GRACE_MS = 5000;

/** Speech-path telemetry for the field: drained by the UI into client-state. */
export interface SpeechEvent {
  kind: string;
  detail: string;
}
const speechEvents: SpeechEvent[] = [];
function emitSpeechEvent(kind: string, detail = ""): void {
  speechEvents.push({ kind, detail });
  if (speechEvents.length > 20) speechEvents.shift();
}
export function drainSpeechEvents(): SpeechEvent[] {
  return speechEvents.splice(0);
}

/** When the queued reply should be over, worst case. 0 means nothing queued. */
let speechDueUntil = 0;
/** Replies started: stale utterance ends never settle a newer reply. */
let speechGen = 0;
/** Browser utterances owed their voice; seamless chains track separately. */
let pendingUtterances = 0;
/** The synth spoke since the last settle: quiet now means the real end. */
let heardAudible = false;
/** Mic-reopen callbacks, fired once per real end (never on the estimate). */
const settleListeners = new Set<() => void>();

/** A new reply owns the mic accounting; stale ends belong to the old one. */
function beginSpeechBatch(): void {
  speechGen += 1;
  speechDueUntil = 0;
  pendingUtterances = 0;
  heardAudible = false;
}

/** The voice really ended: settle now and reopen every waiting mic. */
function noteSpeechEnd(): void {
  speechDueUntil = 0;
  pendingUtterances = 0;
  heardAudible = false;
  for (const listener of [...settleListeners]) {
    try {
      listener();
    } catch {
      /* a bad listener never holds the mic */
    }
  }
}

/** Run when her voice really ends (not on the estimate); returns release. */
export function onSpeechSettled(listener: () => void): () => void {
  settleListeners.add(listener);
  return () => {
    settleListeners.delete(listener);
  };
}

export function estimateSpeechMs(text: string, rate = 1): number {
  const chars = text.replace(/\s+/g, " ").trim().length;
  if (chars === 0) return 0;
  return (
    Math.ceil((chars * SPEECH_MS_PER_CHAR) / Math.max(rate, 0.1)) +
    SPEECH_END_MARGIN_MS
  );
}

/** Note queued speech so a stuck voice still releases the mic on time. */
export function expectSpeech(text: string, rate = 1): void {
  const ms = estimateSpeechMs(text, rate);
  if (ms > 0) speechDueUntil = Date.now() + ms;
}

/** True when no voice is audible and no reply is owed: safe to re-listen. */
export function speechSettled(): boolean {
  if (isSpeaking()) {
    heardAudible = true;
    return false;
  }
  // Quiet after audible: the real end, even with no end event. The
  // estimate below stays the cap for a voice that never sounded at all.
  if (heardAudible) noteSpeechEnd();
  return speechDueUntil === 0 || Date.now() >= speechDueUntil;
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
