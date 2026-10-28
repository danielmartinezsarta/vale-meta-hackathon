// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  attachVoiceBridge,
  tryParseControl,
  type BridgeAgentResult,
} from "./voice-bridge";

/** Minimal browser side: the bridge only uses send/close/on/readyState. */
class FakeBrowser extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    this.sent.push(String(data));
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.emit("close");
  }
  /** Simulate an inbound frame from the browser tab. */
  peerMessage(data: unknown): void {
    this.emit("message", data);
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

let server: WebSocketServer;
let url = "";
let dropOnAudio = false;
let holdFinal = false;
let finalTranscript = "live from the bridge";
let receivedBinaryBytes = 0;
let receivedEndStream = 0;

function fakeAgent(text = "All set, see you soon."): (
  args: unknown,
) => Promise<BridgeAgentResult> {
  return async () => ({
    text,
    usage: { inputTokens: 100, outputTokens: 20 },
    toolUsed: null,
    firstTokenMs: 120,
  });
}

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  url = `ws://127.0.0.1:${port}`;

  server.on("connection", (socket: WebSocket) => {
    let interimSent = false;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        receivedBinaryBytes += (data as Buffer).length;
        if (dropOnAudio) {
          socket.close(1013, "dropped");
          return;
        }
        if (!interimSent) {
          interimSent = true;
          socket.send(
            JSON.stringify({
              type: "transcript",
              transcript: "live",
              final: false,
            }),
          );
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
        receivedEndStream += 1;
        if (holdFinal) return;
        socket.send(
          JSON.stringify({
            type: "transcript",
            transcript: finalTranscript,
            final: true,
            audioProcessedMs: 800,
          }),
        );
        socket.close(1000, "turn complete");
        return;
      }
      socket.send(JSON.stringify({ sessionId: "bridge-test" }));
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type AgentFn = (args: {
  key: string;
  transcript: string;
  startedAt: number;
  onDelta: (text: string) => void;
}) => Promise<BridgeAgentResult>;

function attachForTest(browser: FakeBrowser, agent: AgentFn = fakeAgent()) {
  attachVoiceBridge({
    browser: browser as unknown as WebSocket,
    key: "test-key",
    metaUrl: url,
    runAgent: agent,
  });
}

describe("GET /api/voice live bridge (browser -> Vercel -> Meta)", () => {
  it("relays live partials, ends the turn on a Buffer control frame, then replies", async () => {
    receivedBinaryBytes = 0;
    receivedEndStream = 0;
    finalTranscript = "live from the bridge";
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    try {
      const browser = new FakeBrowser();
      attachForTest(browser);
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "bridge"),
        ).toBe(true);
      });

      // Speech audio while the person talks: partial arrives live, pre-final.
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      await vi.waitFor(() => {
        expect(
          browser.frames().some(
            (frame) =>
              frame.type === "transcript" && frame.final === false,
          ),
        ).toBe(true);
      });

      // End of speech arrives as a Buffer (browser text frames reach the
      // handler as Buffer, never as string): it must end the turn, never
      // travel to Meta disguised as audio.
      const audioBefore = receivedBinaryBytes;
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(receivedEndStream).toBe(1);
      });
      expect(receivedBinaryBytes).toBe(audioBefore);

      await vi.waitFor(() => {
        expect(
          browser.frames().some(
            (frame) =>
              frame.type === "transcript" &&
              frame.final === true &&
              frame.transcript === "live from the bridge",
          ),
        ).toBe(true);
      });
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "reply"),
        ).toBe(true);
      });
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "done")).toBe(
          true,
        );
      });

      const frames = browser.frames();
      const interimAt = frames.findIndex(
        (frame) => frame.type === "transcript" && frame.final === false,
      );
      const finalAt = frames.findIndex(
        (frame) => frame.type === "transcript" && frame.final === true,
      );
      expect(interimAt).toBeGreaterThan(-1);
      expect(finalAt).toBeGreaterThan(interimAt);

      const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
      expect(turns).toHaveLength(1);
      const logged = JSON.parse(turns[0].replace("[voice-turn] ", ""));
      expect(logged.transcript).toBe("live from the bridge");
      expect(logged.inputTokens).toBe(100);
      expect(logged.outputTokens).toBe(20);
      expect(logged.error).toBeNull();
      expect(browser.closed?.code).toBe(1000);
    } finally {
      spy.mockRestore();
    }
  });

  it("maps a pre-final upstream drop to E-ASR with a 1011 close (client reconnects)", async () => {
    dropOnAudio = true;
    try {
      const browser = new FakeBrowser();
      attachForTest(browser);
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "bridge"),
        ).toBe(true);
      });
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "error"),
        ).toBe(true);
      });
      const error = browser.frames().find((frame) => frame.type === "error");
      expect(error?.code).toBe("E-ASR");
      expect(browser.closed?.code).toBe(1011);
    } finally {
      dropOnAudio = false;
    }
  });

  it("answers silence with a gentle E-VAD notice and never calls the model", async () => {
    finalTranscript = "";
    const agent = vi.fn(fakeAgent());
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    try {
      const browser = new FakeBrowser();
      attachForTest(browser, agent);
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "bridge"),
        ).toBe(true);
      });
      browser.peerMessage(Buffer.from(new Int16Array(960).buffer));
      browser.peerMessage(JSON.stringify({ type: "endStream" }));
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "notice"),
        ).toBe(true);
      });
      const notice = browser.frames().find((frame) => frame.type === "notice");
      expect(notice?.code).toBe("E-VAD");
      expect(agent).not.toHaveBeenCalled();
      const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
      expect(turns).toHaveLength(1);
      expect(JSON.parse(turns[0].replace("[voice-turn] ", ""))).toMatchObject({
        modelSkipped: true,
      });
    } finally {
      finalTranscript = "live from the bridge";
      spy.mockRestore();
    }
  });
});

describe("tryParseControl (spike lesson: text frames arrive as Buffer)", () => {
  it("parses string and Buffer endStream controls, ignores binary audio", () => {
    expect(tryParseControl(JSON.stringify({ type: "endStream" }))).toEqual({
      type: "endStream",
    });
    expect(
      tryParseControl(Buffer.from(JSON.stringify({ type: "endStream" }))),
    ).toEqual({ type: "endStream" });
    expect(tryParseControl(Buffer.from([0, 1, 2, 3]))).toBeNull();
    expect(tryParseControl('{"type":"other"}')).toBeNull();
    expect(tryParseControl(null)).toBeNull();
  });
});
