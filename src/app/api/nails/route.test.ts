// @vitest-environment node
import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshTestDb, type ValeDb } from "@/lib/db";
import { openSession } from "@/lib/vale-tools";
import { POST } from "./route";

const SAM_TEXT =
  "<|box;x1=304;y1=697;x2=462;y2=769;w=896;h=1195|>" +
  "<|box;x1=268;y1=589;x2=466;y2=680;w=896;h=1195|>";

const FAKE_PHOTO = `data:image/png;base64,${Buffer.from("fake-photo-bytes").toString("base64")}`;

let testDb: ValeDb;

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getDb: () => testDb,
  };
});

function mockFetch() {
  return vi.fn(async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as Record<
      string,
      unknown
    >;
    if (body.model === "sam-3.1") {
      return Response.json({
        id: "resp_sam",
        output: [
          { type: "message", content: [{ type: "output_text", text: SAM_TEXT }] },
        ],
      });
    }
    return Response.json({
      id: "resp_spark",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "Matte yellow with a lime drawing." },
          ],
        },
      ],
    });
  });
}

function postPhoto(image: unknown, client?: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/nails", {
      method: "POST",
      body: JSON.stringify(client === undefined ? { image } : { image, client }),
    }),
  );
}

beforeEach(() => {
  testDb = freshTestDb();
});

afterEach(() => {
  testDb.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("nails route", () => {
  it("needs a key", async () => {
    vi.stubEnv("META_API_KEY", "");
    openSession(testDb, { client_name: "Ana Beltran", service_name: "Manicura semipermanente" });
    const res = await postPhoto(FAKE_PHOTO);
    expect(res.status).toBe(503);
  });

  it("rejects a non-image payload", async () => {
    vi.stubEnv("META_API_KEY", "test-key");
    openSession(testDb, { client_name: "Ana Beltran", service_name: "Manicura semipermanente" });
    const res = await postPhoto("not-an-image");
    expect(res.status).toBe(400);
  });

  it("refuses without an open session", async () => {
    vi.stubEnv("META_API_KEY", "test-key");
    vi.stubGlobal("fetch", mockFetch());
    const res = await postPhoto(FAKE_PHOTO, "Ana Beltran");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("sesión");
  });

  it("refuses when the client does not match the open session", async () => {
    vi.stubEnv("META_API_KEY", "test-key");
    vi.stubGlobal("fetch", mockFetch());
    openSession(testDb, { client_name: "Ana Beltran", service_name: "Manicura semipermanente" });
    const res = await postPhoto(FAKE_PHOTO, "Maria Solis");
    expect(res.status).toBe(400);
  });

  it("saves the photo on the open session with descriptions", async () => {
    vi.stubEnv("META_API_KEY", "test-key");
    vi.stubGlobal("fetch", mockFetch());
    const opened = openSession(testDb, {
      client_name: "Ana Beltran",
      service_name: "Manicura semipermanente",
    });
    expect(opened.ok).toBe(true);

    const res = await postPhoto(FAKE_PHOTO, "Ana Beltran");
    expect(res.status).toBe(200);
    const saved = (await res.json()) as {
      record: {
        id: number;
        client: string;
        photo: string;
        nailCount: number;
        nails: { description: string }[];
      };
    };
    expect(saved.record.nailCount).toBe(2);
    expect(saved.record.client).toBe("Ana Beltran");
    expect(saved.record.photo).toBe(FAKE_PHOTO);
    expect(saved.record.nails[0].description).toContain("lime");

    const row = testDb
      .prepare("SELECT photo_path FROM sessions WHERE ended_at IS NULL")
      .get() as { photo_path: string };
    expect(row.photo_path).toContain(`session_${saved.record.id}.jpg`);
    expect(existsSync(row.photo_path)).toBe(true);
    rmSync(row.photo_path, { force: true });
  });
});
