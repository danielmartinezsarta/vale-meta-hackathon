// @vitest-environment node
/**
 * B1: automatic replay of the real fixtures through the ASR path.
 * Decodes fixtures/*.webm to PCM_24KHZ mono 16-bit with ffmpeg (dev
 * dependency of this workflow), feeds the bytes through POST /api/voice
 * with a silence-aware fake ASR, and asserts the pipeline behavior.
 * Real-engine word recognition is covered by the budgeted live replay run
 * (see the builder report); this suite runs on every gate with no budget.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { POST } from "./route";

let server: WebSocketServer;
let url = "";
let receivedBytes = 0;
let receivedSilent = true;

function findFfmpeg(): string {
  for (const candidate of ["ffmpeg", "/Users/daniel/.hermes/tools/ffmpeg-9.0.1-darwin-arm64/ffmpeg"]) {
    try {
      execFileSync(candidate, ["-version"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error("ffmpeg is required for the audio fixture replay test");
}

function decodeToPcm24k(webmPath: string): Buffer {
  return execFileSync(
    findFfmpeg(),
    ["-v", "error", "-i", webmPath, "-ar", "24000", "-ac", "1", "-f", "s16le", "-"],
    { maxBuffer: 4 * 1024 * 1024 },
  ) as Buffer;
}

function chunkedStream(data: Buffer): ReadableStream<Uint8Array> {
  const mid = Math.floor(data.length / 2);
  const parts = [data.subarray(0, mid), data.subarray(mid)];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(new Uint8Array(part.buffer, part.byteOffset, part.length));
      }
      controller.close();
    },
  });
}

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  url = `ws://127.0.0.1:${port}`;

  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const bytes = data as Buffer;
        receivedBytes += bytes.length;
        const view = new Int16Array(
          bytes.buffer,
          bytes.byteOffset,
          Math.floor(bytes.length / 2),
        );
        for (const sample of view) {
          if (Math.abs(sample) >= 200) {
            receivedSilent = false;
            break;
          }
        }
        return;
      }
      let message: { type?: string };
      try {
        message = JSON.parse(data.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.type === "endStream") {
        socket.send(
          JSON.stringify({
            type: "transcript",
            transcript: receivedSilent ? "" : "hello book a gel refill",
            final: true,
            audioProcessedMs: 1700,
          }),
        );
        return;
      }
      receivedBytes = 0;
      receivedSilent = true;
      socket.send(JSON.stringify({ sessionId: "replay-test" }));
    });
  });

  vi.stubEnv("META_API_KEY", "test-key");
  vi.stubEnv("META_ASR_URL", url);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

function postPcm(data: Buffer) {
  return POST(
    new Request("http://localhost/api/voice", {
      method: "POST",
      headers: { "content-type": "audio/l16" },
      body: chunkedStream(data),
      // @ts-expect-error Node fetch streaming upload flag
      duplex: "half",
    }),
  ).then((response) => response.text());
}

describe("fixture replay through the ASR path (B1)", () => {
  it("replays hello.webm: every byte flows and a final transcript comes back", async () => {
    const path = join(process.cwd(), "fixtures/hello.webm");
    expect(existsSync(path)).toBe(true);
    const pcm = decodeToPcm24k(path);
    // ~1.7 s of speech at 48 000 bytes/s.
    expect(pcm.length).toBeGreaterThan(48000);
    expect(pcm.length).toBeLessThan(144000);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unused", { status: 200 })),
    );
    const text = await postPcm(pcm);
    // The whole fixture crossed into the ASR socket.
    expect(receivedBytes).toBe(pcm.length);
    expect(receivedSilent).toBe(false);
    expect(text).toContain("event: final");
    expect(text).toContain("hello book a gel refill");
    expect(text).not.toContain("event: notice");
    vi.unstubAllGlobals();
  });

  it("replays silence.webm: no model call, gentle notice instead", async () => {
    const path = join(process.cwd(), "fixtures/silence.webm");
    expect(existsSync(path)).toBe(true);
    const pcm = decodeToPcm24k(path);
    // 2 s of digital silence at 48 000 bytes/s.
    expect(pcm.length).toBeGreaterThan(90000);
    expect(pcm.length).toBeLessThan(102000);

    const modelFetch = vi.fn(async () => new Response("unused", { status: 200 }));
    vi.stubGlobal("fetch", modelFetch);
    const text = await postPcm(pcm);
    expect(receivedBytes).toBe(pcm.length);
    expect(receivedSilent).toBe(true);
    expect(text).toContain("event: notice");
    expect(text).not.toContain("event: reply");
    expect(modelFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
