// Fold a chosen live run into the committed replay file (HACK-024):
//   npm run replay:from-logs -- --since <ISO time> [--until <ISO time>]
//
// Reads data/logs/*.jsonl (voice and typed turns alike), keeps the rows in
// the window, and writes the same replay shape the recorder produces.
// Pure file fold: no Meta calls, and replies ride through verbatim — never
// hand-edit replay content, rebuild the run instead.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReplayRun } from "../src/lib/replay";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function usage(): never {
  console.error("usage: replay:from-logs --since <ISO time> [--until <ISO time>] [--logs <dir>] [--out <file>]");
  process.exit(1);
}

function parseTime(value: string | null, name: string): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    console.error(`[replay:from-logs] cannot parse ${name}: ${value}`);
    process.exit(1);
  }
  return ms;
}

const since = parseTime(argValue("--since"), "--since");
if (since === null) usage();
const until = parseTime(argValue("--until"), "--until");
const logsDir = (() => {
  const override = argValue("--logs");
  if (!override) return join(root, "data", "logs");
  return isAbsolute(override) ? override : join(root, override);
})();
const outFile = (() => {
  const override = argValue("--out");
  if (!override) return join(root, "replay", "demo-run.json");
  return isAbsolute(override) ? override : join(root, override);
})();

if (!existsSync(logsDir)) {
  console.error(`[replay:from-logs] no logs directory: ${logsDir}`);
  process.exit(1);
}
const rows: { ts: number; line: string }[] = [];
for (const file of readdirSync(logsDir)) {
  if (!file.endsWith(".jsonl")) continue;
  for (const line of readFileSync(join(logsDir, file), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as { ts?: unknown };
      const ts = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : NaN;
      if (Number.isNaN(ts) || ts < (since as number)) continue;
      if (until !== null && ts > until) continue;
      rows.push({ ts, line });
    } catch {
      /* junk lines never make the run */
    }
  }
}
rows.sort((a, b) => a.ts - b.ts);
const run = buildReplayRun(rows.map((row) => row.line));
if (run.turns.length === 0) {
  console.error("[replay:from-logs] no turns in range; the replay file is untouched");
  process.exit(1);
}
const totalCost = run.turns.reduce((sum, turn) => sum + turn.costUsd, 0);
console.log(`[replay:from-logs] ${run.turns.length} turns, cost $${totalCost.toFixed(4)}`);
for (const turn of run.turns) {
  console.log(
    `  ${turn.turn} tool=${turn.tool ?? "none"} widget=${turn.widget?.kind ?? "none"} $${turn.costUsd.toFixed(4)} :: ${turn.reply.slice(0, 80)}`,
  );
}
const serialized = `${JSON.stringify(run, null, 2)}\n`;
if (serialized.includes("data/audio") || serialized.includes('"wav"')) {
  console.error("[replay:from-logs] audio leaked into the replay file");
  process.exit(1);
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, serialized);
console.log(`[replay:from-logs] wrote ${outFile}`);
