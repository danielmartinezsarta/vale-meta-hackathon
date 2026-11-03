// @vitest-environment node
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { freshTestDb, userName } from "./db";
import { bogotaDay } from "./natural-date";
import { resolveSeedDay, seedDay } from "./seed-dates";
import { goalProgress, listToday } from "./vale-tools";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Seed through the judges' path (scripts/seed.mjs) into a scratch file. */
function seedCliFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "vale-demo-seed-")), "vale.db");
  execFileSync("node", [join(root, "scripts", "seed.mjs")], {
    env: { ...process.env, VALE_DB_PATH: file },
    timeout: 30000,
    stdio: "pipe",
  });
  return file;
}

function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

describe("relative-date seed helper (HACK-024, extended by HACK-005)", () => {
  it("resolves today and tomorrow on the salon clock and passes dates through", () => {
    const today = bogotaDay(new Date());
    expect(seedDay(0)).toBe(today);
    expect(resolveSeedDay("today")).toBe(today);
    expect(resolveSeedDay("tomorrow")).toBe(seedDay(1));
    expect(resolveSeedDay("2026-01-15")).toBe("2026-01-15");
  });

  it("matches the CLI helper day for day across a wide offset range", () => {
    const script = `
      import(${JSON.stringify(join(root, "scripts", "seed-dates.mjs"))}).then((m) => {
        const days = [];
        for (let offset = -40; offset <= 40; offset += 1) days.push(m.seedDay(offset));
        console.log(JSON.stringify(days));
      });`;
    const output = execFileSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    const cliDays = JSON.parse(output) as string[];
    expect(cliDays).toHaveLength(81);
    expect(cliDays[40]).toBe(seedDay(0));
    cliDays.forEach((day, index) => {
      expect(day).toBe(seedDay(index - 40));
    });
  });
});

describe("demo seed: today is never empty, owner is neutral", () => {
  it("seeds a neutral Demo user, never a real family name", () => {
    const db = freshTestDb();
    try {
      expect(userName(db)).toBe("Demo");
      const names = rows(db, "SELECT name FROM clients ORDER BY id").map((row) => row.name);
      expect(names).toEqual(["David", "Sofia", "Paola", "Ana"]);
      expect(names).not.toContain("Daniel");
      const profile = rows(db, "SELECT name FROM user_profile");
      expect(profile).toEqual([{ name: "Demo" }]);
    } finally {
      db.close();
    }
  });

  it("holds David at 3 PM with the latex note plus Sofia and Paola today", () => {
    const db = freshTestDb();
    try {
      const result = listToday(db);
      expect(result.ok).toBe(true);
      const appointments = (result.data as { appointments: { client: string; time: string }[] })
        .appointments;
      expect(appointments.map((row) => `${row.client} ${row.time}`)).toEqual([
        "David 15:00",
        "Sofia 17:00",
        "Paola 19:00",
      ]);
      const notes = rows(
        db,
        "SELECT text FROM notes WHERE kind = 'health_note'",
      ).map((row) => row.text);
      expect(notes.some((text) => String(text).toLowerCase().includes("latex"))).toBe(true);
      const davidPhoto = rows(
        db,
        "SELECT reference_photo FROM appointments WHERE day = '" + bogotaDay(new Date()) + "' AND time = '15:00'",
      );
      expect(davidPhoto[0]?.reference_photo).toContain("seed-assets/");
    } finally {
      db.close();
    }
  });

  it("shows month-goal progress and the shopping plus cleaning reminders", () => {
    const db = freshTestDb();
    try {
      const goal = goalProgress(db);
      expect(goal.ok).toBe(true);
      const data = goal.data as { earned_usd: number; goal_usd: number; month: string };
      expect(data.earned_usd).toBeGreaterThan(0);
      expect(data.earned_usd).toBeLessThan(data.goal_usd);
      expect(data.month).toBe(new Date().toISOString().slice(0, 7));
      const reminders = rows(db, "SELECT text, kind FROM reminders ORDER BY id").map(
        (row) => `${row.kind}: ${row.text}`,
      );
      expect(reminders.some((text) => text.toLowerCase().includes("acetone"))).toBe(true);
      expect(reminders.some((text) => text.toLowerCase().includes("cleaning"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("seeds the same agenda through the CLI path the judges run", () => {
    const file = seedCliFile();
    const db = new DatabaseSync(file);
    try {
      const day = bogotaDay(new Date());
      const agenda = rows(
        db,
        `SELECT c.name AS client, a.time AS time FROM appointments a
         JOIN clients c ON c.id = a.client_id WHERE a.day = '${day}' ORDER BY a.time`,
      ).map((row) => `${row.client} ${row.time}`);
      expect(agenda).toEqual(["David 15:00", "Sofia 17:00", "Paola 19:00"]);
      const profile = rows(db, "SELECT name FROM user_profile");
      expect(profile).toEqual([{ name: "Demo" }]);
    } finally {
      db.close();
    }
  });
});
