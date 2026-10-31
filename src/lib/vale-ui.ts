import type { ValeLanguage } from "./vale-language";

/**
 * Interface dictionary: every chrome string on screen, keyed once.
 * Data (names, notes, list items) is never translated; only the frame.
 */

export interface UiStrings {
  tapToTalk: string;
  stop: string;
  waiting: string;
  listenHint: string;
  ignoredTag: string;
  voice: string;
  speed: string;
  pitch: string;
  test: string;
  systemDefault: string;
  language: string;
  sessionNow: string;
  session: string;
  noSessionOpen: string;
  noNotes: string;
  privateNote: string;
  shoppingList: string;
  emptyList: string;
  micBlockedLead: string;
  micError: string;
  cardFor: (name: string) => string;
}

const EN: UiStrings = {
  tapToTalk: "Tap to talk",
  stop: "Stop",
  waiting: "Waiting for permission…",
  listenHint: "Your microphone is on. Go ahead, I'm listening.",
  ignoredTag: "ignored (no name)",
  voice: "Voice",
  speed: "Speed",
  pitch: "Pitch",
  test: "Test",
  systemDefault: "System default",
  language: "Language",
  sessionNow: "Session in progress",
  session: "Session",
  noSessionOpen: "No open session.",
  noNotes: "No notes.",
  privateNote: "private note 🔒",
  shoppingList: "Shopping list",
  emptyList: "The list is empty.",
  micBlockedLead:
    "Your microphone is blocked, so I can't hear you. To turn it back on:",
  micError:
    "Something went wrong with the microphone. Check that one is connected and tap again.",
  cardFor: (name: string) => `${name}'s card`,
};

const ES: UiStrings = {
  tapToTalk: "Toca para hablar",
  stop: "Detener",
  waiting: "Esperando permiso…",
  listenHint: "Tu micrófono está encendido. Adelante, te escucho.",
  ignoredTag: "ignorado (sin nombre)",
  voice: "Voz",
  speed: "Velocidad",
  pitch: "Tono",
  test: "Probar",
  systemDefault: "Voz del sistema",
  language: "Idioma",
  sessionNow: "Sesión en curso",
  session: "Sesión",
  noSessionOpen: "Sin sesión abierta.",
  noNotes: "Sin notas.",
  privateNote: "nota privada 🔒",
  shoppingList: "Lista de compras",
  emptyList: "La lista está vacía.",
  micBlockedLead:
    "Tu micrófono está bloqueado, así que no puedo oírte. Para reactivarlo:",
  micError:
    "Algo falló con el micrófono. Revisa que haya uno conectado y toca de nuevo.",
  cardFor: (name: string) => `Ficha de ${name}`,
};

/** Every interface string in the screen language. */
export function uiStrings(language: ValeLanguage = "en"): UiStrings {
  return language === "es" ? ES : EN;
}
