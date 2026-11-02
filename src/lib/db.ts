// Server-side only: holds the SQLite database. Never import from client code.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { bogotaDay } from "./natural-date";
import seedData from "./seed-data.json";
import { quotePrice, type PricingConfig } from "./quote";
import { vlog } from "./turn-log";

export type ValeDb = DatabaseSync;

/**
 * File database location. VALE_DB_PATH overrides it (absolute, or relative
 * to the working directory) so evals and tools can use their own file and
 * never touch the live data/vale.db. Pure for tests: pass cwd explicitly.
 */
export function resolveDbFile(cwd: string = process.cwd()): string {
  const override = process.env.VALE_DB_PATH?.trim();
  if (override) return isAbsolute(override) ? override : join(cwd, override);
  return join(cwd, "data", "vale.db");
}

export const DB_FILE = resolveDbFile();

// Placeholder shown wherever a private health note would appear.
// The real text never leaves this module toward the cloud.
export const PRIVATE_NOTE_LABEL = "nota privada 🔒";

export interface PublicNote {
  id: number;
  kind: "note" | "health_note";
  /** Null when the note is private: the text is never exposed. */
  text: string | null;
  masked: boolean;
}

export interface TableCounts {
  clients: number;
  services: number;
  supplies: number;
}

interface SeedSupply {
  name: string;
  es?: string;
  aliases?: string[];
  unit?: string;
  content_per_product?: number;
  stock?: number;
  min?: number;
  price_per_product_usd?: number;
}

interface SeedClient {
  name: string;
  es?: string;
  sex?: string;
  phone?: string;
  email?: string;
  birthday?: string;
}

interface SeedDemoNote {
  client: string;
  kind?: string;
  private?: boolean;
  text: string;
}

interface SeedDemoAppointment {
  client: string;
  service: string;
  day: string;
  time: string;
  reference_photo?: string;
}

interface SeedDemoReminder {
  text: string;
  kind?: string;
  day?: string;
  items?: string[];
}

interface SeedDemoVisit {
  client: string;
  service?: string;
  days_ago?: number;
  photo?: string;
  note?: string;
}

interface SeedDemoPastSession {
  client: string;
  service: string;
  days_ago?: number;
  start?: string;
  minutes?: number;
  margin_earned?: number;
}

interface SeedRecipeLine {
  name: string;
  qty: number;
  unit?: string;
}

interface SeedService {
  name: string;
  es?: string;
  aliases?: string[];
  minutes: number;
  supplies?: SeedRecipeLine[];
}

/** "lun-vie" counts its weekday days: nothing about the schedule is hardcoded. */
function workDaysPerWeek(schedule: string): number {
  const order = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"];
  const plain = schedule
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const [first, last] = plain.split("-").map((part) => part.trim());
  const from = order.indexOf(first);
  const to = last === undefined ? from : order.indexOf(last);
  if (from === -1 || to === -1 || to < from) return 5;
  return to - from + 1;
}

function pricingFromSeed(): PricingConfig {
  const pricing = (
    seedData as unknown as {
      pricing: {
        monthly_goal_usd: number;
        margin_pct: number;
        schedule: string;
        work_hours_per_day: number;
        fixed_costs: { label: string; amount_usd: number }[];
      };
    }
  ).pricing;
  const fixedMonthlyUsd = pricing.fixed_costs.reduce((sum, item) => sum + item.amount_usd, 0);
  return {
    goalMonthlyUsd: pricing.monthly_goal_usd,
    workDaysPerWeek: workDaysPerWeek(pricing.schedule ?? "lun-vie"),
    workHoursPerDay: pricing.work_hours_per_day,
    marginPct: pricing.margin_pct,
    fixedMonthlyUsd,
  };
}

export const PRICING: PricingConfig = pricingFromSeed();

/** Final rounded price of a service with its seed minutes and recipe. */
export function seedServicePrice(service: SeedService): number {
  const suppliesByName = new Map(
    ((seedData as unknown as { supplies: SeedSupply[] }).supplies ?? []).map((supply) => [supply.name, supply]),
  );
  const breakdown = quotePrice(
    PRICING,
    service.minutes,
    (service.supplies ?? []).map((line) => {
      const supply = suppliesByName.get(line.name);
      return {
        qty: line.qty,
        pricePerProductUsd: supply?.price_per_product_usd ?? 0,
        contentPerProduct: supply?.content_per_product ?? 0,
      };
    }),
  );
  return breakdown.finalPrice;
}

function schemaSql(): string {
  return readFileSync(join(process.cwd(), "src", "lib", "schema.sql"), "utf8");
}

/**
 * Bogota YYYY-MM-DD shifted by a day offset. Same salon clock as the
 * tools, so a seeded "today" is the tools' today on every machine.
 */
function seedDay(offsetDays = 0): string {
  const [year, month, day] = bogotaDay(new Date()).split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1, day, 12));
  const next = new Date(base.getTime() + offsetDays * 86_400_000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Resolve a demo day marker ("today", "tomorrow") to a local YYYY-MM-DD. */
function resolveSeedDay(day: string): string {
  if (day === "today") return seedDay(0);
  if (day === "tomorrow") return seedDay(1);
  return day;
}

/**
 * Local YYYY-MM-DDTHH:MM:SS for a past session. Stays inside the current
 * month so the month goal always shows the seeded progress.
 */
function pastSessionStart(daysAgo: number, time: string): string {
  const now = new Date();
  const probe = new Date(now);
  probe.setDate(now.getDate() - daysAgo);
  const sameMonth =
    probe.getFullYear() === now.getFullYear() && probe.getMonth() === now.getMonth();
  const day = sameMonth ? seedDay(-daysAgo) : `${seedDay(0).slice(0, 8)}01`;
  return `${day}T${time}:00`;
}

/** Add minutes to a local YYYY-MM-DDTHH:MM:SS stamp. */
function addMinutes(stamp: string, minutes: number): string {
  const [date, time] = stamp.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const when = new Date(year, month - 1, day, hour, minute, 0);
  when.setMinutes(when.getMinutes() + minutes);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}:00`;
}

/** Add a column when an older database file lacks it. */
function ensureColumn(db: ValeDb, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Add columns that older databases predate. Idempotent. */
export function migrateDatabase(db: ValeDb): void {
  ensureColumn(db, "sessions", "photo_path", "TEXT");
}

/** Create tables and insert the invented seed. Idempotent. */
/** The user behind the voice: seeded, overridable with VALE_USER_NAME. */
export const DEFAULT_USER_NAME = "Daniel";

/** The user's name for the prompt: env wins, then the seeded profile. */
export function userName(db: ValeDb): string {
  const env = process.env.VALE_USER_NAME?.trim();
  if (env) return env;
  try {
    const row = db
      .prepare("SELECT name FROM user_profile WHERE id = 1")
      .get() as { name: string } | undefined;
    if (row?.name.trim()) return row.name.trim();
  } catch {
    /* old database without the table: fall through to the default */
  }
  return DEFAULT_USER_NAME;
}

export function seedDatabase(db: ValeDb): void {
  db.exec(schemaSql());
  migrateDatabase(db);
  ensureColumn(db, "clients", "sex", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "clients", "phone", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "clients", "email", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "clients", "birthday", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "services", "es", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "services", "aliases", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "supplies", "es", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "supplies", "aliases", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "supplies", "unit", "TEXT NOT NULL DEFAULT 'pcs'");
  ensureColumn(db, "supplies", "content_per_product", "REAL NOT NULL DEFAULT 1");
  ensureColumn(db, "supplies", "stock_qty", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "supplies", "min_qty", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "supplies", "price_per_product_usd", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "appointments", "reference_photo", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "sessions", "margin_earned", "REAL");
  migrateNoteKinds(db);

  const seed = seedData as unknown as {
    clients: SeedClient[];
    services: SeedService[];
    supplies: SeedSupply[];
    demo_notes?: SeedDemoNote[];
    demo_appointments?: SeedDemoAppointment[];
    demo_reminders?: SeedDemoReminder[];
    demo_visits?: SeedDemoVisit[];
    demo_past_sessions?: SeedDemoPastSession[];
  };
  const clientIds = new Map<string, number>();
  const upsertClient = db.prepare(
    `INSERT INTO clients (name, sex, phone, email, birthday)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       sex = excluded.sex,
       phone = excluded.phone,
       email = excluded.email,
       birthday = excluded.birthday`,
  );
  for (const client of seed.clients) {
    upsertClient.run(
      client.name,
      client.sex ?? "",
      client.phone ?? "",
      client.email ?? "",
      client.birthday ?? "",
    );
    const row = db.prepare("SELECT id FROM clients WHERE name = ?").get(client.name) as { id: number };
    clientIds.set(client.name, row.id);
  }
  db.prepare("INSERT OR IGNORE INTO user_profile (id, name) VALUES (1, ?)").run(DEFAULT_USER_NAME);

  const upsertSupply = db.prepare(
    `INSERT INTO supplies (name, es, aliases, unit, content_per_product, stock_qty, min_qty, price_per_product_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       es = excluded.es,
       aliases = excluded.aliases,
       unit = excluded.unit,
       content_per_product = excluded.content_per_product,
       min_qty = excluded.min_qty,
       price_per_product_usd = excluded.price_per_product_usd`,
  );
  const supplyIds = new Map<string, number>();
  for (const supply of seed.supplies) {
    upsertSupply.run(
      supply.name,
      supply.es ?? "",
      JSON.stringify(supply.aliases ?? []),
      supply.unit ?? "pcs",
      supply.content_per_product ?? 1,
      supply.stock ?? 0,
      supply.min ?? 0,
      supply.price_per_product_usd ?? 0,
    );
    const row = db.prepare("SELECT id FROM supplies WHERE name = ?").get(supply.name) as { id: number };
    supplyIds.set(supply.name, row.id);
  }

  const upsertService = db.prepare(
    `INSERT INTO services (name, es, aliases, price_cents, duration_min)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       es = excluded.es,
       aliases = excluded.aliases,
       price_cents = excluded.price_cents,
       duration_min = excluded.duration_min`,
  );
  const serviceIds = new Map<string, number>();
  for (const service of seed.services) {
    upsertService.run(
      service.name,
      service.es ?? "",
      JSON.stringify(service.aliases ?? []),
      Math.round(seedServicePrice(service) * 100),
      service.minutes,
    );
    const row = db.prepare("SELECT id FROM services WHERE name = ?").get(service.name) as { id: number };
    serviceIds.set(service.name, row.id);
    db.prepare("DELETE FROM service_supplies WHERE service_id = ?").run(row.id);
    const addLine = db.prepare("INSERT INTO service_supplies (service_id, supply_id, qty, unit) VALUES (?, ?, ?, ?)");
    for (const line of service.supplies ?? []) {
      const supplyId = supplyIds.get(line.name);
      if (supplyId !== undefined) addLine.run(row.id, supplyId, line.qty, line.unit ?? "pcs");
    }
  }

  seedDemoNotes(db, seed.demo_notes ?? [], clientIds);
  seedDemoAppointments(db, seed.demo_appointments ?? [], clientIds, serviceIds);
  seedDemoReminders(db, seed.demo_reminders ?? [], supplyIds);
  seedDemoVisits(db, seed.demo_visits ?? [], clientIds, serviceIds);
  seedDemoPastSessions(db, seed.demo_past_sessions ?? [], clientIds, serviceIds);
}

/** Table row count, used to seed demo rows once without touching live rows. */
function tableCount(db: ValeDb, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * Note kinds are only note and health_note: migrate the old general/health
 * values, and rebuild the table when its CHECK still names them (SQLite
 * keeps the old CHECK on existing files, which would reject new writes).
 */
function migrateNoteKinds(db: ValeDb): void {
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'notes'").get() as
    | { sql: string }
    | undefined;
  if (def && def.sql.includes("'general'")) {
    db.exec(`CREATE TABLE notes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'health_note')),
  private_for_glimmer INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`);
    db.exec(`INSERT INTO notes_new (id, client_id, text, kind, private_for_glimmer, created_at)
  SELECT id, client_id, text,
    CASE kind WHEN 'general' THEN 'note' WHEN 'health' THEN 'health_note' ELSE kind END,
    CASE WHEN kind = 'health' THEN 1 ELSE private_for_glimmer END,
    created_at
  FROM notes`);
    db.exec("DROP TABLE notes");
    db.exec("ALTER TABLE notes_new RENAME TO notes");
    return;
  }
  db.exec("UPDATE notes SET kind = 'note' WHERE kind = 'general'");
  db.exec("UPDATE notes SET kind = 'health_note', private_for_glimmer = 1 WHERE kind = 'health'");
}

/**
 * Demo health notes (David's test allergy). Seeded without the write log so
 * undo_last only ever reverts the user's own writes.
 */
function seedDemoNotes(db: ValeDb, notes: SeedDemoNote[], clientIds: Map<string, number>): void {
  const addNote = db.prepare(
    "INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (?, ?, ?, ?)",
  );
  for (const note of notes) {
    const clientId = clientIds.get(note.client);
    if (clientId === undefined) continue;
    const kind = note.kind === "health_note" || note.kind === "health" ? "health_note" : "note";
    const existing = db
      .prepare("SELECT id FROM notes WHERE client_id = ? AND kind = ?")
      .get(clientId, kind) as { id: number } | undefined;
    if (existing) continue;
    addNote.run(clientId, note.text, kind, note.private === true || kind === "health_note" ? 1 : 0);
  }
}

/** Demo agenda: today's three appointments plus Ana's. Seeded once. */
function seedDemoAppointments(
  db: ValeDb,
  appointments: SeedDemoAppointment[],
  clientIds: Map<string, number>,
  serviceIds: Map<string, number>,
): void {
  if (appointments.length === 0 || tableCount(db, "appointments") > 0) return;
  const add = db.prepare(
    "INSERT INTO appointments (client_id, service_id, day, time, reference_photo) VALUES (?, ?, ?, ?, ?)",
  );
  for (const appointment of appointments) {
    const clientId = clientIds.get(appointment.client);
    const serviceId = serviceIds.get(appointment.service);
    if (clientId === undefined || serviceId === undefined) continue;
    add.run(
      clientId,
      serviceId,
      resolveSeedDay(appointment.day),
      appointment.time,
      appointment.reference_photo ?? "",
    );
  }
}

/**
 * Demo reminders. The shopping reminder links to its shopping_list rows so
 * the shopping logic works even though it never shows in the video.
 */
function seedDemoReminders(
  db: ValeDb,
  reminders: SeedDemoReminder[],
  supplyIds: Map<string, number>,
): void {
  if (reminders.length === 0 || tableCount(db, "reminders") > 0) return;
  const addReminder = db.prepare("INSERT INTO reminders (text, kind, day) VALUES (?, ?, ?)");
  const addShopping = db.prepare("INSERT OR IGNORE INTO shopping_list (supply_id) VALUES (?)");
  const linkItem = db.prepare("INSERT OR IGNORE INTO reminder_items (reminder_id, shopping_list_id) VALUES (?, ?)");
  for (const reminder of reminders) {
    const kind = reminder.kind === "shopping" || reminder.kind === "call" ? reminder.kind : "general";
    const id = Number(
      addReminder.run(reminder.text, kind, resolveSeedDay(reminder.day ?? "today")).lastInsertRowid,
    );
    for (const name of reminder.items ?? []) {
      const supplyId = supplyIds.get(name);
      if (supplyId === undefined) continue;
      addShopping.run(supplyId);
      const listRow = db
        .prepare("SELECT id FROM shopping_list WHERE supply_id = ?")
        .get(supplyId) as { id: number };
      linkItem.run(id, listRow.id);
    }
  }
}

/** Demo visits with photo markers for the full client card. Seeded once. */
function seedDemoVisits(
  db: ValeDb,
  visits: SeedDemoVisit[],
  clientIds: Map<string, number>,
  serviceIds: Map<string, number>,
): void {
  if (visits.length === 0 || tableCount(db, "visits") > 0) return;
  const add = db.prepare(
    "INSERT INTO visits (client_id, service_id, visited_at, photo, note) VALUES (?, ?, ?, ?, ?)",
  );
  for (const visit of visits) {
    const clientId = clientIds.get(visit.client);
    if (clientId === undefined) continue;
    const serviceId = visit.service ? serviceIds.get(visit.service) : undefined;
    add.run(
      clientId,
      serviceId ?? null,
      `${seedDay(-(visit.days_ago ?? 7))}T12:00:00`,
      visit.photo ?? "",
      visit.note ?? "",
    );
  }
}

/**
 * Demo past sessions closed this month so the month goal shows progress.
 * No write_log rows and no supply links: they predate the demo user.
 */
function seedDemoPastSessions(
  db: ValeDb,
  pastSessions: SeedDemoPastSession[],
  clientIds: Map<string, number>,
  serviceIds: Map<string, number>,
): void {
  if (pastSessions.length === 0 || tableCount(db, "sessions") > 0) return;
  const add = db.prepare(
    "INSERT INTO sessions (client_id, service_id, started_at, ended_at, duration_s, margin_earned) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const past of pastSessions) {
    const clientId = clientIds.get(past.client);
    const serviceId = serviceIds.get(past.service);
    if (clientId === undefined || serviceId === undefined) continue;
    const minutes = past.minutes ?? 60;
    const started = pastSessionStart(past.days_ago ?? 1, past.start ?? "10:00");
    add.run(clientId, serviceId, started, addMinutes(started, minutes), minutes * 60, past.margin_earned ?? 0);
  }
}

export interface HistoryTurn {
  role: "user" | "vale";
  text: string;
  tool: string | null;
}

/** Last turns of one conversation, oldest first. */
export const HISTORY_TURNS = 20;

export function recordTurn(
  db: ValeDb,
  clientKey: string,
  role: HistoryTurn["role"],
  text: string,
  tool: string | null = null,
): void {
  // Without a key nothing is saved: "unknown" (or blank) keys used to mix
  // test and headless traffic into Daniel's live turns.
  if (clientKey.trim() === "" || clientKey === "unknown") {
    vlog({
      turn: "-",
      process: "DB",
      status: "error",
      detail: { role },
      content: "refusing turn without client key",
    });
    return;
  }
  db.prepare("INSERT INTO turns (client_key, role, text, tool) VALUES (?, ?, ?, ?)").run(
    clientKey,
    role,
    text,
    tool,
  );
  db.prepare(
    "DELETE FROM turns WHERE client_key = ? AND id NOT IN (SELECT id FROM turns WHERE client_key = ? ORDER BY id DESC LIMIT ?)",
  ).run(clientKey, clientKey, HISTORY_TURNS * 2);
}

export function recentTurns(db: ValeDb, clientKey: string, limit: number = HISTORY_TURNS): HistoryTurn[] {
  const rows = db
    .prepare("SELECT role, text, tool FROM turns WHERE client_key = ? ORDER BY id DESC LIMIT ?")
    .all(clientKey, limit) as unknown as HistoryTurn[];
  return rows.reverse();
}

export function getCounts(db: ValeDb): TableCounts {
  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  };
  return { clients: count("clients"), services: count("services"), supplies: count("supplies") };
}

function toPublicNote(row: {
  id: number;
  kind: string;
  text: string;
  private_for_glimmer: number;
}): PublicNote {
  const kind = row.kind === "health_note" || row.kind === "health" ? "health_note" : "note";
  const masked = row.private_for_glimmer === 1 || kind === "health_note";
  return {
    id: row.id,
    kind,
    text: masked ? null : row.text,
    masked,
  };
}

/**
 * Notes safe to show on screen or send to the cloud model.
 * Health notes stay masked: only the label is exposed, never the text.
 */
export function getPublicNotes(db: ValeDb, clientId: number): PublicNote[] {
  const rows = db
    .prepare("SELECT id, kind, text, private_for_glimmer FROM notes WHERE client_id = ? ORDER BY id")
    .all(clientId) as { id: number; kind: string; text: string; private_for_glimmer: number }[];
  return rows.map(toPublicNote);
}

let shared: ValeDb | null = null;

/** Open the file database, or fall back to a seeded in-memory copy. */
export function getDb(): ValeDb {
  if (shared) return shared;
  if (process.env.VALE_DB_MEMORY === "1") {
    shared = new DatabaseSync(":memory:");
    seedDatabase(shared);
    vlog({
      turn: "-",
      process: "DB",
      status: "ok",
      content: "VALE_DB_MEMORY=1; using in-memory seed",
    });
    return shared;
  }
  if (process.env.VITEST === "true") {
    throw new Error(
      "[vale-db] refusing the file database under vitest; tests use VALE_DB_MEMORY=1 or a tmp file",
    );
  }
  try {
    const file = resolveDbFile();
    mkdirSync(dirname(file), { recursive: true });
    shared = new DatabaseSync(file);
    seedDatabase(shared);
    return shared;
  } catch {
    shared = new DatabaseSync(":memory:");
    seedDatabase(shared);
    vlog({
      turn: "-",
      process: "DB",
      status: "ok",
      content: "writable FS unavailable; using in-memory seed",
    });
    return shared;
  }
}

/** Fresh seeded in-memory database for tests. */
export function freshTestDb(): ValeDb {
  const db = new DatabaseSync(":memory:");
  seedDatabase(db);
  return db;
}
