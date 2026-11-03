// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { previewsDir, sessionPhotosDir } from "@/lib/session-photo";
import { GET } from "./route";

const savedPhotoDir = process.env.VALE_PHOTO_DIR;
let photoDir = "";

const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 8, 9]);

function useTmpPhotos(): string {
  photoDir = mkdtempSync(join(tmpdir(), "route-photos-"));
  process.env.VALE_PHOTO_DIR = photoDir;
  mkdirSync(sessionPhotosDir(), { recursive: true });
  mkdirSync(previewsDir(), { recursive: true });
  writeFileSync(join(sessionPhotosDir(), "pre_7.jpg"), JPG_BYTES);
  writeFileSync(join(previewsDir(), "preview_7.png"), PNG_BYTES);
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

function getRequest(file: string | null): Request {
  const url = file === null ? "http://test/api/photos" : `http://test/api/photos?file=${file}`;
  return new Request(url);
}

describe("GET /api/photos", () => {
  it("serves a session JPG with the jpeg content type", async () => {
    useTmpPhotos();
    const res = await GET(getRequest("pre_7.jpg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPG_BYTES);
  });

  it("serves a preview PNG with the png content type", async () => {
    useTmpPhotos();
    const res = await GET(getRequest("preview_7.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("404s unknown, missing, and non-image files without touching disk outside the dirs", async () => {
    useTmpPhotos();
    for (const file of ["nope.jpg", "notes.txt", "", null]) {
      const res = await GET(getRequest(file));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(
        expect.objectContaining({ code: "E-NO-PHOTO" }),
      );
    }
  });

  it("404s traversal and absolute paths", async () => {
    useTmpPhotos();
    for (const file of ["..%2Fsecret", "..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd", "a%2Fb.jpg"]) {
      const res = await GET(getRequest(file));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(
        expect.objectContaining({ code: "E-NO-PHOTO" }),
      );
    }
  });

  it("serves a repo-committed seed-assets reference photo", async () => {
    useTmpPhotos();
    const res = await GET(getRequest("seed-assets/david-last-service.jpg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("404s seed-assets traversal, absolute paths, other dirs, and missing files", async () => {
    useTmpPhotos();
    for (const file of [
      "seed-assets/%2E%2E/secret.jpg",
      "seed-assets/%2E%2E.jpg",
      "%2Fetc%2Fpasswd",
      "other/dir.jpg",
      "seed-assets/nope.txt",
      "seed-assets/missing.jpg",
    ]) {
      const res = await GET(getRequest(file));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(
        expect.objectContaining({ code: "E-NO-PHOTO" }),
      );
    }
  });
});
