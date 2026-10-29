// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function wavResponse(synthesis = "0.89"): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
    status: 200,
    headers: { "Content-Type": "audio/wav", "X-Synthesis-Seconds": synthesis },
  });
}

describe("seamless-voice proxy", () => {
  it("returns the wav with the synthesis header", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => wavResponse("1.23"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(new Request("http://test/api/seamless-voice?text=Hola"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    expect(res.headers.get("X-Synthesis-Seconds")).toBe("1.23");
    expect(res.headers.get("X-Speaker-Requested")).toBe("10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("text=Hola");
    expect(String(fetchMock.mock.calls[0][0])).toContain("speaker=10");
  });

  it("forwards an explicit speaker and echoes it back", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => wavResponse());
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(
      new Request("http://test/api/seamless-voice?text=Hola&speaker=42"),
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain("speaker=42");
    expect(res.headers.get("X-Speaker-Requested")).toBe("42");
  });

  it("clamps out-of-range speakers and falls back on garbage", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => wavResponse());
    vi.stubGlobal("fetch", fetchMock);
    await GET(
      new Request("http://test/api/seamless-voice?text=Hola&speaker=999"),
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain("speaker=199");
    await GET(
      new Request("http://test/api/seamless-voice?text=Hola&speaker=abc"),
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain("speaker=10");
  });

  it("caps callers at 30 per minute with a short 429", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => wavResponse());
    vi.stubGlobal("fetch", fetchMock);
    const url = "http://test/api/seamless-voice?text=Hola";
    for (let i = 0; i < 30; i++) {
      const res = await GET(
        new Request(url, { headers: { "x-forwarded-for": "10.0.0.1" } }),
      );
      expect(res.status).toBe(200);
    }
    const limited = await GET(
      new Request(url, { headers: { "x-forwarded-for": "10.0.0.1" } }),
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual(
      expect.objectContaining({ code: "E-LIMIT" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(30);
    const other = await GET(
      new Request(url, { headers: { "x-forwarded-for": "10.0.0.2" } }),
    );
    expect(other.status).toBe(200);
  });

  it("falls back on blank speaker and clamps the low end", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => wavResponse());
    vi.stubGlobal("fetch", fetchMock);
    await GET(
      new Request("http://test/api/seamless-voice?text=Hola&speaker=%20%20"),
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain("speaker=10");
    await GET(
      new Request("http://test/api/seamless-voice?text=Hola&speaker=-5"),
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain("speaker=0");
  });

  it("caps the text at 500 characters", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => wavResponse());
    vi.stubGlobal("fetch", fetchMock);
    await GET(new Request(`http://test/api/seamless-voice?text=${"a".repeat(600)}`));
    const called = String(fetchMock.mock.calls[0][0]);
    expect(called.split("text=")[1].length).toBe(500);
  });

  it("rejects empty text without calling upstream", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => wavResponse());
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(new Request("http://test/api/seamless-voice?text=%20%20"));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps upstream failures to a short message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 500 })),
    );
    const failed = await GET(new Request("http://test/api/seamless-voice?text=Hola"));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual(
      expect.objectContaining({ code: "E-NET" }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    const unreachable = await GET(new Request("http://test/api/seamless-voice?text=Hola"));
    expect(unreachable.status).toBe(502);
  });
});
