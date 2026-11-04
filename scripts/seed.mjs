// Seed a file database with the invented demo data.
// Usage:
//   node scripts/seed.mjs                  -> seeds data/vale-demo.db (a copy)
//   VALE_DB_PATH=/tmp/x.db node scripts/seed.mjs -> seeds that file
//   node scripts/seed.mjs --live           -> seeds the live data/vale.db
//   node scripts/seed.mjs --live --reset   -> rebuild the live file from scratch
// Never touches the live data/vale.db unless --live is passed. Reads the same
// schema and seed data as the app. The price math mirrors src/lib/quote.ts and
// src/lib/db.ts (canonical for the app); all names and figures are invented.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSeedDay, seedBirthday, seedDay } from "./seed-dates.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(join(root, "src", "lib", "seed-data.json"), "utf8"));
const schema = readFileSync(join(root, "src", "lib", "schema.sql"), "utf8");

const args = new Set(process.argv.slice(2));
const liveFile = join(root, "data", "vale.db");
const file = (() => {
  const override = (process.env.VALE_DB_PATH ?? "").trim();
  if (override) return isAbsolute(override) ? override : join(root, override);
  if (args.has("--live")) return liveFile;
  return join(root, "data", "vale-demo.db");
})();
const isLive = file === liveFile;

// The live database is only rebuilt with an explicit second flag; otherwise
// the seed merges without deleting anything.
const rebuild = !isLive || args.has("--reset");
if (!isLive || args.has("--live")) {
  mkdirSync(dirname(file), { recursive: true });
  if (rebuild && existsSync(file)) rmSync(file);
} else {
  console.error("[seed] refusing to touch the live database without --live");
  process.exit(1);
}
const db = new DatabaseSync(file);
db.exec(schema);

const pad = (value) => String(value).padStart(2, "0");
function workDaysPerWeek(schedule) {
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
function weekdayCountOfMonth(when) {
  const daysInMonth = new Date(when.getFullYear(), when.getMonth() + 1, 0).getDate();
  let count = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const weekday = new Date(when.getFullYear(), when.getMonth(), day).getDay();
    if (weekday >= 1 && weekday <= 5) count += 1;
  }
  return count;
}
// Mirrors quotePrice in src/lib/quote.ts.
function seedServicePrice(service) {
  const pricing = seed.pricing;
  const fixedMonthlyUsd = pricing.fixed_costs.reduce((sum, item) => sum + item.amount_usd, 0);
  const workable =
    weekdayCountOfMonth(new Date()) * workDaysPerWeek(pricing.schedule ?? "lun-vie") * pricing.work_hours_per_day * 60;
  const suppliesByName = new Map(seed.supplies.map((supply) => [supply.name, supply]));
  let suppliesCost = 0;
  for (const line of service.supplies ?? []) {
    const supply = suppliesByName.get(line.name);
    if (supply?.content_per_product > 0) {
      suppliesCost += (line.qty * supply.price_per_product_usd) / supply.content_per_product;
    }
  }
  const timeCost = (service.minutes * pricing.monthly_goal_usd) / workable;
  const fixedShare = (fixedMonthlyUsd * service.minutes) / workable;
  const withMargin = (suppliesCost + timeCost + fixedShare) * (1 + pricing.margin_pct / 100);
  return Math.ceil(withMargin / 10) * 10;
}

const clientIds = new Map();
const upsertClient = db.prepare(
  `INSERT INTO clients (name, sex, phone, email, birthday) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(name) DO UPDATE SET sex = excluded.sex, phone = excluded.phone, email = excluded.email, birthday = excluded.birthday`,
);
for (const client of seed.clients) {
  // Relative birthday marker (mirror of src/lib/db.ts).
  const birthday =
    typeof client.birthday_in_days === "number"
      ? seedBirthday(client.birthday_in_days, client.birthday_year ?? 1990)
      : (client.birthday ?? "");
  upsertClient.run(client.name, client.sex ?? "", client.phone ?? "", client.email ?? "", birthday);
  clientIds.set(client.name, db.prepare("SELECT id FROM clients WHERE name = ?").get(client.name).id);
}
db.prepare("INSERT OR IGNORE INTO user_profile (id, name) VALUES (1, ?)").run("Demo");

const supplyIds = new Map();
const upsertSupply = db.prepare(
  `INSERT INTO supplies (name, es, aliases, unit, content_per_product, stock_qty, min_qty, price_per_product_usd)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(name) DO UPDATE SET es = excluded.es, aliases = excluded.aliases, unit = excluded.unit,
     content_per_product = excluded.content_per_product, min_qty = excluded.min_qty, price_per_product_usd = excluded.price_per_product_usd`,
);
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
  supplyIds.set(supply.name, db.prepare("SELECT id FROM supplies WHERE name = ?").get(supply.name).id);
}

const serviceIds = new Map();
const upsertService = db.prepare(
  `INSERT INTO services (name, es, aliases, price_cents, duration_min) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(name) DO UPDATE SET es = excluded.es, aliases = excluded.aliases, price_cents = excluded.price_cents, duration_min = excluded.duration_min`,
);
for (const service of seed.services) {
  upsertService.run(
    service.name,
    service.es ?? "",
    JSON.stringify(service.aliases ?? []),
    Math.round(seedServicePrice(service) * 100),
    service.minutes,
  );
  const id = db.prepare("SELECT id FROM services WHERE name = ?").get(service.name).id;
  serviceIds.set(service.name, id);
  db.prepare("DELETE FROM service_supplies WHERE service_id = ?").run(id);
  const addLine = db.prepare("INSERT INTO service_supplies (service_id, supply_id, qty, unit) VALUES (?, ?, ?, ?)");
  for (const line of service.supplies ?? []) {
    if (supplyIds.has(line.name)) addLine.run(id, supplyIds.get(line.name), line.qty, line.unit ?? "pcs");
  }
}

for (const note of seed.demo_notes ?? []) {
  const clientId = clientIds.get(note.client);
  if (clientId === undefined) continue;
  const kind = note.kind === "health_note" || note.kind === "health" ? "health_note" : "note";
  // Dedup on the full row so one client can seed several notes.
  const existing = db.prepare("SELECT id FROM notes WHERE client_id = ? AND kind = ? AND text = ?").get(clientId, kind, note.text);
  if (!existing) {
    db.prepare("INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (?, ?, ?, ?)").run(
      clientId,
      note.text,
      kind,
      note.private === true || kind === "health_note" ? 1 : 0,
    );
  }
}

if ((seed.demo_appointments ?? []).length > 0 && db.prepare("SELECT COUNT(*) AS n FROM appointments").get().n === 0) {
  const add = db.prepare(
    "INSERT INTO appointments (client_id, service_id, day, time, reference_photo) VALUES (?, ?, ?, ?, ?)",
  );
  for (const appointment of seed.demo_appointments) {
    if (!clientIds.has(appointment.client) || !serviceIds.has(appointment.service)) continue;
    add.run(
      clientIds.get(appointment.client),
      serviceIds.get(appointment.service),
      resolveSeedDay(appointment.day),
      appointment.time,
      appointment.reference_photo ?? "",
    );
  }
}

if ((seed.demo_reminders ?? []).length > 0 && db.prepare("SELECT COUNT(*) AS n FROM reminders").get().n === 0) {
  for (const reminder of seed.demo_reminders) {
    const kind = reminder.kind === "shopping" || reminder.kind === "call" ? reminder.kind : "general";
    const id = Number(
      db
        .prepare("INSERT INTO reminders (text, kind, day) VALUES (?, ?, ?)")
        .run(reminder.text, kind, resolveSeedDay(reminder.day ?? "today")).lastInsertRowid,
    );
    for (const name of reminder.items ?? []) {
      if (!supplyIds.has(name)) continue;
      db.prepare("INSERT OR IGNORE INTO shopping_list (supply_id) VALUES (?)").run(supplyIds.get(name));
      const listId = db.prepare("SELECT id FROM shopping_list WHERE supply_id = ?").get(supplyIds.get(name)).id;
      db.prepare("INSERT OR IGNORE INTO reminder_items (reminder_id, shopping_list_id) VALUES (?, ?)").run(id, listId);
    }
  }
}

if ((seed.demo_visits ?? []).length > 0 && db.prepare("SELECT COUNT(*) AS n FROM visits").get().n === 0) {
  const add = db.prepare("INSERT INTO visits (client_id, service_id, visited_at, photo, note) VALUES (?, ?, ?, ?, ?)");
  for (const visit of seed.demo_visits) {
    if (!clientIds.has(visit.client)) continue;
    add.run(
      clientIds.get(visit.client),
      visit.service ? (serviceIds.get(visit.service) ?? null) : null,
      `${seedDay(-(visit.days_ago ?? 7))}T12:00:00`,
      visit.photo ?? "",
      visit.note ?? "",
    );
  }
}

if ((seed.demo_past_sessions ?? []).length > 0 && db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n === 0) {
  const add = db.prepare(
    "INSERT INTO sessions (client_id, service_id, started_at, ended_at, duration_s, margin_earned) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const past of seed.demo_past_sessions) {
    if (!clientIds.has(past.client) || !serviceIds.has(past.service)) continue;
    const now = new Date();
    const probe = new Date(now);
    probe.setDate(now.getDate() - (past.days_ago ?? 1));
    const sameMonth = probe.getFullYear() === now.getFullYear() && probe.getMonth() === now.getMonth();
    const day = sameMonth ? seedDay(-(past.days_ago ?? 1)) : `${seedDay(0).slice(0, 8)}01`;
    const minutes = past.minutes ?? 60;
    const [hour, minute] = (past.start ?? "10:00").split(":").map(Number);
    const started = new Date(
      Number(day.slice(0, 4)),
      Number(day.slice(5, 7)) - 1,
      Number(day.slice(8, 10)),
      hour,
      minute,
      0,
    );
    const ended = new Date(started);
    ended.setMinutes(ended.getMinutes() + minutes);
    const stamp = (when) =>
      `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}:00`;
    add.run(
      clientIds.get(past.client),
      serviceIds.get(past.service),
      stamp(started),
      stamp(ended),
      minutes * 60,
      past.margin_earned ?? 0,
    );
  }
}

const counts = Object.fromEntries(
  ["clients", "services", "supplies", "notes", "appointments", "reminders", "shopping_list", "visits", "sessions"].map(
    (table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n],
  ),
);
console.log(`[seed] ${file} ${JSON.stringify(counts)}`);
db.close();
