// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MODEL } from "@/lib/agent";
import { getDb } from "@/lib/db";
import { SAM_MODEL } from "@/lib/nails";
import { POST } from "./route";

vi.mock("sharp", () => {
  const chain = () => {
    const image = {
      metadata: async () => ({ width: 200, height: 100 }),
      extract: () => image,
      resize: () => image,
      composite: () => image,
      png: () => image,
      toBuffer: async () => Buffer.from("fake-mosaic"),
    };
    return image;
  };
  return { default: () => chain() };
});

const savedPhotoDir = process.env.VALE_PHOTO_DIR;
const savedApiKey = process.env.META_API_KEY;
let photoDir = "";

function useTmpPhotos(): string {
  photoDir = mkdtempSync(join(tmpdir(), "route-session-photo-"));
  process.env.VALE_PHOTO_DIR = photoDir;
  return photoDir;
}

afterEach(() => {
  if (savedPhotoDir === undefined) delete process.env.VALE_PHOTO_DIR;
  else process.env.VALE_PHOTO_DIR = savedPhotoDir;
  if (savedApiKey === undefined) delete process.env.META_API_KEY;
  else process.env.META_API_KEY = savedApiKey;
  vi.unstubAllGlobals();
  if (photoDir) {
    rmSync(photoDir, { recursive: true, force: true });
    photoDir = "";
  }
});

function boxToken(index: number): string {
  const base = index * 10;
  return `<|box;x1=${base};y1=${base};x2=${base + 50};y2=${base + 50};w=200;h=100|>`;
}

/** Stubbed SAM plus Spark; returns every request body so tests count calls. */
function stubModels(samBoxes: number, description: string): Record<string, unknown>[] {
  process.env.META_API_KEY = "test-key";
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      bodies.push(body);
      const text =
        body.model === SAM_MODEL
          ? Array.from({ length: samBoxes }, (_, index) => boxToken(index)).join(" ")
          : description;
      return Response.json({
        id: "x",
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
      });
    }),
  );
  return bodies;
}

function sparkCalls(bodies: Record<string, unknown>[]): Record<string, unknown>[] {
  return bodies.filter((body) => body.model === AGENT_MODEL);
}

function openSession(): number {
  const row = getDb()
    .prepare("INSERT INTO sessions (client_id, service_id, started_at) VALUES (1, 1, '2026-11-02T10:00:00.000Z')")
    .run();
  return Number(row.lastInsertRowid);
}

const PNG = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], "photo.png", {
  type: "image/png",
});

function uploadRequest(fields: { photo?: File; sessionId?: string; slot?: string }): Request {
  const form = new FormData();
  if (fields.photo) form.set("photo", fields.photo);
  if (fields.sessionId !== undefined) form.set("sessionId", fields.sessionId);
  if (fields.slot !== undefined) form.set("slot", fields.slot);
  return new Request("http://test/api/session-photo", { method: "POST", body: form });
}

describe("POST /api/session-photo", () => {
  it("stores a before photo as pre with boxes and no mosaic", async () => {
    const dir = useTmpPhotos();
    stubModels(2, "unused description");
    const sessionId = openSession();
    const res = await POST(
      uploadRequest({ photo: PNG, sessionId: String(sessionId), slot: "before" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      sessionId,
      slot: "pre",
      photoUrl: `/api/photos?file=pre_${sessionId}.jpg`,
      sam: {
        nailCount: 2,
        boxes: [
          { x1: 0, y1: 0, x2: 50, y2: 50, w: 200, h: 100 },
          { x1: 10, y1: 10, x2: 60, y2: 60, w: 200, h: 100 },
        ],
      },
      checks: { nailsFound: false, nailsExpected: 5, mosaic: false },
    });
    expect("photoPath" in body).toBe(false);
    expect("mosaicUrl" in body).toBe(false);
    expect("description" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain(dir);
    expect(existsSync(join(dir, "session-photos", `pre_${sessionId}.jpg`))).toBe(true);
  });

  it("maps after to post and reference to ref", async () => {
    const dir = useTmpPhotos();
    stubModels(5, "Red matte.");
    const sessionId = openSession();
    const after = await POST(
      uploadRequest({ photo: PNG, sessionId: String(sessionId), slot: "after" }),
    );
    expect(await after.json()).toEqual(
      expect.objectContaining({
        ok: true,
        sessionId,
        slot: "post",
        mosaicUrl: `/api/photos?file=mosaic_${sessionId}.png`,
      }),
    );
    const reference = await POST(
      uploadRequest({ photo: PNG, sessionId: String(sessionId), slot: "reference" }),
    );
    expect(await reference.json()).toEqual(
      expect.objectContaining({ ok: true, sessionId, slot: "ref" }),
    );
    expect(existsSync(join(dir, "session-photos", `post_${sessionId}.jpg`))).toBe(true);
    expect(existsSync(join(dir, "session-photos", `ref_${sessionId}.jpg`))).toBe(true);
  });

  it("runs SAM plus one mosaic describe on after and stores the mosaic", async () => {
    const dir = useTmpPhotos();
    const bodies = stubModels(5, "Red matte with gold swirls.");
    const sessionId = openSession();
    const res = await POST(
      uploadRequest({ photo: PNG, sessionId: String(sessionId), slot: "after" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      sessionId,
      slot: "post",
      photoUrl: `/api/photos?file=post_${sessionId}.jpg`,
      sam: {
        nailCount: 5,
        boxes: [0, 1, 2, 3, 4].map((index) => ({
          x1: index * 10,
          y1: index * 10,
          x2: index * 10 + 50,
          y2: index * 10 + 50,
          w: 200,
          h: 100,
        })),
      },
      mosaicUrl: `/api/photos?file=mosaic_${sessionId}.png`,
      description: "Red matte with gold swirls.",
      checks: { nailsFound: true, nailsExpected: 5, mosaic: true },
    });
    expect(bodies).toHaveLength(2);
    expect(sparkCalls(bodies)).toHaveLength(1);
    expect(existsSync(join(dir, "previews", `mosaic_${sessionId}.png`))).toBe(true);
  });

  it("still describes after when SAM finds fewer than 5 nails", async () => {
    const dir = useTmpPhotos();
    const bodies = stubModels(2, "Two red nails.");
    const sessionId = openSession();
    const res = await POST(
      uploadRequest({ photo: PNG, sessionId: String(sessionId), slot: "after" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        sessionId,
        slot: "post",
        mosaicUrl: `/api/photos?file=mosaic_${sessionId}.png`,
        description: "Two red nails.",
        checks: { nailsFound: false, nailsExpected: 5, mosaic: true },
      }),
    );
    expect(bodies).toHaveLength(2);
    expect(sparkCalls(bodies)).toHaveLength(1);
    expect(existsSync(join(dir, "previews", `mosaic_${sessionId}.png`))).toBe(true);
  });

  it("rejects the analysis without a key", async () => {
    useTmpPhotos();
    delete process.env.META_API_KEY;
    const sessionId = openSession();
    const res = await POST(
      uploadRequest({ photo: PNG, sessionId: String(sessionId), slot: "after" }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "E-NO-KEY" }));
  });

  it("rejects unknown or missing slots with E-BAD-SLOT", async () => {
    useTmpPhotos();
    const sessionId = openSession();
    const bad = await POST(
      uploadRequest({ photo: PNG, sessionId: String(sessionId), slot: "middle" }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual(
      expect.objectContaining({ code: "E-BAD-SLOT" }),
    );
    const missing = await POST(
      uploadRequest({ photo: PNG, sessionId: String(sessionId) }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual(
      expect.objectContaining({ code: "E-BAD-SLOT" }),
    );
  });

  it("rejects missing or non-image photos with E-NO-PHOTO", async () => {
    useTmpPhotos();
    const sessionId = openSession();
    const missing = await POST(uploadRequest({ sessionId: String(sessionId), slot: "before" }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual(
      expect.objectContaining({ code: "E-NO-PHOTO" }),
    );
    const text = new File(["hello"], "photo.txt", { type: "text/plain" });
    const wrongType = await POST(
      uploadRequest({ photo: text, sessionId: String(sessionId), slot: "before" }),
    );
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toEqual(
      expect.objectContaining({ code: "E-NO-PHOTO" }),
    );
  });

  it("rejects malformed and unknown sessions with E-NO-SESSION", async () => {
    useTmpPhotos();
    const malformed = await POST(
      uploadRequest({ photo: PNG, sessionId: "abc", slot: "before" }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual(
      expect.objectContaining({ code: "E-NO-SESSION" }),
    );
    const unknown = await POST(
      uploadRequest({ photo: PNG, sessionId: "999999", slot: "before" }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(
      expect.objectContaining({ code: "E-NO-SESSION" }),
    );
  });
});
