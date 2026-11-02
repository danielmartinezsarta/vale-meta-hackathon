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
import { appendPreviewCost } from "@/lib/photo-preview";
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

describe("POST /api/photo-preview", () => {
  it("makes one two-image call and returns the JSON shape", async () => {
    useTmpPhotos();
    const { sessionId } = seedReadySession(photoDir);
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse(PREVIEW_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(previewRequest(sessionId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      previewUrl: `/api/photos?file=preview_${sessionId}.png`,
      elapsedMs: expect.any(Number),
      estimatedCostUsd: 0.1,
      aiPreview: true,
      disclaimer: "AI preview, the real result may vary",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = (fetchMock.mock.calls[0][1] as unknown as RequestInit).body as FormData;
    expect(sent.getAll("image")).toHaveLength(2);
    expect(existsSync(join(previewsDir(), `preview_${sessionId}.png`))).toBe(true);
    const lines = readFileSync(previewCostLogPath(), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { costUsd: number }).costUsd).toBe(0.1);
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
    const fetchMock = vi.fn(async () => jsonResponse(PREVIEW_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(previewRequest(sessionId));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "E-BUDGET" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
