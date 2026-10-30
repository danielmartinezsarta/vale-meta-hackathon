/**
 * Voice output: browser speech synthesizer by default, Seamless TTS by switch.
 * Silent no-op without the web APIs; the text always stays on screen.
 */

import { DEFAULT_LANGUAGE, type ValeLanguage } from "./vale-language";

const VOICE_PRIORITY: Record<ValeLanguage, string[]> = {
  es: ["es-CO", "es-419", "es-MX"],
  en: ["en-US", "en"],
};
const FALLBACK_LANG: Record<ValeLanguage, string> = { es: "es-CO", en: "en-US" };
export const SEAMLESS_SPEAKER = 10;
const SEAMLESS_MAX_CHARS = 500;
const VOICES_WAIT_MS = 1000;

export type VoiceEngine = "browser" | "seamless";

let engine: VoiceEngine = "browser";

/** Switch the output engine at runtime; switch back with "browser". */
export function setVoiceEngine(next: VoiceEngine): void {
  engine = next;
  stopSeamlessSpeech();
}

export function voiceEngine(): VoiceEngine {
  return engine;
}

export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  language: ValeLanguage = DEFAULT_LANGUAGE,
): SpeechSynthesisVoice | null {
  for (const prefix of VOICE_PRIORITY[language]) {
    const found = voices.find((voice) =>
      voice.lang.toLowerCase().startsWith(prefix.toLowerCase()),
    );
    if (found) return found;
  }
  const short = language === "en" ? "en" : "es";
  return (
    voices.find((voice) => voice.lang.toLowerCase().startsWith(short)) ?? null
  );
}

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

/**
 * Browser voices load asynchronously: getVoices() is often empty on the
 * first call, which used to speak with no voice at all. Wait for them.
 */
function ensureVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const available = synth.getVoices();
  if (available.length > 0) return Promise.resolve(available);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(synth.getVoices());
    };
    const timer = setTimeout(finish, VOICES_WAIT_MS);
    try {
      synth.addEventListener(
        "voiceschanged",
        () => {
          clearTimeout(timer);
          finish();
        },
        { once: true },
      );
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

function sayWithBrowser(
  synth: SpeechSynthesis,
  text: string,
  voices: readonly SpeechSynthesisVoice[],
  language: ValeLanguage = DEFAULT_LANGUAGE,
): void {
  try {
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    const voice = pickVoice(voices, language);
    utterance.lang = voice?.lang ?? FALLBACK_LANG[language];
    if (voice) utterance.voice = voice;
    synth.speak(utterance);
  } catch {
    /* voice output is best-effort; the text stays on screen */
  }
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

async function playSeamless(
  text: string,
  language: ValeLanguage = DEFAULT_LANGUAGE,
): Promise<void> {
  stopSeamlessSpeech();
  const playId = seamlessPlayId;
  let response: Response;
  try {
    response = await fetch(
      `/api/seamless-voice?speaker=${SEAMLESS_SPEAKER}&text=${encodeURIComponent(text.slice(0, SEAMLESS_MAX_CHARS))}`,
    );
  } catch {
    sayBrowserFallback(text, language);
    return;
  }
  if (!response.ok || playId !== seamlessPlayId) {
    if (response.ok) return;
    sayBrowserFallback(text, language);
    return;
  }
  try {
    const blob = await response.blob();
    if (playId !== seamlessPlayId) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    seamlessAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (seamlessAudio === audio) seamlessAudio = null;
    };
    await audio.play();
  } catch {
    sayBrowserFallback(text, language);
  }
}

/** Seamless failed: the browser voice says it instead of silence. */
function sayBrowserFallback(
  text: string,
  language: ValeLanguage = DEFAULT_LANGUAGE,
): void {
  const s = synth();
  if (!s) return;
  void ensureVoices(s).then((voices) => sayWithBrowser(s, text, voices, language));
}

export function speak(
  text: string,
  language: ValeLanguage = DEFAULT_LANGUAGE,
): void {
  if (text.trim() === "") return;
  if (engine === "seamless") {
    // The demo speaker is fixed; the reply text itself stays in the
    // selected language, so Seamless never invents another one.
    void playSeamless(text, language);
    return;
  }
  const s = synth();
  if (!s) return;
  const voices = s.getVoices();
  if (voices.length > 0) {
    sayWithBrowser(s, text, voices, language);
    return;
  }
  void ensureVoices(s).then((late) => sayWithBrowser(s, text, late, language));
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
