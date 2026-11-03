import { describe, expect, it, vi } from "vitest";
import { loadPhotosData } from "./photos-data";

type FetchImpl = typeof fetch;

function stubFetch(handler: (url: string) => { ok: boolean; json?: unknown }): FetchImpl {
  return (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : String(input);
    const result = handler(url);
    return {
      ok: result.ok,
      json: async () => result.json ?? {},
    };
  }) as FetchImpl;
}

describe("loadPhotosData", () => {
  it("takes the reference photo from the appointment endpoint, never hardcoded", async () => {
    const seen: string[] = [];
    const fetchImpl = stubFetch((url) => {
      seen.push(url);
      if (url.startsWith("/api/photos/reference?sessionId=7")) {
        return {
          ok: true,
          json: { photoUrl: "/api/photos?file=seed-assets%2Ffrom-db.jpg" },
        };
      }
      if (url === "/api/photos?file=pre_7.jpg") return { ok: true };
      return { ok: false };
    });
    const data = await loadPhotosData(7, fetchImpl);
    expect(data.reference).toBe("/api/photos?file=seed-assets%2Ffrom-db.jpg");
    expect(data.before).toBe("/api/photos?file=pre_7.jpg");
    expect(data.expected).toBeNull();
    expect(data.final).toBeNull();
    expect(seen).toContain("/api/photos/reference?sessionId=7");
    expect(seen.some((url) => url.includes("david-appointment-reference"))).toBe(false);
  });

  it("leaves the reference empty when the appointment has none", async () => {
    const fetchImpl = stubFetch((url) =>
      url.startsWith("/api/photos/reference?") ? { ok: false } : { ok: false },
    );
    const data = await loadPhotosData(9, fetchImpl);
    expect(data.reference).toBeNull();
  });

  it("keeps probing the session slots even when the reference lookup fails", async () => {
    const fetchImpl = stubFetch((url) => {
      if (url === "/api/photos?file=post_7.jpg") return { ok: true };
      if (url === "/api/photos?file=pre_7.jpg") return { ok: true };
      throw new Error("network down");
    });
    const data = await loadPhotosData(7, fetchImpl);
    expect(data.before).toBe("/api/photos?file=pre_7.jpg");
    expect(data.final).toBe("/api/photos?file=post_7.jpg");
    expect(data.reference).toBeNull();
  });
});

describe("TapToTalk photo sheet", () => {
  it("has no hardcoded appointment reference file", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "src", "components", "TapToTalk.tsx"), "utf8");
    expect(source.includes("david-appointment-reference")).toBe(false);
    expect(source.includes("APPOINTMENT_REFERENCE_FILE")).toBe(false);
  });
});
