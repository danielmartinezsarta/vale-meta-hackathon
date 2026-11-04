// Management screens write path. Server-side only: never import
// from client code. Every save and delete here writes to the same tables as
// the voice tools, logs to write_log, and is reversible with undoLastWrite.
import { getBusinessSettings, getPublicNotes, type ValeDb } from "./db";
import { getStoredBrief } from "./client-briefs";
import {
  addNote,
  addToShoppingList,
  allClients,
  cancelAppointment,
  createAppointment,
  createClient,
  logWrite,
  matchOne,
  readStock,
  removeFromShoppingList,
  setStock,
  type ToolResult,
} from "./vale-tools";
import type { ValeLanguage } from "./vale-language";

const en: ValeLanguage = "en";

function fail(message: string): ToolResult {
  return { ok: false, message };
}

function num(raw: unknown): number | null {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
}

function rowById(db: ValeDb, table: string, id: number): Record<string, unknown> | null {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ?? null;
}

/* ---------- Agenda ---------- */

export interface AgendaDay {
  appointments: {
    id: number;
    day: string;
    time: string;
    client: string;
    service: string;
    clientId: number;
    serviceId: number;
    referencePhoto: string;
  }[];
  reminders: { id: number; text: string; kind: string; day: string }[];
  undated: { id: number; text: string; kind: string; day: string }[];
}

/** One day of bookings plus its reminders; undated reminders always show. */
export function listAgenda(db: ValeDb, day: string): AgendaDay {
  const appointments = db
    .prepare(
      `SELECT a.id, a.day, a.time, c.name AS client, s.name AS service,
              a.client_id AS clientId, a.service_id AS serviceId,
              a.reference_photo AS referencePhoto
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
       JOIN services s ON s.id = a.service_id
       WHERE a.day = ? ORDER BY a.time`,
    )
    .all(day) as unknown as AgendaDay["appointments"];
  const reminders = db
    .prepare("SELECT id, text, kind, day FROM reminders WHERE done = 0 AND day = ? ORDER BY id")
    .all(day) as unknown as AgendaDay["reminders"];
  const undated = db
    .prepare("SELECT id, text, kind, day FROM reminders WHERE done = 0 AND day = '' ORDER BY id")
    .all() as unknown as AgendaDay["undated"];
  return { appointments, reminders, undated };
}

export function saveAppointment(
  db: ValeDb,
  args: { id?: unknown; clientName?: unknown; serviceName?: unknown; day?: unknown; time?: unknown },
): ToolResult {
  const id = num(args.id);
  if (id !== null) {
    // Day/time edit: same table and log action as the voice move, so the
    // same undo restores the previous slot.
    const current = rowById(db, "appointments", id);
    if (!current) return fail("Appointment not found.");
    const day = text(args.day);
    const time = text(args.time);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return fail("The day or time is not valid.");
    }
    db.prepare("UPDATE appointments SET day = ?, time = ? WHERE id = ?").run(day, time, id);
    logWrite(db, "agenda_move_appointment", "appointments", id, {
      prev_day: current.day,
      prev_time: current.time,
    });
    return { ok: true, message: "Appointment saved.", data: { appointment_id: id } };
  }
  return createAppointment(
    db,
    { client_name: text(args.clientName), service_name: text(args.serviceName), day: text(args.day), time: text(args.time) },
    en,
  );
}

export function deleteAppointment(db: ValeDb, id: number): ToolResult {
  // The screen already confirmed ("Cancel appointment" is the confirm step),
  // so the voice call runs with its confirmed intent at once.
  return cancelAppointment(db, { appointment_id: id }, en);
}

export function saveReminder(
  db: ValeDb,
  args: { text?: unknown; kind?: unknown; day?: unknown; noDate?: unknown },
): ToolResult {
  const note = text(args.text);
  if (note === "") return fail("The reminder text is empty.");
  const kind = text(args.kind);
  if (!["general", "call", "shopping"].includes(kind)) return fail("Kind must be General, Call or Shopping.");
  const day = args.noDate === true ? "" : text(args.day);
  if (day !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail("The day is not valid.");
  // Direct insert (same table and log action as the voice reminder):
  // the voice helper defaults an empty day to today, the screen keeps "No date".
  const created = db
    .prepare("INSERT INTO reminders (text, kind, day) VALUES (?, ?, ?)")
    .run(note, kind, day);
  const id = Number(created.lastInsertRowid);
  logWrite(db, "agenda_create_reminder", "reminders", id);
  return { ok: true, message: "Reminder saved.", data: { reminder_id: id } };
}

export function clearAppointmentPhoto(db: ValeDb, id: number): ToolResult {
  const row = rowById(db, "appointments", id);
  if (!row) return fail("Appointment not found.");
  db.prepare("UPDATE appointments SET reference_photo = '' WHERE id = ?").run(id);
  logWrite(db, "manage_clear_appointment_photo", "appointments", id, { prev_photo: row.reference_photo ?? "" });
  return { ok: true, message: "Photo removed.", data: { appointment_id: id } };
}

export function deleteReminder(db: ValeDb, id: number): ToolResult {
  const row = rowById(db, "reminders", id);
  if (!row) return fail("Reminder not found.");
  const links = db
    .prepare("SELECT shopping_list_id FROM reminder_items WHERE reminder_id = ?")
    .all(id) as { shopping_list_id: number }[];
  const supplyIds = links
    .map((link) =>
      db.prepare("SELECT supply_id FROM shopping_list WHERE id = ?").get(link.shopping_list_id) as
        | { supply_id: number }
        | undefined,
    )
    .filter((found) => found !== undefined)
    .map((found) => (found as { supply_id: number }).supply_id);
  db.prepare("DELETE FROM reminder_items WHERE reminder_id = ?").run(id);
  db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
  logWrite(db, "manage_delete_reminder", "reminders", id, { row, supply_ids: supplyIds });
  return { ok: true, message: "Reminder deleted.", data: { reminder_id: id } };
}

/* ---------- Client files ---------- */

export interface ClientListRow {
  id: number;
  name: string;
  phone: string;
  next: string | null;
}

export function listClients(db: ValeDb, query = ""): ClientListRow[] {
  const q = `%${query.trim().toLowerCase()}%`;
  const rows = db
    .prepare(
      `SELECT id, name, phone FROM clients
       WHERE lower(name) LIKE ? OR lower(COALESCE(phone, '')) LIKE ? OR lower(COALESCE(email, '')) LIKE ?
       ORDER BY name`,
    )
    .all(q, q, q) as { id: number; name: string; phone: string }[];
  return rows.map((row) => {
    const next = db
      .prepare("SELECT day, time FROM appointments WHERE client_id = ? AND day >= date('now', 'localtime') ORDER BY day, time LIMIT 1")
      .get(row.id) as { day: string; time: string } | undefined;
    return { ...row, next: next ? `${next.day} ${next.time}` : null };
  });
}

export interface ClientDetail {
  id: number;
  name: string;
  sex: string;
  phone: string;
  email: string;
  birthday: string;
  notes: { id: number; kind: string; text: string | null; masked: boolean }[];
  healthAlert: boolean;
  visits: { id: number; visitedAt: string; service: string; photo: string; note: string }[];
  brief: string[] | null;
}

/** Full client card for the screen: same rows the voice card shows, plus the stored private brief. */
export function getClient(db: ValeDb, id: number): ClientDetail | null {
  const row = db
    .prepare("SELECT id, name, sex, phone, email, birthday FROM clients WHERE id = ?")
    .get(id) as
    | { id: number; name: string; sex: string; phone: string; email: string; birthday: string }
    | undefined;
  if (!row) return null;
  const notes = getPublicNotes(db, id);
  const visits = db
    .prepare(
      `SELECT v.id, v.visited_at AS visitedAt, COALESCE(s.name, '') AS service, v.photo, v.note
       FROM visits v LEFT JOIN services s ON s.id = v.service_id
       WHERE v.client_id = ? ORDER BY v.visited_at DESC`,
    )
    .all(id) as unknown as ClientDetail["visits"];
  let brief: string[] | null = null;
  try {
    const stored = getStoredBrief(db, id);
    brief = stored ? stored.brief.summary : null;
  } catch {
    brief = null;
  }
  return {
    ...row,
    notes,
    healthAlert: notes.some((note) => note.kind === "health_note"),
    visits,
    brief,
  };
}

const CLIENT_FIELDS = ["name", "sex", "phone", "email", "birthday"] as const;

export function saveClient(
  db: ValeDb,
  args: { id?: unknown; name?: unknown; sex?: unknown; phone?: unknown; email?: unknown; birthday?: unknown },
): ToolResult {
  const id = num(args.id);
  const name = text(args.name);
  if (name === "") return fail("The name is empty.");
  if (id === null) {
    const found = matchOne(allClients(db), name);
    if (found.kind === "match") return fail(`${found.row.name} is already registered.`);
    const created = createClient(db, { name }, en);
    if (!created.ok) return created;
    const clientId = (created.data as { client_id: number }).client_id;
    db.prepare("UPDATE clients SET sex = ?, phone = ?, email = ?, birthday = ? WHERE id = ?").run(
      text(args.sex),
      text(args.phone),
      text(args.email),
      text(args.birthday),
      clientId,
    );
    const row = rowById(db, "clients", clientId);
    logWrite(db, "manage_save_client", "clients", clientId, { prev: null, row });
    return { ok: true, message: `${name} registered.`, data: { client_id: clientId } };
  }
  const prev = rowById(db, "clients", id);
  if (!prev) return fail("Client not found.");
  if (name.toLowerCase() !== String(prev.name).toLowerCase()) {
    const found = matchOne(allClients(db).filter((item) => item.id !== id), name);
    if (found.kind === "match") return fail(`${found.row.name} is already registered.`);
  }
  db.prepare("UPDATE clients SET name = ?, sex = ?, phone = ?, email = ?, birthday = ? WHERE id = ?").run(
    name,
    text(args.sex),
    text(args.phone),
    text(args.email),
    text(args.birthday),
    id,
  );
  logWrite(db, "manage_save_client", "clients", id, { prev });
  return { ok: true, message: `${name} saved.`, data: { client_id: id } };
}

export function deleteClient(db: ValeDb, id: number): ToolResult {
  const row = rowById(db, "clients", id);
  if (!row) return fail("Client not found.");
  for (const table of ["appointments", "sessions", "visits"]) {
    const refs = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE client_id = ?`).get(id) as { n: number };
    if (refs.n > 0) return fail("This client has bookings or visits and cannot be deleted.");
  }
  const notes = db.prepare("SELECT * FROM notes WHERE client_id = ?").all(id) as Record<string, unknown>[];
  db.prepare("DELETE FROM notes WHERE client_id = ?").run(id);
  db.prepare("DELETE FROM clients WHERE id = ?").run(id);
  logWrite(db, "manage_delete_client", "clients", id, { row, notes });
  return { ok: true, message: "Client deleted.", data: { client_id: id } };
}

export function saveClientNote(
  db: ValeDb,
  args: { clientId?: unknown; text?: unknown; healthNote?: unknown },
): ToolResult {
  const clientId = num(args.clientId);
  const row = clientId === null ? null : rowById(db, "clients", clientId);
  if (!row) return fail("Client not found.");
  const noteText = text(args.text);
  if (noteText === "") return fail("The note text is empty.");
  return addNote(
    db,
    { client_name: String(row.name), text: noteText, kind: args.healthNote === true ? "health_note" : "note" },
    en,
  );
}

export function deleteClientNote(db: ValeDb, id: number): ToolResult {
  const row = rowById(db, "notes", id);
  if (!row) return fail("Note not found.");
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  logWrite(db, "manage_delete_note", "notes", id, { row });
  return { ok: true, message: "Note deleted.", data: { note_id: id } };
}

export function clearVisitPhoto(db: ValeDb, id: number): ToolResult {
  const row = rowById(db, "visits", id);
  if (!row) return fail("Visit not found.");
  db.prepare("UPDATE visits SET photo = '' WHERE id = ?").run(id);
  logWrite(db, "manage_clear_visit_photo", "visits", id, { prev_photo: row.photo ?? "" });
  return { ok: true, message: "Photo removed.", data: { visit_id: id } };
}

/* ---------- Services ---------- */

export interface ServiceRow {
  id: number;
  name: string;
  es: string;
  priceUsd: number;
  durationMin: number;
  supplies: { supplyId: number; name: string; qty: number; unit: string }[];
}

export function listServices(db: ValeDb): ServiceRow[] {
  const rows = db
    .prepare("SELECT id, name, es, price_cents, duration_min FROM services ORDER BY name")
    .all() as { id: number; name: string; es: string; price_cents: number; duration_min: number }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    es: row.es ?? "",
    priceUsd: Math.round((row.price_cents ?? 0) / 100 * 100) / 100,
    durationMin: row.duration_min,
    supplies: db
      .prepare(
        `SELECT ss.supply_id AS supplyId, s.name, ss.qty, ss.unit
         FROM service_supplies ss JOIN supplies s ON s.id = ss.supply_id
         WHERE ss.service_id = ? ORDER BY s.name`,
      )
      .all(row.id) as unknown as ServiceRow["supplies"],
  }));
}

function serviceRefs(db: ValeDb, id: number): number {
  let total = 0;
  for (const table of ["appointments", "sessions", "visits"]) {
    const column = "service_id";
    const refs = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id) as { n: number };
    total += refs.n;
  }
  return total;
}

export function saveService(
  db: ValeDb,
  args: {
    id?: unknown;
    name?: unknown;
    es?: unknown;
    priceUsd?: unknown;
    durationMin?: unknown;
    supplies?: { supplyId?: unknown; qty?: unknown; unit?: unknown }[];
  },
): ToolResult {
  const id = num(args.id);
  const name = text(args.name);
  if (name === "") return fail("The service name is empty.");
  const price = num(args.priceUsd);
  if (price === null || price < 0) return fail("The price is not valid.");
  const minutes = num(args.durationMin);
  if (minutes === null || minutes <= 0) return fail("The duration is not valid.");
  const lines = Array.isArray(args.supplies) ? args.supplies : [];
  const supplyIds: number[] = [];
  for (const line of lines) {
    const supplyId = num(line.supplyId);
    const qty = num(line.qty);
    if (supplyId === null || !rowById(db, "supplies", supplyId)) return fail("Unknown supply in the recipe.");
    if (qty === null || qty <= 0) return fail("The supply quantity is not valid.");
    supplyIds.push(supplyId);
  }
  if (id === null) {
    const dupe = db.prepare("SELECT id FROM services WHERE lower(name) = lower(?)").get(name) as
      | { id: number }
      | undefined;
    if (dupe) return fail(`${name} already exists.`);
    const created = db
      .prepare("INSERT INTO services (name, es, aliases, price_cents, duration_min) VALUES (?, ?, '[]', ?, ?)")
      .run(name, text(args.es), Math.round(price * 100), Math.round(minutes));
    const serviceId = Number(created.lastInsertRowid);
    const add = db.prepare("INSERT INTO service_supplies (service_id, supply_id, qty, unit) VALUES (?, ?, ?, ?)");
    lines.forEach((line, index) => {
      add.run(serviceId, supplyIds[index], Number(line.qty), text(line.unit) || "pcs");
    });
    logWrite(db, "manage_save_service", "services", serviceId, { prev: null });
    return { ok: true, message: `${name} saved.`, data: { service_id: serviceId } };
  }
  const prev = rowById(db, "services", id);
  if (!prev) return fail("Service not found.");
  const dupe = db.prepare("SELECT id FROM services WHERE lower(name) = lower(?) AND id != ?").get(name, id) as
    | { id: number }
    | undefined;
  if (dupe) return fail(`${name} already exists.`);
  const prevLines = db.prepare("SELECT * FROM service_supplies WHERE service_id = ?").all(id);
  db.prepare("UPDATE services SET name = ?, es = ?, price_cents = ?, duration_min = ? WHERE id = ?").run(
    name,
    text(args.es),
    Math.round(price * 100),
    Math.round(minutes),
    id,
  );
  db.prepare("DELETE FROM service_supplies WHERE service_id = ?").run(id);
  const add = db.prepare("INSERT INTO service_supplies (service_id, supply_id, qty, unit) VALUES (?, ?, ?, ?)");
  lines.forEach((line, index) => {
    add.run(id, supplyIds[index], Number(line.qty), text(line.unit) || "pcs");
  });
  logWrite(db, "manage_save_service", "services", id, { prev, prev_lines: prevLines });
  return { ok: true, message: `${name} saved.`, data: { service_id: id } };
}

export function deleteService(db: ValeDb, id: number): ToolResult {
  const row = rowById(db, "services", id);
  if (!row) return fail("Service not found.");
  if (serviceRefs(db, id) > 0) return fail("This service has bookings or sessions and cannot be deleted.");
  const lines = db.prepare("SELECT * FROM service_supplies WHERE service_id = ?").all(id);
  db.prepare("DELETE FROM service_supplies WHERE service_id = ?").run(id);
  db.prepare("DELETE FROM services WHERE id = ?").run(id);
  logWrite(db, "manage_delete_service", "services", id, { row, lines });
  return { ok: true, message: "Service deleted.", data: { service_id: id } };
}

/* ---------- Supplies & stock ---------- */

export interface SupplyRow {
  id: number;
  name: string;
  es: string;
  unit: string;
  contentPerProduct: number;
  stockQty: number;
  minQty: number;
  pricePerProductUsd: number;
  low: boolean;
}

export function listSupplies(db: ValeDb, filter: "all" | "low" = "all"): SupplyRow[] {
  const rows = db
    .prepare(
      `SELECT id, name, es, unit, content_per_product AS contentPerProduct, stock_qty AS stockQty,
              min_qty AS minQty, price_per_product_usd AS pricePerProductUsd
       FROM supplies ORDER BY name`,
    )
    .all() as unknown as SupplyRow[];
  const withFlag = rows.map((row) => ({ ...row, low: row.stockQty <= row.minQty }));
  return filter === "low" ? withFlag.filter((row) => row.low) : withFlag;
}

export function saveSupply(
  db: ValeDb,
  args: {
    id?: unknown;
    name?: unknown;
    es?: unknown;
    unit?: unknown;
    contentPerProduct?: unknown;
    stockQty?: unknown;
    minQty?: unknown;
    pricePerProductUsd?: unknown;
  },
): ToolResult {
  const id = num(args.id);
  const name = text(args.name);
  if (name === "") return fail("The supply name is empty.");
  const unit = text(args.unit) || "pcs";
  if (!["pcs", "ml", "g"].includes(unit)) return fail("Unit must be pcs, ml or g.");
  const content = num(args.contentPerProduct) ?? 1;
  const stock = num(args.stockQty);
  const min = num(args.minQty) ?? 0;
  const price = num(args.pricePerProductUsd) ?? 0;
  if (content <= 0 || stock === null || stock < 0 || min < 0 || price < 0) {
    return fail("Stock, minimum and price must be zero or more.");
  }
  if (id === null) {
    const dupe = db.prepare("SELECT id FROM supplies WHERE lower(name) = lower(?)").get(name) as
      | { id: number }
      | undefined;
    if (dupe) return fail(`${name} already exists.`);
    const created = db
      .prepare(
        "INSERT INTO supplies (name, es, aliases, unit, content_per_product, stock_qty, min_qty, price_per_product_usd) VALUES (?, ?, '[]', ?, ?, ?, ?, ?)",
      )
      .run(name, text(args.es), unit, content, stock, min, price);
    const supplyId = Number(created.lastInsertRowid);
    logWrite(db, "manage_save_supply", "supplies", supplyId, { prev: null });
    return { ok: true, message: `${name} saved.`, data: { supply_id: supplyId } };
  }
  const prev = rowById(db, "supplies", id);
  if (!prev) return fail("Supply not found.");
  db.prepare(
    "UPDATE supplies SET name = ?, es = ?, unit = ?, content_per_product = ?, stock_qty = ?, min_qty = ?, price_per_product_usd = ? WHERE id = ?",
  ).run(name, text(args.es), unit, content, stock, min, price, id);
  logWrite(db, "manage_save_supply", "supplies", id, { prev });
  return { ok: true, message: `${name} saved.`, data: { supply_id: id } };
}

export function deleteSupply(db: ValeDb, id: number): ToolResult {
  const row = rowById(db, "supplies", id);
  if (!row) return fail("Supply not found.");
  for (const table of ["service_supplies", "session_supplies", "shopping_list"]) {
    const refs = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE supply_id = ?`).get(id) as { n: number };
    if (refs.n > 0) return fail("This supply is in use and cannot be deleted.");
  }
  db.prepare("DELETE FROM supplies WHERE id = ?").run(id);
  logWrite(db, "manage_delete_supply", "supplies", id, { row });
  return { ok: true, message: "Supply deleted.", data: { supply_id: id } };
}

/** Stock stepper: same voice path as setStock, so the write log and undo match. */
export function setSupplyStock(db: ValeDb, name: string, qty: number): ToolResult {
  return setStock(db, { name, qty }, en);
}

export function addSupplyToShopping(db: ValeDb, name: string): ToolResult {
  return addToShoppingList(db, { item_name: name }, en);
}

/* ---------- Shopping list ---------- */

export interface ShoppingData {
  items: { id: number; supplyId: number; name: string; stockQty: number }[];
  suggestions: { supplyId: number; name: string; stockQty: number }[];
}

export function listShopping(db: ValeDb): ShoppingData {
  const items = db
    .prepare(
      `SELECT l.id, l.supply_id AS supplyId, s.name, s.stock_qty AS stockQty
       FROM shopping_list l JOIN supplies s ON s.id = l.supply_id ORDER BY s.name`,
    )
    .all() as unknown as ShoppingData["items"];
  const inList = new Set(items.map((item) => item.supplyId));
  const low = readStock(db);
  const lowRows = Array.isArray((low.data as { low?: unknown })?.low)
    ? ((low.data as { low: { name: string; stock_qty: number }[] }).low ?? [])
    : [];
  const suggestions: ShoppingData["suggestions"] = [];
  for (const row of lowRows) {
    const supply = db.prepare("SELECT id, stock_qty FROM supplies WHERE name = ?").get(row.name) as
      | { id: number; stock_qty: number }
      | undefined;
    if (supply && !inList.has(supply.id)) {
      suggestions.push({ supplyId: supply.id, name: row.name, stockQty: supply.stock_qty });
    }
  }
  return { items, suggestions };
}

export function removeShoppingItem(db: ValeDb, name: string): ToolResult {
  return removeFromShoppingList(db, { item_name: name }, en);
}

/* ---------- Payments ---------- */

export interface PaymentRow {
  id: number;
  amountUsd: number;
  createdAt: string;
  client: string;
  service: string;
  sessionId: number;
  durationS: number | null;
}

export interface PayableSession {
  sessionId: number;
  client: string;
  service: string;
  startedAt: string;
  durationS: number | null;
  supplies: { name: string; qty: number }[];
  paid: boolean;
}

function paymentRows(db: ValeDb, where: string, ...params: (string | number)[]): PaymentRow[] {
  return db
    .prepare(
      `SELECT p.id, p.amount_usd AS amountUsd, p.created_at AS createdAt,
              c.name AS client, s.name AS service, p.session_id AS sessionId, se.duration_s AS durationS
       FROM payments p
       JOIN sessions se ON se.id = p.session_id
       JOIN clients c ON c.id = se.client_id
       JOIN services s ON s.id = se.service_id
       ${where} ORDER BY p.created_at DESC`,
    )
    .all(...params) as unknown as PaymentRow[];
}

/** Charges of this week or this month, newest first. */
export function listPayments(db: ValeDb, range: "week" | "month" = "week"): PaymentRow[] {
  if (range === "month") {
    return paymentRows(db, "WHERE strftime('%Y-%m', p.created_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')");
  }
  return paymentRows(db, "WHERE date(p.created_at, 'localtime') >= date('now', 'localtime', '-7 days')");
}

/** Closed sessions the charge form can attach a payment to. */
export function listPayableSessions(db: ValeDb): PayableSession[] {
  const rows = db
    .prepare(
      `SELECT se.id AS sessionId, c.name AS client, s.name AS service,
              se.started_at AS startedAt, se.duration_s AS durationS
       FROM sessions se
       JOIN clients c ON c.id = se.client_id
       JOIN services s ON s.id = se.service_id
       WHERE se.ended_at IS NOT NULL
       ORDER BY se.started_at DESC LIMIT 20`,
    )
    .all() as unknown as PayableSession[];
  return rows.map((row) => ({
    ...row,
    supplies: db
      .prepare(
        `SELECT s.name, ss.qty FROM session_supplies ss
         JOIN supplies s ON s.id = ss.supply_id WHERE ss.session_id = ?`,
      )
      .all(row.sessionId) as unknown as PayableSession["supplies"],
    paid:
      (db.prepare("SELECT COUNT(*) AS n FROM payments WHERE session_id = ?").get(row.sessionId) as { n: number }).n > 0,
  }));
}

export function savePayment(db: ValeDb, args: { sessionId?: unknown; amountUsd?: unknown }): ToolResult {
  const sessionId = num(args.sessionId);
  const amount = num(args.amountUsd);
  if (sessionId === null || !rowById(db, "sessions", sessionId)) return fail("Session not found.");
  if (amount === null || amount <= 0) return fail("The amount is not valid.");
  const created = db
    .prepare("INSERT INTO payments (session_id, amount_usd) VALUES (?, ?)")
    .run(sessionId, Math.round(amount * 100) / 100);
  const paymentId = Number(created.lastInsertRowid);
  logWrite(db, "manage_save_payment", "payments", paymentId, null);
  return { ok: true, message: "Payment saved.", data: { payment_id: paymentId } };
}

export function deletePayment(db: ValeDb, id: number): ToolResult {
  const row = rowById(db, "payments", id);
  if (!row) return fail("Payment not found.");
  db.prepare("DELETE FROM payments WHERE id = ?").run(id);
  logWrite(db, "manage_delete_payment", "payments", id, { row });
  return { ok: true, message: "Payment deleted.", data: { payment_id: id } };
}

/* ---------- Goals ---------- */

export function saveSettings(
  db: ValeDb,
  args: { monthlyGoalUsd?: unknown; marginPct?: unknown; schedule?: unknown; workHoursPerDay?: unknown },
): ToolResult {
  const goal = num(args.monthlyGoalUsd);
  const margin = num(args.marginPct);
  const hours = num(args.workHoursPerDay);
  const schedule = text(args.schedule);
  if (goal === null || goal <= 0) return fail("The monthly goal is not valid.");
  if (margin === null || margin < 0 || margin > 90) return fail("The margin must be between 0 and 90.");
  if (hours === null || hours <= 0 || hours > 24) return fail("Hours per day must be between 1 and 24.");
  if (schedule === "") return fail("The work days are empty.");
  const prev = getBusinessSettings(db);
  const put = db.prepare("INSERT INTO business_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  put.run("monthly_goal_usd", String(goal));
  put.run("margin_pct", String(margin));
  put.run("schedule", schedule);
  put.run("work_hours_per_day", String(hours));
  logWrite(db, "manage_save_settings", "business_settings", 1, {
    prev: {
      monthly_goal_usd: prev.monthlyGoalUsd,
      margin_pct: prev.marginPct,
      schedule: prev.schedule,
      work_hours_per_day: prev.workHoursPerDay,
    },
  });
  return { ok: true, message: "Goal saved.", data: getBusinessSettings(db) };
}

export function addFixedCost(db: ValeDb, args: { label?: unknown; amountUsd?: unknown }): ToolResult {
  const label = text(args.label);
  const amount = num(args.amountUsd);
  if (label === "") return fail("The label is empty.");
  if (amount === null || amount < 0) return fail("The amount is not valid.");
  const created = db.prepare("INSERT INTO business_fixed_costs (label, amount_usd) VALUES (?, ?)").run(label, amount);
  const costId = Number(created.lastInsertRowid);
  logWrite(db, "manage_add_fixed_cost", "business_fixed_costs", costId, null);
  return { ok: true, message: "Fixed cost added.", data: { fixed_cost_id: costId } };
}

export function deleteFixedCost(db: ValeDb, id: number): ToolResult {
  const row = rowById(db, "business_fixed_costs", id);
  if (!row) return fail("Fixed cost not found.");
  db.prepare("DELETE FROM business_fixed_costs WHERE id = ?").run(id);
  logWrite(db, "manage_delete_fixed_cost", "business_fixed_costs", id, { row });
  return { ok: true, message: "Fixed cost deleted.", data: { fixed_cost_id: id } };
}

/* ---------- Preferences ---------- */

export function saveProfileName(db: ValeDb, name: string): ToolResult {
  const next = text(name);
  if (next === "") return fail("The name is empty.");
  const prev = db.prepare("SELECT name FROM user_profile WHERE id = 1").get() as
    | { name: string }
    | undefined;
  db.prepare("INSERT INTO user_profile (id, name) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name").run(next);
  logWrite(db, "manage_save_profile", "user_profile", 1, { prev_name: prev?.name ?? "" });
  return { ok: true, message: "Profile saved.", data: { name: next } };
}
