// Relative-date helper for the demo seed (HACK-024). The demo agenda is
// always "today", so the seed resolves day markers on the salon clock
// (America/Bogota, same as the tools) instead of storing fixed dates.
// HACK-005 extends the JSON markers on top of this helper; keep the
// marker set ("today", "tomorrow", plain YYYY-MM-DD) stable.
// Server-side only like the rest of the seed; never import from client code.
import { bogotaDay } from "./natural-date";

/**
 * Bogota YYYY-MM-DD shifted by a day offset. Same salon clock as the
 * tools, so a seeded "today" is the tools' today on every machine.
 */
export function seedDay(offsetDays = 0, when = new Date()): string {
  const [year, month, day] = bogotaDay(when).split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1, day, 12));
  const next = new Date(base.getTime() + offsetDays * 86_400_000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Resolve a demo day marker ("today", "tomorrow") to a local YYYY-MM-DD. */
export function resolveSeedDay(day: string, when = new Date()): string {
  if (day === "today") return seedDay(0, when);
  if (day === "tomorrow") return seedDay(1, when);
  return day;
}
