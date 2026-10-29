// Server-side only: holds the SQLite database. Never import from client code.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import seedData from "./seed-data.json";

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

function schemaSql(): string {
  return readFileSync(join(process.cwd(), "src", "lib", "schema.sql"), "utf8");
}

/** Create tables and insert the invented seed. Idempotent. */
export function seedDatabase(db: ValeDb): void {
  db.exec(schemaSql());
  const addClient = db.prepare("INSERT OR IGNORE INTO clients (name) VALUES (?)");
  for (const name of seedData.clients) addClient.run(name);
  const addService = db.prepare(
    "INSERT OR IGNORE INTO services (name, price_cents, duration_min) VALUES (?, ?, ?)",
  );
  for (const service of seedData.services) {
    addService.run(service.name, service.price_cents, service.duration_min);
  }
  const addSupply = db.prepare("INSERT OR IGNORE INTO supplies (name) VALUES (?)");
  for (const name of seedData.supplies) addSupply.run(name);
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
