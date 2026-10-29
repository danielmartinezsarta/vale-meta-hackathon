// The 8 HACK-002 tools plus undo_last_write, over the SQLite database.
// Server-side only: executors run here; only short speakable results and
// masked public notes ever reach the model. Private health-note text never
// leaves this module toward the cloud.
import { getPublicNotes, type PublicNote, type ValeDb } from "./db";

export interface ValeToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  message: string;
  data?: unknown;
  /** Set when the tool needs a yes/no from the user before writing. */
  pendingCreate?: string;
}

interface Named {
  id: number;
  name: string;
}

type Match =
  | { kind: "match"; row: Named; how: "exact" | "prefix" | "contains" }
  | { kind: "ambiguous"; options: Named[] }
  | { kind: "none" };

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Deterministic name lookup: exact, then prefix, then substring. */
export function matchOne(candidates: Named[], query: string): Match {
  const wanted = normalizeName(query);
  if (wanted === "") return { kind: "none" };
  const exact = candidates.filter((item) => normalizeName(item.name) === wanted);
  if (exact.length === 1) return { kind: "match", row: exact[0], how: "exact" };
  if (exact.length > 1) return { kind: "ambiguous", options: exact.slice(0, 3) };
  const prefixed = candidates.filter((item) => normalizeName(item.name).startsWith(wanted));
  if (prefixed.length === 1) return { kind: "match", row: prefixed[0], how: "prefix" };
  if (prefixed.length > 1) return { kind: "ambiguous", options: prefixed.slice(0, 3) };
  const contained = candidates.filter((item) => normalizeName(item.name).includes(wanted));
  if (contained.length === 1) return { kind: "match", row: contained[0], how: "contains" };
  if (contained.length > 1) return { kind: "ambiguous", options: contained.slice(0, 3) };
  return { kind: "none" };
}

function ambiguousMessage(options: Named[]): string {
  return `¿Cuál: ${options.map((item) => item.name).join(" o ")}?`;
}

function allClients(db: ValeDb): Named[] {
  return db.prepare("SELECT id, name FROM clients ORDER BY id").all() as unknown as Named[];
}

function allServices(db: ValeDb): Named[] {
  return db.prepare("SELECT id, name FROM services ORDER BY id").all() as unknown as Named[];
}

function allSupplies(db: ValeDb): Named[] {
  return db.prepare("SELECT id, name FROM supplies ORDER BY id").all() as unknown as Named[];
}

function logWrite(db: ValeDb, action: string, tableName: string, rowId: number, extra?: unknown): void {
  db.prepare("INSERT INTO write_log (action, table_name, row_id, extra) VALUES (?, ?, ?, ?)").run(
    action,
    tableName,
    rowId,
    extra === undefined ? null : JSON.stringify(extra),
  );
}

interface OpenSessionRow {
  id: number;
  client_id: number;
  service_id: number;
  started_at: string;
}

export function getOpenSession(db: ValeDb): OpenSessionRow | null {
  const row = db
    .prepare("SELECT id, client_id, service_id, started_at FROM sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1")
    .get() as OpenSessionRow | undefined;
  return row ?? null;
}

export function clientLabel(db: ValeDb, id: number): string {
  const row = db.prepare("SELECT name FROM clients WHERE id = ?").get(id) as { name: string };
  return row.name;
}

const noParams = { type: "object", properties: {}, required: [] as string[] };

export const VALE_TOOLS: ValeToolDefinition[] = [
  {
    type: "function",
    name: "open_session",
    description: "Open a nail session with a timer for a client and a service.",
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Client name, approximate is fine." },
        service_name: { type: "string", description: "Service name, approximate is fine." },
      },
      required: ["client_name", "service_name"],
    },
  },
  {
    type: "function",
    name: "close_session",
    description: "Close the open session, saving its real duration and used products.",
    parameters: {
      type: "object",
      properties: {
        products_used: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "find_client",
    description: "Look up a client by approximate name. Never invents a client.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "add_note",
    description: "Save a note on the client card. Health notes stay private.",
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        text: { type: "string" },
        kind: { type: "string", description: "general or health" },
      },
      required: ["client_name", "text"],
    },
  },
  {
    type: "function",
    name: "add_to_shopping_list",
    description: "Add a supply reminder to the shopping list.",
    parameters: {
      type: "object",
      properties: { item_name: { type: "string" } },
      required: ["item_name"],
    },
  },
  {
    type: "function",
    name: "read_shopping_list",
    description: "Read the current shopping list.",
    parameters: noParams,
  },
  {
    type: "function",
    name: "create_client",
    description: "Register a new client with an empty card.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "log_supply_use",
    description: "Record a supply used in the open session.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        confirm_create: { type: "boolean", description: "Set true only after the user said yes to creating it." },
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "undo_last_write",
    description: "Undo the most recent write.",
    parameters: noParams,
  },
];

export function openSession(db: ValeDb, args: { client_name?: unknown; service_name?: unknown }): ToolResult {
  if (getOpenSession(db)) return { ok: false, message: "Ya hay una sesión abierta." };
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const serviceName = typeof args.service_name === "string" ? args.service_name : "";
  const client = matchOne(allClients(db), clientName);
  if (client.kind === "none") return { ok: false, message: `No encuentro a "${clientName}".` };
  if (client.kind === "ambiguous") return { ok: false, message: ambiguousMessage(client.options) };
  const service = matchOne(allServices(db), serviceName);
  if (service.kind === "none") return { ok: false, message: `No encuentro el servicio "${serviceName}".` };
  if (service.kind === "ambiguous") return { ok: false, message: ambiguousMessage(service.options) };
  const startedAt = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO sessions (client_id, service_id, started_at) VALUES (?, ?, ?)")
    .run(client.row.id, service.row.id, startedAt);
  logWrite(db, "open_session", "sessions", Number(result.lastInsertRowid));
  return { ok: true, message: `Sesión abierta con ${client.row.name}.`, data: { session_id: Number(result.lastInsertRowid) } };
}

export function closeSession(db: ValeDb, args: { products_used?: unknown }): ToolResult {
  const open = getOpenSession(db);
  if (!open) return { ok: false, message: "No hay sesión abierta." };
  const products = Array.isArray(args.products_used)
    ? args.products_used.filter((item): item is string => typeof item === "string")
    : [];
  const supplies = allSupplies(db);
  const recorded: string[] = [];
  const recordedIds: number[] = [];
  const unknown: string[] = [];
  for (const product of products) {
    const found = matchOne(supplies, product);
    if (found.kind === "match") {
      db.prepare("INSERT OR IGNORE INTO session_supplies (session_id, supply_id) VALUES (?, ?)").run(open.id, found.row.id);
      recorded.push(found.row.name);
      recordedIds.push(found.row.id);
    } else {
      unknown.push(product);
    }
  }
  const endedAt = new Date().toISOString();
  const started = db.prepare("SELECT started_at FROM sessions WHERE id = ?").get(open.id) as { started_at: string };
  const durationS = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(started.started_at)) / 1000));
  db.prepare("UPDATE sessions SET ended_at = ?, duration_s = ? WHERE id = ?").run(endedAt, durationS, open.id);
  logWrite(db, "close_session", "sessions", open.id, { supplies: recordedIds });
  const minutes = Math.max(1, Math.round(durationS / 60));
  let message = `Sesión cerrada. Duró ${minutes} minutos.`;
  if (recorded.length > 0) message += ` Anoté: ${recorded.join(", ")}.`;
  if (unknown.length > 0) message += ` No encontré: ${unknown.join(", ")}.`;
  return { ok: true, message, data: { duration_s: durationS, recorded, unknown } };
}

export interface ClientCard {
  id: number;
  name: string;
  notes: PublicNote[];
}

export function findClient(db: ValeDb, args: { name?: unknown }): ToolResult & { card?: ClientCard } {
  const name = typeof args.name === "string" ? args.name : "";
  const found = matchOne(allClients(db), name);
  if (found.kind === "none") return { ok: false, message: `No encuentro a "${name}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const card: ClientCard = { id: found.row.id, name: found.row.name, notes: getPublicNotes(db, found.row.id) };
  return { ok: true, message: `Esta es la ficha de ${found.row.name}.`, data: card, card };
}

export function addNote(db: ValeDb, args: { client_name?: unknown; text?: unknown; kind?: unknown }): ToolResult {
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (text === "") return { ok: false, message: "La nota está vacía." };
  const kind = args.kind === "health" ? "health" : "general";
  const found = matchOne(allClients(db), clientName);
  if (found.kind === "none") return { ok: false, message: `No encuentro a "${clientName}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const result = db
    .prepare("INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (?, ?, ?, ?)")
    .run(found.row.id, text, kind, kind === "health" ? 1 : 0);
  logWrite(db, "add_note", "notes", Number(result.lastInsertRowid));
  // The result never carries the note text back: health text must not re-enter the model context.
  if (kind === "health") return { ok: true, message: "Nota privada guardada.", data: { note_id: Number(result.lastInsertRowid), private: true } };
  return { ok: true, message: `Nota guardada en la ficha de ${found.row.name}.`, data: { note_id: Number(result.lastInsertRowid), private: false } };
}

export function addToShoppingList(db: ValeDb, args: { item_name?: unknown }): ToolResult {
  const item = typeof args.item_name === "string" ? args.item_name : "";
  const found = matchOne(allSupplies(db), item);
  if (found.kind === "none") return { ok: false, message: `No conozco el insumo "${item}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const existing = db.prepare("SELECT id FROM shopping_list WHERE supply_id = ?").get(found.row.id) as { id: number } | undefined;
  if (existing) return { ok: true, message: `${found.row.name} ya está en la lista.`, data: { already: true } };
  const result = db.prepare("INSERT INTO shopping_list (supply_id) VALUES (?)").run(found.row.id);
  logWrite(db, "add_to_shopping_list", "shopping_list", Number(result.lastInsertRowid));
  return { ok: true, message: `${found.row.name} agregado a la lista.` };
}

export function readShoppingList(db: ValeDb): ToolResult {
  const rows = db
    .prepare("SELECT s.name FROM shopping_list l JOIN supplies s ON s.id = l.supply_id ORDER BY l.id")
    .all() as { name: string }[];
  const items = rows.map((row) => row.name);
  if (items.length === 0) return { ok: true, message: "La lista está vacía.", data: { items } };
  return { ok: true, message: `En la lista: ${items.join(", ")}.`, data: { items } };
}

export function createClient(db: ValeDb, args: { name?: unknown }): ToolResult {
  const name = typeof args.name === "string" ? args.name.trim().replace(/\s+/g, " ") : "";
  if (name === "") return { ok: false, message: "Falta el nombre de la clienta." };
  const found = matchOne(allClients(db), name);
  if (found.kind === "match") return { ok: false, message: `${found.row.name} ya está registrada.` };
  if (found.kind === "ambiguous") return { ok: false, message: `${found.options[0].name} ya está registrada.` };
  const result = db.prepare("INSERT INTO clients (name) VALUES (?)").run(name);
  logWrite(db, "create_client", "clients", Number(result.lastInsertRowid));
  return { ok: true, message: `${name} registrada.`, data: { client_id: Number(result.lastInsertRowid) } };
}

export function logSupplyUse(db: ValeDb, args: { name?: unknown; confirm_create?: unknown }): ToolResult {
  const open = getOpenSession(db);
  if (!open) return { ok: false, message: "No hay sesión abierta." };
  const name = typeof args.name === "string" ? args.name.trim().replace(/\s+/g, " ") : "";
  if (name === "") return { ok: false, message: "Falta el nombre del insumo." };
  const found = matchOne(allSupplies(db), name);
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  if (found.kind === "match") {
    const link = db
      .prepare("INSERT OR IGNORE INTO session_supplies (session_id, supply_id) VALUES (?, ?)")
      .run(open.id, found.row.id);
    logWrite(db, "log_supply_use", "session_supplies", open.id, { supply_id: found.row.id, auto_created: false });
    if (link.changes === 0) return { ok: true, message: `${found.row.name} ya estaba anotado.` };
    return { ok: true, message: `${found.row.name} anotado en la sesión.` };
  }
  if (args.confirm_create === true) {
    const created = db.prepare("INSERT INTO supplies (name) VALUES (?)").run(name);
    const supplyId = Number(created.lastInsertRowid);
    db.prepare("INSERT OR IGNORE INTO session_supplies (session_id, supply_id) VALUES (?, ?)").run(open.id, supplyId);
    logWrite(db, "log_supply_use", "session_supplies", open.id, { supply_id: supplyId, auto_created: true });
    return { ok: true, message: `${name} creado y anotado en la sesión.` };
  }
  return { ok: false, message: `No encuentro "${name}". ¿lo creo y lo anoto en la sesión?`, pendingCreate: name };
}

const UNDO_LABELS: Record<string, string> = {
  open_session: "apertura de sesión",
  close_session: "cierre de sesión",
  add_note: "nota agregada",
  add_to_shopping_list: "agregado a la lista",
  create_client: "clienta registrada",
  log_supply_use: "insumo anotado",
};

export function undoLastWrite(db: ValeDb): ToolResult {
  const entry = db.prepare("SELECT id, action, table_name, row_id, extra FROM write_log WHERE undone = 0 ORDER BY id DESC LIMIT 1").get() as
    | { id: number; action: string; table_name: string; row_id: number; extra: string | null }
    | undefined;
  if (!entry) return { ok: false, message: "No hay nada que deshacer." };
  const extra = entry.extra ? (JSON.parse(entry.extra) as { supply_id?: number; supplies?: number[]; auto_created?: boolean }) : {};
  switch (entry.action) {
    case "open_session":
      db.prepare("DELETE FROM session_supplies WHERE session_id = ?").run(entry.row_id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(entry.row_id);
      break;
    case "close_session": {
      const ids = Array.isArray(extra.supplies) ? extra.supplies : [];
      for (const supplyId of ids) {
        db.prepare("DELETE FROM session_supplies WHERE session_id = ? AND supply_id = ?").run(entry.row_id, supplyId);
      }
      db.prepare("UPDATE sessions SET ended_at = NULL, duration_s = NULL WHERE id = ?").run(entry.row_id);
      break;
    }
    case "add_note":
      db.prepare("DELETE FROM notes WHERE id = ?").run(entry.row_id);
      break;
    case "add_to_shopping_list":
      db.prepare("DELETE FROM shopping_list WHERE id = ?").run(entry.row_id);
      break;
    case "create_client": {
      const notes = db.prepare("SELECT COUNT(*) AS n FROM notes WHERE client_id = ?").get(entry.row_id) as { n: number };
      const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE client_id = ?").get(entry.row_id) as { n: number };
      if (notes.n > 0 || sessions.n > 0) return { ok: false, message: "No se puede deshacer." };
      db.prepare("DELETE FROM clients WHERE id = ?").run(entry.row_id);
      break;
    }
    case "log_supply_use": {
      const supplyId = typeof extra.supply_id === "number" ? extra.supply_id : null;
      if (supplyId !== null) {
        db.prepare("DELETE FROM session_supplies WHERE session_id = ? AND supply_id = ?").run(entry.row_id, supplyId);
        if (extra.auto_created === true) {
          const refs = db.prepare("SELECT COUNT(*) AS n FROM session_supplies WHERE supply_id = ?").get(supplyId) as { n: number };
          const listed = db.prepare("SELECT COUNT(*) AS n FROM shopping_list WHERE supply_id = ?").get(supplyId) as { n: number };
          if (refs.n === 0 && listed.n === 0) db.prepare("DELETE FROM supplies WHERE id = ?").run(supplyId);
        }
      }
      break;
    }
    default:
      return { ok: false, message: "No se puede deshacer." };
  }
  db.prepare("UPDATE write_log SET undone = 1 WHERE id = ?").run(entry.id);
  return { ok: true, message: `Deshecho: ${UNDO_LABELS[entry.action] ?? entry.action}.` };
}

export function runValeTool(db: ValeDb, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case "open_session":
      return openSession(db, args);
    case "close_session":
      return closeSession(db, args);
    case "find_client":
      return findClient(db, args);
    case "add_note":
      return addNote(db, args);
    case "create_client":
      return createClient(db, args);
    case "add_to_shopping_list":
      return addToShoppingList(db, args);
    case "read_shopping_list":
      return readShoppingList(db);
    case "log_supply_use":
      return logSupplyUse(db, args);
    case "undo_last_write":
      return undoLastWrite(db);
    default:
      return { ok: false, message: "Herramienta desconocida." };
  }
}
