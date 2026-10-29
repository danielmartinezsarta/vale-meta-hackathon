// Seed the file database with invented demo data. Usage: node scripts/seed.mjs
// Reads the same schema and seed data as the app. Never commits data/vale.db.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(join(root, "src", "lib", "seed-data.json"), "utf8"));
const schema = readFileSync(join(root, "src", "lib", "schema.sql"), "utf8");

const file = join(root, "data", "vale.db");
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec(schema);

const addClient = db.prepare("INSERT OR IGNORE INTO clients (name) VALUES (?)");
for (const name of seed.clients) addClient.run(name);
const addService = db.prepare(
  "INSERT OR IGNORE INTO services (name, price_cents, duration_min) VALUES (?, ?, ?)",
);
for (const service of seed.services) {
  addService.run(service.name, service.price_cents, service.duration_min);
}
const addSupply = db.prepare("INSERT OR IGNORE INTO supplies (name) VALUES (?)");
for (const name of seed.supplies) addSupply.run(name);

const counts = {
  clients: db.prepare("SELECT COUNT(*) AS n FROM clients").get().n,
  services: db.prepare("SELECT COUNT(*) AS n FROM services").get().n,
  supplies: db.prepare("SELECT COUNT(*) AS n FROM supplies").get().n,
};
console.log(`[seed] ${file} clients=${counts.clients} services=${counts.services} supplies=${counts.supplies}`);
db.close();
