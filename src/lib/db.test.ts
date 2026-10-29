// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PRIVATE_NOTE_LABEL, freshTestDb, getCounts, getPublicNotes, seedDatabase } from "./db";

describe("seeded database", () => {
  it("seeds 5 clients, 8 services and 10 supplies", () => {
    const db = freshTestDb();
    expect(getCounts(db)).toEqual({ clients: 5, services: 8, supplies: 10 });
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
    expect(getCounts(db)).toEqual({ clients: 5, services: 8, supplies: 10 });
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
