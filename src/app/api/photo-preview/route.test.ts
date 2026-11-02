// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import {
  previewCostLogPath,
  previewsDir,
  sessionPhotosDir,
} from "@/lib/session-photo";
import { appendPreviewCost, PREVIEW_ENDPOINT } from "@/lib/photo-preview";
import { POST } from "./route";

const savedPhotoDir = process.env.VALE_PHOTO_DIR;
const savedKey = process.env.META_API_KEY;
let photoDir = "";

const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 8, 9]);

function useTmpPhotos(): string {
  photoDir = mkdtempSync(join(tmpdir(), "route-photo-preview-"));
  process.env.VALE_PHOTO_DIR = photoDir;
  process.env.META_API_KEY = "test-key";
  return photoDir;
}

afterEach(() => {
  if (savedPhotoDir === undefined) delete process.env.VALE_PHOTO_DIR;
  else process.env.VALE_PHOTO_DIR = savedPhotoDir;
  if (savedKey === undefined) delete process.env.META_API_KEY;
  else process.env.META_API_KEY = savedKey;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (photoDir) {
    rmSync(photoDir, { recursive: true, force: true });
    photoDir = "";
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function previewRequest(sessionId: unknown): Request {
  return new Request("http://test/api/photo-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

/** Session with a before photo on disk plus an appointment reference photo. */
function seedReadySession(dir: string): { sessionId: number; appointmentId: number } {
  const db = getDb();
  const sessionId = Number(
    db
      .prepare("INSERT INTO sessions (client_id, service_id, started_at) VALUES (1, 1, '2026-11-02T10:00:00.000Z')")
      .run().lastInsertRowid,
  );
  mkdirSync(sessionPhotosDir(), { recursive: true });
  writeFileSync(join(sessionPhotosDir(), `pre_${sessionId}.jpg`), JPG_BYTES);
  const refPath = join(dir, `ref_${sessionId}.jpg`);
  writeFileSync(refPath, JPG_BYTES);
  const appointmentId = Number(
    db
      .prepare(
        "INSERT INTO appointments (client_id, service_id, day, time, reference_photo_ref) VALUES (1, 1, '2026-11-03', '10:00', ?)",
      )
      .run(refPath).lastInsertRowid,
  );
  return { sessionId, appointmentId };
}

const PREVIEW_PAYLOAD = {
  data: [{ b64_json: PNG_BYTES.toString("base64") }],
  width: 64,
  height: 64,
  usage: { input_tokens: 10, output_tokens: 20 },
};

interface BoxSpec {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
}

const FIVE_BOXES: BoxSpec[] = [
  { x1: 0, y1: 0, x2: 100, y2: 100, w: 1000, h: 1000 },
  { x1: 200, y1: 100, x2: 300, y2: 200, w: 1000, h: 1000 },
  { x1: 400, y1: 200, x2: 500, y2: 300, w: 1000, h: 1000 },
  { x1: 600, y1: 300, x2: 700, y2: 400, w: 1000, h: 1000 },
  { x1: 800, y1: 400, x2: 900, y2: 500, w: 1000, h: 1000 },
];

const FOUR_BOXES: BoxSpec[] = FIVE_BOXES.slice(0, 4);

const SHIFTED_BOXES: BoxSpec[] = FIVE_BOXES.map((box, index) =>
  index === 2
    ? { ...box, x1: box.x1 + 300, x2: box.x2 + 300 }
    : { ...box },
);

function boxText(boxes: BoxSpec[]): string {
  return (
    boxes
      .map((box) => `nails <|box;x1=${box.x1};y1=${box.y1};x2=${box.x2};y2=${box.y2};w=${box.w};h=${box.h}|>`)
      .join(" ") + " done"
  );
}

function samResponse(text: string): Response {
  return jsonResponse({
    id: "sam-1",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  });
}

/**
 * Dispatching stub: Image endpoint calls get the preview payload, every
 * other call (SAM segmentation) gets the next queued box text. Returns the
 * mock so tests can count Image calls by endpoint.
 */
function stubFlows(samTexts: string[]) {
  let samCalls = 0;
  const fetchMock = vi.fn(async (url: unknown, _init?: RequestInit) => {
    if (String(url) === PREVIEW_ENDPOINT) return jsonResponse(PREVIEW_PAYLOAD);
    const text = samTexts[Math.min(samCalls, samTexts.length - 1)];
    samCalls += 1;
    return samResponse(text);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function imageCallCount(fetchMock: ReturnType<typeof stubFlows>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === PREVIEW_ENDPOINT).length;
}

describe("POST /api/photo-preview", () => {
  it("makes one two-image call and returns checks with secondCall false", async () => {
    useTmpPhotos();
    const { sessionId } = seedReadySession(photoDir);
    const fetchMock = stubFlows([boxText(FIVE_BOXES), boxText(FIVE_BOXES)]);
    const res = await POST(previewRequest(sessionId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      previewUrl: `/api/photos?file=preview_${sessionId}.png`,
      elapsedMs: expect.any(Number),
      estimatedCostUsd: 0.1,
      aiPreview: true,
      disclaimer: "AI preview, the real result may vary",
      preCheck: { nailCount: 5, boxes: FIVE_BOXES },
      postCheck: { nailCount: 5, matched: true },
      secondCall: false,
    });
    expect(imageCallCount(fetchMock)).toBe(1);
    const imageCall = fetchMock.mock.calls.find((call) => String(call[0]) === PREVIEW_ENDPOINT);
    const sent = (imageCall?.[1] as unknown as RequestInit).body as FormData;
    expect(sent.getAll("image")).toHaveLength(2);
    expect(existsSync(join(previewsDir(), `preview_${sessionId}.png`))).toBe(true);
    const lines = readFileSync(previewCostLogPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { costUsd: number }).costUsd).toBe(0.1);
  });

  it("returns 422 with zero Image calls when the pre-check sees 4 nails", async () => {
    useTmpPhotos();
    const { sessionId } = seedReadySession(photoDir);
    const fetchMock = stubFlows([boxText(FOUR_BOXES)]);
    const res = await POST(previewRequest(sessionId));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "I need a photo with all five nails visible.",
      code: "E-NO-NAILS",
      sam: { nailCount: 4, boxes: FOUR_BOXES },
    });
    expect(imageCallCount(fetchMock)).toBe(0);
  });

  it("runs exactly one more Image call on post-check mismatch and returns secondCall true", async () => {
    useTmpPhotos();
    const { sessionId } = seedReadySession(photoDir);
    const fetchMock = stubFlows([
      boxText(FIVE_BOXES),
      boxText(SHIFTED_BOXES),
      boxText(FIVE_BOXES),
    ]);
    const res = await POST(previewRequest(sessionId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        ok: true,
        postCheck: { nailCount: 5, matched: true },
        secondCall: true,
      }),
    );
    expect(imageCallCount(fetchMock)).toBe(2);
  });

  it("never exceeds 2 Image calls even when the retry still mismatches", async () => {
    useTmpPhotos();
    const { sessionId } = seedReadySession(photoDir);
    const fetchMock = stubFlows([
      boxText(FIVE_BOXES),
      boxText(SHIFTED_BOXES),
      boxText(SHIFTED_BOXES),
    ]);
    const res = await POST(previewRequest(sessionId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        ok: true,
        postCheck: { nailCount: 5, matched: false },
        secondCall: true,
      }),
    );
    expect(imageCallCount(fetchMock)).toBe(2);
  });

  it("rejects unknown sessions with E-NO-SESSION without calling the model", async () => {
    useTmpPhotos();
    const fetchMock = vi.fn(async () => jsonResponse(PREVIEW_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(previewRequest(999999));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "E-NO-SESSION" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns E-NO-PHOTO when the before photo is missing", async () => {
    useTmpPhotos();
    const sessionId = Number(
      getDb()
        .prepare("INSERT INTO sessions (client_id, service_id, started_at) VALUES (1, 1, '2026-11-02T10:00:00.000Z')")
        .run().lastInsertRowid,
    );
    const fetchMock = vi.fn(async () => jsonResponse(PREVIEW_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(previewRequest(sessionId));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "E-NO-PHOTO" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns E-NO-PHOTO when no appointment reference photo exists", async () => {
    useTmpPhotos();
    const db = getDb();
    const clientId = Number(
      db.prepare("INSERT INTO clients (name) VALUES (?)").run(`preview-client-${Date.now()}`).lastInsertRowid,
    );
    const serviceId = Number(
      db.prepare("INSERT INTO services (name, price_cents, duration_min) VALUES (?, 100, 30)").run(`preview-service-${Date.now()}`).lastInsertRowid,
    );
    const sessionId = Number(
      db
        .prepare("INSERT INTO sessions (client_id, service_id, started_at) VALUES (?, ?, '2026-11-02T10:00:00.000Z')")
        .run(clientId, serviceId).lastInsertRowid,
    );
    mkdirSync(sessionPhotosDir(), { recursive: true });
    writeFileSync(join(sessionPhotosDir(), `pre_${sessionId}.jpg`), JPG_BYTES);
    const fetchMock = vi.fn(async () => jsonResponse(PREVIEW_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(previewRequest(sessionId));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "E-NO-PHOTO" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the budget server-side with E-BUDGET", async () => {
    useTmpPhotos();
    const { sessionId } = seedReadySession(photoDir);
    appendPreviewCost(
      { inputTokens: 0, outputTokens: 0, elapsedMs: 1, costUsd: 2.0 },
      previewCostLogPath(),
    );
    const fetchMock = stubFlows([boxText(FIVE_BOXES)]);
    const res = await POST(previewRequest(sessionId));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "E-BUDGET" }),
    );
    expect(imageCallCount(fetchMock)).toBe(0);
  });
});
