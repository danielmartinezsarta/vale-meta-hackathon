// Relative-date helper for scripts/seed.mjs (HACK-024). Plain-JS mirror of
// src/lib/seed-dates.ts (the CLI seed runs under plain node, no tsx): keep
// both implementations identical. The JSON day markers extend on
// top of this helper; keep the marker set stable.
function bogotaDay(when = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

const pad = (value) => String(value).padStart(2, "0");

export function seedDay(offsetDays = 0, when = new Date()) {
  const [year, month, day] = bogotaDay(when).split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1, day, 12));
  const next = new Date(base.getTime() + offsetDays * 86_400_000);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export function resolveSeedDay(day, when = new Date()) {
  if (day === "today") return seedDay(0, when);
  if (day === "tomorrow") return seedDay(1, when);
  return day;
}

// Relative birthday: mirror of src/lib/seed-dates.ts. Month and
// day from an offset off today, fixed birth year, clamped to the month.
export function seedBirthday(inDays, year, when = new Date()) {
  const [, month, day] = seedDay(inDays, when).split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
}
