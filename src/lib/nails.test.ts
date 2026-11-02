// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshTestDb, migrateDatabase, seedDatabase } from "./db";
import {
  NAIL_CONCEPT,
  NAIL_DESCRIBE_INSTRUCTIONS,
  buildNailDescribePrompt,
  describeNail,
  parseNailBoxes,
  photoPathForSession,
  saveSessionPhoto,
  segmentNails,
} from "./nails";

const SAM_TEXT =
  "start <|box;x1=304;y1=697;x2=462;y2=769;w=896;h=1195|> mid" +
  " <|box;x1=268;y1=589;x2=466;y2=680;w=896;h=1195|> end";

const FAKE_PHOTO = `data:image/png;base64,${Buffer.from("fake-photo-bytes").toString("base64")}`;

function jsonResponse(body: unknown): Response {
  return Response.json(body);
}

function openTestSession(db: ReturnType<typeof freshTestDb>): number {
  const started = db
    .prepare("INSERT INTO sessions (client_id, service_id, started_at) VALUES (1, 1, '2026-10-29T10:00:00.000Z')")
    .run();
  return Number(started.lastInsertRowid);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseNailBoxes", () => {
  it("finds SAM boxes with coordinates", () => {
    const boxes = parseNailBoxes(SAM_TEXT);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toEqual({
      x1: 304,
      y1: 697,
      x2: 462,
      y2: 769,
      w: 896,
      h: 1195,
    });
  });

  it("returns no boxes for empty output", () => {
    expect(parseNailBoxes("no nails here")).toEqual([]);
  });
});

describe("describe prompt", () => {
  it("stays on design and finish, never exact material", () => {
    const box = { x1: 1, y1: 2, x2: 3, y2: 4, w: 8, h: 9 };
    const prompt = buildNailDescribePrompt(0, box);
    expect(prompt).toContain("x1=1");
    expect(prompt).toContain("Do not promise or name exact materials.");
    expect(NAIL_DESCRIBE_INSTRUCTIONS).toContain("Never promise");
    expect(NAIL_CONCEPT).toBe("nail");
  });
});

describe("migrateDatabase", () => {
  it("adds photo_path to a database created before the column", () => {
    const db = freshTestDb();
    db.exec("ALTER TABLE sessions DROP COLUMN photo_path");
    let columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(columns.some((column) => column.name === "photo_path")).toBe(false);

    migrateDatabase(db);
    migrateDatabase(db);

    columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(columns.some((column) => column.name === "photo_path")).toBe(true);
    db.close();
  });

  it("runs inside seedDatabase for fresh databases", () => {
    const db = freshTestDb();
    seedDatabase(db);
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(columns.some((column) => column.name === "photo_path")).toBe(true);
    db.close();
  });
});

describe("saveSessionPhoto", () => {
  it("writes the file and points the session at it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nails-"));
    try {
      const db = freshTestDb();
      const sessionId = openTestSession(db);
      const path = saveSessionPhoto(db, sessionId, FAKE_PHOTO, dir);
      expect(path).toBe(photoPathForSession(sessionId, dir));
      const row = db.prepare("SELECT photo_path FROM sessions WHERE id = ?").get(sessionId) as {
        photo_path: string;
      };
      expect(row.photo_path).toBe(path);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a photo that is not an image data URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "nails-"));
    try {
      const db = freshTestDb();
      const sessionId = openTestSession(db);
      expect(saveSessionPhoto(db, sessionId, "not-an-image", dir)).toBeNull();
      const row = db.prepare("SELECT photo_path FROM sessions WHERE id = ?").get(sessionId) as {
        photo_path: string | null;
      };
      expect(row.photo_path).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the session when the photo cannot be written", () => {
    const db = freshTestDb();
    const sessionId = openTestSession(db);
    const blocker = join(tmpdir(), `nails-blocker-${Date.now()}`);
    writeFileSync(blocker, "x");
    try {
      expect(saveSessionPhoto(db, sessionId, FAKE_PHOTO, join(blocker, "nope"))).toBeNull();
      const row = db.prepare("SELECT photo_path FROM sessions WHERE id = ?").get(sessionId) as {
        photo_path: string | null;
      };
      expect(row.photo_path).toBeNull();
      db.close();
    } finally {
      rmSync(blocker, { force: true });
    }
  });
});

describe("model calls", () => {
  it("segments with the nail concept and describes each box", async () => {
    const fetchText = vi.fn(async () =>
      jsonResponse({
        id: "s",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: SAM_TEXT }],
          },
        ],
      }),
    );
    const found = await segmentNails(
      "key",
      "data:image/png;base64,zzz",
      fetchText as typeof fetch,
    );
    expect(found).toHaveLength(2);
    expect(fetchText).toHaveBeenCalledTimes(1);

    const fetchDescribe = vi.fn(async () =>
      jsonResponse({
        id: "d",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Matte yellow." }],
          },
        ],
      }),
    );
    const description = await describeNail(
      "key",
      "data:image/png;base64,zzz",
      0,
      { x1: 1, y1: 2, x2: 3, y2: 4, w: 8, h: 9 },
      fetchDescribe as typeof fetch,
    );
    expect(description).toBe("Matte yellow.");
  });
});
