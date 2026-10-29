/**
 * Voice output through the browser speech synthesizer.
 * Neutral Spanish, Colombian voice first; silent no-op without the API.
 * Provider seam: a future Meta TTS backend plugs in behind
 * speak/stopSpeaking without changing callers.
 */

const VOICE_PRIORITY = ["es-CO", "es-419", "es-MX"];

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  for (const prefix of VOICE_PRIORITY) {
    const found = voices.find((voice) =>
      voice.lang.toLowerCase().startsWith(prefix.toLowerCase()),
    );
    if (found) return found;
  }
  return (
    voices.find((voice) => voice.lang.toLowerCase().startsWith("es")) ?? null
  );
}

export function speak(text: string): void {
  const s = synth();
  if (!s || text.trim() === "") return;
  try {
    s.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    const voice = pickVoice(s.getVoices());
    utterance.lang = voice?.lang ?? "es-CO";
    if (voice) utterance.voice = voice;
    s.speak(utterance);
  } catch {
    /* voice output is best-effort; the text stays on screen */
  }
}

export function stopSpeaking(): void {
  try {
    synth()?.cancel();
  } catch {
    /* nothing playing or nothing to stop */
  }
}
