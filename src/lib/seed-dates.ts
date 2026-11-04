// Relative-date helper for the demo seed (HACK-024). The demo agenda is
// always "today", so the seed resolves day markers on the salon clock
// (America/Bogota, same as the tools) instead of storing fixed dates.
// The JSON markers extend on top of this helper; keep the
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

/**
 * Relative birthday: month and day from an offset off today, with
 * a fixed birth year, so the birthday is always that many days out. The
 * day clamps to the month length (Feb 29 never lands on a common year).
 */
export function seedBirthday(inDays: number, year: number, when = new Date()): string {
  const [, month, day] = seedDay(inDays, when).split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
}
