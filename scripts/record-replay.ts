// Record the committed demo run: posts the plan phrases as typed turns
// through the real app, uploads the studio photos through the real
// /api/session-photo endpoint, then folds the filtered unified log
// (data/logs/*.jsonl) into replay/demo-run.json.
//
// Run it against an isolated server, never :3000 and never the live DB:
//   VALE_DB_PATH=/tmp/vale-replay.db PORT=3222 npm run db:reset
//   PORT=3222 VALE_DB_PATH=/tmp/vale-replay.db tsx --env-file=.env server.ts
//   REPLAY_BASE=http://localhost:3222 VALE_DB_PATH=/tmp/vale-replay.db npm run replay:record
//
// Meta cap for the whole recording: 2.00 USD. The server must run on a
// fresh demo database: run db:reset and (re)start the server first,
// because replacing the file under a running server breaks its writes.
// No user audio lands in the replay file: text and payloads only.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { briefSourceHash, getStoredBrief } from "../src/lib/client-briefs";
import { buildReplayRun, stampReplayScenes, type ReplayRun } from "../src/lib/replay";
import { REPLAY_PLAN, replayPlanScenes } from "./replay-plan";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = process.env.REPLAY_BASE ?? "http://localhost:3222";
if (base.includes("localhost:3000") || base.includes("127.0.0.1:3000")) {
  console.error("[replay:record] refusing :3000; point REPLAY_BASE at the isolated run");
  process.exit(1);
}
const language = process.env.REPLAY_LANG ?? "en";

const MAX_COST_USD = 2.0;
const SEED_PHOTO = join(root, "seed-assets", "david-last-service.jpg");

/** Resolve the database file the same way src/lib/db.ts does. */
function dbFile(): string {
  const override = (process.env.VALE_DB_PATH ?? "").trim();
  if (override !== "") return isAbsolute(override) ? override : join(root, override);
  return join(root, "data", "vale.db");
}

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

async function runTurn(index: number, phrase: string): Promise<string> {
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
  // The body is also the source for the adaptive payment amount.
  return res.text();
}

/** Suggested total off the drained quote SSE stream, if present. */
function suggestedFromSse(sse: string): number | null {
  for (const line of sse.split("\n")) {
    const text = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (text === "") continue;
    try {
      const payload = JSON.parse(text) as {
        widget?: { kind?: unknown; data?: { suggested?: unknown } };
      };
      const suggested = payload?.widget?.data?.suggested;
      // The quote sheet rides as kind "price" on the widget event.
      if (typeof suggested === "number" && Number.isFinite(suggested)) {
        return suggested;
      }
    } catch {
      /* non-JSON data lines never carry the quote */
    }
  }
  return null;
}

/** Latest session id in the isolated database. */
function latestSessionId(file: string): number {
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("SELECT id FROM sessions ORDER BY id DESC LIMIT 1").get() as
      | { id: number }
      | undefined;
    if (!row) throw new Error("no sessions in the database");
    return row.id;
  } finally {
    db.close();
  }
}

/**
 * Upload one studio photo through the real endpoint (same path the camera
 * upload takes): SAM runs, the slot file lands on disk, and the after
 * slot returns the mosaic description from the open model.
 */
async function uploadStudioPhoto(sessionId: number, slot: "before" | "after"): Promise<void> {
  const bytes = readFileSync(SEED_PHOTO);
  const form = new FormData();
  form.set("sessionId", String(sessionId));
  form.set("slot", slot);
  form.set("photo", new File([bytes], "david-last-service.jpg", { type: "image/jpeg" }));
  const res = await fetch(`${base}/api/session-photo`, { method: "POST", body: form });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`studio ${slot} upload failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  console.log(`[replay:record] studio ${slot} upload ok for session ${sessionId}`);
  if (slot === "after") {
    try {
      const description = (JSON.parse(body) as { description?: unknown }).description;
      console.log(`[replay:record] final photo description: ${String(description ?? "").slice(0, 300)}`);
    } catch {
      console.log(`[replay:record] final photo response: ${body.slice(0, 200)}`);
    }
  }
}

/**
 * Wait for Glimmer's private brief for Nina with the current record hash;
 * the card and summary scenes need the stored row to match the notes just
 * written. Existence alone is not enough: an earlier background refresh
 * may have stored a brief from before the health note.
 */
async function waitForBrief(file: string): Promise<void> {
  const deadline = Date.now() + 240_000;
  for (;;) {
    const db = new DatabaseSync(file);
    try {
      const client = db.prepare("SELECT id FROM clients WHERE name = 'Nina'").get() as
        | { id: number }
        | undefined;
      const hash = client ? briefSourceHash(db, client.id) : null;
      const stored = client ? getStoredBrief(db, client.id) : null;
      if (client && hash !== null && stored?.source_hash === hash) {
        console.log(`[replay:record] Nina brief ready (${stored.created_at})`);
        return;
      }
    } finally {
      db.close();
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for Nina's private brief; not faking it");
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function main(): Promise<void> {
  const file = dbFile();
  if (existsSync(file)) {
    const probe = new DatabaseSync(file);
    const userTurns = probe.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number };
    probe.close();
    if (userTurns.n > 0) {
      console.log("[replay:record] warning: the database already has turns; for a clean take run npm run db:reset and restart the server first");
    }
  }
  {
    const paymentIndex = REPLAY_PLAN.findIndex((turn) => turn.phrase.includes("{AMOUNT}"));
    if (paymentIndex === -1) throw new Error("no adaptive payment turn in the plan");
    const before = logSizes();
    const tags = REPLAY_PLAN.map((_, i) => turnTag(i));
    let paymentAmount = 0;
    for (let i = 0; i < REPLAY_PLAN.length; i += 1) {
      let phrase = REPLAY_PLAN[i].phrase;
      if (i === paymentIndex) {
        if (paymentAmount <= 0) throw new Error("quote turn did not report a suggested total");
        phrase = phrase.replace("{AMOUNT}", String(paymentAmount));
      }
      console.log(`[replay:record] turn ${tags[i]} [${REPLAY_PLAN[i].scene}]: ${phrase}`);
      const sse = await runTurn(i, phrase);
      // The quote turn reports its suggested total on the widget stream;
      // the payment turn offers more, never the same number.
      if (i === paymentIndex - 1) {
        const suggested = suggestedFromSse(sse);
        if (suggested === null) throw new Error("quote turn carried no suggested total");
        paymentAmount = suggested + 5;
        console.log(`[replay:record] quoted ${suggested}, will pay ${paymentAmount}`);
      }
      // Nina's health note kicks Glimmer's background brief; the card
      // turn needs the stored row, so wait for the real one here.
      if (REPLAY_PLAN[i].phrase.startsWith("Vale, save a health note")) {
        await waitForBrief(file);
      }
      // The studio before photo lands through the real upload endpoint
      // once David's session is open, before the before-photo turn.
      if (REPLAY_PLAN[i].phrase === "Vale, open a session with David") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await uploadStudioPhoto(latestSessionId(file), "before");
      }
      // The final photo lands the same way after the preview turn.
      if (REPLAY_PLAN[i].phrase.startsWith("Vale, preview the design")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await uploadStudioPhoto(latestSessionId(file), "after");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const lines = newLines(before).filter((line) => tags.some((tag) => line.includes(`"${tag}"`)));
    let run: ReplayRun = buildReplayRun(lines);
    const missing = tags.filter((tag) => !run.turns.some((turn) => turn.turn === tag));
    if (missing.length > 0) {
      throw new Error(`missing turns in the log: ${missing.join(", ")}`);
    }
    run = stampReplayScenes(run, replayPlanScenes());
    const totalCost = run.turns.reduce((sum, turn) => sum + turn.costUsd, 0);
    console.log(`[replay:record] ${run.turns.length} turns, cost $${totalCost.toFixed(4)}`);
    for (const turn of run.turns) {
      console.log(
        `  ${turn.turn} [${turn.scene}] tool=${turn.tool ?? "none"} widget=${turn.widget?.kind ?? "none"} $${turn.costUsd.toFixed(4)} :: ${turn.reply.slice(0, 80)}`,
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
    // Content guard: REPLAY_BANNED_WORDS carries the comma-separated
    // blocklist in the shell (never committed); the run fails if the
    // recorded replies name anyone or anything outside the demo.
    const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const word of (process.env.REPLAY_BANNED_WORDS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")) {
      if (new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(serialized)) {
        throw new Error("banned word in the replay file");
      }
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
