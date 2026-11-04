/** Session stopwatch: HH:MM:SS from the table's start. */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function sessionClock(startedAt: string, now: number): string {
  const parsed = Date.parse(startedAt);
  const seconds = Number.isFinite(parsed)
    ? Math.max(0, Math.floor((now - parsed) / 1000))
    : 0;
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}
