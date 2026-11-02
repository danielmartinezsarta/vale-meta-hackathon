// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshTestDb, migrateDatabase, seedDatabase } from "./db";
import {
  MOSAIC_CELL_HEIGHT,
  MOSAIC_DESCRIBE_PROMPT,
  MOSAIC_PADDING,
  NAIL_CONCEPT,
  NAIL_DESCRIBE_INSTRUCTIONS,
  buildNailDescribePrompt,
  buildNailMosaic,
  describeMosaic,
  describeNail,
  parseNailBoxes,
  photoPathForSession,
  saveSessionPhoto,
  segmentNails,
  type SharpFactory,
  type SharpImage,
} from "./nails";

vi.mock("sharp", () => ({}));

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
    expect(prompt).toContain("nail art");
    expect(prompt).not.toContain("lemon");
    expect(NAIL_DESCRIBE_INSTRUCTIONS).toContain("Never promise");
    expect(NAIL_DESCRIBE_INSTRUCTIONS).toContain("colors, finish, and nail art.");
    expect(NAIL_DESCRIBE_INSTRUCTIONS).not.toContain("lemon");
    expect(NAIL_CONCEPT).toBe("nail");
  });

  it("describes the mosaic without naming materials or products", () => {
    expect(MOSAIC_DESCRIBE_PROMPT).toContain("cropped nails");
    expect(MOSAIC_DESCRIBE_PROMPT).toContain("without naming materials or products");
    expect(MOSAIC_DESCRIBE_PROMPT).not.toContain("lemon");
  });
});

function stubSharp(): {
  factory: SharpFactory;
  extracts: { left: number; top: number; width: number; height: number }[];
  resizes: { width: number; height: number }[];
  state: {
    created: { width: number; height: number; channels: number } | null;
    layers: { input: Buffer; left: number; top: number }[] | null;
  };
} {
  const extracts: { left: number; top: number; width: number; height: number }[] = [];
  const resizes: { width: number; height: number }[] = [];
  const state = {
    created: null as { width: number; height: number; channels: number } | null,
    layers: null as { input: Buffer; left: number; top: number }[] | null,
  };
  const factory = ((input: Buffer | { create: { width: number; height: number; channels: number } }) => {
    if (typeof input === "object" && "create" in input) {
      state.created = input.create;
    }
    const image: SharpImage = {
      metadata: async () => ({ width: 200, height: 100 }),
      extract: (region) => {
        extracts.push(region);
        return image;
      },
      resize: (width, height) => {
        resizes.push({ width, height });
        return image;
      },
      composite: (layers) => {
        state.layers = layers;
        return image;
      },
      png: () => image,
      toBuffer: async () => Buffer.from("mosaic-bytes"),
    };
    return image;
  }) as unknown as SharpFactory;
  return { factory, extracts, resizes, state };
}

describe("buildNailMosaic", () => {
  it("tiles N crops side by side with padding on black", async () => {
    const stub = stubSharp();
    const photo = Buffer.from("photo-bytes");
    const out = await buildNailMosaic(
      photo,
      [
        { x1: 0, y1: 0, x2: 200, y2: 100, w: 200, h: 100 },
        { x1: 0, y1: 0, x2: 200, y2: 200, w: 400, h: 200 },
        { x1: 100, y1: 0, x2: 200, y2: 50, w: 200, h: 100 },
      ],
      stub.factory,
    );
    expect(out).toEqual(Buffer.from("mosaic-bytes"));
    // Second box scales from a 400x200 SAM frame onto the 200x100 photo.
    expect(stub.extracts).toEqual([
      { left: 0, top: 0, width: 200, height: 100 },
      { left: 0, top: 0, width: 100, height: 100 },
      { left: 100, top: 0, width: 100, height: 50 },
    ]);
    // Uniform cell height, widths keep each crop aspect.
    expect(stub.resizes).toEqual([
      { width: 256, height: MOSAIC_CELL_HEIGHT },
      { width: 128, height: MOSAIC_CELL_HEIGHT },
      { width: 256, height: MOSAIC_CELL_HEIGHT },
    ]);
    expect(stub.state.created).toEqual({
      width: 256 + 128 + 256 + MOSAIC_PADDING * 4,
      height: MOSAIC_CELL_HEIGHT + MOSAIC_PADDING * 2,
      channels: 4,
    });
    expect(stub.state.layers?.map((layer) => [layer.left, layer.top])).toEqual([
      [MOSAIC_PADDING, MOSAIC_PADDING],
      [MOSAIC_PADDING + 256 + MOSAIC_PADDING, MOSAIC_PADDING],
      [MOSAIC_PADDING + 256 + MOSAIC_PADDING + 128 + MOSAIC_PADDING, MOSAIC_PADDING],
    ]);
  });

  it("throws E-NO-SHARP when sharp cannot load", async () => {
    await expect(buildNailMosaic(Buffer.from("photo-bytes"), [])).rejects.toMatchObject({
      code: "E-NO-SHARP",
    });
  });
});

describe("describeMosaic", () => {
  it("makes one Spark call with the mosaic prompt and image", async () => {
    let seenBody = "";
    const fetchDescribe = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seenBody = String(init?.body ?? "");
      return jsonResponse({
        id: "d",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "  Red matte with gold swirls. " }],
          },
        ],
      });
    });
    const text = await describeMosaic(
      "key",
      Buffer.from("mosaic-bytes"),
      fetchDescribe as typeof fetch,
    );
    expect(text).toBe("Red matte with gold swirls.");
    expect(fetchDescribe).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(seenBody) as {
      model: string;
      input: { content: { type: string; text?: string; image_url?: string }[] }[];
    };
    expect(payload.input[0].content[0].text).toBe(MOSAIC_DESCRIBE_PROMPT);
    expect(payload.input[0].content[1].image_url).toBe(
      `data:image/png;base64,${Buffer.from("mosaic-bytes").toString("base64")}`,
    );
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
