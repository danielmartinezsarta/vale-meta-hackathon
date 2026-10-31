import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAsrConnection, type AsrEvent } from "./asr";

interface Handshake {
  authorization?: { accessToken?: string };
  audioEncoding?: string;
  model?: string;
  mode?: string;
  languageBias?: unknown;
}

let server: WebSocketServer;
let url = "";
let lastHandshake: Handshake | null = null;
let binaryBytes = 0;
let serverSockets: WebSocket[] = [];
let closedCount = 0;
let failHandshake = false;

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  url = `ws://127.0.0.1:${port}`;

  server.on("connection", (socket) => {
    serverSockets.push(socket);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        binaryBytes += (data as Buffer).length;
        return;
      }
      let message: { type?: string } & Handshake;
      try {
        message = JSON.parse(data.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.type === "endStream") {
        socket.send(
          JSON.stringify({ type: "transcript", transcript: "hello", final: false }),
        );
        socket.send(
          JSON.stringify({ type: "transcript", transcript: "hello world", final: false }),
        );
        socket.send(
          JSON.stringify({
            type: "transcript",
            transcript: "hello world",
            final: true,
            audioProcessedMs: 1000,
          }),
        );
        // Meta closes after the final on PUSH_TO_TALK.
        socket.close(1000, "turn complete");
        return;
      }
      lastHandshake = message;
      if (failHandshake) {
        socket.close(1013, "limit");
        return;
      }
      socket.send(JSON.stringify({ sessionId: "test-session" }));
    });
    socket.on("close", () => {
      closedCount += 1;
    });
  });
});

afterAll(async () => {
  for (const socket of serverSockets) {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

function resetCounters() {
  lastHandshake = null;
  binaryBytes = 0;
  closedCount = 0;
  failHandshake = false;
}

describe("server ASR bridge", () => {
  it("handshakes with key, encoding, model and mode, then acks", async () => {
    resetCounters();
    const events: AsrEvent[] = [];
    const conn = await openAsrConnection({
      key: "test-key",
      url,
      onEvent: (event) => events.push(event),
    });
    expect(lastHandshake?.authorization?.accessToken).toBe("Bearer test-key");
    expect(lastHandshake?.audioEncoding).toBe("PCM_24KHZ");
    expect(lastHandshake?.model).toBe("muse-voice-transcribe-1.0");
    expect(lastHandshake?.mode).toBe("PUSH_TO_TALK");
    expect(lastHandshake?.languageBias).toEqual(["English"]);
    expect(conn.open).toBe(true);
    conn.close();
    expect(events).toEqual([]);
  });

  it("pins the transcription bias to Spanish when asked", async () => {
    resetCounters();
    const conn = await openAsrConnection({
      key: "test-key",
      url,
      language: "es",
      onEvent: () => {},
    });
    expect(lastHandshake?.languageBias).toEqual(["Spanish"]);
    conn.close();
  });

  it("forwards binary PCM and delivers interim then final on endTurn", async () => {
    resetCounters();
    const events: AsrEvent[] = [];
    const conn = await openAsrConnection({
      key: "test-key",
      url,
      onEvent: (event) => events.push(event),
    });
    conn.sendPcm(new Uint8Array(4800));
    conn.endTurn();
    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === "final")).toBe(true);
    });
    expect(binaryBytes).toBe(4800);
    expect(events.map((e) => e.kind)).toEqual(["interim", "interim", "final"]);
    expect(events[events.length - 1]).toMatchObject({
      kind: "final",
      transcript: "hello world",
    });
    conn.close();
  });

  it("rejects when the socket drops before the handshake", async () => {
    resetCounters();
    failHandshake = true;
    await expect(
      openAsrConnection({ key: "test-key", url, onEvent: () => {} }),
    ).rejects.toThrow();
  });

  it("close() closes the server-side socket", async () => {
    resetCounters();
    const conn = await openAsrConnection({
      key: "test-key",
      url,
      onEvent: () => {},
    });
    conn.close();
    await vi.waitFor(() => {
      expect(closedCount).toBe(1);
    });
  });

  it("treats the post-final socket close as a normal turn end, not an error", async () => {
    resetCounters();
    const events: AsrEvent[] = [];
    const errors: string[] = [];
    const conn = await openAsrConnection({
      key: "test-key",
      url,
      onEvent: (event) => events.push(event),
      onError: (message) => errors.push(message),
    });
    conn.sendPcm(new Uint8Array(4800));
    conn.endTurn();
    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === "final")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(conn.open).toBe(false);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors).toEqual([]);
    conn.close();
  });
});

describe("client bundle secrecy", () => {
  const clientFiles = [
    "src/app/page.tsx",
    "src/components/TapToTalk.tsx",
    "src/lib/speak.ts",
  ];
  for (const file of clientFiles) {
    it(`${file} never references the Meta key or API host`, () => {
      const root = process.cwd();
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toContain("META_API_KEY");
      expect(source).not.toContain("api.meta.ai");
    });
  }
});
