// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PRIVATE_NOTE_LABEL,
  freshTestDb,
  getCounts,
  getDb,
  getPublicNotes,
  recentTurns,
  recordTurn,
  resolveDbFile,
  seedDatabase,
  userName,
} from "./db";
import { localDay } from "./vale-tools";

describe("seeded database", () => {
  it("seeds 4 clients, 6 services and 23 supplies", () => {
    const db = freshTestDb();
    expect(getCounts(db)).toEqual({ clients: 4, services: 6, supplies: 23 });
    db.close();
  });

  it("seeds Ana among the clients", () => {
    const db = freshTestDb();
    const rows = db
      .prepare("SELECT name FROM clients WHERE name LIKE '%Ana%'")
      .all() as { name: string }[];
    expect(rows).toHaveLength(1);
    db.close();
  });

  it("seeding twice does not duplicate rows", () => {
    const db = freshTestDb();
    const before = {
      appointments: (db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number }).n,
      reminders: (db.prepare("SELECT COUNT(*) AS n FROM reminders").get() as { n: number }).n,
      sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
      visits: (db.prepare("SELECT COUNT(*) AS n FROM visits").get() as { n: number }).n,
    };
    seedDatabase(db);
    expect(getCounts(db)).toEqual({ clients: 4, services: 6, supplies: 23 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number }).n).toBe(
      before.appointments,
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM reminders").get() as { n: number }).n).toBe(before.reminders);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(before.sessions);
    expect((db.prepare("SELECT COUNT(*) AS n FROM visits").get() as { n: number }).n).toBe(before.visits);
    db.close();
  });
});

describe("demo seed (HACK-018)", () => {
  it("holds the four demo clients with full-card fields", () => {
    const db = freshTestDb();
    const rows = db
      .prepare("SELECT name, sex, phone, email, birthday FROM clients ORDER BY id")
      .all() as { name: string; sex: string; phone: string; email: string; birthday: string }[];
    expect(rows.map((row) => row.name)).toEqual(["David", "Sofia", "Paola", "Ana"]);
    for (const row of rows) {
      expect(row.sex.length).toBeGreaterThan(0);
      expect(row.phone.length).toBeGreaterThan(0);
      expect(row.email).toContain("@");
      expect(row.birthday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    db.close();
  });

  it("keeps David's test allergy masked on his card", () => {
    const db = freshTestDb();
    const david = db.prepare("SELECT id FROM clients WHERE name = ?").get("David") as { id: number };
    const notes = getPublicNotes(db, david.id);
    const health = notes.find((note) => note.kind === "health_note")!;
    expect(health.masked).toBe(true);
    expect(health.text).toBeNull();
    expect(JSON.stringify(notes)).not.toContain("latex");
    db.close();
  });

  it("holds today's three appointments plus Ana's, with David's reference photo", () => {
    const db = freshTestDb();
    const rows = db
      .prepare(
        `SELECT c.name AS client, s.name AS service, a.day, a.time, a.reference_photo AS referencePhoto
         FROM appointments a JOIN clients c ON c.id = a.client_id JOIN services s ON s.id = a.service_id
         ORDER BY a.day, a.time`,
      )
      .all() as { client: string; service: string; day: string; time: string; referencePhoto: string }[];
    expect(rows).toHaveLength(4);
    const today = rows.filter((row) => row.day === localDay());
    expect(today.map((row) => `${row.client} ${row.time}`)).toEqual([
      "David 15:00",
      "Sofia 17:00",
      "Paola 19:00",
    ]);
    for (const row of today) expect(row.service.length).toBeGreaterThan(0);
    const david = today.find((row) => row.client === "David")!;
    expect(david.referencePhoto.length).toBeGreaterThan(0);
    const ana = rows.find((row) => row.client === "Ana")!;
    expect(ana.day).not.toBe(localDay());
    db.close();
  });

  it("links the shopping reminder to shopping_list rows and keeps the call reminder", () => {
    const db = freshTestDb();
    const reminders = db.prepare("SELECT id, text, kind FROM reminders ORDER BY id").all() as {
      id: number;
      text: string;
      kind: string;
    }[];
    expect(reminders).toHaveLength(2);
    const shopping = reminders.find((row) => row.kind === "shopping")!;
    const items = db
      .prepare(
        `SELECT s.name FROM reminder_items i JOIN shopping_list l ON l.id = i.shopping_list_id
         JOIN supplies s ON s.id = l.supply_id WHERE i.reminder_id = ? ORDER BY s.name`,
      )
      .all(shopping.id) as { name: string }[];
    expect(items.map((row) => row.name)).toEqual(["Acetone", "Cotton pads", "Foil wraps"]);
    const call = reminders.find((row) => row.kind === "call")!;
    expect(call.text).toContain("cleaning company");
    const linked = db
      .prepare("SELECT COUNT(*) AS n FROM reminder_items WHERE reminder_id = ?")
      .get(call.id) as { n: number };
    expect(linked.n).toBe(0);
    db.close();
  });

  it("keeps top coat at its minimum and past sessions behind the month goal", () => {
    const db = freshTestDb();
    const top = db.prepare("SELECT stock_qty, min_qty FROM supplies WHERE name = ?").get("Top coat") as {
      stock_qty: number;
      min_qty: number;
    };
    expect(top.stock_qty).toBe(top.min_qty);
    const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NOT NULL").all() as {
      n: number;
    }[];
    expect(sessions[0].n).toBeGreaterThan(0);
    const earned = db
      .prepare(
        `SELECT COALESCE(SUM(margin_earned), 0) AS earned FROM sessions
         WHERE ended_at IS NOT NULL AND strftime('%Y-%m', ended_at) = strftime('%Y-%m', 'now')`,
      )
      .get() as { earned: number };
    expect(earned.earned).toBeGreaterThan(0);
    db.close();
  });

  it("holds visits with photo markers for every demo client", () => {
    const db = freshTestDb();
    const rows = db
      .prepare(
        `SELECT c.name AS client, v.photo FROM visits v JOIN clients c ON c.id = v.client_id ORDER BY v.id`,
      )
      .all() as { client: string; photo: string }[];
    expect(rows.map((row) => row.client).sort()).toEqual(["Ana", "David", "Paola", "Sofia"]);
    for (const row of rows) expect(row.photo.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("private health notes", () => {
  it("marks health notes private and never exposes their text", () => {
    const db = freshTestDb();
    const ana = db.prepare("SELECT id FROM clients WHERE name LIKE '%Ana%'").get() as {
      id: number;
    };
    db.prepare("INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (?, ?, ?, ?)").run(
      ana.id,
      "onicolisis en el pulgar derecho",
      "health_note",
      1,
    );
    db.prepare("INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (?, ?, ?, ?)").run(
      ana.id,
      "prefiere cita los viernes",
      "note",
      0,
    );

    const stored = db.prepare("SELECT private_for_glimmer FROM notes WHERE kind = 'health_note'").get() as {
      private_for_glimmer: number;
    };
    expect(stored.private_for_glimmer).toBe(1);

    const notes = getPublicNotes(db, ana.id);
    expect(notes).toHaveLength(2);
    const health = notes.find((note) => note.kind === "health_note")!;
    expect(health.masked).toBe(true);
    expect(health.text).toBeNull();
    expect(JSON.stringify(notes)).not.toContain("onicolisis");
    const general = notes.find((note) => note.kind === "note")!;
    expect(general.masked).toBe(false);
    expect(general.text).toBe("prefiere cita los viernes");
    expect(PRIVATE_NOTE_LABEL.length).toBeGreaterThan(0);
    db.close();
  });

  it("migrates legacy general/health kinds to note/health_note", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)");
    db.exec("INSERT INTO clients (name) VALUES ('Ana')");
    db.exec(`CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'health')),
  private_for_glimmer INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`);
    db.exec("INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (1, 'Likes neon colors', 'general', 0)");
    db.exec("INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (1, 'Allergic to monomer', 'health', 0)");
    seedDatabase(db);
    const rows = db.prepare("SELECT kind, private_for_glimmer FROM notes ORDER BY id").all() as {
      kind: string;
      private_for_glimmer: number;
    }[];
    expect(rows.slice(0, 2)).toEqual([
      { kind: "note", private_for_glimmer: 0 },
      { kind: "health_note", private_for_glimmer: 1 },
    ]);
    // New writes pass the rebuilt CHECK.
    const ana = db.prepare("SELECT id FROM clients WHERE name = 'Ana'").get() as { id: number };
    db.prepare("INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (?, ?, ?, ?)").run(
      ana.id,
      "He likes neon colors",
      "note",
      0,
    );
    db.close();
  });
});

describe("conversation turns", () => {
  it("returns the last turns in order for one client only", () => {
    const db = freshTestDb();
    recordTurn(db, "c1", "user", "Vale, open a session for Emma");
    recordTurn(db, "c1", "vale", "Which service for Emma?", "client_card_show");
    recordTurn(db, "c2", "user", "Vale, hi");
    const turns = recentTurns(db, "c1", 20);
    expect(turns).toEqual([
      { role: "user", text: "Vale, open a session for Emma", tool: null },
      { role: "vale", text: "Which service for Emma?", tool: "client_card_show" },
    ]);
    db.close();
  });

  it("stores only the label for a spoken client summary (HACK-005)", () => {
    const db = freshTestDb();
    recordTurn(db, "c1", "vale", "David comes every 3 weeks.", "client_summary");
    recordTurn(db, "c1", "vale", "David's card is on screen.", "client_card_show");
    const turns = recentTurns(db, "c1", 20);
    expect(turns).toEqual([
      { role: "vale", text: "(client summary shown)", tool: "client_summary" },
      { role: "vale", text: "David's card is on screen.", tool: "client_card_show" },
    ]);
    db.close();
  });

  it("keeps only the newest turns per client", () => {
    const db = freshTestDb();
    for (let i = 0; i < 25; i += 1) {
      recordTurn(db, "c1", i % 2 === 0 ? "user" : "vale", `turn ${i}`);
    }
    const turns = recentTurns(db, "c1", 20);
    expect(turns).toHaveLength(20);
    expect(turns[0].text).toBe("turn 5");
    expect(turns[19].text).toBe("turn 24");
    db.close();
  });
});

describe("test-database guards", () => {
  it("refuses turns without a client key", () => {
    const db = freshTestDb();
    recordTurn(db, "unknown", "user", "hello?");
    recordTurn(db, "   ", "user", "hello?");
    recordTurn(db, "c1", "user", "Vale, open a session");
    const turns = recentTurns(db, "c1", 20);
    expect(turns).toHaveLength(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n,
    ).toBe(1);
    db.close();
  });

  it("seeds Demo as the neutral user", () => {
    const db = freshTestDb();
    expect(userName(db)).toBe("Demo");
    db.close();
  });

  it("prefers VALE_USER_NAME over the seed and keeps a renamed profile", () => {
    const saved = process.env.VALE_USER_NAME;
    const db = freshTestDb();
    try {
      process.env.VALE_USER_NAME = "Maria";
      expect(userName(db)).toBe("Maria");
    } finally {
      if (saved === undefined) delete process.env.VALE_USER_NAME;
      else process.env.VALE_USER_NAME = saved;
    }
    db.prepare("UPDATE user_profile SET name = ? WHERE id = 1").run("Maria");
    seedDatabase(db);
    expect(userName(db)).toBe("Maria");
    db.close();
  });

  it("resolves the live file by default and honors VALE_DB_PATH", () => {
    const saved = process.env.VALE_DB_PATH;
    try {
      delete process.env.VALE_DB_PATH;
      expect(resolveDbFile("/tmp/x")).toBe(join("/tmp", "x", "data", "vale.db"));
      process.env.VALE_DB_PATH = "data/eval.db";
      expect(resolveDbFile("/tmp/x")).toBe(join("/tmp", "x", "data", "eval.db"));
      process.env.VALE_DB_PATH = "/tmp/abs/eval.db";
      expect(resolveDbFile("/tmp/x")).toBe("/tmp/abs/eval.db");
    } finally {
      if (saved === undefined) delete process.env.VALE_DB_PATH;
      else process.env.VALE_DB_PATH = saved;
    }
  });

  it("never lets the eval runner target the live database file", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts", "eval-hack017.mjs"),
      "utf8",
    );
    // The runner resolves its own disposable file through VALE_DB_PATH.
    expect(source).toContain("VALE_DB_PATH");
    // No reset or open may name the live file: rmSync vale.db once
    // deleted Daniel's real turns, clients and appointments.
    expect(source).not.toMatch(/rmSync\([^)]*vale\.db/);
    expect(source).not.toMatch(/new DatabaseSync\([^)]*vale\.db/);
  });

  it("refuses the file database under vitest", () => {
    const saved = process.env.VALE_DB_MEMORY;
    delete process.env.VALE_DB_MEMORY;
    try {
      expect(() => getDb()).toThrow(/under vitest/);
    } finally {
      if (saved === undefined) delete process.env.VALE_DB_MEMORY;
      else process.env.VALE_DB_MEMORY = saved;
    }
  });
});
