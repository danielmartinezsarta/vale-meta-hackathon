// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const savedKey = process.env.META_API_KEY;
const savedReplay = process.env.VALE_REPLAY;
const savedSeamless = process.env.SEAMLESS_URL;

afterEach(() => {
  if (savedKey === undefined) delete process.env.META_API_KEY;
  else process.env.META_API_KEY = savedKey;
  if (savedReplay === undefined) delete process.env.VALE_REPLAY;
  else process.env.VALE_REPLAY = savedReplay;
  if (savedSeamless === undefined) delete process.env.SEAMLESS_URL;
  else process.env.SEAMLESS_URL = savedSeamless;
});

describe("GET /api/status", () => {
  it("reports a missing key and replay off without leaking anything", async () => {
    delete process.env.META_API_KEY;
    delete process.env.VALE_REPLAY;
    delete process.env.SEAMLESS_URL;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ key: false, replay: false, seamless: false });
    expect(JSON.stringify(body)).not.toContain("META_API_KEY");
    expect(JSON.stringify(body)).not.toContain("SEAMLESS_URL");
  });

  it("reports the key and replay when both are set", async () => {
    process.env.META_API_KEY = "test-key";
    process.env.VALE_REPLAY = "1";
    delete process.env.SEAMLESS_URL;
    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(body).toEqual({ key: true, replay: true, seamless: false });
  });

  it("reports the open-model voice only when SEAMLESS_URL is set", async () => {
    delete process.env.META_API_KEY;
    delete process.env.VALE_REPLAY;
    process.env.SEAMLESS_URL = "https://seamless.test/speak";
    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(body).toEqual({ key: false, replay: false, seamless: true });
  });
});
