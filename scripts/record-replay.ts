// Record the committed demo run (HACK-024): posts the demo phrases as
// typed turns through the real app, then folds the unified log
// (data/logs/*.jsonl) into replay/demo-run.json. Run it with the server up:
//   PORT=3106 npm run dev   # or tsx server.ts with META_API_KEY set
//   npm run replay:record
// Meta cap for the whole recording: 0.50 USD. The server must run on a
// fresh demo database: run npm run db:reset and (re)start the server first,
// because replacing the file under a running server breaks its writes.
// No user audio lands in the replay file: text and payloads only.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { buildReplayRun, type ReplayRun } from "../src/lib/replay";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = process.env.REPLAY_BASE ?? "http://localhost:3106";
const language = process.env.REPLAY_LANG ?? "en";

const MAX_COST_USD = 0.5;

// Demo phrases, one per catalog beat: agenda, client card, month goal,
// price, session open, photos, reminders, close with summary.
const PHRASES = [
  "Vale, what do I have today?",
  "Vale, David is on his way. Show me his card.",
  "Vale, how am I doing with my monthly goal?",
  "Vale, how much is a semi-permanent manicure?",
  "Vale, open a session with David",
  "Vale, show me the photos",
  "Vale, what do I need to buy?",
  "Vale, close the session",
];

function logSizes(): Map<string, number> {
  const dir = join(root, "data", "logs");
  const sizes = new Map<string, number>();
  if (!existsSync(dir)) return sizes;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    sizes.set(file, statSync(join(dir, file)).size);
  }
  return sizes;
}

function newLines(before: Map<string, number>): string[] {
  const dir = join(root, "data", "logs");
  const lines: string[] = [];
  if (!existsSync(dir)) return lines;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const raw = readFileSync(join(dir, file), "utf8");
    const start = before.get(file) ?? 0;
    const chunk = raw.length > start ? raw.slice(start) : raw;
    lines.push(...chunk.split("\n").filter((line) => line.trim() !== ""));
  }
  return lines;
}

/** Log turn tags: the app only accepts tNNN, so the run owns t901…. */
function turnTag(index: number): string {
  return `t9${String(index + 1).padStart(2, "0")}`;
}

async function runTurn(index: number, phrase: string): Promise<void> {
  const tag = turnTag(index);
  const res = await fetch(`${base}/api/voice?language=${language}&turn=${tag}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: phrase, typed: true }),
  });
  if (!res.ok) {
    throw new Error(`turn ${tag} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  // Drain the SSE stream: the server closes it after the done event.
  await res.text();
}

async function main(): Promise<void> {
  const dbFile = join(root, "data", "vale.db");
  if (existsSync(dbFile)) {
    const probe = new DatabaseSync(dbFile);
    const userTurns = probe.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number };
    probe.close();
    if (userTurns.n > 0) {
      console.log("[replay:record] warning: the database already has turns; for a clean take run npm run db:reset and restart the server first");
    }
  }
  {
    const before = logSizes();
    const tags = PHRASES.map((_, i) => turnTag(i));
    for (let i = 0; i < PHRASES.length; i += 1) {
      console.log(`[replay:record] turn ${tags[i]}: ${PHRASES[i]}`);
      await runTurn(i, PHRASES[i]);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const lines = newLines(before).filter((line) => tags.some((tag) => line.includes(`"${tag}"`)));
    const run: ReplayRun = buildReplayRun(lines);
    const missing = tags.filter((tag) => !run.turns.some((turn) => turn.turn === tag));
    if (missing.length > 0) {
      throw new Error(`missing turns in the log: ${missing.join(", ")}`);
    }
    const totalCost = run.turns.reduce((sum, turn) => sum + turn.costUsd, 0);
    console.log(`[replay:record] ${run.turns.length} turns, cost $${totalCost.toFixed(4)}`);
    for (const turn of run.turns) {
      console.log(
        `  ${turn.turn} tool=${turn.tool ?? "none"} widget=${turn.widget?.kind ?? "none"} $${turn.costUsd.toFixed(4)} :: ${turn.reply.slice(0, 80)}`,
      );
    }
    if (totalCost > MAX_COST_USD) {
      throw new Error(`over the $${MAX_COST_USD} recording cap: $${totalCost.toFixed(4)}`);
    }
    const outFile = join(root, "replay", "demo-run.json");
    const serialized = `${JSON.stringify(run, null, 2)}\n`;
    if (serialized.includes("data/audio") || serialized.includes('"wav"')) {
      throw new Error("audio leaked into the replay file");
    }
    mkdirSync(join(root, "replay"), { recursive: true });
    writeFileSync(outFile, serialized);
    console.log(`[replay:record] wrote ${outFile}`);
  }
}

void main().catch((error: unknown) => {
  console.error(`[replay:record] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
