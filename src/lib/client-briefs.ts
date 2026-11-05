// Private client briefs from the open-weights model (Glimmer).
// Server-side only: the record below (including health-note text) never
// leaves this module toward the cloud model. Meta only ever sees the
// client name and agenda; the stored brief is spoken and shown, never
// sent back. Tests stub the Glimmer fetch; no network in the suite.
import { createHash } from "node:crypto";
import type { ValeDb } from "./db";
import { bogotaDay } from "./natural-date";
import { vlog } from "./turn-log";

/** Fixed Glimmer schema: what the voice says, what the card shows. */
export interface ClientBrief {
  /** English, at most 2 sentences, never any health-note content. */
  spoken: string;
  /** Card lines on top of the sheet, longest first. */
  summary: string[];
  has_health_note: boolean;
}

export interface StoredBrief {
  brief: ClientBrief;
  model: string;
  ms: number | null;
  created_at: string;
  source_hash: string;
}

export const GLIMMER_MODEL = "muse-glimmer-30B";
/** Card line under the summary, always in English. */
export const BRIEF_LABEL = "Prepared privately by Muse Glimmer (open weights)";

/** Present only when the private model is wired: URL plus token. */
export function glimmerConfigured(): boolean {
  return (
    (process.env.GLIMMER_URL?.trim() ?? "") !== "" &&
    (process.env.GLIMMER_TOKEN?.trim() ?? "") !== ""
  );
}

/** Private briefs table; created here so no other schema file changes. */
export function ensureClientBriefsTable(db: ValeDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS client_briefs (
    client_id INTEGER PRIMARY KEY REFERENCES clients(id),
    brief_json TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    ms REAL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
}

interface BriefRecord {
  name: string;
  notes: { kind: string; text: string }[];
  visits: { service: string; visited_at: string; note: string }[];
  upcoming: { service: string; day: string; time: string }[];
}

/**
 * Everything Glimmer may read: notes with their full private text,
 * visits and upcoming appointments. Contact (phone, email, birthday)
 * stays out: the brief never needs it.
 */
export function briefSourceRecord(db: ValeDb, clientId: number): BriefRecord | null {
  const client = db.prepare("SELECT name FROM clients WHERE id = ?").get(clientId) as
    | { name: string }
    | undefined;
  if (!client) return null;
  const notes = db
    .prepare("SELECT kind, text FROM notes WHERE client_id = ? ORDER BY id")
    .all(clientId) as { kind: string; text: string }[];
  const visits = db
    .prepare(
      `SELECT COALESCE(s.name, '') AS service, v.visited_at, v.note
       FROM visits v LEFT JOIN services s ON s.id = v.service_id
       WHERE v.client_id = ? ORDER BY v.visited_at DESC LIMIT 5`,
    )
    .all(clientId) as { service: string; visited_at: string; note: string }[];
  const upcoming = db
    .prepare(
      `SELECT s.name AS service, a.day, a.time
       FROM appointments a JOIN services s ON s.id = a.service_id
       WHERE a.client_id = ? ORDER BY a.day, a.time`,
    )
    .all(clientId) as { service: string; day: string; time: string }[];
  return { name: client.name, notes, visits, upcoming };
}

/** Hash of the record the brief was built from; a new note ages it. */
export function briefSourceHash(db: ValeDb, clientId: number): string | null {
  const record = briefSourceRecord(db, clientId);
  if (!record) return null;
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

/** Strict shape check: Glimmer must return exactly this, nothing else. */
export function parseBriefJson(value: unknown): ClientBrief | null {
  if (!value || typeof value !== "object") return null;
  const brief = value as Record<string, unknown>;
  if (typeof brief.spoken !== "string" || brief.spoken.trim() === "") return null;
  if (!Array.isArray(brief.summary)) return null;
  if (!brief.summary.every((line): line is string => typeof line === "string")) return null;
  if (typeof brief.has_health_note !== "boolean") return null;
  return {
    spoken: brief.spoken.trim(),
    summary: brief.summary.map((line) => line.trim()).filter((line) => line !== ""),
    has_health_note: brief.has_health_note,
  };
}

export function getStoredBrief(db: ValeDb, clientId: number): StoredBrief | null {
  ensureClientBriefsTable(db);
  const row = db
    .prepare("SELECT brief_json, source_hash, model, ms, created_at FROM client_briefs WHERE client_id = ?")
    .get(clientId) as
    | { brief_json: string; source_hash: string; model: string; ms: number | null; created_at: string }
    | undefined;
  if (!row) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.brief_json);
  } catch {
    return null;
  }
  const brief = parseBriefJson(parsed);
  if (!brief) return null;
  return { brief, model: row.model, ms: row.ms, created_at: row.created_at, source_hash: row.source_hash };
}

function storeBrief(db: ValeDb, clientId: number, brief: ClientBrief, hash: string, ms: number): StoredBrief {
  ensureClientBriefsTable(db);
  const created = new Date().toISOString();
  db.prepare(
    `INSERT INTO client_briefs (client_id, brief_json, source_hash, model, ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET
       brief_json = excluded.brief_json,
       source_hash = excluded.source_hash,
       model = excluded.model,
       ms = excluded.ms,
       created_at = excluded.created_at`,
  ).run(clientId, JSON.stringify(brief), hash, GLIMMER_MODEL, ms, created);
  return { brief, model: GLIMMER_MODEL, ms, created_at: created, source_hash: hash };
}

/** System prompt: the fixed schema plus the health-silence rule. The health
 * line is neutral on purpose: the record may carry no sex, and the brief
 * must read the same for every client instead of guessing a pronoun. */
export function buildBriefSystemPrompt(): string {
  return [
    "You are a private salon assistant. Write a pre-appointment brief as JSON only:",
    '{"spoken": "...", "summary": ["..."], "has_health_note": true|false}.',
    "spoken is English, at most 2 sentences: visit pattern, tastes and what to mention.",
    "Never write any health condition, allergy or product to avoid in spoken or summary.",
    "summary lists the practical points, longest first; has_health_note mirrors the record.",
    "When a health note exists, end spoken with exactly: \"There is also a health note; it's on screen.\"",
  ].join(" ");
}

/** User prompt: the full private record as JSON. Never leaves the server. */
export function buildBriefUserPrompt(record: BriefRecord): string {
  return (
    "Client record (private, never repeat health details aloud):\n" +
    JSON.stringify(record) +
    "\nWrite the pre-appointment brief as JSON."
  );
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
}

/** The private model is still loading its weights: worth one more try. */
export class GlimmerLoadingError extends Error {
  constructor() {
    super("private model loading");
  }
}

/**
 * The model does not always honor the exact health line (it keeps the old
 * "He/She also has" shape on its own), so the tail is enforced here: any
 * trailing variant becomes the one neutral sentence. Never adds one.
 */
export function normalizeBriefSpoken(spoken: string): string {
  const exact = "There is also a health note; it's on screen.";
  if (spoken.trimEnd().endsWith(exact)) return spoken;
  const stripped = spoken.replace(
    /\s*(?:He|She|There is|There)\s+also has a health note[^.]*\.?\s*$/i,
    "",
  );
  if (stripped === spoken) return spoken;
  const separator = stripped.endsWith(" ") || stripped === "" ? "" : " ";
  return `${stripped}${separator}${exact}`;
}

/** One Glimmer call with the fixed schema; throws when unusable. */
export async function fetchClientBrief(
  record: BriefRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<{ brief: ClientBrief; ms: number }> {
  const base = process.env.GLIMMER_URL?.trim() ?? "";
  const token = process.env.GLIMMER_TOKEN?.trim() ?? "";
  if (base === "" || token === "") throw new Error("private model not configured");
  const started = Date.now();
  const response = await fetchImpl(`${base.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: GLIMMER_MODEL,
      messages: [
        { role: "system", content: buildBriefSystemPrompt() },
        { role: "user", content: buildBriefUserPrompt(record) },
      ],
      max_tokens: 1024,
      temperature: 1.0,
      top_p: 0.95,
      top_k: 64,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (response.status === 503) throw new GlimmerLoadingError();
  if (!response.ok) throw new Error(`private model error: ${response.status}`);
  const data = (await response.json()) as ChatCompletion;
  const content = data.choices?.[0]?.message?.content ?? "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = /\{[\s\S]*\}/.exec(content);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }
  const brief = parseBriefJson(parsed);
  if (!brief) throw new Error("private model returned no usable brief");
  return { brief: { ...brief, spoken: normalizeBriefSpoken(brief.spoken) }, ms: Date.now() - started };
}

/** Lowercase alphanumeric tokens, short glue words dropped. */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
}

/**
 * Voice-safety net behind the prompt rule: a brief that repeats any
 * health-note word is dropped. The record's own notes supply the word set,
 * so the check follows whatever the client file holds.
 */
export function briefLeaksHealth(brief: ClientBrief, record: BriefRecord): boolean {
  const banned = new Set<string>();
  for (const note of record.notes) {
    if (note.kind !== "health_note") continue;
    for (const word of contentWords(note.text)) banned.add(word);
  }
  if (banned.size === 0) return false;
  return [brief.spoken, ...brief.summary]
    .flatMap(contentWords)
    .some((word) => banned.has(word));
}

export interface RefreshOptions {
  /** Ride out cold starts: retry a 503 with backoff. Voice turns opt out. */
  retryLoading?: boolean;
  /** Backoff base between 503 retries; tests shrink it. */
  retryDelayMs?: number;
  /** Where the refresh runs: precompute warms, voice answers, refresh is misc. */
  source?: "precompute" | "refresh" | "voice";
}

type BriefResult = "stored" | "leak-regenerated" | "leak-dropped" | "fetch-error" | "cache-hit";

/**
 * Generation and cache events for the demo recording: model, timing and
 * outcome only. The brief text and the record (with health notes) never
 * reach the log; vlog also prints the same line to the server console.
 */
function logGlimmer(event: {
  clientId: number;
  source: "precompute" | "refresh" | "voice" | "cache";
  result: BriefResult;
  ms?: number | null;
  createdAt?: string;
  model?: string;
}): void {
  vlog({
    turn: "-",
    process: "GLIMMER",
    model: event.model ?? GLIMMER_MODEL,
    durationMs: event.ms ?? null,
    status: event.result === "fetch-error" ? "error" : event.result === "leak-dropped" ? "ignored" : "ok",
    detail: {
      source: event.source,
      client: event.clientId,
      result: event.result,
      ...(event.createdAt === undefined ? {} : { created_at: event.createdAt }),
    },
    content: null,
  });
}

/** A turn shows the card off a stored brief: record the cache hit. */
export function logBriefCacheHit(db: ValeDb, clientId: number): void {
  const stored = getStoredBrief(db, clientId);
  if (!stored) return;
  logGlimmer({
    clientId,
    source: "cache",
    result: "cache-hit",
    ms: stored.ms,
    createdAt: stored.created_at,
    model: stored.model === "" ? undefined : stored.model,
  });
}

// Six tries ride out a multi-minute cold load: 15 + 30 + 45 + 60 + 75 s
// of backoff between attempts, background only.
const REFRESH_ATTEMPTS = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fresh stored brief, regenerating when the record changed. Null when
 * there is no client, no private model, or Glimmer fails: the voice
 * falls back to the card, it never waits on an error. Background callers
 * ride out a cold model (503 with backoff); the voice path opts out so a
 * loading model answers the fallback at once instead of blocking speech.
 */
export async function refreshClientBrief(
  db: ValeDb,
  clientId: number,
  fetchImpl: typeof fetch = fetch,
  options: RefreshOptions = {},
): Promise<StoredBrief | null> {
  ensureClientBriefsTable(db);
  const hash = briefSourceHash(db, clientId);
  if (hash === null) return null;
  const stored = getStoredBrief(db, clientId);
  if (stored && stored.source_hash === hash) return stored;
  if (!glimmerConfigured()) return null;
  const record = briefSourceRecord(db, clientId);
  if (!record) return null;
  const tries = options.retryLoading === false ? 1 : REFRESH_ATTEMPTS;
  const baseDelay = options.retryDelayMs ?? 15000;
  const source = options.source ?? "refresh";
  let regenerated = false;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const { brief, ms } = await fetchClientBrief(record, fetchImpl);
      if (!briefLeaksHealth(brief, record)) {
        const stored = storeBrief(db, clientId, brief, hash, ms);
        logGlimmer({ clientId, source, result: regenerated ? "leak-regenerated" : "stored", ms });
        return stored;
      }
      // A leaking brief is dropped and generated once more; a second
      // leak stores nothing so the voice falls back to the card.
      if (regenerated) {
        logGlimmer({ clientId, source, result: "leak-dropped", ms: null });
        return null;
      }
      regenerated = true;
    } catch (error) {
      if (!(error instanceof GlimmerLoadingError) || attempt + 1 >= tries) {
        logGlimmer({ clientId, source, result: "fetch-error", ms: null });
        return null;
      }
      await sleep(baseDelay * (attempt + 1));
    }
  }
  logGlimmer({ clientId, source, result: "fetch-error", ms: null });
  return null;
}

/**
 * Background regen after a record write: never blocks the voice, never
 * throws. Only called from record writes (addNote, closeSession).
 */
export function refreshClientBriefInBackground(db: ValeDb, clientId: number): void {
  if (!glimmerConfigured()) return;
  void refreshClientBrief(db, clientId).catch(() => {});
}

/**
 * Clients with an appointment today, oldest booking first. The server
 * warms exactly these briefs on start; db:reset chains the same call.
 */
export function todayClientIds(db: ValeDb, when = new Date()): number[] {
  const rows = db
    .prepare("SELECT DISTINCT client_id AS id FROM appointments WHERE day = ? ORDER BY id")
    .all(bogotaDay(when)) as { id: number }[];
  return rows.map((row) => row.id);
}

/**
 * Precompute for server start and db:reset: every listed client gets a
 * fresh brief. Failures resolve to null and never throw.
 */
export async function precomputeBriefsForClients(
  db: ValeDb,
  clientIds: number[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshed: number; total: number }> {
  let refreshed = 0;
  for (const clientId of clientIds) {
    const stored = await refreshClientBrief(db, clientId, fetchImpl, { source: "precompute" });
    if (stored) refreshed += 1;
  }
  return { refreshed, total: clientIds.length };
}
