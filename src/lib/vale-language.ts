/**
 * Closed language set for Vale: Spanish or English, picked on screen.
 * Client-safe: no server imports, so TapToTalk can use it too.
 */

export type ValeLanguage = "es" | "en";

export const DEFAULT_LANGUAGE: ValeLanguage = "es";

/** Unknown or missing values fall back to Spanish; the set stays closed. */
export function parseLanguage(value: unknown): ValeLanguage {
  return value === "en" ? "en" : "es";
}

export type VoiceErrorKind =
  | "setup"
  | "timeout"
  | "lost"
  | "model"
  | "vad-tap"
  | "vad-continue";

const ERROR_TEXT: Record<VoiceErrorKind, Record<ValeLanguage, string>> = {
  setup: {
    es: "La voz no está configurada. Intenta de nuevo más tarde.",
    en: "Voice is not set up. Try again later.",
  },
  timeout: {
    es: "El turno de voz se agotó. Toca para intentar de nuevo.",
    en: "The voice turn ran out. Tap to try again.",
  },
  lost: {
    es: "Se perdió la conexión. Toca para intentar de nuevo.",
    en: "The connection dropped. Tap to try again.",
  },
  model: {
    es: "Perdón, tuve un problema. Toca para intentar de nuevo.",
    en: "Sorry, I had a problem. Tap to try again.",
  },
  "vad-tap": {
    es: "No te escuché. Toca y habla.",
    en: "I didn't hear you. Tap and speak.",
  },
  "vad-continue": {
    es: "No te escuché. Habla y te escucho.",
    en: "I didn't hear you. Speak, I'm listening.",
  },
};

/** User-facing turn error in the selected language. */
export function turnErrorText(
  kind: VoiceErrorKind,
  language: ValeLanguage = DEFAULT_LANGUAGE,
): string {
  return ERROR_TEXT[kind][language];
}
