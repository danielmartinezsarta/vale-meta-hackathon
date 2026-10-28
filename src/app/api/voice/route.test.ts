// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { POST } from "./route";

let server: WebSocketServer;
let url = "";
let closedCount = 0;
let holdFinal = false;

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  url = `ws://127.0.0.1:${port}`;

  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let message: { type?: string };
      try {
        message = JSON.parse(data.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.type === "endStream") {
        if (holdFinal) return;
        socket.send(
          JSON.stringify({
            type: "transcript",
            transcript: "canned from fake asr",
            final: true,
            audioProcessedMs: 800,
          }),
        );
        return;
      }
      socket.send(JSON.stringify({ sessionId: "route-test" }));
    });
    socket.on("close", () => {
      closedCount += 1;
    });
  });

  vi.stubEnv("META_API_KEY", "test-key");
  vi.stubEnv("META_ASR_URL", url);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

function pcmBody(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(bytes);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("POST /api/voice", () => {
  it("streams PCM to Meta and returns SSE interim/final events", async () => {
    const request = new Request("http://localhost/api/voice", {
      method: "POST",
      headers: { "content-type": "audio/l16" },
      body: pcmBody(4800),
      // @ts-expect-error Node fetch streaming upload flag
      duplex: "half",
    });
    const response = await POST(request);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: final");
    expect(text).toContain("canned from fake asr");
    expect(text).toContain("event: done");
    expect(text).not.toContain("test-key");
  });

  it("accepts a canned transcript without touching ASR (agent-only turn)", async () => {
    const request = new Request("http://localhost/api/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "hello, book a gel refill" }),
    });
    const response = await POST(request);
    const text = await response.text();
    expect(text).toContain("event: final");
    expect(text).toContain("hello, book a gel refill");
  });

  it("returns a plain 503 with no stack trace when the key is missing", async () => {
    vi.stubEnv("META_API_KEY", "");
    const request = new Request("http://localhost/api/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "hi" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not configured/i);
    expect(JSON.stringify(body)).not.toMatch(/\n\s*at\s/);
    vi.stubEnv("META_API_KEY", "test-key");
  });

  it("closes the Meta socket when the page disconnects mid-turn", async () => {
    holdFinal = true;
    closedCount = 0;
    const controller = new AbortController();
    const request = new Request("http://localhost/api/voice", {
      method: "POST",
      headers: { "content-type": "audio/l16" },
      body: pcmBody(4800),
      signal: controller.signal,
      // @ts-expect-error Node fetch streaming upload flag
      duplex: "half",
    });
    const pending = POST(request);
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();
    await pending.catch(() => {});
    await vi.waitFor(() => {
      expect(closedCount).toBeGreaterThan(0);
    });
    holdFinal = false;
  });
});
