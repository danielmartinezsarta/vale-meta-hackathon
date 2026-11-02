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
import { checkWake } from "./wake";

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
/** Next endStream gets a Meta error frame instead of a final. */
let asrErrorOnce = false;
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
        if (asrErrorOnce) {
          asrErrorOnce = false;
          socket.send(
            JSON.stringify({ type: "error", message: "slow ingress" }),
          );
          return;
        }
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
  clientId = "test-client",
) {
  attachVoiceBridge({
    browser: browser as unknown as WebSocket,
    key,
    clientId,
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

  it("answers silence with an empty turn, no notice, never calls the model", async () => {
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
          browser.frames().some((frame) => frame.type === "transcript"),
        ).toBe(true);
      });
      expect(browser.frames().some((frame) => frame.type === "notice")).toBe(false);
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

  it("persists the client engine and sheet flag from endStream", async () => {
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
      browser.peerMessage(
        JSON.stringify({
          type: "endStream",
          lostBlocks: 3,
          srcBlocks: 100,
          engine: "script",
          sheetOpen: true,
        }),
      );
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "done")).toBe(
          true,
        );
      });
      const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
      expect(turns).toHaveLength(1);
      expect(JSON.parse(turns[0].replace("[voice-turn] ", ""))).toMatchObject({
        lostBlocks: 3,
        srcBlocks: 100,
        engine: "script",
        sheetOpen: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("adopts the endStream language with no prior language frame", async () => {
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
      // No language frame was ever sent: the turn still lands in Spanish.
      browser.peerMessage(JSON.stringify({ type: "endStream", language: "es" }));
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "done")).toBe(
          true,
        );
      });
      const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
      expect(turns).toHaveLength(1);
      expect(JSON.parse(turns[0].replace("[voice-turn] ", ""))).toMatchObject({
        language: "es",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("anchors the attention window on her real last word", async () => {
    const browser = new FakeBrowser();
    attachForTest(browser, fakeAgent(), "spoken-key", "spoken-client-1");
    await vi.waitFor(() => {
      expect(browser.frames().some((frame) => frame.type === "bridge")).toBe(
        true,
      );
    });
    expect(
      checkWake("what time is it", "spoken-client-1", Date.now()).execute,
    ).toBe(false);
    browser.peerMessage(JSON.stringify({ type: "spoken" }));
    expect(
      checkWake("what time is it", "spoken-client-1", Date.now()),
    ).toMatchObject({ execute: true, namedVale: false, gate: "ventana" });
    expect(tryParseControl(JSON.stringify({ type: "spoken" }))).toEqual({
      type: "spoken",
    });
  });

  it("closes the sheet on dismiss with no model call", async () => {
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
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(
        JSON.stringify({ type: "dismiss", transcript: "close the agenda" }),
      );
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "done")).toBe(
          true,
        );
      });
      expect(
        browser.frames().some((frame) => frame.type === "ignored"),
      ).toBe(true);
      expect(agent).not.toHaveBeenCalled();
      const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
      expect(turns).toHaveLength(1);
      expect(JSON.parse(turns[0].replace("[voice-turn] ", ""))).toMatchObject({
        transcript: "close the agenda",
        ignored: true,
        modelSkipped: true,
        gate: "cierre",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("holds the window open behind her sheet and restarts it on close", async () => {
    finalTranscript = "read me the total";
    const agent = vi.fn(fakeAgent());
    const browser = new FakeBrowser();
    attachVoiceBridge({
      browser: browser as unknown as WebSocket,
      key: "sheet-key",
      clientId: "sheet-client-2",
      metaUrl: url,
      runAgent: agent,
      conversation: true,
    });
    await vi.waitFor(() => {
      expect(browser.frames().some((frame) => frame.type === "bridge")).toBe(
        true,
      );
    });
    const voiceTurn = (sheetOpen: boolean): void => {
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(JSON.stringify({ type: "endStream", sheetOpen }));
    };
    const doneCount = (): number =>
      browser.frames().filter((frame) => frame.type === "done").length;
    // No sheet, no window: background chatter never reaches the model.
    voiceTurn(false);
    await vi.waitFor(() => {
      expect(doneCount()).toBe(1);
    });
    expect(agent).not.toHaveBeenCalled();
    expect(
      browser.frames().some((frame) => frame.type === "ignored"),
    ).toBe(true);
    // Sheet open on screen: the same unnamed phrase executes.
    voiceTurn(true);
    await vi.waitFor(() => {
      expect(doneCount()).toBe(2);
    });
    expect(agent).toHaveBeenCalledTimes(1);
    expect(
      browser.frames().some(
        (frame) => frame.type === "reply" && frame.text === "All set, see you soon.",
      ),
    ).toBe(true);
    // The X on her sheet restarts the window: the follow-up runs sheetless.
    browser.peerMessage(JSON.stringify({ type: "sheet-closed" }));
    expect(
      checkWake("and the time", "sheet-client-2", Date.now()),
    ).toMatchObject({ execute: true, namedVale: false, gate: "ventana" });
    // A voice close restarts it the same way.
    browser.peerMessage(
      JSON.stringify({ type: "dismiss", transcript: "close it" }),
    );
    await vi.waitFor(() => {
      expect(doneCount()).toBe(3);
    });
    expect(
      checkWake("and the time", "sheet-client-2", Date.now()),
    ).toMatchObject({ execute: true, namedVale: false, gate: "ventana" });
    // ...but the restarted window still expires on its own.
    expect(
      checkWake("and the time", "sheet-client-2", Date.now() + 46_000, false, "en")
        .execute,
    ).toBe(false);
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

  it("a tap wake frame no longer opens the window", async () => {
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
        browser.frames().some((frame) => frame.type === "ignored"),
      ).toBe(true);
    });
    expect(agent).not.toHaveBeenCalled();
    expect(
      browser.frames().some((frame) => frame.type === "reply"),
    ).toBe(false);
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
      languageBias?: unknown;
    };
    expect(auth.languageBias).toEqual(["English"]);
    expect(auth.authorization?.accessToken).toBe("Bearer test-key-2");
    browser.close(1000, "test done");
  });


  it("pins the ASR bias to Spanish after a language frame", async () => {
    receivedAuth = [];
    finalTranscript = "vale, sesion de prueba";
    try {
      const browser = new FakeBrowser();
      attachVoiceBridge({
        browser: browser as unknown as WebSocket,
        key: "test-key",
        clientId: "conv-bias-es",
        metaUrl: url,
        runAgent: fakeAgent(),
        conversation: true,
      });
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "bridge"),
        ).toBe(true);
      });
      browser.peerMessage(JSON.stringify({ type: "language", language: "es" }));
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      await vi.waitFor(() => {
        expect(receivedAuth.length).toBeGreaterThan(0);
      });
      const auth = JSON.parse(receivedAuth[receivedAuth.length - 1]) as {
        languageBias?: unknown;
      };
      expect(auth.languageBias).toEqual(["Spanish"]);
      browser.close(1000, "test done");
    } finally {
      finalTranscript = "vale, live from the bridge";
    }
  });

  it("answers the next turn in Spanish after a mid-listening switch", async () => {
    finalTranscript = "hola vale";
    const agent = vi.fn<AgentFn>(fakeAgent("Hola Daniel."));
    try {
      const browser = new FakeBrowser();
      attachVoiceBridge({
        browser: browser as unknown as WebSocket,
        key: "test-key",
        clientId: "conv-switch-es",
        metaUrl: url,
        runAgent: agent,
        conversation: true,
      });
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "bridge"),
        ).toBe(true);
      });
      // Listening is on (default EN); the selector flips to ES mid-stream.
      browser.peerMessage(JSON.stringify({ type: "language", language: "es" }));
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "reply"),
        ).toBe(true);
      });
      expect(agent).toHaveBeenCalledTimes(1);
      expect(agent.mock.calls[0][0].language).toBe("es");
      expect(agent.mock.calls[0][0].transcript).toBe("hola vale");
      browser.close(1000, "test done");
    } finally {
      finalTranscript = "vale, live from the bridge";
    }
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

  it("discards a dropped turn silently and answers the next one", async () => {
    receivedAuth = [];
    dropOnAudio = true;
    finalTranscript = "vale, second try";
    try {
      const browser = new FakeBrowser();
      const agent = vi.fn(fakeAgent());
      attachVoiceBridge({
        browser: browser as unknown as WebSocket,
        key: "test-key",
        clientId: "conv-retry-ok",
        metaUrl: url,
        runAgent: agent,
        conversation: true,
      });
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      // Silent discard: ignored, no visible error, socket stays up.
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "ignored"),
        ).toBe(true);
      });
      expect(
        browser.frames().some((frame) => frame.type === "error"),
      ).toBe(false);
      expect(browser.closed).toBeNull();
      // The next voice redials Meta at once and runs the agent.
      dropOnAudio = false;
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "reply")).toBe(
          true,
        );
      });
      expect(agent).toHaveBeenCalledTimes(1);
      expect(
        browser.frames().filter((frame) => frame.type === "error"),
      ).toHaveLength(0);
      expect(browser.closed).toBeNull();
      browser.close(1000, "test done");
    } finally {
      dropOnAudio = false;
      finalTranscript = "vale, live from the bridge";
    }
  });

  it("shows the error only after straight failures, then closes", async () => {
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
        maxConsecutiveFailures: 3,
      });
      // First two failures stay silent: discarded, socket stays up.
      for (let turn = 1; turn <= 2; turn += 1) {
        browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
        await vi.waitFor(() => {
          expect(
            browser.frames().filter((frame) => frame.type === "ignored").length,
          ).toBe(turn);
        });
      }
      expect(
        browser.frames().some((frame) => frame.type === "error"),
      ).toBe(false);
      expect(browser.closed).toBeNull();
      // Third straight failure: one visible error, then the close.
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      await vi.waitFor(() => {
        expect(
          browser.frames().filter((frame) => frame.type === "error").length,
        ).toBe(1);
      });
      await vi.waitFor(() => {
        expect(browser.closed?.code).toBe(1011);
      });
      expect(browser.closed?.reason).toBe("meta-unavailable");
      // Capped: no fourth dial even when audio keeps coming.
      const dials = receivedAuth.length;
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(receivedAuth.length).toBe(dials);
    } finally {
      dropOnAudio = false;
    }
  });

  it("discards a mid-turn ASR error silently and keeps the conversation", async () => {
    asrErrorOnce = true;
    finalTranscript = "vale, after the outage";
    try {
      const browser = new FakeBrowser();
      const agent = vi.fn(fakeAgent());
      attachVoiceBridge({
        browser: browser as unknown as WebSocket,
        key: "test-key",
        clientId: "conv-asr-error",
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
      // The failed turn is discarded: no error, no reply, socket stays up.
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "ignored"),
        ).toBe(true);
      });
      expect(
        browser.frames().some((frame) => frame.type === "error"),
      ).toBe(false);
      expect(browser.closed).toBeNull();
      expect(agent).not.toHaveBeenCalled();
      // Next voice redials and runs normally.
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "reply")).toBe(
          true,
        );
      });
      expect(agent).toHaveBeenCalledTimes(1);
      browser.close(1000, "test done");
    } finally {
      asrErrorOnce = false;
      finalTranscript = "vale, live from the bridge";
    }
  });

  it("logs client-state frames without failing the turn", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    finalTranscript = "vale, state check";
    try {
      const browser = new FakeBrowser();
      attachVoiceBridge({
        browser: browser as unknown as WebSocket,
        key: "test-key",
        clientId: "conv-client-state",
        metaUrl: url,
        runAgent: fakeAgent(),
        conversation: true,
      });
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "bridge"),
        ).toBe(true);
      });
      // Diagnostics ride along mid-turn: logged, never a turn of their own.
      browser.peerMessage(
        Buffer.from(
          JSON.stringify({
            type: "client-state",
            state: { capture: "live", visible: true },
          }),
        ),
      );
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(browser.frames().some((frame) => frame.type === "reply")).toBe(
          true,
        );
      });
      expect(
        logs.some((line) => line.startsWith("[client-state]")),
      ).toBe(true);
      expect(
        browser.frames().some((frame) => frame.type === "error"),
      ).toBe(false);
      browser.close(1000, "test done");
    } finally {
      finalTranscript = "vale, live from the bridge";
      spy.mockRestore();
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

  it("sends the tool-derived widget frame after a card reply", async () => {
    finalTranscript = "vale, how is my goal";
    const widgetAgent = async (): Promise<BridgeAgentResult> => ({
      text: "Here is your goal.",
      usage: { inputTokens: 100, outputTokens: 20 },
      toolUsed: "goal_progress",
      firstTokenMs: 50,
      widget: {
        kind: "goal",
        title: "Monthly goal",
        size: "half",
        data: { name: null, goal: 600, earned: 120 },
      },
    });
    try {
      const browser = new FakeBrowser();
      attachVoiceBridge({
        browser: browser as unknown as WebSocket,
        key: "test-key",
        clientId: "conv-widget",
        metaUrl: url,
        runAgent: widgetAgent,
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
          browser.frames().some((frame) => frame.type === "widget"),
        ).toBe(true);
      });
      const widget = browser.frames().find((frame) => frame.type === "widget") as {
        widget?: { kind?: string };
      };
      expect(widget.widget?.kind).toBe("goal");
      browser.close(1000, "test done");
    } finally {
      finalTranscript = "vale, live from the bridge";
    }
  });

  it("runs the stored writes on a yes vote with no model call", async () => {
    const agent = vi.fn(fakeAgent());
    const { setPendingAction } = await import("./pending-action");
    setPendingAction("conv-vote-yes", [
      { tool: "create_client", args: { name: "VoteVera" } },
    ]);
    const browser = new FakeBrowser();
    attachVoiceBridge({
      browser: browser as unknown as WebSocket,
      key: "test-key",
      clientId: "conv-vote-yes",
      metaUrl: url,
      runAgent: agent,
      conversation: true,
    });
    await vi.waitFor(() => {
      expect(
        browser.frames().some((frame) => frame.type === "bridge"),
      ).toBe(true);
    });
    browser.peerMessage(
      Buffer.from(JSON.stringify({ type: "vote", vote: "yes" })),
    );
    await vi.waitFor(() => {
      expect(
        browser.frames().some(
          (frame) => frame.type === "reply" && String(frame.text ?? "").includes("VoteVera"),
        ),
      ).toBe(true);
    });
    expect(agent).not.toHaveBeenCalled();
    expect(
      browser.frames().some(
        (frame) => frame.type === "widget" && frame.widget === null,
      ),
    ).toBe(true);
    expect(
      browser.frames().some((frame) => frame.type === "error"),
    ).toBe(false);
    browser.close(1000, "test done");
  });

  it("clarifies a touch yes with nothing pending instead of writing", async () => {
    const agent = vi.fn(fakeAgent());
    const browser = new FakeBrowser();
    attachVoiceBridge({
      browser: browser as unknown as WebSocket,
      key: "test-key",
      clientId: "conv-vote-bare",
      metaUrl: url,
      runAgent: agent,
      conversation: true,
    });
    await vi.waitFor(() => {
      expect(
        browser.frames().some((frame) => frame.type === "bridge"),
      ).toBe(true);
    });
    browser.peerMessage(
      Buffer.from(JSON.stringify({ type: "vote", vote: "yes" })),
    );
    await vi.waitFor(() => {
      expect(
        browser.frames().some(
          (frame) => frame.type === "reply" && frame.text === "What would you like me to confirm?",
        ),
      ).toBe(true);
    });
    expect(agent).not.toHaveBeenCalled();
    browser.close(1000, "test done");
  });

  it("declines without writing on a no vote", async () => {
    const agent = vi.fn(fakeAgent());
    const { setPendingAction } = await import("./pending-action");
    setPendingAction("conv-vote-no", [
      { tool: "create_client", args: { name: "VoteNoa" } },
    ]);
    const browser = new FakeBrowser();
    attachVoiceBridge({
      browser: browser as unknown as WebSocket,
      key: "test-key",
      clientId: "conv-vote-no",
      metaUrl: url,
      runAgent: agent,
      conversation: true,
    });
    await vi.waitFor(() => {
      expect(
        browser.frames().some((frame) => frame.type === "bridge"),
      ).toBe(true);
    });
    browser.peerMessage(
      Buffer.from(JSON.stringify({ type: "vote", vote: "no" })),
    );
    await vi.waitFor(() => {
      expect(
        browser.frames().some(
          (frame) => frame.type === "reply" && frame.text === "OK, I won't save it.",
        ),
      ).toBe(true);
    });
    expect(agent).not.toHaveBeenCalled();
    const { takePendingAction } = await import("./pending-action");
    expect(takePendingAction("conv-vote-no")).toBeUndefined();
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

describe("strict turns (no echo guard: the mic never hears her)", () => {
  it("runs a wakeless repeat of her reply as a normal window turn: gate ventana", async () => {
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
      const client = `conv-noeco-${Date.now()}`;
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
      // Turn 1: a real request with a real reply; the reply opens the window.
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
      // Turn 2: the same words back without her name. Strict turns mean the
      // client never sends her audio, so the server treats this as Daniel
      // talking inside the window: a normal turn, gate ventana.
      finalTranscript = "Emma is booked for gel refill";
      browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      browser.peerMessage(Buffer.from(JSON.stringify({ type: "endStream" })));
      await vi.waitFor(() => {
        expect(
          browser.frames().filter((frame) => frame.type === "done").length,
        ).toBe(doneAfterFirst + 1);
      });
      // Executed, not discarded: a second model call and a second reply.
      expect(agent).toHaveBeenCalledTimes(2);
      expect(
        browser.frames().filter((frame) => frame.type === "reply"),
      ).toHaveLength(2);
      expect(
        browser.frames().some((frame) => frame.type === "ignored"),
      ).toBe(false);
      expect(lines.some((line) => line.includes('"gate":"eco"'))).toBe(false);
      const ventana = lines.filter((line) =>
        line.includes('"gate":"ventana"'),
      );
      expect(ventana.length).toBeGreaterThan(0);
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

  it("keeps the turn PCM as a WAV and logs it with the client stats", async () => {
    receivedEndStream = 0;
    const agent = vi.fn(fakeAgent("WAV heard you."));
    finalTranscript = "vale, wav check";
    const lines: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((line: string) => {
        lines.push(String(line));
      });
    try {
      const browser = new FakeBrowser();
      const client = `conv-wav-${Date.now()}`;
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
      browser.peerMessage(
        Buffer.from(
          JSON.stringify({
            type: "endStream",
            peakLevel: 0.5,
            voicedMs: 320,
            mutedMs: 0,
            valeState: "hearing",
          }),
        ),
      );
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "reply"),
        ).toBe(true);
      });
      const served = lines
        .filter((line) => line.startsWith("[voice-turn] "))
        .map((line) => JSON.parse(line.slice("[voice-turn] ".length)));
      const entry = served.find(
        (e) => e.transcript === "vale, wav check",
      );
      expect(entry).toBeDefined();
      expect(typeof entry.wav).toBe("string");
      const { readFileSync, existsSync } = await import("node:fs");
      expect(existsSync(entry.wav)).toBe(true);
      const wav = readFileSync(entry.wav);
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(24000);
      expect(entry.peakLevel).toBe(0.5);
      expect(entry.voicedMs).toBe(320);
      expect(entry.mutedMs).toBe(0);
      expect(entry.valeState).toBe("hearing");
      browser.close(1000, "test done");
    } finally {
      logSpy.mockRestore();
      finalTranscript = "vale, live from the bridge";
    }
  });

  it("discards a mute-dominant flat turn before the gate and the model", async () => {
    receivedEndStream = 0;
    const agent = vi.fn(fakeAgent("Should never run."));
    // Named, so only the junk gate can stop it: without it the agent runs.
    finalTranscript = "vale, junk check";
    const lines: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((line: string) => {
        lines.push(String(line));
      });
    try {
      const browser = new FakeBrowser();
      const client = `conv-junk-${Date.now()}`;
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
      // 0.6 s of flat tone after a long mute: room tone, not Daniel.
      for (let i = 0; i < 15; i++) {
        browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      }
      browser.peerMessage(
        Buffer.from(
          JSON.stringify({
            type: "endStream",
            peakLevel: 0.12,
            voicedMs: 600,
            mutedMs: 7251,
            valeState: "thinking",
          }),
        ),
      );
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "ignored"),
        ).toBe(true);
      });
      expect(agent).not.toHaveBeenCalled();
      const served = lines
        .filter((line) => line.startsWith("[voice-turn] "))
        .map((line) => JSON.parse(line.slice("[voice-turn] ".length)));
      const entry = served.find(
        (e) => e.transcript === "vale, junk check",
      );
      expect(entry).toBeDefined();
      expect(entry.junk).toBe(true);
      expect(entry.ignored).toBe(true);
      expect(typeof entry.wav).toBe("string");
      browser.close(1000, "test done");
    } finally {
      logSpy.mockRestore();
      finalTranscript = "vale, live from the bridge";
    }
  });

  it("a voice-majority turn with her mute time on the clock reaches the gate", async () => {
    // Incident 23:04:27Z: "el servicio semipermanente" died as junk:true
    // with mutedMs 8836 on 2800 ms of audio, yet the VAD counted 4320 ms
    // of voice at peak 0.12 and the 90 s window was open (14 s after the
    // previous reply). The flatness bar misfires on loud sustained vowels
    // (WAV peak/overall 2.83 < 3), so voice evidence must beat mute
    // accounting: a turn with more voiced audio than audio reaches the
    // wake gate instead of the junk bin.
    receivedEndStream = 0;
    const agent = vi.fn(fakeAgent("Servicio semipermanente, on screen."));
    // Named, so only the junk gate can stop it: without the voice guard
    // this turn dies as junk and the agent never runs.
    finalTranscript = "vale, servicio semipermanente";
    const lines: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((line: string) => {
        lines.push(String(line));
      });
    try {
      const browser = new FakeBrowser();
      const client = `conv-voice-${Date.now()}`;
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
      // 2.8 s of loud flat-ish voice after a long mute, like the
      // incident WAV (flat ratio 2.83, peak 0.12): without the voice
      // guard the flatness bar calls it room tone.
      for (let i = 0; i < 70; i++) {
        browser.peerMessage(Buffer.from(new Int16Array(960).fill(4000).buffer));
      }
      browser.peerMessage(
        Buffer.from(
          JSON.stringify({
            type: "endStream",
            peakLevel: 0.12,
            voicedMs: 1300,
            mutedMs: 2600,
            valeState: "thinking",
            lostBlocks: 0,
            srcBlocks: 200,
          }),
        ),
      );
      await vi.waitFor(() => {
        expect(
          browser.frames().some((frame) => frame.type === "reply"),
        ).toBe(true);
      });
      expect(agent).toHaveBeenCalledTimes(1);
      const served = lines
        .filter((line) => line.startsWith("[voice-turn] "))
        .map((line) => JSON.parse(line.slice("[voice-turn] ".length)));
      const entry = served.find(
        (e) => e.transcript === "vale, servicio semipermanente",
      );
      expect(entry).toBeDefined();
      expect(entry.ignored).toBe(false);
      expect(entry.junk).toBeUndefined();
      browser.close(1000, "test done");
    } finally {
      logSpy.mockRestore();
      finalTranscript = "vale, live from the bridge";
    }
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
    const emptyStats = {
      peakLevel: null,
      voicedMs: null,
      mutedMs: null,
      valeState: null,
      lostBlocks: null,
      srcBlocks: null,
      engine: null,
      sheetOpen: null,
      visible: null,
      actualRate: null,
      ctxState: null,
    };
    expect(tryParseControl(JSON.stringify({ type: "endStream" }))).toEqual({
      type: "endStream",
      stats: emptyStats,
      language: null,
    });
    expect(
      tryParseControl(Buffer.from(JSON.stringify({ type: "endStream" }))),
    ).toEqual({ type: "endStream", stats: emptyStats, language: null });
    expect(
      tryParseControl(
        JSON.stringify({
          type: "endStream",
          peakLevel: 0.5,
          voicedMs: 800,
          mutedMs: 1200,
          valeState: "speaking",
          lostBlocks: 0,
          srcBlocks: 41,
          junk: "dropped",
        }),
      ),
    ).toEqual({
      type: "endStream",
      stats: {
        peakLevel: 0.5,
        voicedMs: 800,
        mutedMs: 1200,
        valeState: "speaking",
        lostBlocks: 0,
        srcBlocks: 41,
        engine: null,
        sheetOpen: null,
        visible: null,
        actualRate: null,
        ctxState: null,
      },
      language: null,
    });
    expect(
      tryParseControl(
        JSON.stringify({
          type: "endStream",
          peakLevel: 9,
          voicedMs: -1,
          valeState: "x".repeat(17),
          lostBlocks: 1.5,
          srcBlocks: -2,
        }),
      ),
    ).toEqual({ type: "endStream", stats: emptyStats, language: null });
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
    expect(
      tryParseControl(
        Buffer.from(
          JSON.stringify({ type: "client-state", state: { visible: false } }),
        ),
      ),
    ).toEqual({ type: "client-state", state: { visible: false } });
    expect(
      tryParseControl(JSON.stringify({ type: "client-state" })),
    ).toBeNull();
    expect(
      tryParseControl(
        Buffer.from(JSON.stringify({ type: "vote", vote: "yes" })),
      ),
    ).toEqual({ type: "vote", vote: "yes" });
    expect(
      tryParseControl(JSON.stringify({ type: "vote", vote: "maybe" })),
    ).toBeNull();
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