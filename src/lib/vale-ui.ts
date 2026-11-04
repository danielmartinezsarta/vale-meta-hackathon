import type { ValeLanguage } from "./vale-language";
import type { ValeState } from "./vale-state";

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
  theme: string;
  lightMode: string;
  darkMode: string;
  sessionNow: string;
  session: string;
  noSessionOpen: string;
  noNotes: string;
  privateNote: string;
  shoppingList: string;
  emptyList: string;
  micBlockedLead: string;
  micBlockedIPhone: string;
  micBlockedChrome: string;
  micError: string;
  settings: string;
  voiceEngine: string;
  browserVoice: string;
  seamlessVoice: string;
  seamlessUnavailable: string;
  seamlessEnableHint: string;
  tryAgain: string;
  cardFor: (name: string) => string;
  valeState: (state: ValeStateName) => string;
  greetingMorning: string;
  greetingAfternoon: string;
  greetingEvening: string;
  homeToday: string;
  homeSupplies: string;
  homeMonthlyGoal: string;
  homeLoading: string;
  homeEmptyToday: string;
  menuAgenda: string;
  menuClientFiles: string;
  menuServices: string;
  menuSuppliesStock: string;
  menuPayments: string;
  menuGoals: string;
  menuPreferences: string;
}

/** The six Vale states the robot can show: the single state union. */
export type ValeStateName = ValeState;

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
  theme: "Theme",
  lightMode: "Light",
  darkMode: "Dark",
  sessionNow: "Session in progress",
  session: "Session",
  noSessionOpen: "No open session.",
  noNotes: "No notes.",
  privateNote: "private note 🔒",
  shoppingList: "Shopping list",
  emptyList: "The list is empty.",
  micBlockedLead:
    "Your microphone is blocked, so I can't hear you. To turn it back on:",
  micBlockedIPhone:
    "iPhone (Safari): open Settings > Safari > Microphone and choose Allow, then reload.",
  micBlockedChrome:
    "Chrome: tap the lock (or tune) icon left of the address bar, choose Microphone > Allow, then reload.",
  micError:
    "Something went wrong with the microphone. Check that one is connected and reload.",
  settings: "Settings",
  voiceEngine: "Voice",
  browserVoice: "Browser",
  seamlessVoice: "Seamless (open model)",
  seamlessUnavailable: "Seamless voice is not configured.",
  seamlessEnableHint:
    "To enable Seamless TTS, set SEAMLESS_URL and SEAMLESS_TOKEN in .env.",
  tryAgain: "Try again",
  cardFor: (name: string) => `${name}'s card`,
  greetingMorning: "Good morning",
  greetingAfternoon: "Good afternoon",
  greetingEvening: "Good evening",
  homeToday: "Today",
  homeSupplies: "Supplies to buy",
  homeMonthlyGoal: "Monthly goal",
  homeLoading: "Loading…",
  homeEmptyToday: "Nothing on the books.",
  menuAgenda: "Agenda",
  menuClientFiles: "Client files",
  menuServices: "Services",
  menuSuppliesStock: "Supplies & stock",
  menuPayments: "Payments",
  menuGoals: "Goals",
  menuPreferences: "Preferences",
  valeState: (state: ValeStateName) =>
    ({
      idle: "Idle",
      listening: "Listening",
      thinking: "Thinking",
      speaking: "Speaking",
      done: "Done",
      error: "Something is wrong",
    })[state],
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
  theme: "Tema",
  lightMode: "Claro",
  darkMode: "Oscuro",
  sessionNow: "Sesión en curso",
  session: "Sesión",
  noSessionOpen: "Sin sesión abierta.",
  noNotes: "Sin notas.",
  privateNote: "nota privada 🔒",
  shoppingList: "Lista de compras",
  emptyList: "La lista está vacía.",
  micBlockedLead:
    "Tu micrófono está bloqueado, así que no puedo oírte. Para reactivarlo:",
  micBlockedIPhone:
    "iPhone (Safari): abre Ajustes > Safari > Micrófono y elige Permitir, luego recarga.",
  micBlockedChrome:
    "Chrome: toca el candado (o el icono de ajuste) junto a la barra de direcciones, elige Micrófono > Permitir, luego recarga.",
  micError:
    "Algo falló con el micrófono. Revisa que haya uno conectado y recarga.",
  settings: "Ajustes",
  voiceEngine: "Voz",
  browserVoice: "Navegador",
  seamlessVoice: "Seamless (modelo abierto)",
  seamlessUnavailable: "La voz Seamless no está configurada.",
  seamlessEnableHint:
    "Para activar Seamless TTS, configura SEAMLESS_URL y SEAMLESS_TOKEN en .env.",
  tryAgain: "Inténtalo de nuevo",
  cardFor: (name: string) => `Ficha de ${name}`,
  greetingMorning: "Buenos días",
  greetingAfternoon: "Buenas tardes",
  greetingEvening: "Buenas noches",
  homeToday: "Hoy",
  homeSupplies: "Materiales por comprar",
  homeMonthlyGoal: "Meta mensual",
  homeLoading: "Cargando…",
  homeEmptyToday: "Sin citas hoy.",
  menuAgenda: "Agenda",
  menuClientFiles: "Fichas de clientes",
  menuServices: "Servicios",
  menuSuppliesStock: "Materiales y stock",
  menuPayments: "Pagos",
  menuGoals: "Metas",
  menuPreferences: "Preferencias",
  valeState: (state: ValeStateName) =>
    ({
      idle: "Inactiva",
      listening: "Escuchando",
      thinking: "Pensando",
      speaking: "Hablando",
      done: "Listo",
      error: "Algo falla",
    })[state],
};

/** Every interface string in the screen language. */
export function uiStrings(language: ValeLanguage = "en"): UiStrings {
  return language === "es" ? ES : EN;
}
