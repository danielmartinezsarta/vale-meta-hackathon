// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshTestDb, migrateDatabase } from "./db";
import {
  NAIL_CONCEPT,
  NAIL_DESCRIBE_INSTRUCTIONS,
  buildNailDescribePrompt,
  parseNailBoxes,
  session_photo_save,
  session_photo_show,
} from "./session-photo";

// Box tokens transcribed from the HACK-004 spike SSE log
// (Tickets/HACK-004/HACK-004 spike t2-nail.sse.log): five nail boxes
// SAM 3.1 returned inline for one photo. Coordinates only, invented demo.
const SPIKE_FIVE_BOXES =
  "nails <|box;x1=304;y1=697;x2=462;y2=769;w=896;h=1195|>" +
  " <|box;x1=268;y1=589;x2=465;y2=679;w=896;h=1195|>" +
  " <|box;x1=628;y1=257;x2=773;y2=365;w=896;h=1195|>" +
  " <|box;x1=275;y1=478;x2=474;y2=570;w=896;h=1195|>" +
  " <|box;x1=340;y1=387;x2=528;y2=466;w=896;h=1195|> done";

const FAKE_PHOTO = `data:image/png;base64,${Buffer.from("fake-slot-photo").toString("base64")}`;

function openTestSession(db: ReturnType<typeof freshTestDb>): number {
  const started = db
    .prepare("INSERT INTO sessions (client_id, service_id, started_at) VALUES (1, 1, '2026-10-29T10:00:00.000Z')")
    .run();
  return Number(started.lastInsertRowid);
}

describe("slot core (via wrapper, no duplication)", () => {
  it("parses the 5-box spike text to 5 boxes", () => {
    const boxes = parseNailBoxes(SPIKE_FIVE_BOXES);
    expect(boxes).toHaveLength(5);
    expect(boxes[2]).toEqual({
      x1: 628,
      y1: 257,
      x2: 773,
      y2: 365,
      w: 896,
      h: 1195,
    });
  });

  it("parses empty output to []", () => {
    expect(parseNailBoxes("no nails here")).toEqual([]);
  });

  it("keeps the nail concept and prompt guardrails", () => {
    expect(NAIL_CONCEPT).toBe("nail");
    expect(NAIL_DESCRIBE_INSTRUCTIONS).toContain("Never promise");
    const prompt = buildNailDescribePrompt(0, {
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
      w: 8,
      h: 9,
    });
    expect(prompt).toContain("x1=1");
    expect(prompt).toContain("Do not promise or name exact materials.");
  });
});

describe("session_photo_save", () => {
  it("saves pre+post+ref as 3 files and points the session at the photo", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-photo-"));
    try {
      const db = freshTestDb();
      const sessionId = openTestSession(db);
      const pre = session_photo_save(db, sessionId, "pre", FAKE_PHOTO, dir);
      const post = session_photo_save(db, sessionId, "post", FAKE_PHOTO, dir);
      const ref = session_photo_save(db, sessionId, "ref", FAKE_PHOTO, dir);
      expect(pre).toBe(join(dir, `pre_${sessionId}.jpg`));
      expect(post).toBe(join(dir, `post_${sessionId}.jpg`));
      expect(ref).toBe(join(dir, `ref_${sessionId}.jpg`));
      for (const path of [pre, post, ref]) expect(existsSync(path as string)).toBe(true);
      const row = db.prepare("SELECT photo_path FROM sessions WHERE id = ?").get(sessionId) as {
        photo_path: string;
      };
      expect(row.photo_path).toBe(ref);
      expect(session_photo_show(db, sessionId, "ref")).toEqual({ slot: "ref", path: ref });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for an invalid photo and keeps the session", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-photo-"));
    try {
      const db = freshTestDb();
      const sessionId = openTestSession(db);
      expect(session_photo_save(db, sessionId, "pre", "not-an-image", dir)).toBeNull();
      expect(session_photo_show(db, sessionId, "pre")).toBeNull();
      const row = db.prepare("SELECT photo_path FROM sessions WHERE id = ?").get(sessionId) as {
        photo_path: string | null;
      };
      expect(row.photo_path).toBeNull();
      const count = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(sessionId) as {
        n: number;
      };
      expect(count.n).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for an unknown slot and keeps the session", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-photo-"));
    try {
      const db = freshTestDb();
      const sessionId = openTestSession(db);
      expect(
        session_photo_save(db, sessionId, "mid" as "pre", FAKE_PHOTO, dir),
      ).toBeNull();
      expect(session_photo_show(db, sessionId, "mid" as "pre")).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migrateDatabase", () => {
  it("restores photo_path after the column is dropped", () => {
    const db = freshTestDb();
    db.exec("ALTER TABLE sessions DROP COLUMN photo_path");
    let columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(columns.some((column) => column.name === "photo_path")).toBe(false);

    migrateDatabase(db);

    columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(columns.some((column) => column.name === "photo_path")).toBe(true);
    db.close();
  });
});
