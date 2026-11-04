// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const savedKey = process.env.META_API_KEY;
const savedReplay = process.env.VALE_REPLAY;
const savedUrl = process.env.SEAMLESS_URL;
const savedToken = process.env.SEAMLESS_TOKEN;

afterEach(() => {
  if (savedKey === undefined) delete process.env.META_API_KEY;
  else process.env.META_API_KEY = savedKey;
  if (savedReplay === undefined) delete process.env.VALE_REPLAY;
  else process.env.VALE_REPLAY = savedReplay;
  if (savedUrl === undefined) delete process.env.SEAMLESS_URL;
  else process.env.SEAMLESS_URL = savedUrl;
  if (savedToken === undefined) delete process.env.SEAMLESS_TOKEN;
  else process.env.SEAMLESS_TOKEN = savedToken;
});

async function seamlessFlag(
  url: string | undefined,
  token: string | undefined,
): Promise<unknown> {
  if (url === undefined) delete process.env.SEAMLESS_URL;
  else process.env.SEAMLESS_URL = url;
  if (token === undefined) delete process.env.SEAMLESS_TOKEN;
  else process.env.SEAMLESS_TOKEN = token;
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /api/status", () => {
  it("reports a missing key and replay off without leaking anything", async () => {
    delete process.env.META_API_KEY;
    delete process.env.VALE_REPLAY;
    delete process.env.SEAMLESS_URL;
    delete process.env.SEAMLESS_TOKEN;
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
    delete process.env.SEAMLESS_TOKEN;
    const body = (await (await GET()).json()) as Record<string, unknown>;
    expect(body).toEqual({ key: true, replay: true, seamless: false });
  });

  it("reports the open-model voice off when neither value is set", async () => {
    const body = await seamlessFlag(undefined, undefined);
    expect(body).toEqual(
      expect.objectContaining({ seamless: false }),
    );
  });

  it("reports the open-model voice off with only SEAMLESS_URL set", async () => {
    const body = await seamlessFlag("https://seamless.test/speak", undefined);
    expect(body).toEqual(expect.objectContaining({ seamless: false }));
  });

  it("reports the open-model voice off with only SEAMLESS_TOKEN set", async () => {
    const body = await seamlessFlag(undefined, "test-token");
    expect(body).toEqual(expect.objectContaining({ seamless: false }));
  });

  it("reports the open-model voice only when both values are set", async () => {
    delete process.env.META_API_KEY;
    delete process.env.VALE_REPLAY;
    const body = await seamlessFlag(
      "https://seamless.test/speak",
      "test-token",
    );
    expect(body).toEqual({ key: false, replay: false, seamless: true });
  });

  it("ignores blank and whitespace-only values", async () => {
    const body = await seamlessFlag("   ", "  ");
    expect(body).toEqual(expect.objectContaining({ seamless: false }));
  });
});
