/**
 * Closed language set for Vale: Spanish or English, picked on screen.
 * Client-safe: no server imports, so TapToTalk can use it too.
 */

export type ValeLanguage = "es" | "en";

export const DEFAULT_LANGUAGE: ValeLanguage = "en";

/** Persisted screen language: the menu selector survives reloads, EN default. */
const LANGUAGE_KEY = "vale-language";

export function storedLanguage(): ValeLanguage {
  try {
    return window.localStorage.getItem(LANGUAGE_KEY) === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

export function storeLanguage(next: ValeLanguage): void {
  try {
    window.localStorage.setItem(LANGUAGE_KEY, next);
  } catch {
    /* private mode: the session still switches for this visit */
  }
  try {
    window.dispatchEvent(new CustomEvent<ValeLanguage>("vale-language", { detail: next }));
  } catch {
    /* the next turn carries the language frame instead */
  }
}

/** Unknown or missing values fall back to English; the set stays closed. */
export function parseLanguage(value: unknown): ValeLanguage {
  return value === "es" ? "es" : "en";
}

export type VoiceErrorKind =
  | "setup"
  | "timeout"
  | "lost"
  | "model"
  | "suspended";

const ERROR_TEXT: Record<VoiceErrorKind, Record<ValeLanguage, string>> = {
  setup: {
    es: "La voz no está configurada.",
    en: "Voice is not set up.",
  },
  timeout: {
    es: "Se agotó el turno de voz.",
    en: "The voice turn ran out.",
  },
  lost: {
    es: "Se perdió la conexión.",
    en: "Connection lost.",
  },
  model: {
    es: "Tuve un problema.",
    en: "Something went wrong.",
  },
  suspended: {
    es: "El micrófono no arrancó.",
    en: "Microphone didn't start.",
  },
};

/** User-facing turn error in the selected language. */
export function turnErrorText(
  kind: VoiceErrorKind,
  language: ValeLanguage = DEFAULT_LANGUAGE,
): string {
  return ERROR_TEXT[kind][language];
}

/** Tapping No on a confirm card: the spoken equivalent of saying no. */
export function declineText(language: ValeLanguage = DEFAULT_LANGUAGE): string {
  return language === "es" ? "Vale, no lo guardo." : "OK, I won't save it.";
}

/** A yes with nothing pending: ask what to confirm instead of writing. */
export function clarifyText(language: ValeLanguage = DEFAULT_LANGUAGE): string {
  return language === "es"
    ? "¿Qué quieres que confirme?"
    : "What would you like me to confirm?";
}
