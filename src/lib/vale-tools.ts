// The 8 HACK-002 tools plus undo_last_write, over the SQLite database.
// Server-side only: executors run here; only short speakable results and
// masked public notes ever reach the model. Private health-note text never
// leaves this module toward the cloud.
import { PRICING, getPublicNotes, type PublicNote, type ValeDb } from "./db";
import { money, quotePrice } from "./quote";
import type { ValeLanguage } from "./vale-language";

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
  /** Set when an off-hours booking waits for the user's yes. */
  pendingOffHours?: boolean;
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

export function allClients(db: ValeDb): Named[] {
  return db.prepare("SELECT id, name FROM clients ORDER BY id").all() as unknown as Named[];
}

export function allServices(db: ValeDb): Named[] {
  return db.prepare("SELECT id, name FROM services ORDER BY id").all() as unknown as Named[];
}

export function allSupplies(db: ValeDb): Named[] {
  return db.prepare("SELECT id, name FROM supplies ORDER BY id").all() as unknown as Named[];
}

interface Aliased {
  id: number;
  name: string;
  es: string;
  aliases: string[];
}

/** Name lookup over the canonical name plus the Spanish name and aliases. */
export function matchAliased(candidates: Aliased[], query: string): Match {
  const wanted = normalizeName(query);
  if (wanted === "") return { kind: "none" };
  const namesOf = (item: Aliased): string[] => [item.name, item.es, ...item.aliases].filter((text) => text !== "");
  const hit = (mode: "exact" | "prefix" | "contains"): Aliased[] => {
    const seen = new Map<number, Aliased>();
    for (const item of candidates) {
      const hitName = namesOf(item).some((text) => {
        const plain = normalizeName(text);
        return mode === "exact" ? plain === wanted : mode === "prefix" ? plain.startsWith(wanted) : plain.includes(wanted);
      });
      if (hitName && !seen.has(item.id)) seen.set(item.id, item);
    }
    return [...seen.values()];
  };
  const exact = hit("exact");
  if (exact.length === 1) return { kind: "match", row: exact[0], how: "exact" };
  if (exact.length > 1) return { kind: "ambiguous", options: exact.slice(0, 3) };
  const prefixed = hit("prefix");
  if (prefixed.length === 1) return { kind: "match", row: prefixed[0], how: "prefix" };
  if (prefixed.length > 1) return { kind: "ambiguous", options: prefixed.slice(0, 3) };
  const contained = hit("contains");
  if (contained.length === 1) return { kind: "match", row: contained[0], how: "contains" };
  if (contained.length > 1) return { kind: "ambiguous", options: contained.slice(0, 3) };
  return { kind: "none" };
}

function aliasedRows(db: ValeDb, table: "services" | "supplies"): Aliased[] {
  const rows = db.prepare(`SELECT id, name, es, aliases FROM ${table} ORDER BY id`).all() as {
    id: number;
    name: string;
    es: string;
    aliases: string;
  }[];
  return rows.map((row) => {
    let aliases: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.aliases || "[]");
      if (Array.isArray(parsed)) aliases = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      aliases = [];
    }
    return { id: row.id, name: row.name, es: row.es || "", aliases };
  });
}

function matchService(db: ValeDb, query: string): Match {
  return matchAliased(aliasedRows(db, "services"), query);
}

function matchSupply(db: ValeDb, query: string): Match {
  return matchAliased(aliasedRows(db, "supplies"), query);
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
  {
    type: "function",
    name: "quote_price",
    description: "Price a service with its supply, time and fixed cost plus margin. Read-only.",
    parameters: {
      type: "object",
      properties: {
        service_name: { type: "string", description: "Service name, in English or Spanish." },
        supply_names: {
          type: "array",
          items: { type: "string" },
          description: "Optional supply override; defaults to the service recipe.",
        },
      },
      required: ["service_name"],
    },
  },
  {
    type: "function",
    name: "goal_progress",
    description: "Report the month margin earned toward the goal.",
    parameters: noParams,
  },
  {
    type: "function",
    name: "create_appointment",
    description: "Book an appointment for an existing client and service.",
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        service_name: { type: "string" },
        day: { type: "string", description: "Date as YYYY-MM-DD." },
        time: { type: "string", description: "Time as HH:MM, 24 hours." },
        confirm_off_hours: {
          type: "boolean",
          description: "Set true only after the user said yes to an off-hours booking.",
        },
      },
      required: ["client_name", "service_name", "day", "time"],
    },
  },
  {
    type: "function",
    name: "list_today",
    description: "List today's appointments.",
    parameters: noParams,
  },
  {
    type: "function",
    name: "next_appointment",
    description: "Show the next appointment today from now.",
    parameters: noParams,
  },
  {
    type: "function",
    name: "move_appointment",
    description: "Move a client's appointment to a new day and time.",
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        new_day: { type: "string", description: "Date as YYYY-MM-DD." },
        new_time: { type: "string", description: "Time as HH:MM, 24 hours." },
      },
      required: ["client_name", "new_day", "new_time"],
    },
  },
  {
    type: "function",
    name: "set_stock",
    description: "Set a supply stock to an exact quantity.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Supply name, in English or Spanish." },
        qty: { type: "number", description: "Exact quantity left." },
      },
      required: ["name", "qty"],
    },
  },
  {
    type: "function",
    name: "add_stock",
    description: "Add a bought quantity to a supply stock.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Supply name, in English or Spanish." },
        qty: { type: "number", description: "Quantity bought." },
      },
      required: ["name", "qty"],
    },
  },
  {
    type: "function",
    name: "read_stock",
    description: "Report supplies at or below their minimum.",
    parameters: noParams,
  },
];

export function openSession(db: ValeDb, args: { client_name?: unknown; service_name?: unknown }, language: ValeLanguage = "es"): ToolResult {
  if (getOpenSession(db)) return { ok: false, message: "Ya hay una sesión abierta." };
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const serviceName = typeof args.service_name === "string" ? args.service_name : "";
  const client = matchOne(allClients(db), clientName);
  if (client.kind === "none") return { ok: false, message: `No encuentro a "${clientName}".` };
  if (client.kind === "ambiguous") return { ok: false, message: ambiguousMessage(client.options) };
  const service = matchService(db, serviceName);
  if (service.kind === "none") return { ok: false, message: `No encuentro el servicio "${serviceName}".` };
  if (service.kind === "ambiguous") return { ok: false, message: ambiguousMessage(service.options) };
  const startedAt = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO sessions (client_id, service_id, started_at) VALUES (?, ?, ?)")
    .run(client.row.id, service.row.id, startedAt);
  logWrite(db, "open_session", "sessions", Number(result.lastInsertRowid));
  return { ok: true, message: language === "en" ? `Session open with ${client.row.name}.` : `Sesión abierta con ${client.row.name}.`, data: { session_id: Number(result.lastInsertRowid) } };
}

export function closeSession(db: ValeDb, args: { products_used?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const open = getOpenSession(db);
  if (!open) return { ok: false, message: "No hay sesión abierta." };
  const products = Array.isArray(args.products_used)
    ? args.products_used.filter((item): item is string => typeof item === "string")
    : [];
  const recorded: string[] = [];
  const recordedIds: number[] = [];
  const unknown: string[] = [];
  for (const product of products) {
    const found = matchSupply(db, product);
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
  const minutes = Math.max(1, Math.round(durationS / 60));
  const service = db.prepare("SELECT id FROM services WHERE id = ?").get(open.service_id) as { id: number };
  const earned = quotePrice(
    PRICING,
    minutes,
    recipeForService(db, service.id).map((line) => ({
      qty: line.qty,
      pricePerProductUsd: line.price_per_product_usd,
      contentPerProduct: line.content_per_product,
    })),
  ).marginEarned;
  db.prepare("UPDATE sessions SET ended_at = ?, duration_s = ?, margin_earned = ? WHERE id = ?").run(endedAt, durationS, earned, open.id);
  logWrite(db, "close_session", "sessions", open.id, { supplies: recordedIds });
  let message = language === "en" ? `Session closed. It lasted ${minutes} minutes.` : `Sesión cerrada. Duró ${minutes} minutos.`;
  if (recorded.length > 0) message += language === "en" ? ` Logged: ${recorded.join(", ")}.` : ` Anoté: ${recorded.join(", ")}.`;
  if (unknown.length > 0) message += language === "en" ? ` Not found: ${unknown.join(", ")}.` : ` No encontré: ${unknown.join(", ")}.`;
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

export function addNote(db: ValeDb, args: { client_name?: unknown; text?: unknown; kind?: unknown }, language: ValeLanguage = "es"): ToolResult {
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
  if (kind === "health") return { ok: true, message: language === "en" ? "Private note saved." : "Nota privada guardada.", data: { note_id: Number(result.lastInsertRowid), private: true } };
  return { ok: true, message: language === "en" ? `Note saved on ${found.row.name}'s card.` : `Nota guardada en la ficha de ${found.row.name}.`, data: { note_id: Number(result.lastInsertRowid), private: false } };
}

export function addToShoppingList(db: ValeDb, args: { item_name?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const item = typeof args.item_name === "string" ? args.item_name : "";
  const found = matchSupply(db, item);
  if (found.kind === "none") return { ok: false, message: `No conozco el insumo "${item}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const existing = db.prepare("SELECT id FROM shopping_list WHERE supply_id = ?").get(found.row.id) as { id: number } | undefined;
  if (existing) return { ok: true, message: language === "en" ? `${found.row.name} is already on the list.` : `${found.row.name} ya está en la lista.`, data: { already: true } };
  const result = db.prepare("INSERT INTO shopping_list (supply_id) VALUES (?)").run(found.row.id);
  logWrite(db, "add_to_shopping_list", "shopping_list", Number(result.lastInsertRowid));
  return { ok: true, message: language === "en" ? `${found.row.name} added to the list.` : `${found.row.name} agregado a la lista.` };
}

export function readShoppingList(db: ValeDb): ToolResult {
  const rows = db
    .prepare("SELECT s.name FROM shopping_list l JOIN supplies s ON s.id = l.supply_id ORDER BY l.id")
    .all() as { name: string }[];
  const items = rows.map((row) => row.name);
  if (items.length === 0) return { ok: true, message: "La lista está vacía.", data: { items } };
  return { ok: true, message: `En la lista: ${items.join(", ")}.`, data: { items } };
}

export function createClient(db: ValeDb, args: { name?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const name = typeof args.name === "string" ? args.name.trim().replace(/\s+/g, " ") : "";
  if (name === "") return { ok: false, message: "Falta el nombre de la clienta." };
  const found = matchOne(allClients(db), name);
  if (found.kind === "match") return { ok: false, message: `${found.row.name} ya está registrada.` };
  if (found.kind === "ambiguous") return { ok: false, message: `${found.options[0].name} ya está registrada.` };
  const result = db.prepare("INSERT INTO clients (name) VALUES (?)").run(name);
  logWrite(db, "create_client", "clients", Number(result.lastInsertRowid));
  return { ok: true, message: language === "en" ? `${name} registered.` : `${name} registrada.`, data: { client_id: Number(result.lastInsertRowid) } };
}

export function logSupplyUse(db: ValeDb, args: { name?: unknown; confirm_create?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const open = getOpenSession(db);
  if (!open) return { ok: false, message: "No hay sesión abierta." };
  const name = typeof args.name === "string" ? args.name.trim().replace(/\s+/g, " ") : "";
  if (name === "") return { ok: false, message: "Falta el nombre del insumo." };
  const found = matchSupply(db, name);
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  if (found.kind === "match") {
    const link = db
      .prepare("INSERT OR IGNORE INTO session_supplies (session_id, supply_id) VALUES (?, ?)")
      .run(open.id, found.row.id);
    logWrite(db, "log_supply_use", "session_supplies", open.id, { supply_id: found.row.id, auto_created: false });
    if (link.changes === 0) return { ok: true, message: language === "en" ? `${found.row.name} was already logged.` : `${found.row.name} ya estaba anotado.` };
    return { ok: true, message: language === "en" ? `${found.row.name} logged for the session.` : `${found.row.name} anotado en la sesión.` };
  }
  if (args.confirm_create === true) {
    const created = db.prepare("INSERT INTO supplies (name) VALUES (?)").run(name);
    const supplyId = Number(created.lastInsertRowid);
    db.prepare("INSERT OR IGNORE INTO session_supplies (session_id, supply_id) VALUES (?, ?)").run(open.id, supplyId);
    logWrite(db, "log_supply_use", "session_supplies", open.id, { supply_id: supplyId, auto_created: true });
    return { ok: true, message: language === "en" ? `${name} created and logged for the session.` : `${name} creado y anotado en la sesión.` };
  }
  return { ok: false, message: `No encuentro "${name}". ¿lo creo y lo anoto en la sesión?`, pendingCreate: name };
}

const UNDO_LABELS: Record<ValeLanguage, Record<string, string>> = {
  es: {
  open_session: "apertura de sesión",
  close_session: "cierre de sesión",
  add_note: "nota agregada",
  add_to_shopping_list: "agregado a la lista",
  create_client: "clienta registrada",
  log_supply_use: "insumo anotado",
  create_appointment: "cita guardada",
  move_appointment: "cita movida",
  set_stock: "cambio de stock",
  add_stock: "entrada de stock",
  },
  en: {
  open_session: "session opening",
  close_session: "session closing",
  add_note: "added note",
  add_to_shopping_list: "list addition",
  create_client: "registered client",
  log_supply_use: "logged supply",
  create_appointment: "saved appointment",
  move_appointment: "moved appointment",
  set_stock: "stock change",
  add_stock: "stock entry",
  },
};

export function undoLastWrite(db: ValeDb, language: ValeLanguage = "es"): ToolResult {
  const entry = db.prepare("SELECT id, action, table_name, row_id, extra FROM write_log WHERE undone = 0 ORDER BY id DESC LIMIT 1").get() as
    | { id: number; action: string; table_name: string; row_id: number; extra: string | null }
    | undefined;
  if (!entry) return { ok: false, message: "No hay nada que deshacer." };
  const extra = entry.extra
    ? (JSON.parse(entry.extra) as {
        supply_id?: number;
        supplies?: number[];
        auto_created?: boolean;
        prev_day?: string;
        prev_time?: string;
        prev_qty?: number;
      })
    : {};
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
      db.prepare("UPDATE sessions SET ended_at = NULL, duration_s = NULL, margin_earned = NULL WHERE id = ?").run(entry.row_id);
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
    case "create_appointment":
      db.prepare("DELETE FROM appointments WHERE id = ?").run(entry.row_id);
      break;
    case "move_appointment": {
      const prevDay = typeof extra.prev_day === "string" ? extra.prev_day : null;
      const prevTime = typeof extra.prev_time === "string" ? extra.prev_time : null;
      if (prevDay === null || prevTime === null) return { ok: false, message: "No se puede deshacer." };
      db.prepare("UPDATE appointments SET day = ?, time = ? WHERE id = ?").run(prevDay, prevTime, entry.row_id);
      break;
    }
    case "set_stock":
    case "add_stock": {
      const prevQty = typeof extra.prev_qty === "number" ? extra.prev_qty : null;
      if (prevQty === null) return { ok: false, message: "No se puede deshacer." };
      db.prepare("UPDATE supplies SET stock_qty = ? WHERE id = ?").run(prevQty, entry.row_id);
      break;
    }
    default:
      return { ok: false, message: "No se puede deshacer." };
  }
  db.prepare("UPDATE write_log SET undone = 1 WHERE id = ?").run(entry.id);
  return { ok: true, message: language === "en" ? `Undone: ${UNDO_LABELS.en[entry.action] ?? entry.action}.` : `Deshecho: ${UNDO_LABELS.es[entry.action] ?? entry.action}.` };
}

interface RecipeLine {
  supply_id: number;
  name: string;
  es: string;
  qty: number;
  price_per_product_usd: number;
  content_per_product: number;
}

function recipeForService(db: ValeDb, serviceId: number): RecipeLine[] {
  return db
    .prepare(
      `SELECT s.id AS supply_id, s.name, s.es, l.qty, s.price_per_product_usd, s.content_per_product
       FROM service_supplies l JOIN supplies s ON s.id = l.supply_id
       WHERE l.service_id = ? ORDER BY l.rowid`,
    )
    .all(serviceId) as unknown as RecipeLine[];
}

/**
 * quote_price: read-only. Uses the open session minutes when it belongs
 * to the quoted service, otherwise the service seed minutes.
 */
export function quotePriceTool(db: ValeDb, args: { service_name?: unknown; supply_names?: unknown }): ToolResult {
  const serviceName = typeof args.service_name === "string" ? args.service_name : "";
  const found = matchService(db, serviceName);
  if (found.kind === "none") return { ok: false, message: `No encuentro el servicio "${serviceName}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const service = db.prepare("SELECT id, name, es, duration_min FROM services WHERE id = ?").get(found.row.id) as {
    id: number;
    name: string;
    es: string;
    duration_min: number;
  };
  let minutes = service.duration_min;
  const open = getOpenSession(db);
  if (open && open.service_id === service.id) {
    const started = db.prepare("SELECT started_at FROM sessions WHERE id = ?").get(open.id) as { started_at: string };
    minutes = Math.max(1, Math.round((Date.now() - Date.parse(started.started_at)) / 60000));
  }
  let lines = recipeForService(db, service.id);
  if (Array.isArray(args.supply_names) && args.supply_names.length > 0) {
    const override: RecipeLine[] = [];
    for (const item of args.supply_names) {
      if (typeof item !== "string") return { ok: false, message: "El insumo no es válido." };
      const supply = matchSupply(db, item);
      if (supply.kind === "none") return { ok: false, message: `No encuentro el insumo "${item}".` };
      if (supply.kind === "ambiguous") return { ok: false, message: ambiguousMessage(supply.options) };
      const known = lines.find((line) => line.supply_id === supply.row.id);
      if (known) {
        override.push(known);
      } else {
        const row = db
          .prepare("SELECT id AS supply_id, name, es, price_per_product_usd, content_per_product FROM supplies WHERE id = ?")
          .get(supply.row.id) as Omit<RecipeLine, "qty">;
        override.push({ ...row, qty: 1 });
      }
    }
    lines = override;
  }
  const breakdown = quotePrice(
    PRICING,
    minutes,
    lines.map((line) => ({
      qty: line.qty,
      pricePerProductUsd: line.price_per_product_usd,
      contentPerProduct: line.content_per_product,
    })),
  );
  const label = service.es || service.name;
  const message =
    `${label}: insumos ${money(breakdown.suppliesCost)} + tiempo ${money(breakdown.timeCost)} + ` +
    `fijos ${money(breakdown.fixedShare)} + margen ${breakdown.marginPct}% = ${breakdown.finalPrice} USD.`;
  return {
    ok: true,
    message,
    data: {
      service: service.name,
      minutes,
      supplies_cost: breakdown.suppliesCost,
      time_cost: breakdown.timeCost,
      fixed_share: breakdown.fixedShare,
      margin_pct: breakdown.marginPct,
      final_price_usd: breakdown.finalPrice,
      margin_earned_usd: breakdown.marginEarned,
    },
  };
}

/** Local YYYY-MM-DD for "today" questions. Exported for tests. */
export function localDay(when = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** Local HH:MM for "who is next" questions. Exported for tests. */
export function localTime(when = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function checkDayTime(day: unknown, time: unknown): string | null {
  if (typeof day !== "string" || !DAY_RE.test(day)) return "Falta la fecha o no la entiendo.";
  if (typeof time !== "string" || !TIME_RE.test(time)) return "Falta la hora o no la entiendo.";
  return null;
}

/** The day exists on the calendar: November 31st and February 29th on
 * non-leap years do not. Returns the problem in the screen language. */
function checkCalendarDay(day: string, language: ValeLanguage): string | null {
  const [year, month, date] = day.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (date <= last) return null;
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  return language === "en"
    ? `${monthName} ${year} has ${last} days, so ${monthName} ${date} does not exist.`
    : `${monthName} de ${year} tiene ${last} días, así que esa fecha no existe.`;
}

interface AppointmentRow {
  id: number;
  client: string;
  service: string;
  day: string;
  time: string;
}

function appointmentLabel(row: AppointmentRow): string {
  return `${row.client} ${row.time}`;
}

function listAppointments(db: ValeDb, where: string, ...params: (string | number)[]): AppointmentRow[] {
  return db
    .prepare(
      `SELECT a.id, c.name AS client, s.name AS service, a.day, a.time
       FROM appointments a JOIN clients c ON c.id = a.client_id JOIN services s ON s.id = a.service_id
       ${where} ORDER BY a.day, a.time, a.id`,
    )
    .all(...params) as unknown as AppointmentRow[];
}

/**
 * Weekend or outside 9-17 appointments warn first and still run:
 * the warning leads the message, then the booking is announced.
 */
export function offHoursReasons(day: string, time: string): string[] {
  const reasons: string[] = [];
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(year, month - 1, date).getDay();
  if (weekday === 0 || weekday === 6) reasons.push("cae en fin de semana");
  if (time < "09:00" || time >= "17:00") reasons.push("queda fuera de 9 a 17");
  return reasons;
}

export function createAppointment(
  db: ValeDb,
  args: {
    client_name?: unknown;
    service_name?: unknown;
    day?: unknown;
    time?: unknown;
    confirm_off_hours?: unknown;
  },
  language: ValeLanguage = "es",
): ToolResult {
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const serviceName = typeof args.service_name === "string" ? args.service_name : "";
  const problem = checkDayTime(args.day, args.time);
  if (problem) return { ok: false, message: problem };
  const calendar = checkCalendarDay(args.day as string, language);
  if (calendar) return { ok: false, message: calendar };
  const client = matchOne(
    db.prepare("SELECT id, name FROM clients ORDER BY id").all() as unknown as Named[],
    clientName,
  );
  if (client.kind === "none") return { ok: false, message: `No encuentro a "${clientName}".` };
  if (client.kind === "ambiguous") return { ok: false, message: ambiguousMessage(client.options) };
  const service = matchService(db, serviceName);
  if (service.kind === "none") return { ok: false, message: `No encuentro el servicio "${serviceName}".` };
  if (service.kind === "ambiguous") return { ok: false, message: ambiguousMessage(service.options) };
  const reasons = offHoursReasons(args.day as string, args.time as string);
  if (reasons.length > 0 && args.confirm_off_hours !== true) {
    return {
      ok: false,
      message: `Ojo, ${reasons.join(" y ")}. ¿La guardo igual?`,
      pendingOffHours: true,
      data: { off_hours: true },
    };
  }
  const result = db
    .prepare("INSERT INTO appointments (client_id, service_id, day, time) VALUES (?, ?, ?, ?)")
    .run(client.row.id, service.row.id, args.day as string, args.time as string);
  const id = Number(result.lastInsertRowid);
  logWrite(db, "create_appointment", "appointments", id);
  return {
    ok: true,
    message: language === "en" ? `Appointment booked: ${client.row.name} ${args.day} ${args.time}.` : `Cita guardada: ${client.row.name} ${args.day} ${args.time}.`,
    data: { appointment_id: id, off_hours: reasons.length > 0 },
  };
}

/** "¿cómo voy con la meta?": margin earned on sessions closed this month vs the goal. */
export function goalProgress(db: ValeDb): ToolResult {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(margin_earned), 0) AS earned FROM sessions
       WHERE ended_at IS NOT NULL AND strftime('%Y-%m', ended_at) = strftime('%Y-%m', 'now')`,
    )
    .get() as { earned: number };
  const earned = Math.round(row.earned * 100) / 100;
  const goal = PRICING.goalMonthlyUsd;
  const pct = Math.round((earned / goal) * 100);
  const month = new Date().toISOString().slice(0, 7);
  return {
    ok: true,
    message: `Vas ${money(earned)} de ${goal} USD este mes (${pct}%).`,
    data: { earned_usd: earned, goal_usd: goal, month },
  };
}

export function listToday(db: ValeDb): ToolResult {
  const rows = listAppointments(db, "WHERE a.day = ?", localDay());
  if (rows.length === 0) return { ok: true, message: "No tienes nada hoy.", data: { appointments: [] } };
  return {
    ok: true,
    message: `Hoy tienes: ${rows.map(appointmentLabel).join(", ")}.`,
    data: { appointments: rows },
  };
}

export function nextAppointment(db: ValeDb): ToolResult {
  const now = localTime();
  const rows = listAppointments(db, "WHERE a.day = ? AND a.time >= ?", localDay(), now);
  if (rows.length === 0) return { ok: true, message: "No queda nadie hoy.", data: { appointment: null } };
  const next = rows[0];
  return { ok: true, message: `Sigue ${next.client} a las ${next.time}.`, data: { appointment: next } };
}

export function moveAppointment(
  db: ValeDb,
  args: { client_name?: unknown; new_day?: unknown; new_time?: unknown },
  language: ValeLanguage = "es",
): ToolResult {
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const problem = checkDayTime(args.new_day, args.new_time);
  if (problem) return { ok: false, message: problem };
  const client = matchOne(
    db.prepare("SELECT id, name FROM clients ORDER BY id").all() as unknown as Named[],
    clientName,
  );
  if (client.kind === "none") return { ok: false, message: `No encuentro a "${clientName}".` };
  if (client.kind === "ambiguous") return { ok: false, message: ambiguousMessage(client.options) };
  const rows = listAppointments(db, "WHERE a.client_id = ?", client.row.id);
  if (rows.length === 0) return { ok: false, message: `No encuentro citas de ${client.row.name}.` };
  if (rows.length > 1) {
    return { ok: false, message: `¿Cuál: ${rows.map((row) => `${row.day} ${row.time}`).join(" o ")}?` };
  }
  const current = rows[0];
  db.prepare("UPDATE appointments SET day = ?, time = ? WHERE id = ?").run(
    args.new_day as string,
    args.new_time as string,
    current.id,
  );
  logWrite(db, "move_appointment", "appointments", current.id, { prev_day: current.day, prev_time: current.time });
  return {
    ok: true,
    message: language === "en" ? `Appointment moved: ${current.client} ${args.new_day} ${args.new_time}.` : `Cita movida: ${current.client} ${args.new_day} ${args.new_time}.`,
    data: { appointment_id: current.id },
  };
}

function parseQty(raw: unknown): number | null {
  const qty = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof qty === "number" && Number.isFinite(qty) ? qty : null;
}

export function setStock(db: ValeDb, args: { name?: unknown; qty?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const name = typeof args.name === "string" ? args.name : "";
  const qty = parseQty(args.qty);
  if (qty === null || qty < 0) return { ok: false, message: "La cantidad no es válida." };
  const found = matchSupply(db, name);
  if (found.kind === "none") return { ok: false, message: `No conozco el insumo "${name}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const row = db.prepare("SELECT stock_qty FROM supplies WHERE id = ?").get(found.row.id) as { stock_qty: number };
  db.prepare("UPDATE supplies SET stock_qty = ? WHERE id = ?").run(qty, found.row.id);
  logWrite(db, "set_stock", "supplies", found.row.id, { prev_qty: row.stock_qty });
  return { ok: true, message: language === "en" ? `${found.row.name}: ${qty} left.` : `${found.row.name}: quedan ${qty}.`, data: { stock_qty: qty } };
}

export function addStock(db: ValeDb, args: { name?: unknown; qty?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const name = typeof args.name === "string" ? args.name : "";
  const qty = parseQty(args.qty);
  if (qty === null || qty <= 0) return { ok: false, message: "La cantidad no es válida." };
  const found = matchSupply(db, name);
  if (found.kind === "none") return { ok: false, message: `No conozco el insumo "${name}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const row = db.prepare("SELECT stock_qty FROM supplies WHERE id = ?").get(found.row.id) as { stock_qty: number };
  const now = row.stock_qty + qty;
  db.prepare("UPDATE supplies SET stock_qty = ? WHERE id = ?").run(now, found.row.id);
  logWrite(db, "add_stock", "supplies", found.row.id, { prev_qty: row.stock_qty });
  return { ok: true, message: language === "en" ? `${found.row.name}: ${row.stock_qty} + ${qty} = ${now}.` : `${found.row.name}: ${row.stock_qty} + ${qty} = ${now}.`, data: { stock_qty: now } };
}

export function readStock(db: ValeDb): ToolResult {
  const rows = db
    .prepare("SELECT name, stock_qty, min_qty FROM supplies WHERE stock_qty <= min_qty ORDER BY name")
    .all() as { name: string; stock_qty: number; min_qty: number }[];
  if (rows.length === 0) return { ok: true, message: "El stock está bien.", data: { low: [] } };
  return {
    ok: true,
    message: `Te queda poco: ${rows.map((row) => `${row.name} (${row.stock_qty}, mínimo ${row.min_qty})`).join(", ")}.`,
    data: { low: rows },
  };
}

export function runValeTool(db: ValeDb, name: string, args: Record<string, unknown>, language: ValeLanguage = "es"): ToolResult {
  switch (name) {
    case "open_session":
      return openSession(db, args, language);
    case "close_session":
      return closeSession(db, args, language);
    case "find_client":
      return findClient(db, args);
    case "add_note":
      return addNote(db, args, language);
    case "create_client":
      return createClient(db, args, language);
    case "add_to_shopping_list":
      return addToShoppingList(db, args, language);
    case "read_shopping_list":
      return readShoppingList(db);
    case "log_supply_use":
      return logSupplyUse(db, args, language);
    case "undo_last_write":
      return undoLastWrite(db, language);
    case "quote_price":
      return quotePriceTool(db, args);
    case "goal_progress":
      return goalProgress(db);
    case "create_appointment":
      return createAppointment(db, args, language);
    case "list_today":
      return listToday(db);
    case "next_appointment":
      return nextAppointment(db);
    case "move_appointment":
      return moveAppointment(db, args, language);
    case "set_stock":
      return setStock(db, args, language);
    case "add_stock":
      return addStock(db, args, language);
    case "read_stock":
      return readStock(db);
    default:
      return { ok: false, message: "Herramienta desconocida." };
  }
}
