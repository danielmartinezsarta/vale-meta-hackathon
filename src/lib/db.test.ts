// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PRIVATE_NOTE_LABEL,
  freshTestDb,
  getCounts,
  getPublicNotes,
  recentTurns,
  recordTurn,
  seedDatabase,
} from "./db";

describe("seeded database", () => {
  it("seeds 5 clients, 6 services and 23 supplies", () => {
    const db = freshTestDb();
    expect(getCounts(db)).toEqual({ clients: 5, services: 6, supplies: 23 });
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
    seedDatabase(db);
    expect(getCounts(db)).toEqual({ clients: 5, services: 6, supplies: 23 });
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
      "health",
      1,
    );
    db.prepare("INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (?, ?, ?, ?)").run(
      ana.id,
      "prefiere cita los viernes",
      "general",
      0,
    );

    const stored = db.prepare("SELECT private_for_glimmer FROM notes WHERE kind = 'health'").get() as {
      private_for_glimmer: number;
    };
    expect(stored.private_for_glimmer).toBe(1);

    const notes = getPublicNotes(db, ana.id);
    expect(notes).toHaveLength(2);
    const health = notes.find((note) => note.kind === "health")!;
    expect(health.masked).toBe(true);
    expect(health.text).toBeNull();
    expect(JSON.stringify(notes)).not.toContain("onicolisis");
    const general = notes.find((note) => note.kind === "general")!;
    expect(general.masked).toBe(false);
    expect(general.text).toBe("prefiere cita los viernes");
    expect(PRIVATE_NOTE_LABEL.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("conversation turns", () => {
  it("returns the last turns in order for one client only", () => {
    const db = freshTestDb();
    recordTurn(db, "c1", "user", "Vale, open a session for Emma");
    recordTurn(db, "c1", "vale", "Which service for Emma?", "find_client");
    recordTurn(db, "c2", "user", "Vale, hi");
    const turns = recentTurns(db, "c1", 20);
    expect(turns).toEqual([
      { role: "user", text: "Vale, open a session for Emma", tool: null },
      { role: "vale", text: "Which service for Emma?", tool: "find_client" },
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
