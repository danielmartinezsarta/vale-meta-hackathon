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

/** Minimal fake of the Model API streaming reply. */
function fakeAgentReply(text: string): Response {
  const raw =
    `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: text.slice(0, 4) })}\n\n` +
    `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: "resp_test",
        output: [{ type: "output_text", text }],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    })}\n\n`;
  return new Response(new TextEncoder().encode(raw), { status: 200 });
}

function stubAgent(text = "Got it, all set.") {
  return vi.fn(async () => fakeAgentReply(text));
}

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
  it("streams PCM to Meta and returns SSE interim/final/reply events", async () => {
    vi.stubGlobal("fetch", stubAgent("All set, see you soon."));
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
    expect(text).toContain("event: reply");
    expect(text).toContain("All set, see you soon.");
    expect(text).toContain("event: done");
    expect(text).not.toContain("test-key");
    vi.unstubAllGlobals();
  });

  it("accepts a canned transcript without touching ASR (agent-only turn)", async () => {
    vi.stubGlobal("fetch", stubAgent());
    const request = new Request("http://localhost/api/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "hello, book a gel refill" }),
    });
    const response = await POST(request);
    const text = await response.text();
    expect(text).toContain("event: final");
    expect(text).toContain("hello, book a gel refill");
    expect(text).toContain("event: reply");
    vi.unstubAllGlobals();
  });

  it("emits one per-turn log line with timings, tokens and cost", async () => {
    vi.stubGlobal("fetch", stubAgent("Done."));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    const sendTurn = () =>
      POST(
        new Request("http://localhost/api/voice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transcript: "first turn" }),
        }),
      ).then((response) => response.text());
    await sendTurn();
    await POST(
      new Request("http://localhost/api/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: "second turn" }),
      }),
    ).then((response) => response.text());
    const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
    expect(turns).toHaveLength(2);
    const first = JSON.parse(turns[0].replace("[voice-turn] ", ""));
    expect(first.transcript).toBe("first turn");
    expect(typeof first.ttftMs).toBe("number");
    expect(first.inputTokens).toBe(100);
    expect(first.outputTokens).toBe(20);
    expect(first.costUsd).toBeGreaterThan(0);
    expect(typeof first.ts).toBe("string");
    expect(first.tool).toBeNull();
    expect(first.error).toBeNull();
    expect(JSON.parse(turns[1].replace("[voice-turn] ", "")).transcript).toBe(
      "second turn",
    );
    spy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("keeps the transcript bubble and logs the error when the model fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    const request = new Request("http://localhost/api/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "hello, book a gel refill" }),
    });
    const text = await POST(request).then((response) => response.text());
    expect(text).toContain("event: final");
    expect(text).toContain("hello, book a gel refill");
    expect(text).toContain("Sorry, I had trouble answering.");
    const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
    expect(turns).toHaveLength(1);
    expect(JSON.parse(turns[0].replace("[voice-turn] ", "")).error).toMatch(
      /model error: 500/,
    );
    spy.mockRestore();
    vi.unstubAllGlobals();
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
