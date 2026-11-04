import { BRAND } from "./brand-tokens";

/**
 * Home screen day/night values from the design reference. Brand hues come
 * from BRAND (no duplicated hex); only the reference's own surface tones
 * stay literal.
 */

export type HomeMode = "day" | "night";

const c = BRAND.color;

/** Day surfaces shared by the home and awake screens: one literal each. */
const SURF_DAY = {
  bg: "#D5E0FF",
  card: "#FFFFFF",
  line: "#B9C8F5",
  muted: "#505B7E",
  t1: "rgba(47,91,255,.16)",
  t2: "rgba(24,184,224,.22)",
  t3: "rgba(230,50,155,.14)",
  a3: "#D12A8A",
  a3bg: "rgba(230,50,155,.12)",
};

/** Night surfaces shared by the home and awake screens. */
const SURF_NIGHT = {
  bg: c.night,
  card: "#22347C",
  line: "#3A4E9C",
  muted: "#B4BFE6",
  t1: "rgba(143,169,255,.14)",
  t2: "rgba(127,221,235,.16)",
  t3: "rgba(255,107,190,.14)",
  a3: c.magentaLight,
};

const DAY: Record<string, string> = {
  "--vs-bg": SURF_DAY.bg,
  "--vs-card": SURF_DAY.card,
  "--vs-line": SURF_DAY.line,
  "--vs-fg": c.night,
  "--vs-muted": SURF_DAY.muted,
  "--vs-logo": c.night,
  "--vs-goal1": c.night,
  "--vs-goal2": c.blue,
  "--vs-fab": SURF_DAY.card,
  "--vs-fabline": SURF_DAY.line,
  "--vs-t1": SURF_DAY.t1,
  "--vs-t2": SURF_DAY.t2,
  "--vs-t3": SURF_DAY.t3,
  "--vs-a1": c.blue,
  "--vs-a1bg": "rgba(47,91,255,.12)",
  "--vs-a2": "#0A8FB3",
  "--vs-a2bg": "rgba(24,184,224,.18)",
  "--vs-a3": SURF_DAY.a3,
  "--vs-a3bg": SURF_DAY.a3bg,
};

const NIGHT: Record<string, string> = {
  "--vs-bg": SURF_NIGHT.bg,
  "--vs-card": SURF_NIGHT.card,
  "--vs-line": SURF_NIGHT.line,
  "--vs-fg": c.mist,
  "--vs-muted": SURF_NIGHT.muted,
  "--vs-logo": c.mist,
  "--vs-goal1": c.blue,
  "--vs-goal2": c.magenta,
  "--vs-fab": SURF_NIGHT.card,
  "--vs-fabline": SURF_NIGHT.line,
  "--vs-t1": SURF_NIGHT.t1,
  "--vs-t2": SURF_NIGHT.t2,
  "--vs-t3": SURF_NIGHT.t3,
  "--vs-a1": c.blueLight,
  "--vs-a1bg": "rgba(143,169,255,.16)",
  "--vs-a2": c.cyanLight,
  "--vs-a2bg": "rgba(127,221,235,.16)",
  "--vs-a3": SURF_NIGHT.a3,
  "--vs-a3bg": "rgba(255,107,190,.16)",
};

/** Night accent wash, awake screens only: differs from the home one. */
const AW_A3BG_NIGHT = "rgba(255,107,190,.18)";

/** Custom properties for one home mode, spread onto the screen root style. */
export function homeVars(mode: HomeMode): Record<string, string> {
  return mode === "night" ? { ...NIGHT } : { ...DAY };
}

const AW_DAY: Record<string, string> = {
  "--aw-bg": SURF_DAY.bg,
  "--aw-card": SURF_DAY.card,
  "--aw-line": SURF_DAY.line,
  "--aw-fg": c.night,
  "--aw-muted": SURF_DAY.muted,
  "--aw-user": c.blue,
  "--aw-sheet": SURF_DAY.card,
  "--aw-field-line": SURF_DAY.line,
  "--aw-link": c.blue,
  "--aw-ok": c.blue,
  "--aw-on-ok": SURF_DAY.card,
  "--aw-a1": c.blue,
  "--aw-a1bg": "rgba(47,91,255,.12)",
  "--aw-a2": "#0A8FB3",
  "--aw-a3": SURF_DAY.a3,
  "--aw-a3bg": SURF_DAY.a3bg,
  "--aw-t1": SURF_DAY.t1,
  "--aw-t2": SURF_DAY.t2,
  "--aw-t3": SURF_DAY.t3,
};

const AW_NIGHT: Record<string, string> = {
  "--aw-bg": SURF_NIGHT.bg,
  "--aw-card": SURF_NIGHT.card,
  "--aw-line": SURF_NIGHT.line,
  "--aw-fg": c.mist,
  "--aw-muted": SURF_NIGHT.muted,
  "--aw-user": c.blue,
  "--aw-sheet": "#2F4283",
  "--aw-field-line": "#5B71BC",
  "--aw-link": "#9CC7FF",
  "--aw-ok": "#A6CEFF",
  "--aw-on-ok": c.night,
  "--aw-a1": c.blueLight,
  "--aw-a1bg": "rgba(143,169,255,.18)",
  "--aw-a2": c.cyanLight,
  "--aw-a3": SURF_NIGHT.a3,
  "--aw-a3bg": AW_A3BG_NIGHT,
  "--aw-t1": SURF_NIGHT.t1,
  "--aw-t2": SURF_NIGHT.t2,
  "--aw-t3": SURF_NIGHT.t3,
};

/** Custom properties for the awake/session screens, one mode. */
export function valeVars(mode: HomeMode): Record<string, string> {
  return mode === "night" ? { ...AW_NIGHT } : { ...AW_DAY };
}
