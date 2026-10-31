// HACK-017 conversation eval runner. Usage:
//   VALE_DB_PATH=data/eval.db node scripts/eval-hack017.mjs <server-url> <conversations.json> [--lang=es] [--server-log=path]
// Resets its OWN database file (VALE_DB_PATH, default data/eval.db: schema +
// minimal invented services/supplies) and never touches the live data/vale.db.
// Launch the server under test with the same VALE_DB_PATH. Runs every turn as
// POST /api/voice?language=<lang>&client=<run>-<conv> with a JSON transcript,
// and prints one JSON object with per-turn client timings plus every event
// name seen. Server-side [voice-turn] lines (ttft, tool, cost, ignored, chain,
// cached tokens) are matched by client key from --server-log when given, and
// their input/cached totals print at the end.
// All data invented; the Meta key stays server-side (never sent by this script).
import { readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Own disposable file: the live data/vale.db is never reset nor opened here.
// Run the server with the same VALE_DB_PATH so both sides share this file.
const dbFile = (() => {
  const override = (process.env.VALE_DB_PATH ?? "").trim();
  if (!override) return join(root, "data", "eval.db");
  return isAbsolute(override) ? override : join(root, override);
})();
const [server, convFile] = process.argv.slice(2);
if (!server || !convFile) {
  console.error("usage: node scripts/eval-hack017.mjs <server-url> <conversations.json> [--lang=es] [--server-log=path]");
  process.exit(1);
}
const lang = (process.argv.find((a) => a.startsWith("--lang=")) || "--lang=en").slice(7);
const serverLogPath = (process.argv.find((a) => a.startsWith("--server-log=")) || "").slice(13);
const convs = JSON.parse(readFileSync(convFile, "utf8")).conversations;

// Fresh database with the minimum invented catalog a session needs.
// --no-reset skips this when the server under test already holds the file:
// deleting it under a live server orphans its handle and every write fails.
const noReset = process.argv.includes("--no-reset");
if (!noReset) {
  rmSync(dbFile, { force: true });
  {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "data"), { recursive: true });
  }
}
const db = new DatabaseSync(dbFile);
if (!noReset) {
  db.exec(readFileSync(join(root, "src", "lib", "schema.sql"), "utf8"));
}
const addService = db.prepare(
  "INSERT INTO services (name, es, aliases, price_cents, duration_min) VALUES (?, '', '[]', ?, ?)",
);
if (!noReset) {
  addService.run("Gel refill", 4500, 75);
  addService.run("Spa pedicure", 6000, 60);
  addService.run("Acrylic full set", 8500, 120);
}
const addSupply = db.prepare(
  "INSERT INTO supplies (name, es, aliases, unit, content_per_product, stock_qty, min_qty, price_per_product_usd) VALUES (?, '', '[]', 'pcs', 1, 10, 2, 5)",
);
if (!noReset) {
  addSupply.run("Top coat");
  addSupply.run("Nail file");
  addSupply.run("Acetone");
  // English clients the conversations book for, so writes really happen.
  // One conversation (C9, Chloe) keeps a new client to measure doubt->confirm.
  const addClient = db.prepare("INSERT INTO clients (name) VALUES (?)");
  for (const name of ["Emma", "Liam", "Sofia", "Nina", "Ava", "Olivia", "Mia", "Zoe"]) {
    addClient.run(name);
  }
}
db.close();

if (process.argv.includes("--reset-only")) process.exit(0);
const run = `eval-${Date.now().toString(36)}`;

function parseSse(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    const type = (block.match(/^event: (.+)$/m) || [])[1];
    const data = (block.match(/^data: (.+)$/m) || [])[1];
    if (type) events.push({ type, data: data ? JSON.parse(data) : null });
  }
  return events;
}

const results = [];
for (const conv of convs) {
  const client = `${run}-${conv.id}`;
  let n = 0;
  for (const transcript of conv.turns) {
    n += 1;
    const started = Date.now();
    let firstReplyMs = null;
    let raw = "";
    let httpError = null;
    try {
      const res = await fetch(
        `${server}/api/voice?language=${lang}&client=${encodeURIComponent(client)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transcript }),
        },
      );
      if (res.status !== 200) httpError = `http-${res.status}`;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        if (
          firstReplyMs === null &&
          /event: reply(-delta)?\n/.test(raw)
        ) {
          firstReplyMs = Date.now() - started;
        }
      }
    } catch (e) {
      httpError = `fetch-${e.cause?.code ?? e.message}`;
    }
    const totalMs = Date.now() - started;
    const events = parseSse(raw);
    const replyText = events.find((e) => e.type === "reply")?.data?.text ?? "";
    const words = replyText.split(/\s+/).filter(Boolean);
    const BANNED = ["love", "darling", "honey", "dear", "sweetie", "babe", "hun"];
    results.push({
      conv: conv.id,
      turn: n,
      client,
      transcript,
      events: events.map((e) => e.type),
      reply: replyText.slice(0, 300),
      replyWords: words.length,
      banned: BANNED.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(replyText)),
      ignored: events.some((e) => e.type === "ignored"),
      errorEvent: events.some((e) => e.type === "error"),
      httpError,
      // Client-measured over localhost: first reply event, and last byte.
      ttftClientMs: firstReplyMs,
      totalClientMs: totalMs,
    });
  }
}

// Prefix-cache measure: match this run's server [voice-turn] lines by key.
let serverTokens = null;
if (serverLogPath) {
  try {
    const lines = readFileSync(serverLogPath, "utf8").split("\n");
    let input = 0;
    let cached = 0;
    let turns = 0;
    for (const line of lines) {
      const at = line.indexOf("[voice-turn]");
      if (at === -1) continue;
      try {
        const fields = JSON.parse(line.slice(at + 12));
        if (typeof fields.key !== "string" || !fields.key.startsWith(run)) continue;
        turns += 1;
        input += fields.inputTokens ?? 0;
        cached += fields.cachedInputTokens ?? 0;
      } catch {
        /* a truncated line never breaks the totals */
      }
    }
    serverTokens = { turns, input, cached, cachedRatio: input > 0 ? cached / input : 0 };
  } catch {
    serverTokens = { error: "unreadable server log" };
  }
}

console.log(JSON.stringify({ run, lang, results, serverTokens }, null, 1));
