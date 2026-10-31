// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  attachVoiceBridge,
  bridgeOptionsForUpgrade,
  tryParseControl,
  type BridgeAgentResult,
} from "./voice-bridge";

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
let finalTranscript = "vale, live from the bridge";
let receivedBinaryBytes = 0;
let receivedEndStream = 0;
/** First upstream text frame per connection: the auth handshake. */
let receivedAuth: string[] = [];

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
    let authed = false;
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
      if (!authed) {
        authed = true;
        receivedAuth.push(data.toString());
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
  history: { role: string; text: string; tool: string | null }[];
  startedAt: number;
  onDelta: (text: string) => void;
  language?: string;
  slotKey?: string;
}) => Promise<BridgeAgentResult>;

function attachForTest(
  browser: FakeBrowser,
  agent: AgentFn = fakeAgent(),
  key = "test-key",
) {
  attachVoiceBridge({
    browser: browser as unknown as WebSocket,
    key,
    clientId: "test-client",
    metaUrl: url,
    runAgent: agent,
  });
}

describe("GET /api/voice live bridge (browser -> Vercel -> Meta)", () => {
  it("relays live partials, ends the turn on a Buffer control frame, then replies", async () => {
    receivedBinaryBytes = 0;
    receivedEndStream = 0;
    finalTranscript = "vale, live from the bridge";
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

      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      await vi.waitFor(() => {
        expect(
          browser.frames().some(
            (frame) =>
              frame.type === "transcript" && frame.final === false,
          ),
        ).toBe(true);
      });

      // Control frames arrive as Buffer too; they must never travel to Meta as audio.
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
              frame.transcript === "vale, live from the bridge",
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
      expect(logged.transcript).toBe("vale, live from the bridge");
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
      finalTranscript = "vale, live from the bridge";
      spy.mockRestore();
    }
  });

  it("hands prior turns as history and drops nothing after a failure", async () => {
    finalTranscript = "vale, si";
    const seen: { role: string; text: string }[][] = [];
    let calls = 0;
    const agent: AgentFn = async (args) => {
      seen.push(args.history);
      calls += 1;
      if (calls === 2) throw new Error("boom");
      return {
        text: "ok",
        usage: { inputTokens: 100, outputTokens: 20 },
        toolUsed: null,
        firstTokenMs: 1,
      };
    };
    const runTap = async () => {
      const browser = new FakeBrowser();
      attachForTest(browser, agent);
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "bridge"),
        ).toBe(true);
      });
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "done")).toBe(
          true,
        );
      });
    };
    try {
      await runTap();
      await runTap();
      await runTap();
      expect(seen).toHaveLength(3);
      for (const history of seen) {
        expect(history.length).toBeGreaterThan(0);
        for (const turn of history) {
          expect(["user", "vale"]).toContain(turn.role);
          expect(typeof turn.text).toBe("string");
        }
      }
      // Tap 2 sees tap 1's user turn; tap 3 also sees tap 1's vale reply,
      // even though tap 2 failed after its own user turn was stored.
      expect(
        seen[1].some((t) => t.role === "user" && t.text === "vale, si"),
      ).toBe(true);
      expect(seen[2].some((t) => t.role === "vale")).toBe(true);
    } finally {
      finalTranscript = "vale, live from the bridge";
    }
  });

  it("carries two turns on one socket in conversation mode", async () => {
    receivedEndStream = 0;
    const agent = vi.fn(fakeAgent());
    finalTranscript = "vale, first turn";
    const browser = new FakeBrowser();
    attachVoiceBridge({
      browser: browser as unknown as WebSocket,
      key: "test-key",
      clientId: "conv-two-turns",
      metaUrl: url,
      runAgent: agent,
      conversation: true,
    });
    await vi.waitFor(() => {
      expect(
        browser.frames().some((frame) => frame.type === "bridge"),
      ).toBe(true);
    });
    const runVoiceTurn = async (transcript: string) => {
      finalTranscript = transcript;
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(JSON.stringify({ type: "endStream" }));
    };
    await runVoiceTurn("vale, first turn");
    await vi.waitFor(() => {
      expect(
        browser.frames().filter((frame) => frame.type === "reply"),
      ).toHaveLength(1);
    });
    // Nameless second turn rides the window the first turn opened.
    await runVoiceTurn("and another thing");
    await vi.waitFor(() => {
      expect(
        browser.frames().filter((frame) => frame.type === "reply"),
      ).toHaveLength(2);
    });
    await vi.waitFor(() => {
      expect(
        browser.frames().filter((frame) => frame.type === "done"),
      ).toHaveLength(2);
    });
    expect(browser.closed).toBeNull();
    expect(receivedEndStream).toBe(2);
    expect(agent).toHaveBeenCalledTimes(2);
    browser.close(1000, "test done");
  });

  it("treats a tap wake frame like the name on a cold window", async () => {
    const agent = vi.fn(fakeAgent());
    finalTranscript = "close the session";
    const browser = new FakeBrowser();
    attachVoiceBridge({
      browser: browser as unknown as WebSocket,
      key: "test-key",
      clientId: "conv-wake-tap",
      metaUrl: url,
      runAgent: agent,
      conversation: true,
    });
    await vi.waitFor(() => {
      expect(
        browser.frames().some((frame) => frame.type === "bridge"),
      ).toBe(true);
    });
    browser.peerMessage(JSON.stringify({ type: "wake" }));
    browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
    browser.peerMessage(JSON.stringify({ type: "endStream" }));
    await vi.waitFor(() => {
      expect(
        browser.frames().some((frame) => frame.type === "reply"),
      ).toBe(true);
    });
    expect(agent).toHaveBeenCalledTimes(1);
    browser.close(1000, "test done");
  });

  it("keys the turn on the browser id announced in a client frame", async () => {
    finalTranscript = "vale, anunciar";
    let slotKey: string | undefined;
    const agent: AgentFn = async (args) => {
      slotKey = args.slotKey;
      return {
        text: "ok",
        usage: { inputTokens: 10, outputTokens: 5 },
        toolUsed: null,
        firstTokenMs: 1,
      };
    };
    const browser = new FakeBrowser();
    attachForTest(browser, agent);
    await vi.waitFor(() => {
      expect(
        browser.frames().some((frame) => frame.type === "bridge"),
      ).toBe(true);
    });
    browser.peerMessage(JSON.stringify({ type: "client", client: "lane-9" }));
    browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
    browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
    try {
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "done")).toBe(
          true,
        );
      });
      expect(slotKey).toBe("lane-9");
    } finally {
      finalTranscript = "vale, live from the bridge";
    }
  });

  it("authenticates Meta with the configured key, never the peer", async () => {
    receivedAuth = [];
    const browser = new FakeBrowser();
    attachForTest(browser, fakeAgent(), "test-key-2");
    browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
    await vi.waitFor(() => {
      expect(receivedAuth.length).toBeGreaterThan(0);
    });
    const auth = JSON.parse(receivedAuth[0]) as {
      authorization?: { accessToken?: string };
    };
    expect(auth.authorization?.accessToken).toBe("Bearer test-key-2");
    browser.close(1000, "test done");
  });

  it("carries real voiced PCM byte-identical to Meta, then ends the turn", async () => {
    receivedBinaryBytes = 0;
    receivedEndStream = 0;
    finalTranscript = "vale, live from the bridge";
    const browser = new FakeBrowser();
    attachForTest(browser);
    await vi.waitFor(() => {
      expect(
        browser.frames().some((frame) => frame.type === "bridge"),
      ).toBe(true);
    });
    // Half a second of 24 kHz voiced sine: real samples with speech-like
    // energy, never silence, never a JSON shortcut.
    const pcm = new Int16Array(12000);
    for (let i = 0; i < pcm.length; i += 1) {
      pcm[i] = Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
    }
    const bytes = Buffer.from(pcm.buffer);
    const audioBefore = receivedBinaryBytes;
    for (let offset = 0; offset < bytes.length; offset += 6000) {
      browser.peerMessage(bytes.subarray(offset, offset + 6000));
    }
    await vi.waitFor(() => {
      expect(receivedBinaryBytes - audioBefore).toBe(bytes.length);
    });
    browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
    await vi.waitFor(() => {
      expect(receivedEndStream).toBe(1);
    });
    await vi.waitFor(() => {
      expect(
        browser.frames().some(
          (frame) => frame.type === "transcript" && frame.final === true,
        ),
      ).toBe(true);
    });
    await vi.waitFor(() => {
      expect(browser.frames().some((frame) => frame.type === "done")).toBe(
        true,
      );
    });
    expect(
      browser.frames().some((frame) => frame.type === "error"),
    ).toBe(false);
    browser.close(1000, "test done");
  });

  it("redials once after a drop and resets the count on success", async () => {
    receivedAuth = [];
    dropOnAudio = true;
    try {
      const browser = new FakeBrowser();
      attachVoiceBridge({
        browser: browser as unknown as WebSocket,
        key: "test-key",
        clientId: "conv-retry-ok",
        metaUrl: url,
        runAgent: fakeAgent(),
        conversation: true,
        retryBaseMs: 50,
        retryMaxMs: 100,
      });
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "error"),
        ).toBe(true);
      });
      // No eager redial: the next voice opens it, after the backoff.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(receivedAuth.length).toBe(1);
      dropOnAudio = false;
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      await vi.waitFor(() => {
        expect(receivedAuth.length).toBe(2);
      });
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "reply")).toBe(
          true,
        );
      });
      expect(
        browser.frames().filter((frame) => frame.type === "error"),
      ).toHaveLength(1);
      expect(browser.closed).toBeNull();
      browser.close(1000, "test done");
    } finally {
      dropOnAudio = false;
    }
  });

  it("closes the socket with a clear reason after straight failures", async () => {
    receivedAuth = [];
    dropOnAudio = true;
    try {
      const browser = new FakeBrowser();
      attachVoiceBridge({
        browser: browser as unknown as WebSocket,
        key: "test-key",
        clientId: "conv-retry-cap",
        metaUrl: url,
        runAgent: fakeAgent(),
        conversation: true,
        retryBaseMs: 20,
        retryMaxMs: 40,
        maxConsecutiveFailures: 3,
      });
      for (let turn = 1; turn <= 3; turn += 1) {
        browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
        await vi.waitFor(() => {
          expect(
            browser.frames().filter((frame) => frame.type === "error").length,
          ).toBe(turn);
        });
      }
      await vi.waitFor(() => {
        expect(browser.closed?.code).toBe(1011);
      });
      expect(browser.closed?.reason).toBe("meta-unavailable");
      expect(
        browser.frames().filter((frame) => frame.type === "error").length,
      ).toBeGreaterThan(0);
      // Capped: no fourth dial even when audio keeps coming.
      const dials = receivedAuth.length;
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(receivedAuth.length).toBe(dials);
    } finally {
      dropOnAudio = false;
    }
  });

  it("holds an idle conversation socket quiet: no dial, no errors", async () => {
    receivedAuth = [];
    const browser = new FakeBrowser();
    attachVoiceBridge({
      browser: browser as unknown as WebSocket,
      key: "test-key",
      clientId: "conv-idle",
      metaUrl: url,
      runAgent: fakeAgent(),
      conversation: true,
    });
    await vi.waitFor(() => {
      expect(
        browser.frames().some((frame) => frame.type === "bridge"),
      ).toBe(true);
    });
    // Two silent seconds: no Meta dial at all, nothing back, socket stays up.
    // (The 60 s platform proof is probe 2 against real Meta: 65 s of ingress
    // then audio still returns a final.)
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(receivedAuth.length).toBe(0);
    expect(
      browser.frames().some((frame) => frame.type === "error"),
    ).toBe(false);
    expect(browser.closed).toBeNull();
    // First voice opens the dial; buffered audio replays on open.
    browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
    browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
    await vi.waitFor(() => {
      expect(browser.frames().some((frame) => frame.type === "done")).toBe(
        true,
      );
    });
    expect(receivedAuth.length).toBe(1);
    browser.close(1000, "test done");
  });
});

describe("bridgeOptionsForUpgrade (single-process wiring)", () => {
  it("hands Meta the API key and names the conversation with the peer", () => {
    expect(bridgeOptionsForUpgrade("::1", "test-key-2", undefined)).toEqual({
      key: "test-key-2",
      clientId: "::1",
      conversation: true,
      metaUrl: undefined,
    });
  });

  it("forwards a custom ASR url when set", () => {
    expect(
      bridgeOptionsForUpgrade("1.2.3.4", "k", "wss://asr.example").metaUrl,
    ).toBe("wss://asr.example");
  });
});

describe("echo guard (her own reply back through the mic)", () => {
  it("drops her own reply coming back as the next transcript: gate eco, no model call", async () => {
    receivedEndStream = 0;
    const agent = vi.fn(fakeAgent("Emma is booked for gel refill"));
    finalTranscript = "vale, book Emma for gel refill";
    const lines: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((line: string) => {
        lines.push(String(line));
      });
    try {
      const browser = new FakeBrowser();
      const client = `conv-eco-${Date.now()}`;
      attachVoiceBridge({
        browser: browser as unknown as WebSocket,
        key: "test-key",
        clientId: client,
        metaUrl: url,
        runAgent: agent,
        conversation: true,
      });
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "bridge"),
        ).toBe(true);
      });
      // Turn 1: a real request with a real reply.
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "reply"),
        ).toBe(true);
      });
      expect(agent).toHaveBeenCalledTimes(1);
      const doneAfterFirst = browser.frames().filter(
        (frame) => frame.type === "done",
      ).length;
      // Turn 2: her own reply echoing back through the mic.
      finalTranscript = "Emma is booked for gel refill";
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(
          browser.frames().filter((frame) => frame.type === "done").length,
        ).toBe(doneAfterFirst + 1);
      });
      // Discarded: no second model call, no second reply, ignored on screen.
      expect(agent).toHaveBeenCalledTimes(1);
      expect(
        browser.frames().filter((frame) => frame.type === "reply"),
      ).toHaveLength(1);
      expect(
        browser.frames().some((frame) => frame.type === "ignored"),
      ).toBe(true);
      const eco = lines.filter((line) => line.includes('"gate":"eco"'));
      expect(eco).toHaveLength(1);
      expect(eco[0]).toContain("Emma is booked for gel refill");
      // The served turn carries a real measured ASR time.
      const served = lines
        .filter((line) => line.startsWith("[voice-turn] "))
        .map((line) => JSON.parse(line.slice("[voice-turn] ".length)));
      const first = served.find(
        (entry) => entry.transcript === "vale, book Emma for gel refill",
      );
      expect(typeof first.asrMs).toBe("number");
    } finally {
      logSpy.mockRestore();
      finalTranscript = "vale, live from the bridge";
    }
  });

  it("executes a short user turn even when it repeats reply words", async () => {
    receivedEndStream = 0;
    const agent = vi.fn(fakeAgent("Done."));
    finalTranscript = "vale, confirm it";
    const browser = new FakeBrowser();
    attachVoiceBridge({
      browser: browser as unknown as WebSocket,
      key: "test-key",
      clientId: `conv-noeco-${Date.now()}`,
      metaUrl: url,
      runAgent: agent,
      conversation: true,
    });
    await vi.waitFor(() => {
      expect(browser.frames().some((frame) => frame.type === "bridge")).toBe(
        true,
      );
    });
    browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
    browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
    await vi.waitFor(() => {
      expect(browser.frames().some((frame) => frame.type === "reply")).toBe(
        true,
      );
    });
    // Short overlap with the reply is the user confirming, not echo.
    finalTranscript = "yes, confirm it";
    browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
    browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
    await vi.waitFor(() => {
      expect(
        browser.frames().filter((frame) => frame.type === "reply").length,
      ).toBe(2);
    });
    expect(agent).toHaveBeenCalledTimes(2);
    browser.close(1000, "test done");
  });
});

describe("empty finals (noise, not Daniel)", () => {
  it("discards an empty final without the model, the window or the board", async () => {
    receivedEndStream = 0;
    const agent = vi.fn(fakeAgent("Should never run."));
    finalTranscript = "   ";
    const lines: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((line: string) => {
        lines.push(String(line));
      });
    try {
      const browser = new FakeBrowser();
      const client = `conv-empty-${Date.now()}`;
      attachVoiceBridge({
        browser: browser as unknown as WebSocket,
        key: "test-key",
        clientId: client,
        metaUrl: url,
        runAgent: agent,
        conversation: true,
      });
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "bridge"),
        ).toBe(true);
      });
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(
          browser.frames().filter((frame) => frame.type === "done").length,
        ).toBe(1);
      });
      // Nothing executed: no model call, no reply, no board move.
      expect(agent).not.toHaveBeenCalled();
      expect(
        browser.frames().filter((frame) => frame.type === "reply"),
      ).toHaveLength(0);
      expect(
        browser.frames().filter((frame) => frame.type === "board"),
      ).toHaveLength(0);
      const served = lines
        .filter((line) => line.startsWith("[voice-turn] "))
        .map((line) => JSON.parse(line.slice("[voice-turn] ".length)));
      const empty = served.find((entry) => entry.transcript === "");
      expect(empty).toMatchObject({ modelSkipped: true, gate: null });
      browser.close(1000, "test done");
    } finally {
      logSpy.mockRestore();
      finalTranscript = "vale, live from the bridge";
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

  it("parses the screen language frame and closes the set on junk", () => {
    expect(
      tryParseControl(JSON.stringify({ type: "language", language: "es" })),
    ).toEqual({ type: "language", language: "es" });
    expect(
      tryParseControl(
        Buffer.from(JSON.stringify({ type: "language", language: "it" })),
      ),
    ).toEqual({ type: "language", language: "en" });
    expect(tryParseControl(JSON.stringify({ type: "language" }))).toEqual({
      type: "language",
      language: "en",
    });
  });
});

describe("bridge language frame", () => {
  it("carries the selector language to the agent, never as audio", async () => {
    finalTranscript = "vale, si";
    const seen: (string | undefined)[] = [];
    const agent: AgentFn = async (args) => {
      seen.push(args.language);
      return {
        text: "ok",
        usage: { inputTokens: 100, outputTokens: 20 },
        toolUsed: null,
        firstTokenMs: 1,
      };
    };
    const browser = new FakeBrowser();
    attachForTest(browser, agent);
    try {
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "bridge"),
        ).toBe(true);
      });
      browser.peerMessage(
        Buffer.from(JSON.stringify({ type: "language", language: "en" })),
      );
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "done")).toBe(
          true,
        );
      });
      expect(seen).toEqual(["en"]);
    } finally {
      finalTranscript = "vale, live from the bridge";
    }
  });
});
