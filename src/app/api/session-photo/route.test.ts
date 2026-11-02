// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { POST } from "./route";

const savedPhotoDir = process.env.VALE_PHOTO_DIR;
let photoDir = "";

function useTmpPhotos(): string {
  photoDir = mkdtempSync(join(tmpdir(), "route-session-photo-"));
  process.env.VALE_PHOTO_DIR = photoDir;
  return photoDir;
}

afterEach(() => {
  if (savedPhotoDir === undefined) delete process.env.VALE_PHOTO_DIR;
  else process.env.VALE_PHOTO_DIR = savedPhotoDir;
  if (photoDir) {
    rmSync(photoDir, { recursive: true, force: true });
    photoDir = "";
  }
});

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
  it("stores a before photo as pre and returns the JSON shape", async () => {
    const dir = useTmpPhotos();
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
    });
    expect("photoPath" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain(dir);
    expect(existsSync(join(dir, "session-photos", `pre_${sessionId}.jpg`))).toBe(true);
  });

  it("maps after to post and reference to ref", async () => {
    const dir = useTmpPhotos();
    const sessionId = openSession();
    const after = await POST(
      uploadRequest({ photo: PNG, sessionId: String(sessionId), slot: "after" }),
    );
    expect(await after.json()).toEqual(
      expect.objectContaining({ ok: true, sessionId, slot: "post" }),
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
