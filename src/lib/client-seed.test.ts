// @vitest-environment node
// David's record for the private brief: 3-week visits, relative birthday.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { freshTestDb } from "./db";
import { seedBirthday, seedDay } from "./seed-dates";
import { goalProgress } from "./vale-tools";

const root = fileURLToPath(new URL("../../", import.meta.url));

function seedCliFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "vale-h005-seed-")), "vale.db");
  execFileSync("node", [join(root, "scripts", "seed.mjs")], {
    env: { ...process.env, VALE_DB_PATH: file },
    timeout: 30000,
    stdio: "pipe",
  });
  return file;
}

function davidId(db: DatabaseSync): number {
  return (db.prepare("SELECT id FROM clients WHERE name = ?").get("David") as { id: number }).id;
}

describe("David seed for the private brief", () => {
  it("keeps the birthday five days out with the 1990 year", () => {
    const db = freshTestDb();
    try {
      const row = db.prepare("SELECT birthday FROM clients WHERE name = ?").get("David") as {
        birthday: string;
      };
      expect(row.birthday).toBe(seedBirthday(5, 1990));
      expect(row.birthday).toMatch(/^1990-\d{2}-\d{2}$/);
      const file = seedCliFile();
      const cli = new DatabaseSync(file);
      try {
        const cliRow = cli.prepare("SELECT birthday FROM clients WHERE name = ?").get("David") as {
          birthday: string;
        };
        expect(cliRow.birthday).toBe(row.birthday);
      } finally {
        cli.close();
      }
    } finally {
      db.close();
    }
  });

  it("clamps the relative birthday to the month length", () => {
    // 2024-02-24 plus 5 days is Feb 29: a common birth year has no such day.
    expect(seedBirthday(5, 1990, new Date("2024-02-24T12:00:00Z"))).toBe("1990-02-28");
  });

  it("seeds the 3-week visit pattern with the demo notes", () => {
    const db = freshTestDb();
    try {
      const id = davidId(db);
      const visits = db
        .prepare("SELECT visited_at, photo FROM visits WHERE client_id = ? ORDER BY visited_at")
        .all(id) as { visited_at: string; photo: string }[];
      expect(visits.map((row) => row.visited_at.slice(0, 10))).toEqual([
        seedDay(-63),
        seedDay(-42),
        seedDay(-21),
      ]);
      for (const visit of visits) expect(visit.photo.length).toBeGreaterThan(0);
      const notes = db
        .prepare("SELECT text, kind, private_for_glimmer FROM notes WHERE client_id = ? ORDER BY id")
        .all(id) as { text: string; kind: string; private_for_glimmer: number }[];
      expect(notes).toEqual([
        { text: "Test allergy (demo only): reacts to latex gloves.", kind: "health_note", private_for_glimmer: 1 },
        { text: "Prefers dark matte designs", kind: "note", private_for_glimmer: 0 },
        { text: "Hockey fan, ask about the Rangers", kind: "note", private_for_glimmer: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it("moves David's old sessions to Alejandra with the goal untouched", () => {
    const db = freshTestDb();
    try {
      const davidSessions = (
        db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE client_id = ?").get(davidId(db)) as {
          n: number;
        }
      ).n;
      expect(davidSessions).toBe(0);
      const moved = db
        .prepare(
          `SELECT s.name AS service, se.started_at AS started, se.duration_s AS duration,
                  se.margin_earned AS margin FROM sessions se
           JOIN services s ON s.id = se.service_id JOIN clients c ON c.id = se.client_id
           WHERE c.name = 'Ana' ORDER BY se.started_at`,
        )
        .all() as { service: string; started: string; duration: number; margin: number }[];
      const month = new Date().toISOString().slice(0, 7);
      for (const row of moved) expect(row.started.slice(0, 7)).toBe(month);
      expect(
        moved
          .map((row) => `${row.service} ${row.started.slice(11, 16)} ${row.duration / 60}min ${row.margin}`)
          .sort(),
      ).toEqual([
        "Gel refill 10:00 75min 22.4",
        "Gel removal 12:00 30min 9.8",
        "Semi-permanent manicure 15:00 60min 19.2",
      ]);
      const data = goalProgress(db).data as { earned_usd: number };
      expect(data.earned_usd).toBeCloseTo(22.4 + 19.2 + 18.1 + 19.6 + 9.8 + 23.5, 5);
    } finally {
      db.close();
    }
  });
});
