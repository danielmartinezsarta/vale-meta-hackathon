// Server-side only: holds the SQLite database. Never import from client code.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import seedData from "./seed-data.json";
import { quotePrice, type PricingConfig } from "./quote";

export type ValeDb = DatabaseSync;

export const DB_FILE = join(process.cwd(), "data", "vale.db");

// Placeholder shown wherever a private health note would appear.
// The real text never leaves this module toward the cloud.
export const PRIVATE_NOTE_LABEL = "nota privada 🔒";

export interface PublicNote {
  id: number;
  kind: "general" | "health";
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

/** Add a column when an older database file lacks it. */
function ensureColumn(db: ValeDb, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
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
  ensureColumn(db, "services", "es", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "services", "aliases", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "supplies", "es", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "supplies", "aliases", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "supplies", "unit", "TEXT NOT NULL DEFAULT 'pcs'");
  ensureColumn(db, "supplies", "content_per_product", "REAL NOT NULL DEFAULT 1");
  ensureColumn(db, "supplies", "stock_qty", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "supplies", "min_qty", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "supplies", "price_per_product_usd", "REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "sessions", "margin_earned", "REAL");

  const seed = seedData as unknown as { clients: string[]; services: SeedService[]; supplies: SeedSupply[] };
  const addClient = db.prepare("INSERT OR IGNORE INTO clients (name) VALUES (?)");
  for (const name of seed.clients) addClient.run(name);
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
  for (const service of seed.services) {
    upsertService.run(
      service.name,
      service.es ?? "",
      JSON.stringify(service.aliases ?? []),
      Math.round(seedServicePrice(service) * 100),
      service.minutes,
    );
    const row = db.prepare("SELECT id FROM services WHERE name = ?").get(service.name) as { id: number };
    db.prepare("DELETE FROM service_supplies WHERE service_id = ?").run(row.id);
    const addLine = db.prepare("INSERT INTO service_supplies (service_id, supply_id, qty, unit) VALUES (?, ?, ?, ?)");
    for (const line of service.supplies ?? []) {
      const supplyId = supplyIds.get(line.name);
      if (supplyId !== undefined) addLine.run(row.id, supplyId, line.qty, line.unit ?? "pcs");
    }
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
    console.warn(`[vale-db] refusing turn without client key (role=${role})`);
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
  const masked = row.private_for_glimmer === 1 || row.kind === "health";
  return {
    id: row.id,
    kind: row.kind === "health" ? "health" : "general",
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
    console.log("[vale-db] VALE_DB_MEMORY=1; using in-memory seed");
    return shared;
  }
  if (process.env.VITEST === "true") {
    throw new Error(
      "[vale-db] refusing the file database under vitest; tests use VALE_DB_MEMORY=1 or a tmp file",
    );
  }
  try {
    mkdirSync(dirname(DB_FILE), { recursive: true });
    shared = new DatabaseSync(DB_FILE);
    seedDatabase(shared);
    return shared;
  } catch {
    shared = new DatabaseSync(":memory:");
    seedDatabase(shared);
    console.log("[vale-db] writable FS unavailable; using in-memory seed");
    return shared;
  }
}

/** Fresh seeded in-memory database for tests. */
export function freshTestDb(): ValeDb {
  const db = new DatabaseSync(":memory:");
  seedDatabase(db);
  return db;
}
