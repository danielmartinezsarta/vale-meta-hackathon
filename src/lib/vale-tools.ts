// The 8 HACK-002 tools plus undo_last_write, over the SQLite database.
// Server-side only: executors run here; only short speakable results and
// masked public notes ever reach the model. Private health-note text never
// leaves this module toward the cloud.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { PRICING, getPublicNotes, type PublicNote, type ValeDb } from "./db";
import { segmentNails } from "./nails";
import { bogotaDay, bogotaTime, formatNaturalDateTime, hour12, parseNaturalDate } from "./natural-date";
import { runPhotoPreview, samBoxesMatch, type DesignSpec } from "./photo-preview";
import { money, quotePrice } from "./quote";
import {
  previewCostLogPath,
  previewsDir,
  sessionPhotoPath,
  sessionPhotosDir,
} from "./session-photo";
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
  /** Set when a live session blocks the requested open: a yes closes it first. */
  pendingSessionSwitch?: { client_name: string; service_name: string };
  /** Set when a quoted total waits for Accept: a yes registers the payment. */
  pendingAccept?: { amount: number; session_id: number };
  /** Set when a move waits for the user's yes before rewriting the booking. */
  pendingMove?: { client_name: string; new_day: string; new_time: string };
  /** Set when a cancel waits for the user's yes before deleting the booking. */
  pendingCancel?: { appointment_id: number };
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
    name: "session_open",
    description:
      "Open a nail session with a timer for a client. The service is optional: when it is missing, today's appointment for that client names it (for example Start a session with David, my client David is getting near). Never for asking about a client: 'what do you have on X' shows the card, it never opens a session. Call it right away when the request names a client, even when another session is already open: the refusal carries the switch question and a yes runs it.",
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Client name, approximate is fine." },
        service_name: { type: "string", description: "Service name, approximate is fine. Falls back to today's appointment for the client." },
      },
      required: ["client_name"],
    },
  },
  {
    type: "function",
    name: "session_close",
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
    name: "client_create",
    description: "Register a new client with an empty card.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "client_card_show",
    description: "Show the full client card: contact, visits and notes. Call it for 'X is here, what do I have on him' and 'what do you have on X': asking about a client shows the card, it never opens a session. A health alert shows on screen only, never spoken.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Client name, approximate is fine." } },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "client_note_add",
    description:
      "Save a one-line note on the client card at once, no confirmation. Call it for 'add a note for X: ...' and 'note that X ...'. Kind is note, or health_note for allergies and similar health topics (stays private, never spoken).",
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Client name, approximate is fine." },
        text: { type: "string", description: "The note in one line." },
        kind: { type: "string", description: "note or health_note." },
      },
      required: ["client_name", "text"],
    },
  },
  {
    type: "function",
    name: "session_log_supply",
    description: "Record a supply used in the open session, with quantity when she says how many (\"add three crystals\" -> name \"crystals\", quantity 3). Unknown names never invent a row: the tool asks to confirm first.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        quantity: { type: "integer", description: "Units used, default 1." },
        confirm_create: { type: "boolean", description: "Set true only after the user said yes to creating it." },
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "undo_last",
    description: "Undo the most recent write. Call it when the user says undo it (or deshazlo), and also for delete that note, remove that note, borra esa nota or elimina la nota: those remove the last saved note.",
    parameters: noParams,
  },
  {
    type: "function",
    name: "widget_show",
    description: "Show a screen card when no other tool produces one: the shopping list or the open session.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "shopping or session." } },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "tool_get_details",
    description: "Full guide of one tool when its short description is not enough: parameters and an example.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Tool name." } },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "session_quote",
    description:
      "Quote the open session: base cost, extras total and suggested total on a sheet. A yes or accept registers the payment for the suggested total; a no or reject leaves the sheet waiting for the spoken amount. With an open session, any call with amount (\"David paid 25\", \"me pagó 25\") registers that payment at once, quote open or not, and closes the sheet. Neither closes the session. Never say any amount aloud and never name the on-screen buttons: the totals live on the screen only.",
    parameters: {
      type: "object",
      properties: {
        service_name: { type: "string", description: "Service name, in English or Spanish. Defaults to the open session." },
        supply_names: {
          type: "array",
          items: { type: "string" },
          description: "Optional supply override; defaults to the service recipe.",
        },
        amount: {
          type: "number",
          description: "Spoken payment after a reject: registers this amount instead of the suggested total.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "goal_show",
    description: "Show the month goal and the margin earned. The amounts stay on the screen: say one short line pointing at them, never read them aloud.",
    parameters: noParams,
  },
  {
    type: "function",
    name: "photo_preview_design",
    description:
      "Generate a brand-new AI preview of the appointment reference design on the open session nails from the before photo, shown on screen. Only for generating: to show photos already stored (reference, before, preview, final), use photo_show.",
    parameters: noParams,
  },
  {
    type: "function",
    name: "photo_show",
    description:
      "Show the stored session photos on the photos sheet: before, reference, preview and final, whichever exist. Call it when the user asks to see the reference, the before photo, the preview, the final photo, or the stored photos. Never for generating anything new.",
    parameters: noParams,
  },
  {
    type: "function",
    name: "agenda_create_appointment",
    description:
      "Book an appointment for an existing client. The service is optional and falls back to the open session. Pass day and time as YYYY-MM-DD and HH:MM, or the natural words with when; never invent one: when day and time are missing, ask. The booking always saves, even off hours; undo it when it is wrong.",
    parameters: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Client name, approximate is fine." },
        service_name: { type: "string", description: "Service name, in English or Spanish. Falls back to the open session." },
        day: { type: "string", description: "Date as YYYY-MM-DD." },
        time: { type: "string", description: "Time as HH:MM, 24 hours." },
        when: { type: "string", description: "Natural date and time in English, for example next Friday at 5 PM. Resolved on the America/Bogota calendar; overrides day and time." },
      },
      required: ["client_name"],
    },
  },
  {
    type: "function",
    name: "agenda_show",
    description: "Show appointments with reminders: today, one date, the week, or a range. Today is voice only and opens no sheet.",
    parameters: {
      type: "object",
      properties: {
        range: { type: "string", description: "today, date, week or range." },
        day: { type: "string", description: "Date as YYYY-MM-DD for date, or the anchor day for week." },
        from: { type: "string", description: "First day as YYYY-MM-DD for range." },
        to: { type: "string", description: "Last day as YYYY-MM-DD for range." },
      },
      required: ["range"],
    },
  },
  {
    type: "function",
    name: "stock_set",
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
];

/**
 * Today's appointments for one client, oldest first. The card and the
 * client-only session open both resolve through here on one clock.
 */
function todayAppointmentsFor(db: ValeDb, clientId: number, today: string): AppointmentRow[] {
  return listAppointments(db, "WHERE a.client_id = ? AND a.day = ?", clientId, today);
}

export function openSession(db: ValeDb, args: { client_name?: unknown; service_name?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const already = getOpenSession(db);
  if (already) {
    // A vague yes never reopens: the refusal names the open session and
    // the next step, so the model asks instead of writing.
    const service = db.prepare("SELECT name FROM services WHERE id = ?").get(already.service_id) as {
      name: string;
    } | undefined;
    const who = `${clientLabel(db, already.client_id)}, ${service?.name ?? "unknown"}`;
    const requestedClient = typeof args.client_name === "string" ? args.client_name.trim() : "";
    const requestedService = typeof args.service_name === "string" ? args.service_name.trim() : "";
    return {
      ok: false,
      message:
        language === "en"
          ? `There is already an open session (${who}). Do not call session_close yet: first tell the user what is open and ask whether to close it and open ${requestedClient || "the new one"}.`
          : `Ya hay una sesión abierta (${who}). No llames session_close todavía: primero dile al usuario qué hay abierto y pregunta si lo cierra y abre ${requestedClient || "la nueva"}.`,
      pendingSessionSwitch:
        requestedClient !== "" && requestedService !== ""
          ? { client_name: requestedClient, service_name: requestedService }
          : undefined,
    };
  }
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const serviceName = typeof args.service_name === "string" ? args.service_name : "";
  const client = matchOne(allClients(db), clientName);
  if (client.kind === "none") return { ok: false, message: `No encuentro a "${clientName}".` };
  if (client.kind === "ambiguous") return { ok: false, message: ambiguousMessage(client.options) };
  // A bare client names the service through today's booking: Start a
  // session with David opens the service of David's appointment today.
  let service: Match = { kind: "none" };
  if (serviceName.trim() !== "") {
    service = matchService(db, serviceName);
    if (service.kind === "none") return { ok: false, message: `No encuentro el servicio "${serviceName}".` };
  } else {
    const today = todayAppointmentsFor(db, client.row.id, bogotaDay(new Date()));
    if (today.length === 1) {
      service = { kind: "match", row: { id: 0, name: today[0].service }, how: "exact" };
      const resolved = db.prepare("SELECT id, name FROM services WHERE name = ?").get(today[0].service) as Named | undefined;
      if (resolved) service = { kind: "match", row: resolved, how: "exact" };
      else service = { kind: "none" };
    } else if (today.length > 1) {
      return {
        ok: false,
        message:
          language === "en"
            ? `${client.row.name} has several appointments today: which service do we open?`
            : `${client.row.name} tiene varias citas hoy: ¿qué servicio abrimos?`,
      };
    }
  }
  if (service.kind === "none") {
    return {
      ok: false,
      message:
        language === "en"
          ? `Which service for ${client.row.name}?`
          : `¿Qué servicio para ${client.row.name}?`,
    };
  }
  if (service.kind === "ambiguous") return { ok: false, message: ambiguousMessage(service.options) };
  const startedAt = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO sessions (client_id, service_id, started_at) VALUES (?, ?, ?)")
    .run(client.row.id, service.row.id, startedAt);
  logWrite(db, "session_open", "sessions", Number(result.lastInsertRowid));
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
  const service = db.prepare("SELECT id, name FROM services WHERE id = ?").get(open.service_id) as { id: number; name: string };
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
  logWrite(db, "session_close", "sessions", open.id, { supplies: recordedIds });
  // The full summary sheet reads the payment off this session, if any.
  const paid = db.prepare("SELECT COALESCE(SUM(amount_usd), 0) AS total FROM payments WHERE session_id = ?").get(open.id) as { total: number };
  const lasted = language === "en" ? `It lasted ${minutes} minute${minutes === 1 ? "" : "s"}.` : `Duró ${minutes} minuto${minutes === 1 ? "" : "s"}.`;
  let message = language === "en" ? `Session closed. ${lasted}` : `Sesión cerrada. ${lasted}`;
  if (recorded.length > 0) message += language === "en" ? ` Logged: ${recorded.join(", ")}.` : ` Anoté: ${recorded.join(", ")}.`;
  if (unknown.length > 0) message += language === "en" ? ` Not found: ${unknown.join(", ")}.` : ` No encontré: ${unknown.join(", ")}.`;
  return {
    ok: true,
    message,
    data: {
      duration_s: durationS,
      minutes,
      recorded,
      unknown,
      service: service.name,
      client: clientLabel(db, open.client_id),
      paid_amount_usd: paid.total,
    },
  };
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

export interface ClientVisit {
  service: string;
  visited_at: string;
  photo: string;
  note: string;
}

export interface FullClientCard {
  id: number;
  name: string;
  sex: string;
  phone: string;
  email: string;
  birthday: string;
  notes: PublicNote[];
  /** A health note exists: the alert shows on screen only, never spoken. */
  health_alert: boolean;
  visits: ClientVisit[];
  upcoming: AppointmentRow[];
}

/**
 * client_card_show: the full sheet (1.1). Contact, visits with photo
 * markers, upcoming appointments. The health alert rides the screen only:
 * the message never names it, so the voice never says it either.
 */
export function showClientCard(db: ValeDb, args: { name?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const name = typeof args.name === "string" ? args.name : "";
  const found = matchOne(allClients(db), name);
  if (found.kind === "none") return { ok: false, message: `No encuentro a "${name}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const contact = db
    .prepare("SELECT sex, phone, email, birthday FROM clients WHERE id = ?")
    .get(found.row.id) as { sex: string; phone: string; email: string; birthday: string };
  const notes = getPublicNotes(db, found.row.id);
  const visits = db
    .prepare(
      `SELECT COALESCE(s.name, '') AS service, v.visited_at, v.photo, v.note
       FROM visits v LEFT JOIN services s ON s.id = v.service_id
       WHERE v.client_id = ? ORDER BY v.visited_at DESC LIMIT 5`,
    )
    .all(found.row.id) as unknown as ClientVisit[];
  const upcoming = listAppointments(
    db,
    "WHERE a.client_id = ? AND a.day >= ?",
    found.row.id,
    bogotaDay(new Date()),
  );
  // Health notes ride first on the card, then the rest in saved order.
  const ordered = [...notes].sort(
    (a, b) => (a.kind === "health_note" ? 0 : 1) - (b.kind === "health_note" ? 0 : 1),
  );
  const card: FullClientCard = {
    id: found.row.id,
    name: found.row.name,
    sex: contact.sex,
    phone: contact.phone,
    email: contact.email,
    birthday: contact.birthday,
    notes: ordered,
    health_alert: ordered.some((note) => note.kind === "health_note"),
    visits,
    upcoming,
  };
  return {
    ok: true,
    message:
      language === "en"
        ? `${found.row.name}'s card is on screen.`
        : `La ficha de ${found.row.name} está en pantalla.`,
    data: { card },
  };
}

export function addNote(db: ValeDb, args: { client_name?: unknown; text?: unknown; kind?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (text === "") return { ok: false, message: "La nota está vacía." };
  const kind = args.kind === "health_note" || args.kind === "health" ? "health_note" : "note";
  const found = matchOne(allClients(db), clientName);
  if (found.kind === "none") return { ok: false, message: `No encuentro a "${clientName}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const result = db
    .prepare("INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (?, ?, ?, ?)")
    .run(found.row.id, text, kind, kind === "health_note" ? 1 : 0);
  logWrite(db, "client_note_add", "notes", Number(result.lastInsertRowid));
  // The result never carries the note text back: health text must not re-enter the model context.
  if (kind === "health_note") return { ok: true, message: language === "en" ? "Private note saved." : "Nota privada guardada.", data: { note_id: Number(result.lastInsertRowid), private: true } };
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
  logWrite(db, "shopping_add", "shopping_list", Number(result.lastInsertRowid));
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

export function removeFromShoppingList(db: ValeDb, args: { item_name?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const item = typeof args.item_name === "string" ? args.item_name : "";
  const found = matchSupply(db, item);
  if (found.kind === "none") return { ok: false, message: `No conozco el insumo "${item}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const row = db.prepare("SELECT id FROM shopping_list WHERE supply_id = ?").get(found.row.id) as { id: number } | undefined;
  if (!row) {
    return {
      ok: false,
      message: language === "en" ? `${found.row.name} is not on the list.` : `${found.row.name} no está en la lista.`,
    };
  }
  db.prepare("DELETE FROM shopping_list WHERE id = ?").run(row.id);
  logWrite(db, "shopping_remove", "shopping_list", row.id, { supply_id: found.row.id });
  return {
    ok: true,
    message: language === "en" ? `${found.row.name} removed from the list.` : `${found.row.name} fuera de la lista.`,
    data: { removed: found.row.name },
  };
}

export interface ServiceLine {
  service: string;
  minutes: number;
  supplies_cost: number;
  time_cost: number;
  fixed_share: number;
  list_price_usd: number;
}

/**
 * service_show: the list price behind session_quote. The voice never reads
 * the price: the message carries minutes only, the price rides data.
 */
export function showService(db: ValeDb, args: { service_name?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const wanted = typeof args.service_name === "string" ? args.service_name.trim() : "";
  if (wanted === "") {
    const rows = db.prepare("SELECT name, duration_min FROM services ORDER BY name").all() as {
      name: string;
      duration_min: number;
    }[];
    return {
      ok: true,
      message: language === "en" ? `Services on screen: ${rows.length}.` : `Servicios en pantalla: ${rows.length}.`,
      data: { services: rows.map((row) => ({ name: row.name, minutes: row.duration_min })) },
    };
  }
  const found = matchService(db, wanted);
  if (found.kind === "none") return { ok: false, message: `No encuentro el servicio "${wanted}".` };
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  const service = db.prepare("SELECT id, name, duration_min FROM services WHERE id = ?").get(found.row.id) as {
    id: number;
    name: string;
    duration_min: number;
  };
  const lines = recipeForService(db, service.id);
  const breakdown = quotePrice(
    PRICING,
    service.duration_min,
    lines.map((line) => ({
      qty: line.qty,
      pricePerProductUsd: line.price_per_product_usd,
      contentPerProduct: line.content_per_product,
    })),
  );
  const detail: ServiceLine = {
    service: service.name,
    minutes: service.duration_min,
    supplies_cost: breakdown.suppliesCost,
    time_cost: breakdown.timeCost,
    fixed_share: breakdown.fixedShare,
    list_price_usd: breakdown.finalPrice,
  };
  return {
    ok: true,
    message:
      language === "en"
        ? `${service.name} takes ${service.duration_min} minutes; the price is on screen.`
        : `${service.name} toma ${service.duration_min} minutos; el precio está en pantalla.`,
    data: detail,
  };
}

/**
 * widget_show: a screen card with no other tool behind it. Only the
 * shopping list and the open session qualify; anything else is a no.
 */
export function showWidget(db: ValeDb, args: { name?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const name = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
  if (name === "shopping") {
    const rows = db
      .prepare("SELECT s.name FROM shopping_list l JOIN supplies s ON s.id = l.supply_id ORDER BY l.id")
      .all() as { name: string }[];
    return {
      ok: true,
      message: language === "en" ? "The shopping list is on screen." : "La lista de compras está en pantalla.",
      data: { widget: "shopping", items: rows.map((row) => row.name) },
    };
  }
  if (name === "session") {
    const open = getOpenSession(db);
    if (!open) {
      return {
        ok: false,
        message: language === "en" ? "No session is open." : "No hay sesión abierta.",
      };
    }
    const service = db.prepare("SELECT name FROM services WHERE id = ?").get(open.service_id) as { name: string };
    return {
      ok: true,
      message: language === "en" ? "The open session is on screen." : "La sesión abierta está en pantalla.",
      data: { widget: "session", client: clientLabel(db, open.client_id), service: service.name, started_at: open.started_at },
    };
  }
  return {
    ok: false,
    message:
      language === "en"
        ? `I can only show the shopping list or the open session.`
        : `Solo puedo mostrar la lista de compras o la sesión abierta.`,
  };
}

/** tool_get_details: the full guide of one known tool for the model. */
export function getToolDetails(args: { name?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const known = new Map(VALE_TOOLS.map((tool) => [tool.name, tool]));
  // Internal helpers answer details too, but say so: the model calls them
  // only through a proposal, never directly.
  const internal: Record<string, string> = {
    client_note_add: "Save a one-line note on the client card immediately, no confirmation. Kind is note or health_note (allergies and similar health topics, stays private). If the client is unknown, register them with client_create first, then save.",

    agenda_move_appointment: "Move an appointment. Asks first: the refusal carries the confirm question and a yes moves it.",
    agenda_cancel_appointment: "Cancel an appointment. Asks first: the refusal carries the confirm question and a yes cancels it.",
    agenda_get_next: "Next appointment today. Internal: only when asked who is next.",
    agenda_create_reminder: "Save a standalone reminder. Internal: only when asked to remind.",
    shopping_add: "Add a supply to the shopping list. Internal: only when asked to buy or add.",
    shopping_remove: "Remove a supply from the shopping list. Internal: only when asked to remove.",
    shopping_show: "Read the shopping list. Internal: reads run with the agenda.",
    stock_show_low: "Supplies at minimum. Internal: only when asked about stock.",
    stock_add: "Add bought stock. Internal: only when asked.",
    service_show: "One service with parts and list price. Internal: only when asked about a price.",
    session_quote_accept: "Register the quoted payment. Internal: only through the Accept proposal, never directly.",
  };
  const tool = known.get(name);
  if (tool) {
    return {
      ok: true,
      message: language === "en" ? `${tool.name}: ${tool.description}` : `${tool.name}: ${tool.description}`,
      data: { name: tool.name, description: tool.description, parameters: tool.parameters },
    };
  }
  if (internal[name] !== undefined) {
    return {
      ok: true,
      message: internal[name],
      data: { name, description: internal[name], internal: true },
    };
  }
  return {
    ok: false,
    message: language === "en" ? `There is no tool called "${name}".` : `No hay herramienta "${name}".`,
  };
}

/**
 * agenda_create_reminder: a standalone reminder, optionally linked to
 * shopping-list supplies. The shopping logic works through the link even
 * though the video never shows it.
 */
export function createReminder(
  db: ValeDb,
  args: { text?: unknown; day?: unknown; items?: unknown },
  language: ValeLanguage = "es",
): ToolResult {
  const text = typeof args.text === "string" ? args.text.trim().replace(/\s+/g, " ") : "";
  if (text === "") {
    return {
      ok: false,
      message: language === "en" ? "The reminder text is empty." : "El recordatorio está vacío.",
    };
  }
  const day = typeof args.day === "string" && DAY_RE.test(args.day) ? args.day : bogotaDay(new Date());
  const calendar = checkCalendarDay(day, language);
  if (calendar) return { ok: false, message: calendar };
  const wanted = Array.isArray(args.items) ? args.items.filter((item): item is string => typeof item === "string") : [];
  const supplyIds: number[] = [];
  for (const item of wanted) {
    const found = matchSupply(db, item);
    if (found.kind === "none") return { ok: false, message: `No conozco el insumo "${item}".` };
    if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
    supplyIds.push(found.row.id);
  }
  const kind = supplyIds.length > 0 ? "shopping" : "general";
  const id = Number(
    db.prepare("INSERT INTO reminders (text, kind, day) VALUES (?, ?, ?)").run(text, kind, day).lastInsertRowid,
  );
  const addShopping = db.prepare("INSERT OR IGNORE INTO shopping_list (supply_id) VALUES (?)");
  const linkItem = db.prepare("INSERT OR IGNORE INTO reminder_items (reminder_id, shopping_list_id) VALUES (?, ?)");
  for (const supplyId of supplyIds) {
    addShopping.run(supplyId);
    const listRow = db.prepare("SELECT id FROM shopping_list WHERE supply_id = ?").get(supplyId) as { id: number };
    linkItem.run(id, listRow.id);
  }
  logWrite(db, "agenda_create_reminder", "reminders", id);
  return {
    ok: true,
    message: language === "en" ? "Reminder saved." : "Recordatorio guardado.",
    data: { reminder_id: id },
  };
}

export function createClient(db: ValeDb, args: { name?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const name = typeof args.name === "string" ? args.name.trim().replace(/\s+/g, " ") : "";
  if (name === "") return { ok: false, message: "Falta el nombre de la clienta." };
  const found = matchOne(allClients(db), name);
  if (found.kind === "match") return { ok: false, message: `${found.row.name} ya está registrada.` };
  if (found.kind === "ambiguous") return { ok: false, message: `${found.options[0].name} ya está registrada.` };
  const result = db.prepare("INSERT INTO clients (name) VALUES (?)").run(name);
  logWrite(db, "client_create", "clients", Number(result.lastInsertRowid));
  return { ok: true, message: language === "en" ? `${name} registered.` : `${name} registrada.`, data: { client_id: Number(result.lastInsertRowid) } };
}

/** Leading count words: safety net when the model sends the count in the name. */
const LEADING_QTY_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

/** "three crystals" -> { name: "crystals", qty: 3 }: no leading count passes through. */
function splitLeadingQuantity(raw: string): { name: string; qty: number | null } {
  const match = raw.match(/^(\d+|[a-záéíóúñü]+)\s+(.+)$/i);
  if (!match) return { name: raw, qty: null };
  const head = match[1].toLowerCase();
  const numeric = /^\d+$/.test(head) ? Number(head) : (LEADING_QTY_WORDS[head] ?? null);
  if (numeric === null || !Number.isInteger(numeric) || numeric < 1 || numeric > 99) return { name: raw, qty: null };
  return { name: match[2], qty: numeric };
}

export function logSupplyUse(
  db: ValeDb,
  args: { name?: unknown; quantity?: unknown; confirm_create?: unknown },
  language: ValeLanguage = "es",
): ToolResult {
  const open = getOpenSession(db);
  if (!open) return { ok: false, message: "No hay sesión abierta." };
  const raw = typeof args.name === "string" ? args.name.trim().replace(/\s+/g, " ") : "";
  if (raw === "") return { ok: false, message: "Falta el nombre del insumo." };
  const split = splitLeadingQuantity(raw);
  const explicit =
    typeof args.quantity === "number" && Number.isInteger(args.quantity) && args.quantity > 0 ? args.quantity : null;
  const qty = explicit ?? split.qty ?? 1;
  const name = split.name;
  const found = matchSupply(db, name);
  if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
  if (found.kind === "match") {
    db.prepare(
      "INSERT INTO session_supplies (session_id, supply_id, qty) VALUES (?, ?, ?) ON CONFLICT(session_id, supply_id) DO UPDATE SET qty = qty + excluded.qty",
    ).run(open.id, found.row.id, qty);
    logWrite(db, "session_log_supply", "session_supplies", open.id, { supply_id: found.row.id, qty, auto_created: false });
    return { ok: true, message: language === "en" ? `${found.row.name} logged for the session.` : `${found.row.name} anotado en la sesión.` };
  }
  if (args.confirm_create === true) {
    const created = db.prepare("INSERT INTO supplies (name) VALUES (?)").run(name);
    const supplyId = Number(created.lastInsertRowid);
    db.prepare("INSERT INTO session_supplies (session_id, supply_id, qty) VALUES (?, ?, ?)").run(open.id, supplyId, qty);
    logWrite(db, "session_log_supply", "session_supplies", open.id, { supply_id: supplyId, qty, auto_created: true });
    return { ok: true, message: language === "en" ? `${name} added to the session.` : `${name} anotado en la sesión.` };
  }
  // Unknown supplies never invent rows: the confirm card creates them.
  return {
    ok: false,
    message:
      language === "en"
        ? `"${name}" is not in the supplies. Confirm to add it.`
        : `"${name}" no está en los insumos. Confirma para agregarlo.`,
    pendingCreate: name,
  };
}

const UNDO_LABELS: Record<ValeLanguage, Record<string, string>> = {
  es: {
  session_open: "apertura de sesión",
  session_close: "cierre de sesión",
  client_note_add: "nota agregada",
  shopping_add: "agregado a la lista",
  shopping_remove: "quitado de la lista",
  client_create: "clienta registrada",
  session_log_supply: "insumo anotado",
  agenda_create_appointment: "cita guardada",
  agenda_move_appointment: "cita movida",
  agenda_cancel_appointment: "cita cancelada",
  agenda_create_reminder: "recordatorio guardado",
  session_quote_accept: "pago registrado",
  stock_set: "cambio de stock",
  stock_add: "entrada de stock",
  },
  en: {
  session_open: "session opening",
  session_close: "session closing",
  client_note_add: "added note",
  shopping_add: "list addition",
  shopping_remove: "list removal",
  client_create: "registered client",
  session_log_supply: "logged supply",
  agenda_create_appointment: "saved appointment",
  agenda_move_appointment: "moved appointment",
  agenda_cancel_appointment: "cancelled appointment",
  agenda_create_reminder: "saved reminder",
  session_quote_accept: "registered payment",
  stock_set: "stock change",
  stock_add: "stock entry",
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
        row?: Record<string, unknown>;
      })
    : {};
  switch (entry.action) {
    case "session_open":
      db.prepare("DELETE FROM session_supplies WHERE session_id = ?").run(entry.row_id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(entry.row_id);
      break;
    case "session_close": {
      const ids = Array.isArray(extra.supplies) ? extra.supplies : [];
      for (const supplyId of ids) {
        db.prepare("DELETE FROM session_supplies WHERE session_id = ? AND supply_id = ?").run(entry.row_id, supplyId);
      }
      db.prepare("UPDATE sessions SET ended_at = NULL, duration_s = NULL, margin_earned = NULL WHERE id = ?").run(entry.row_id);
      break;
    }
    case "client_note_add": {
      const note = db.prepare("SELECT text, kind, private_for_glimmer FROM notes WHERE id = ?").get(entry.row_id) as
        | { text: string; kind: string; private_for_glimmer: number }
        | undefined;
      db.prepare("DELETE FROM notes WHERE id = ?").run(entry.row_id);
      // The reply names the removed text, unless it was private: health
      // text never reaches the voice. Either way the write is consumed.
      if (note && note.private_for_glimmer !== 1 && note.kind !== "health_note" && note.kind !== "health") {
        db.prepare("UPDATE write_log SET undone = 1 WHERE id = ?").run(entry.id);
        return {
          ok: true,
          message:
            language === "en"
              ? `Done, I removed the note '${note.text}'.`
              : `Listo, quité la nota '${note.text}'.`,
        };
      }
      db.prepare("UPDATE write_log SET undone = 1 WHERE id = ?").run(entry.id);
      return {
        ok: true,
        message:
          language === "en" ? "Done, I removed the private note." : "Listo, quité la nota privada.",
      };
    }
    case "shopping_add":
      db.prepare("DELETE FROM shopping_list WHERE id = ?").run(entry.row_id);
      break;
    case "shopping_remove": {
      const supplyId = typeof extra.supply_id === "number" ? extra.supply_id : null;
      if (supplyId === null) return { ok: false, message: "No se puede deshacer." };
      db.prepare("INSERT OR IGNORE INTO shopping_list (supply_id) VALUES (?)").run(supplyId);
      break;
    }
    case "client_create": {
      const notes = db.prepare("SELECT COUNT(*) AS n FROM notes WHERE client_id = ?").get(entry.row_id) as { n: number };
      const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE client_id = ?").get(entry.row_id) as { n: number };
      if (notes.n > 0 || sessions.n > 0) return { ok: false, message: "No se puede deshacer." };
      db.prepare("DELETE FROM clients WHERE id = ?").run(entry.row_id);
      break;
    }
    case "session_log_supply": {
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
    case "agenda_create_appointment":
      db.prepare("DELETE FROM appointments WHERE id = ?").run(entry.row_id);
      break;
    case "agenda_move_appointment": {
      const prevDay = typeof extra.prev_day === "string" ? extra.prev_day : null;
      const prevTime = typeof extra.prev_time === "string" ? extra.prev_time : null;
      if (prevDay === null || prevTime === null) return { ok: false, message: "No se puede deshacer." };
      db.prepare("UPDATE appointments SET day = ?, time = ? WHERE id = ?").run(prevDay, prevTime, entry.row_id);
      break;
    }
    case "agenda_cancel_appointment": {
      const row = extra.row;
      const cell = (name: string): string | number | null => {
        const value = row?.[name];
        return typeof value === "string" || typeof value === "number" ? value : null;
      };
      if (!row || typeof row.id !== "number") return { ok: false, message: "No se puede deshacer." };
      db.prepare(
        "INSERT OR REPLACE INTO appointments (id, client_id, service_id, day, time, reference_photo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(row.id, cell("client_id"), cell("service_id"), cell("day"), cell("time"), cell("reference_photo") ?? "", cell("created_at"));
      break;
    }
    case "agenda_create_reminder":
      db.prepare("DELETE FROM reminder_items WHERE reminder_id = ?").run(entry.row_id);
      db.prepare("DELETE FROM reminders WHERE id = ?").run(entry.row_id);
      break;
    case "session_quote_accept":
      db.prepare("DELETE FROM payments WHERE id = ?").run(entry.row_id);
      break;
    case "stock_set":
    case "stock_add": {
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

export interface QuoteData {
  service: string;
  minutes: number;
  supplies_cost: number;
  time_cost: number;
  fixed_share: number;
  margin_pct: number;
  final_price_usd: number;
  margin_earned_usd: number;
  /** accept: a yes registers the suggested total; amount: name it instead. */
  awaiting: "accept" | "amount";
}

function computeQuote(
  db: ValeDb,
  serviceId: number,
  minutes: number,
  supplyNames: unknown,
): { breakdown: ReturnType<typeof quotePrice>; lines: RecipeLine[] } | { error: string } {
  let lines = recipeForService(db, serviceId);
  if (Array.isArray(supplyNames) && supplyNames.length > 0) {
    const override: RecipeLine[] = [];
    for (const item of supplyNames) {
      if (typeof item !== "string") return { error: "El insumo no es válido." };
      const supply = matchSupply(db, item);
      if (supply.kind === "none") return { error: `No encuentro el insumo "${item}".` };
      if (supply.kind === "ambiguous") return { error: ambiguousMessage(supply.options) };
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
  return {
    breakdown: quotePrice(
      PRICING,
      minutes,
      lines.map((line) => ({
        qty: line.qty,
        pricePerProductUsd: line.price_per_product_usd,
        contentPerProduct: line.content_per_product,
      })),
    ),
    lines,
  };
}

/**
 * Quote over the service recipe plus the extras logged in the open
 * session, so "How much do I charge?" always prices what was used.
 */
function computeQuoteWithSessionExtras(
  db: ValeDb,
  serviceId: number,
  minutes: number,
  sessionId: number | null,
): { breakdown: ReturnType<typeof quotePrice>; lines: RecipeLine[] } | { error: string } {
  const lines = recipeForService(db, serviceId);
  if (sessionId !== null) {
    const logged = db
      .prepare("SELECT supply_id, qty FROM session_supplies WHERE session_id = ?")
      .all(sessionId) as { supply_id: number; qty: number }[];
    for (const row of logged) {
      if (lines.some((line) => line.supply_id === row.supply_id)) continue;
      const extra = db
        .prepare("SELECT id AS supply_id, name, es, price_per_product_usd, content_per_product FROM supplies WHERE id = ?")
        .get(row.supply_id) as Omit<RecipeLine, "qty"> | undefined;
      if (extra) lines.push({ ...extra, qty: row.qty ?? 1 });
    }
  }
  return {
    breakdown: quotePrice(
      PRICING,
      minutes,
      lines.map((line) => ({
        qty: line.qty,
        pricePerProductUsd: line.price_per_product_usd,
        contentPerProduct: line.content_per_product,
      })),
    ),
    lines,
  };
}

/** Sessions whose quote was rejected: the next spoken amount registers. */
const quoteAwaiting = new Set<number>();

export function markQuoteAwaiting(sessionId: number): void {
  quoteAwaiting.add(sessionId);
}

export function isQuoteAwaiting(sessionId: number): boolean {
  return quoteAwaiting.has(sessionId);
}

export function clearQuoteAwaiting(sessionId: number): void {
  quoteAwaiting.delete(sessionId);
}

function recordPayment(db: ValeDb, sessionId: number, amount: number, language: ValeLanguage): ToolResult {
  const valid = typeof amount === "number" && Number.isFinite(amount) && amount > 0;
  if (!valid) {
    return {
      ok: false,
      message: language === "en" ? "That amount does not work." : "Ese monto no sirve.",
    };
  }
  const id = Number(
    db.prepare("INSERT INTO payments (session_id, amount_usd) VALUES (?, ?)").run(sessionId, amount).lastInsertRowid,
  );
  logWrite(db, "session_quote_accept", "payments", id, { session_id: sessionId, amount_usd: amount });
  clearQuoteAwaiting(sessionId);
  return {
    ok: true,
    // The total stays on the sheet: the voice only confirms it registered.
    message: language === "en" ? "Payment registered." : "Pago registrado.",
    data: { paid_amount_usd: amount, session_id: sessionId },
  };
}

/** The Accept behind the pending proposal: a yes or a tap registers it. */
export function acceptQuote(db: ValeDb, args: { amount?: unknown; session_id?: unknown }, language: ValeLanguage = "es"): ToolResult {
  const sessionId = typeof args.session_id === "number" ? args.session_id : getOpenSession(db)?.id;
  if (sessionId === undefined) {
    return { ok: false, message: language === "en" ? "No session is open." : "No hay sesión abierta." };
  }
  return recordPayment(db, sessionId, Number(args.amount), language);
}

/**
 * The Reject behind a no: the sheet stays open waiting for the spoken
 * amount, and the session stays open too. Never names the total.
 */
export function rejectQuote(db: ValeDb, sessionId: number, language: ValeLanguage = "es"): ToolResult {
  const open = db.prepare("SELECT id, client_id, service_id FROM sessions WHERE id = ? AND ended_at IS NULL").get(sessionId) as
    | { id: number; client_id: number; service_id: number }
    | undefined;
  if (!open) {
    return { ok: false, message: language === "en" ? "No session is open." : "No hay sesión abierta." };
  }
  markQuoteAwaiting(sessionId);
  const quoted = quoteSession(db, {}, language);
  const data = (quoted as { data?: unknown }).data as QuoteData | undefined;
  return {
    ok: true,
    message: language === "en" ? "Tell me the amount and I'll register it." : "Dime el monto y lo registro.",
    data: data ? { ...data, awaiting: "amount" as const } : { awaiting: "amount" as const },
  };
}

/**
 * session_quote: the price sheet with Accept and Reject (2.6-2.8).
 * The quote itself registers nothing: Accept (a yes, a tap, or "accept")
 * registers the suggested total, Reject (a no or "reject") waits for the
 * spoken amount, and a later call with amount registers that instead.
 * Neither closes the session, and no amount is ever spoken.
 */
export function quoteSession(
  db: ValeDb,
  args: { service_name?: unknown; supply_names?: unknown; amount?: unknown },
  language: ValeLanguage = "en",
): ToolResult {
  const open = getOpenSession(db);
  // A spoken amount with an open session always registers the payment:
  // quote on screen or not, accepted or not. The sheet closes on payment.
  if (args.amount !== undefined) {
    if (!open) return { ok: false, message: language === "en" ? "No session is open." : "No hay sesión abierta." };
    return recordPayment(db, open.id, Number(args.amount), language);
  }
  const serviceName = typeof args.service_name === "string" ? args.service_name.trim() : "";
  let serviceId: number | null = null;
  let serviceDisplay = "";
  if (serviceName !== "") {
    const found = matchService(db, serviceName);
    if (found.kind === "none") return { ok: false, message: `No encuentro el servicio "${serviceName}".` };
    if (found.kind === "ambiguous") return { ok: false, message: ambiguousMessage(found.options) };
    serviceId = found.row.id;
    serviceDisplay = found.row.name;
  } else if (open) {
    serviceId = open.service_id;
    serviceDisplay = (db.prepare("SELECT name FROM services WHERE id = ?").get(serviceId) as { name: string }).name;
  } else {
    return {
      ok: false,
      message: language === "en" ? "Which service should I quote?" : "¿Qué servicio cotizo?",
    };
  }
  const resolved = db.prepare("SELECT id, name, duration_min FROM services WHERE id = ?").get(serviceId) as {
    id: number;
    name: string;
    duration_min: number;
  };
  let minutes = resolved.duration_min;
  if (open && open.service_id === resolved.id) {
    const started = db.prepare("SELECT started_at FROM sessions WHERE id = ?").get(open.id) as { started_at: string };
    minutes = Math.max(1, Math.round((Date.now() - Date.parse(started.started_at)) / 60000));
  }
  const computed =
    Array.isArray(args.supply_names) && args.supply_names.length > 0
      ? computeQuote(db, resolved.id, minutes, args.supply_names)
      : computeQuoteWithSessionExtras(db, resolved.id, minutes, open?.id ?? null);
  if ("error" in computed) return { ok: false, message: computed.error };
  const data: QuoteData = {
    service: serviceDisplay || resolved.name,
    minutes,
    supplies_cost: computed.breakdown.suppliesCost,
    time_cost: computed.breakdown.timeCost,
    fixed_share: computed.breakdown.fixedShare,
    margin_pct: computed.breakdown.marginPct,
    final_price_usd: computed.breakdown.finalPrice,
    margin_earned_usd: computed.breakdown.marginEarned,
    awaiting: "accept",
  };
  return {
    ok: true,
    // Amounts live on the sheet: the voice only points at it.
    message:
      language === "en"
        ? "The quote is on screen."
        : "La cotización está en pantalla.",
    data,
    pendingAccept: open ? { amount: computed.breakdown.finalPrice, session_id: open.id } : undefined,
  };
}

/**
 * photo_preview_design: AI preview of the appointment reference design on
 * the open session nails. Mirrors the preview route flow: SAM pre-check on
 * the before photo (needs all five nails, no Image call otherwise), one
 * Muse Image call, SAM post-check with at most one same-prompt retry
 * (hard cap: two Image calls per request), then the PNG is stored.
 * Operates on the open session, like session_quote does: no arguments.
 */
const PREVIEW_DESIGN: DesignSpec = {
  shape: "natural",
  color: "reference",
  finish: "reference",
  detail: "reference",
};

/** Hard cap: at most two Image calls per request, no matter what. */
const MAX_PREVIEW_IMAGE_CALLS = 2;

function sniffPreviewMime(bytes: Buffer): "image/png" | "image/jpeg" {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    ? "image/png"
    : "image/jpeg";
}

/**
 * Reference photo bytes plus the servable URL, if any. Absolute disk
 * paths and data URLs stay server-side: only seed-assets/ values map to
 * /api/photos?file= URLs, which the photos route allowlists.
 */
function resolveReferencePhoto(refValue: string): { bytes: Buffer; url: string | null } | null {
  const dataMatch = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(refValue);
  if (dataMatch) {
    try {
      const bytes = Buffer.from(dataMatch[2], "base64");
      return bytes.length > 0 ? { bytes, url: null } : null;
    } catch {
      return null;
    }
  }
  if (refValue.startsWith("seed-assets/")) {
    if (!/^seed-assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png)$/i.test(refValue) || refValue.includes("..")) {
      return null;
    }
    try {
      const bytes = readFileSync(join(process.cwd(), refValue));
      if (bytes.length === 0) return null;
      return { bytes, url: `/api/photos?file=${refValue}` };
    } catch {
      return null;
    }
  }
  try {
    const bytes = readFileSync(isAbsolute(refValue) ? refValue : join(process.cwd(), refValue));
    return bytes.length > 0 ? { bytes, url: null } : null;
  } catch {
    return null;
  }
}

export async function previewDesign(
  db: ValeDb,
  _args: Record<string, unknown>,
  language: ValeLanguage = "es",
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  const fail = (en: string, es: string): ToolResult => ({
    ok: false,
    message: language === "en" ? en : es,
  });
  const open = getOpenSession(db);
  if (!open) return fail("No session is open.", "No hay sesión abierta.");
  let before: Buffer;
  try {
    before = readFileSync(sessionPhotoPath(open.id, "pre", sessionPhotosDir()));
    if (before.length === 0) throw new Error("empty before photo");
  } catch {
    return fail("Take a before photo first.", "Toma la foto del antes primero.");
  }
  const session = db
    .prepare("SELECT client_id, service_id FROM sessions WHERE id = ?")
    .get(open.id) as { client_id: number; service_id: number } | undefined;
  const appointment = session
    ? (db
        .prepare(
          "SELECT id, reference_photo FROM appointments WHERE client_id = ? AND service_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(session.client_id, session.service_id) as
        | { id: number; reference_photo: string | null }
        | undefined)
    : undefined;
  const refValue = appointment?.reference_photo?.trim() ?? "";
  const reference = refValue === "" ? null : resolveReferencePhoto(refValue);
  if (!reference) {
    return fail(
      "I don't have a reference photo for this appointment.",
      "No tengo foto de referencia para esta cita.",
    );
  }
  const key = process.env.META_API_KEY?.trim() ?? "";
  if (!key) return fail("Preview is not available right now.", "La vista previa no está disponible ahora.");
  const beforeMime = sniffPreviewMime(before);
  let beforeBoxes: Awaited<ReturnType<typeof segmentNails>>;
  try {
    beforeBoxes = await segmentNails(
      key,
      `data:${beforeMime};base64,${before.toString("base64")}`,
      fetchImpl,
    );
  } catch {
    return fail("Photo preview failed.", "Falló la vista previa.");
  }
  if (beforeBoxes.length !== 5) {
    return { ok: false, message: "I need a photo with all five nails visible." };
  }
  const referenceMime = sniffPreviewMime(reference.bytes);
  const previewInput = {
    beforePhoto: before,
    mime: beforeMime,
    referencePhoto: reference.bytes,
    referenceMime,
    design: PREVIEW_DESIGN,
    appointmentRef: appointment ? `APT-${appointment.id}` : "APT-open",
  };
  const previewOpts = { apiKey: key, fetchImpl, costLogPath: previewCostLogPath() };
  let imageCalls = 0;
  let result: Awaited<ReturnType<typeof runPhotoPreview>>;
  try {
    result = await runPhotoPreview(previewInput, previewOpts);
    imageCalls += 1;
  } catch {
    return fail("Photo preview failed.", "Falló la vista previa.");
  }
  const postCheck = async (): Promise<{ count: number; matched: boolean }> => {
    const afterBoxes = await segmentNails(
      key,
      `data:image/png;base64,${result.image.toString("base64")}`,
      fetchImpl,
    );
    return { count: afterBoxes.length, matched: samBoxesMatch(beforeBoxes, afterBoxes) };
  };
  try {
    const first = await postCheck();
    if (!first.matched && imageCalls < MAX_PREVIEW_IMAGE_CALLS) {
      result = await runPhotoPreview(previewInput, previewOpts);
      imageCalls += 1;
      await postCheck();
    }
  } catch {
    return fail("Photo preview failed.", "Falló la vista previa.");
  }
  const previewName = `preview_${open.id}.png`;
  mkdirSync(previewsDir(), { recursive: true });
  writeFileSync(join(previewsDir(), previewName), result.image);
  return {
    ok: true,
    message: "Here is how it would look. The preview is on screen.",
    data: {
      before: `/api/photos?file=pre_${open.id}.jpg`,
      reference: reference.url,
      expected: `/api/photos?file=${previewName}`,
      elapsedMs: result.elapsedMs,
      estimatedCostUsd: result.estimatedCostUsd,
      aiPreview: true,
      disclaimer: result.disclaimer,
    },
  };
}

/**
 * photo_show: the stored session photos, whichever exist. No SAM, no
 * image generation, no description: only file presence probed, so showing
 * the reference never demands a before photo or spends an Image call.
 * Operates on the open session, like session_quote: no arguments.
 */
export function showPhotos(db: ValeDb, language: ValeLanguage = "es"): ToolResult {
  const open = getOpenSession(db);
  if (!open) return { ok: false, message: language === "en" ? "No session is open." : "No hay sesión abierta." };
  const stored = (file: string): string | null =>
    existsSync(join(sessionPhotosDir(), file)) ? `/api/photos?file=${file}` : null;
  const storedPreview = (file: string): string | null =>
    existsSync(join(previewsDir(), file)) ? `/api/photos?file=${file}` : null;
  const session = db
    .prepare("SELECT client_id, service_id FROM sessions WHERE id = ?")
    .get(open.id) as { client_id: number; service_id: number } | undefined;
  const appointment = session
    ? (db
        .prepare(
          "SELECT reference_photo FROM appointments WHERE client_id = ? AND service_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(session.client_id, session.service_id) as { reference_photo: string | null } | undefined)
    : undefined;
  const refValue = appointment?.reference_photo?.trim() ?? "";
  const reference = refValue === "" ? null : (resolveReferencePhoto(refValue)?.url ?? null);
  return {
    ok: true,
    message: language === "en" ? "Here are the stored session photos." : "Aquí están las fotos guardadas de la sesión.",
    data: {
      before: stored(`pre_${open.id}.jpg`),
      reference,
      expected: storedPreview(`preview_${open.id}.png`),
      final: stored(`post_${open.id}.jpg`),
    },
  };
}

/**
 * Today on the salon clock. America/Bogota always: the server-local date
 * is a different day for hours around midnight. Exported for tests.
 */
export function localDay(when = new Date()): string {
  return bogotaDay(when);
}

/** Current time on the salon clock (HH:MM). Exported for tests. */
export function localTime(when = new Date()): string {
  return bogotaTime(when);
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
 * Weekend or outside 9-17 appointments still save: the warning rides the
 * message, then the booking is announced. 17:00 counts as in-hours.
 */
export function offHoursReasons(day: string, time: string): string[] {
  const reasons: string[] = [];
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(year, month - 1, date).getDay();
  if (weekday === 0 || weekday === 6) reasons.push("cae en fin de semana");
  if (time < "09:00" || time > "17:00") reasons.push("queda fuera de 9 a 17");
  return reasons;
}

/** The salon clock for natural dates: today plus the current time. */
function bogotaAnchor(): { today: string; time: string } {
  const now = new Date();
  return { today: bogotaDay(now), time: bogotaTime(now) };
}

/**
 * Resolve day/time from explicit stamps or natural words. Natural words win
 * when present; without either, the correction keeps the fallback time.
 */
function resolveDayTime(
  args: { day?: unknown; time?: unknown; when?: unknown },
  fallbackTime: string | null,
  language: ValeLanguage,
): { day: string; time: string } | { error: string } {
  const rawDay = typeof args.day === "string" ? args.day : "";
  const rawTime = typeof args.time === "string" ? args.time : "";
  const rawWhen = typeof args.when === "string" ? args.when.trim() : "";
  if (rawWhen !== "") {
    const anchor = bogotaAnchor();
    const parsed = parseNaturalDate(rawWhen, anchor);
    if (parsed === null) {
      return {
        error:
          language === "en"
            ? `I didn't catch the date in "${rawWhen}".`
            : `No entendí la fecha en "${rawWhen}".`,
      };
    }
    // A date correction with no time keeps the original time (9.4): the
    // anchor time is only for phrases with no time to keep.
    const time = hasTimeSignal(rawWhen) ? parsed.time : (fallbackTime ?? parsed.time);
    return { day: parsed.day, time };
  }
  if (rawDay === "" || rawTime === "") {
    return {
      error:
        language === "en"
          ? "Which day and time?"
          : "¿Qué día y a qué hora?",
    };
  }
  const problem = checkDayTime(rawDay, rawTime);
  if (problem) return { error: problem };
  return { day: rawDay, time: rawTime };
}

/** True when the natural words name a time of day. */
function hasTimeSignal(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    /\b(am|pm)\b/.test(lowered) ||
    /\b(noon|midnight)\b/.test(lowered) ||
    /\d:\d/.test(lowered) ||
    /\bat\s+\d/.test(lowered)
  );
}

export function createAppointment(
  db: ValeDb,
  args: {
    client_name?: unknown;
    service_name?: unknown;
    day?: unknown;
    time?: unknown;
    when?: unknown;
  },
  language: ValeLanguage = "es",
): ToolResult {
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const serviceName = typeof args.service_name === "string" ? args.service_name : "";
  const client = matchOne(
    db.prepare("SELECT id, name FROM clients ORDER BY id").all() as unknown as Named[],
    clientName,
  );
  if (client.kind === "none") return { ok: false, message: `No encuentro a "${clientName}".` };
  if (client.kind === "ambiguous") return { ok: false, message: ambiguousMessage(client.options) };
  // The service falls back to the open session; only then do we ask.
  let service: Match = { kind: "none" };
  if (serviceName.trim() !== "") {
    service = matchService(db, serviceName);
    if (service.kind === "none") return { ok: false, message: `No encuentro el servicio "${serviceName}".` };
  } else {
    const open = getOpenSession(db);
    if (open) {
      const row = db.prepare("SELECT id, name FROM services WHERE id = ?").get(open.service_id) as Named | undefined;
      if (row) service = { kind: "match", row, how: "exact" };
    }
  }
  if (service.kind === "none") {
    return {
      ok: false,
      message:
        language === "en"
          ? `Which service for ${client.row.name}?`
          : `¿Qué servicio para ${client.row.name}?`,
    };
  }
  if (service.kind === "ambiguous") return { ok: false, message: ambiguousMessage(service.options) };
  const resolved = resolveDayTime(args, null, language);
  if ("error" in resolved) return { ok: false, message: resolved.error };
  const calendar = checkCalendarDay(resolved.day, language);
  if (calendar) return { ok: false, message: calendar };
  // Decision 2: the booking always saves, even off hours. Undo fixes it.
  const result = db
    .prepare("INSERT INTO appointments (client_id, service_id, day, time) VALUES (?, ?, ?, ?)")
    .run(client.row.id, service.row.id, resolved.day, resolved.time);
  const id = Number(result.lastInsertRowid);
  logWrite(db, "agenda_create_appointment", "appointments", id);
  const reasons = offHoursReasons(resolved.day, resolved.time);
  const natural = formatNaturalDateTime(resolved.day, resolved.time);
  let message =
    language === "en"
      ? `Booked: ${client.row.name} ${natural} for ${service.row.name}.`
      : `Guardada: ${client.row.name} ${natural} de ${service.row.name}.`;
  if (reasons.length > 0) {
    message += language === "en" ? " It is off hours." : " Queda fuera de horario.";
  }
  return {
    ok: true,
    message,
    data: {
      appointment_id: id,
      client: client.row.name,
      service: service.row.name,
      day: resolved.day,
      time: resolved.time,
      off_hours: reasons.length > 0,
    },
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

export function listToday(db: ValeDb, language: ValeLanguage = "es"): ToolResult {
  const rows = listAppointments(db, "WHERE a.day = ?", localDay());
  if (rows.length === 0)
    return { ok: true, message: language === "en" ? "Nothing today." : "No tienes nada hoy.", data: { appointments: [] } };
  return {
    ok: true,
    message:
      language === "en"
        ? `Today: ${rows.map(appointmentLabel).join(", ")}.`
        : `Hoy tienes: ${rows.map(appointmentLabel).join(", ")}.`,
    data: { appointments: rows },
  };
}

export function nextAppointment(db: ValeDb, language: ValeLanguage = "es"): ToolResult {
  const now = localTime();
  const rows = listAppointments(db, "WHERE a.day = ? AND a.time >= ?", localDay(), now);
  if (rows.length === 0)
    return { ok: true, message: language === "en" ? "Nobody else today." : "No queda nadie hoy.", data: { appointment: null } };
  const next = rows[0];
  return {
    ok: true,
    message: language === "en" ? `Next is ${next.client} at ${next.time}.` : `Sigue ${next.client} a las ${next.time}.`,
    data: { appointment: next },
  };
}

/**
 * Resolve which appointment moves: one booking moves at once; several ask
 * which day, and a day pinpoints it.
 */
function appointmentToMove(
  db: ValeDb,
  clientId: number,
  day: unknown,
  language: ValeLanguage,
): AppointmentRow[] | { error: string } {
  const pinned = typeof day === "string" && DAY_RE.test(day) ? day : "";
  const rows = listAppointments(db, "WHERE a.client_id = ?", clientId);
  if (rows.length === 0) return { error: language === "en" ? "No appointments found." : "No encuentro citas." };
  if (pinned !== "") {
    const same = rows.filter((row) => row.day === pinned);
    if (same.length === 0) return { error: language === "en" ? "No appointment on that day." : "No hay cita ese día." };
    return same;
  }
  return rows;
}

export function moveAppointment(
  db: ValeDb,
  args: { client_name?: unknown; new_day?: unknown; new_time?: unknown; new_when?: unknown; day?: unknown; confirm_move?: unknown },
  language: ValeLanguage = "es",
): ToolResult {
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const client = matchOne(
    db.prepare("SELECT id, name FROM clients ORDER BY id").all() as unknown as Named[],
    clientName,
  );
  if (client.kind === "none") return { ok: false, message: `No encuentro a "${clientName}".` };
  if (client.kind === "ambiguous") return { ok: false, message: ambiguousMessage(client.options) };
  const picked = appointmentToMove(db, client.row.id, args.day, language);
  if ("error" in picked) return { ok: false, message: picked.error };
  if (picked.length > 1) {
    const options = picked.map((row) => formatNaturalDateTime(row.day, row.time)).join(" or ");
    return {
      ok: false,
      message:
        language === "en"
          ? `Which one: ${options}?`
          : `¿Cuál: ${options}?`,
    };
  }
  const current = picked[0];
  // A date correction with no time keeps the booking's own time (9.4).
  const resolved = resolveDayTime(
    { day: args.new_day, time: args.new_time, when: args.new_when },
    current.time,
    language,
  );
  if ("error" in resolved) return { ok: false, message: resolved.error };
  const calendar = checkCalendarDay(resolved.day, language);
  if (calendar) return { ok: false, message: calendar };
  // Moves ask first (decision 2): the refusal carries the question and a
  // yes runs the same call with confirm_move true.
  if (args.confirm_move !== true) {
    const natural = formatNaturalDateTime(resolved.day, resolved.time);
    return {
      ok: false,
      message:
        language === "en"
          ? `Move ${current.client} to ${natural}? Say yes to confirm.`
          : `¿Muevo a ${current.client} a ${natural}? Di que sí para confirmar.`,
      pendingMove: { client_name: client.row.name, new_day: resolved.day, new_time: resolved.time },
      data: { pending_move: true },
    };
  }
  db.prepare("UPDATE appointments SET day = ?, time = ? WHERE id = ?").run(
    resolved.day,
    resolved.time,
    current.id,
  );
  logWrite(db, "agenda_move_appointment", "appointments", current.id, { prev_day: current.day, prev_time: current.time });
  const natural = formatNaturalDateTime(resolved.day, resolved.time);
  return {
    ok: true,
    message: language === "en" ? `Moved: ${current.client} ${natural}.` : `Movida: ${current.client} ${natural}.`,
    data: {
      appointment_id: current.id,
      client: current.client,
      service: current.service,
      day: resolved.day,
      time: resolved.time,
    },
  };
}

export function cancelAppointment(
  db: ValeDb,
  args: { client_name?: unknown; day?: unknown; confirm_cancel?: unknown; appointment_id?: unknown },
  language: ValeLanguage = "es",
): ToolResult {
  // A confirmed yes names the booking directly: no client needed.
  if (typeof args.appointment_id === "number") {
    const row = db.prepare("SELECT id FROM appointments WHERE id = ?").get(args.appointment_id) as { id: number } | undefined;
    if (!row) {
      return { ok: false, message: language === "en" ? "That booking is gone." : "Esa cita ya no existe." };
    }
    if (args.confirm_cancel !== true) {
      return {
        ok: false,
        message: language === "en" ? "Say yes to confirm." : "Di que sí para confirmar.",
        pendingCancel: { appointment_id: row.id },
        data: { pending_cancel: true },
      };
    }
    const current = listAppointments(db, "WHERE a.id = ?", row.id)[0];
    const full = db.prepare("SELECT * FROM appointments WHERE id = ?").get(row.id) as Record<string, unknown>;
    db.prepare("DELETE FROM appointments WHERE id = ?").run(row.id);
    logWrite(db, "agenda_cancel_appointment", "appointments", row.id, { row: full });
    const natural = formatNaturalDateTime(current.day, current.time);
    return {
      ok: true,
      message: language === "en" ? `Cancelled: ${current.client} ${natural}.` : `Cancelada: ${current.client} ${natural}.`,
      data: { appointment_id: row.id },
    };
  }
  const clientName = typeof args.client_name === "string" ? args.client_name : "";
  const client = matchOne(
    db.prepare("SELECT id, name FROM clients ORDER BY id").all() as unknown as Named[],
    clientName,
  );
  if (client.kind === "none") return { ok: false, message: `No encuentro a "${clientName}".` };
  if (client.kind === "ambiguous") return { ok: false, message: ambiguousMessage(client.options) };
  const picked = appointmentToMove(db, client.row.id, args.day, language);
  if ("error" in picked) return { ok: false, message: picked.error };
  if (picked.length > 1) {
    const options = picked.map((row) => formatNaturalDateTime(row.day, row.time)).join(" or ");
    return {
      ok: false,
      message:
        language === "en"
          ? `Which one: ${options}?`
          : `¿Cuál: ${options}?`,
    };
  }
  const current = picked[0];
  // Deletes ask first (decision 2): a yes runs the same call confirmed.
  if (args.confirm_cancel !== true) {
    const natural = formatNaturalDateTime(current.day, current.time);
    return {
      ok: false,
      message:
        language === "en"
          ? `Cancel ${current.client} ${natural}? Say yes to confirm.`
          : `¿Cancelo a ${current.client} ${natural}? Di que sí para confirmar.`,
      pendingCancel: { appointment_id: current.id },
      data: { pending_cancel: true },
    };
  }
  const full = db.prepare("SELECT * FROM appointments WHERE id = ?").get(current.id) as Record<string, unknown>;
  db.prepare("DELETE FROM appointments WHERE id = ?").run(current.id);
  logWrite(db, "agenda_cancel_appointment", "appointments", current.id, { row: full });
  const natural = formatNaturalDateTime(current.day, current.time);
  return {
    ok: true,
    message: language === "en" ? `Cancelled: ${current.client} ${natural}.` : `Cancelada: ${current.client} ${natural}.`,
    data: { appointment_id: current.id },
  };
}

/**
 * agenda_show: appointments with reminders (0.2, X.1). Today is voice
 * only and opens no sheet: the voice says the day, the screen stays put.
 */
export function showAgenda(
  db: ValeDb,
  args: { range?: unknown; day?: unknown; from?: unknown; to?: unknown },
  language: ValeLanguage = "es",
): ToolResult {
  const range = typeof args.range === "string" ? args.range.trim().toLowerCase() : "";
  const anchor = typeof args.day === "string" && DAY_RE.test(args.day) ? args.day : bogotaDay(new Date());
  let start = anchor;
  let end = anchor;
  if (range === "today" || range === "date") {
    if (range === "date" && (typeof args.day !== "string" || !DAY_RE.test(args.day))) {
      return {
        ok: false,
        message: language === "en" ? "Which date?" : "¿Qué fecha?",
      };
    }
    start = range === "date" ? (args.day as string) : bogotaDay(new Date());
    end = start;
  } else if (range === "week") {
    start = anchor;
    end = addDaysIso(anchor, 6);
  } else if (range === "range") {
    if (typeof args.from !== "string" || !DAY_RE.test(args.from) || typeof args.to !== "string" || !DAY_RE.test(args.to)) {
      return {
        ok: false,
        message: language === "en" ? "Which days, from and to?" : "¿Qué días, desde y hasta?",
      };
    }
    start = args.from;
    end = args.to;
  } else {
    return {
      ok: false,
      message: language === "en" ? "Today, a date, the week, or a range?" : "¿Hoy, una fecha, la semana o un rango?",
    };
  }
  const appointments = listAppointments(db, "WHERE a.day >= ? AND a.day <= ?", start, end);
  const reminders = db
    .prepare("SELECT id, text, kind FROM reminders WHERE day >= ? AND day <= ? ORDER BY day, id")
    .all(start, end) as { id: number; text: string; kind: string }[];
  const said = appointments.map(
    (row) => `${row.client} at ${hour12(row.time)} for ${row.service}`,
  );
  const rangeWords =
    range === "today" ? (language === "en" ? "Today" : "Hoy") : `${start} to ${end}`;
  let message =
    said.length > 0
      ? language === "en"
        ? `${rangeWords}: ${said.join("; ")}.`
        : `${rangeWords}: ${said.join("; ")}.`
      : language === "en"
        ? `${rangeWords}: nothing on the books.`
        : `${rangeWords}: no tienes nada.`;
  if (reminders.length > 0) {
    message += language === "en" ? ` Reminders: ${reminders.map((item) => item.text).join("; ")}.` : ` Recuerda: ${reminders.map((item) => item.text).join("; ")}.`;
  }
  return {
    ok: true,
    message,
    data: { range, start, end, appointments, reminders } satisfies { range: string; start: string; end: string; appointments: AppointmentRow[]; reminders: { id: number; text: string; kind: string }[] },
  };
}

/** Add days to an ISO day on the Bogota calendar (no DST there). */
function addDaysIso(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1, date, 12));
  const next = new Date(base.getTime() + delta * 86_400_000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
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
  logWrite(db, "stock_set", "supplies", found.row.id, { prev_qty: row.stock_qty });
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
  logWrite(db, "stock_add", "supplies", found.row.id, { prev_qty: row.stock_qty });
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
    case "session_open":
      return openSession(db, args, language);
    case "session_close":
      return closeSession(db, args, language);
    case "session_log_supply":
      return logSupplyUse(db, args, language);
    case "session_quote":
      return quoteSession(db, args, language);
    case "session_quote_accept":
      return acceptQuote(db, args, language);
    case "client_create":
      return createClient(db, args, language);
    case "client_card_show":
      return showClientCard(db, args, language);
    case "client_note_add":
      return addNote(db, args, language);
    case "shopping_add":
      return addToShoppingList(db, args, language);
    case "shopping_show":
      return readShoppingList(db);
    case "shopping_remove":
      return removeFromShoppingList(db, args, language);
    case "service_show":
      return showService(db, args, language);
    case "widget_show":
      return showWidget(db, args, language);
    case "photo_show":
      return showPhotos(db, language);
    case "tool_get_details":
      return getToolDetails(args, language);
    case "agenda_create_appointment":
      return createAppointment(db, args, language);
    case "list_today":
      return listToday(db, language);
    case "next_appointment":
      return nextAppointment(db, language);
    case "agenda_show":
      return showAgenda(db, args, language);
    case "agenda_get_next":
      return nextAppointment(db, language);
    case "agenda_move_appointment":
      return moveAppointment(db, args, language);
    case "agenda_cancel_appointment":
      return cancelAppointment(db, args, language);
    case "agenda_create_reminder":
      return createReminder(db, args, language);
    case "goal_show":
      return goalProgress(db);
    case "stock_set":
      return setStock(db, args, language);
    case "stock_add":
      return addStock(db, args, language);
    case "stock_show_low":
      return readStock(db);
    case "undo_last":
      return undoLastWrite(db, language);
    default:
      return { ok: false, message: "Herramienta desconocida." };
  }
}

/**
 * Async tool runner. Synchronous tools delegate to runValeTool; model
 * tools that call out over the network live here so the sync runner and
 * the yes-vote path stay synchronous.
 */
export async function runValeToolAsync(
  db: ValeDb,
  name: string,
  args: Record<string, unknown>,
  language: ValeLanguage = "es",
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  if (name === "photo_preview_design") {
    return previewDesign(db, args, language, fetchImpl);
  }
  return runValeTool(db, name, args, language);
}
