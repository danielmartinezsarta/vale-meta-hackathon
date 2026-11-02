import { BRAND } from "./brand-tokens";

/**
 * Home screen day/night values from the design reference. Brand hues come
 * from BRAND (no duplicated hex); only the reference's own surface tones
 * stay literal.
 */

export type HomeMode = "day" | "night";

const c = BRAND.color;

const DAY: Record<string, string> = {
  "--vs-bg": "#D5E0FF",
  "--vs-card": "#FFFFFF",
  "--vs-line": "#B9C8F5",
  "--vs-fg": c.night,
  "--vs-muted": "#505B7E",
  "--vs-logo": c.night,
  "--vs-goal1": c.night,
  "--vs-goal2": c.blue,
  "--vs-fab": "#FFFFFF",
  "--vs-fabline": "#B9C8F5",
  "--vs-t1": "rgba(47,91,255,.16)",
  "--vs-t2": "rgba(24,184,224,.22)",
  "--vs-t3": "rgba(230,50,155,.14)",
  "--vs-a1": c.blue,
  "--vs-a1bg": "rgba(47,91,255,.12)",
  "--vs-a2": "#0A8FB3",
  "--vs-a2bg": "rgba(24,184,224,.18)",
  "--vs-a3": "#D12A8A",
  "--vs-a3bg": "rgba(230,50,155,.12)",
};

const NIGHT: Record<string, string> = {
  "--vs-bg": c.night,
  "--vs-card": "#22347C",
  "--vs-line": "#3A4E9C",
  "--vs-fg": c.mist,
  "--vs-muted": "#B4BFE6",
  "--vs-logo": c.mist,
  "--vs-goal1": c.blue,
  "--vs-goal2": c.magenta,
  "--vs-fab": "#22347C",
  "--vs-fabline": "#3A4E9C",
  "--vs-t1": "rgba(143,169,255,.14)",
  "--vs-t2": "rgba(127,221,235,.16)",
  "--vs-t3": "rgba(255,107,190,.14)",
  "--vs-a1": c.blueLight,
  "--vs-a1bg": "rgba(143,169,255,.16)",
  "--vs-a2": c.cyanLight,
  "--vs-a2bg": "rgba(127,221,235,.16)",
  "--vs-a3": c.magentaLight,
  "--vs-a3bg": "rgba(255,107,190,.16)",
};

/** Custom properties for one home mode, spread onto the screen root style. */
export function homeVars(mode: HomeMode): Record<string, string> {
  return mode === "night" ? { ...NIGHT } : { ...DAY };
}
