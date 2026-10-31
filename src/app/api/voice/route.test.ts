// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { POST } from "./route";

let server: WebSocketServer;
let url = "";
let closedCount = 0;
let holdFinal = false;
let dropOnAudio = false;
let receivedAudioBytes = 0;
let receivedAudioSilent = true;

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
        const bytes = data as Buffer;
        receivedAudioBytes += bytes.length;
        const view = new Int16Array(
          bytes.buffer,
          bytes.byteOffset,
          Math.floor(bytes.length / 2),
        );
        for (const sample of view) {
          if (Math.abs(sample) >= 200) {
            receivedAudioSilent = false;
            break;
          }
        }
        if (dropOnAudio) {
          socket.close(1013, "dropped");
          return;
        }
        if (!interimSent) {
          interimSent = true;
          socket.send(
            JSON.stringify({
              type: "transcript",
              transcript: "vale, canning",
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
        if (holdFinal) return;
        // The fake mimics the real engine: silence in, silence out.
        socket.send(
          JSON.stringify({
            type: "transcript",
            transcript: receivedAudioSilent ? "" : "vale, canned from fake asr",
            final: true,
            audioProcessedMs: 800,
          }),
        );
        // Meta closes after the final on PUSH_TO_TALK.
        socket.close(1000, "turn complete");
        return;
      }
      receivedAudioBytes = 0;
      receivedAudioSilent = true;
      socket.send(JSON.stringify({ sessionId: "route-test" }));
    });
    socket.on("close", () => {
      closedCount += 1;
    });
  });

  vi.stubEnv("META_API_KEY", "test-key");
  vi.stubEnv("META_ASR_URL", url);
});

function fakeAgentReply(text: string, id = "resp_test"): Response {
  const raw =
    `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: text.slice(0, 4) })}\n\n` +
    `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id,
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text }],
          },
        ],
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

function pcmBody(bytes: number, silent = false): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(bytes);
  // Speech-like energy so the fake ASR answers with a transcript.
  if (!silent) chunk.fill(1000 % 256);
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
    const interimAt = text.indexOf("event: interim");
    const finalAt = text.indexOf("event: final");
    expect(interimAt).toBeGreaterThan(-1);
    expect(finalAt).toBeGreaterThan(interimAt);
    expect(text).toContain("canning");
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
      body: JSON.stringify({ transcript: "vale, hello, book a gel refill" }),
    });
    const response = await POST(request);
    const text = await response.text();
    expect(text).toContain("event: final");
    expect(text).toContain("hello, book a gel refill");
    expect(text).toContain("event: reply");
    vi.unstubAllGlobals();
  });

  it("collapses echoed repeats before the gate", async () => {
    vi.stubGlobal("fetch", stubAgent("vale mismo"));
    const text = await POST(
      new Request("http://localhost/api/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: "vale abre sesion, vale abre sesion" }),
      }),
    ).then((response) => response.text());
    const finals = text
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("event: final"));
    expect(finals).toHaveLength(1);
    expect(JSON.parse(finals[0].split("data: ")[1])).toEqual({
      transcript: "vale abre sesion",
    });
    vi.unstubAllGlobals();
  });

  it("runs a stored yes-proposal directly without calling the model", async () => {
    const modelFetch = vi.fn(async () => fakeAgentReply("should not happen"));
    vi.stubGlobal("fetch", modelFetch);
    const { setPendingAction } = await import("@/lib/pending-action");
    setPendingAction("pend-yes-1", [
      { tool: "find_client", args: { name: "Ana" } },
    ]);
    const text = await POST(
      new Request("http://localhost/api/voice", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "pend-yes-1",
        },
        body: JSON.stringify({ transcript: "vale, sí, por favor" }),
      }),
    ).then((response) => response.text());
    expect(text).toContain("event: reply");
    expect(text).toContain("ficha de Ana");
    expect(modelFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("holds the selected language even when the transcript is Italian", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        return fakeAgentReply("reply");
      }),
    );
    const sendTurn = (url: string, transcript: string) =>
      POST(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transcript }),
        }),
      ).then((response) => response.text());
    const esText = await sendTurn(
      "http://localhost/api/voice?language=es",
      "vale, apri una sessione con Ana",
    );
    expect(esText).toContain("event: reply");
    const enText = await sendTurn(
      "http://localhost/api/voice?language=en",
      "vale, open a session",
    );
    expect(enText).toContain("event: reply");
    expect(bodies).toHaveLength(2);
    expect(String(bodies[0].instructions)).toContain(
      "Nunca respondas en otro idioma",
    );
    expect(String(bodies[1].instructions)).toContain("only in English");
    expect(String(bodies[1].instructions)).not.toContain("¿lo guardo?");
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
          body: JSON.stringify({ transcript: "vale, first turn" }),
        }),
      ).then((response) => response.text());
    await sendTurn();
    await POST(
      new Request("http://localhost/api/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: "vale, second turn" }),
      }),
    ).then((response) => response.text());
    const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
    expect(turns).toHaveLength(2);
    const first = JSON.parse(turns[0].replace("[voice-turn] ", ""));
    expect(first.transcript).toBe("vale, first turn");
    expect(typeof first.ttftMs).toBe("number");
    expect(first.inputTokens).toBe(100);
    expect(first.outputTokens).toBe(20);
    expect(first.costUsd).toBeGreaterThan(0);
    expect(typeof first.ts).toBe("string");
    expect(first.tool).toBeNull();
    expect(first.error).toBeNull();
    expect(JSON.parse(turns[1].replace("[voice-turn] ", "")).transcript).toBe(
      "vale, second turn",
    );
    spy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("stays silent and skips the model when the ASR final is empty", async () => {
    const modelFetch = vi.fn(async () => fakeAgentReply("should not happen"));
    vi.stubGlobal("fetch", modelFetch);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    const request = new Request("http://localhost/api/voice", {
      method: "POST",
      headers: { "content-type": "audio/l16" },
      body: pcmBody(4800, true),
      // @ts-expect-error Node fetch streaming upload flag
      duplex: "half",
    });
    const text = await POST(request).then((response) => response.text());
    expect(text).toContain("event: notice");
    expect(text).toContain('"code":"E-VAD"');
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: reply");
    expect(modelFetch).not.toHaveBeenCalled();
    const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
    expect(turns).toHaveLength(1);
    const logged = JSON.parse(turns[0].replace("[voice-turn] ", ""));
    expect(logged.modelSkipped).toBe(true);
    expect(logged.ttftMs).toBeNull();
    spy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("reports a lost connection and reconnects cleanly on the next tap", async () => {
    dropOnAudio = true;
    vi.stubGlobal("fetch", stubAgent("unused"));
    const dropped = await POST(
      new Request("http://localhost/api/voice?language=es", {
        method: "POST",
        headers: { "content-type": "audio/l16" },
        body: pcmBody(4800),
        // @ts-expect-error Node fetch streaming upload flag
        duplex: "half",
      }),
    ).then((response) => response.text());
    expect(dropped).toContain("event: error");
    expect(dropped).toMatch(/Se perdió la conexión|tuve un problema/);

    dropOnAudio = false;
    const retried = await POST(
      new Request("http://localhost/api/voice", {
        method: "POST",
        headers: { "content-type": "audio/l16" },
        body: pcmBody(4800),
        // @ts-expect-error Node fetch streaming upload flag
        duplex: "half",
      }),
    ).then((response) => response.text());
    expect(retried).toContain("event: final");
    expect(retried).toContain("event: reply");
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
      body: JSON.stringify({ transcript: "vale, hello, book a gel refill" }),
    });
    const text = await POST(request).then((response) => response.text());
    expect(text).toContain("event: final");
    expect(text).toContain("hello, book a gel refill");
    expect(text).toContain("Sorry, I had a problem.");
    expect(text).toContain('"code":"E-MODEL"');
    const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
    expect(turns).toHaveLength(1);
    expect(JSON.parse(turns[0].replace("[voice-turn] ", "")).error).toMatch(
      /model error: 500/,
    );
    spy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("answers the model error in Spanish when language=es", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const request = new Request(
      "http://localhost/api/voice?language=es",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: "vale, hola" }),
      },
    );
    const text = await POST(request).then((response) => response.text());
    expect(text).toContain("Perdón, tuve un problema.");
    expect(text).toContain('"code":"E-MODEL"');
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
    expect(body.error).toMatch(/set up/i);
    expect(JSON.stringify(body)).not.toMatch(/\n\s*at\s/);
    vi.stubEnv("META_API_KEY", "test-key");
  });

  it("writes a clear server log line when the key is missing (M3)", async () => {
    vi.stubEnv("META_API_KEY", "");
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(String(line));
    });
    await POST(
      new Request("http://localhost/api/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: "hi" }),
      }),
    );
    expect(errors.some((line) => line.includes("[voice]"))).toBe(true);
    expect(errors.join("\n")).not.toMatch(/test-key|Bearer/);
    spy.mockRestore();
    vi.stubEnv("META_API_KEY", "test-key");
  });

  it("logs a timed-out turn instead of dropping it silently (b3)", async () => {
    process.env.VOICE_TURN_TIMEOUT_MS = "150";
    holdFinal = true;
    vi.stubGlobal("fetch", stubAgent("unused"));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    const text = await POST(
      new Request("http://localhost/api/voice", {
        method: "POST",
        headers: { "content-type": "audio/l16" },
        body: pcmBody(4800),
        // @ts-expect-error Node fetch streaming upload flag
        duplex: "half",
      }),
    ).then((response) => response.text());
    expect(text).toContain("ran out");
    const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
    expect(turns).toHaveLength(1);
    expect(JSON.parse(turns[0].replace("[voice-turn] ", ""))).toMatchObject({
      error: "timeout",
    });
    spy.mockRestore();
    vi.unstubAllGlobals();
    holdFinal = false;
    delete process.env.VOICE_TURN_TIMEOUT_MS;
  });

  it("sends prior turns as history and never a chained id", async () => {
    // Real database: a unique key per run keeps earlier runs out of history.
    const clientKey = `history-turns-${Date.now()}`;
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        calls += 1;
        if (calls === 3) return new Response("nope", { status: 500 });
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        return fakeAgentReply(calls === 1 ? "Which service?" : "Done.");
      }),
    );
    const postTranscript = (transcript: string) =>
      POST(
        new Request("http://localhost/api/voice", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": clientKey,
          },
          body: JSON.stringify({ transcript }),
        }),
      ).then((response) => response.text());
    expect(await postTranscript("vale, open a session")).toContain("event: reply");
    expect(await postTranscript("gel polish")).toContain("event: reply");
    // A failure surfaces at once: no retry, no chain to drop.
    expect(await postTranscript("vale, boom")).toContain("E-MODEL");
    expect(await postTranscript("vale, hi again")).toContain("event: reply");
    for (const body of bodies) {
      expect(body.previous_response_id).toBeUndefined();
      expect(Array.isArray(body.input)).toBe(true);
    }
    expect(bodies[0].input).toHaveLength(1);
    expect(bodies[1].input).toHaveLength(3);
    expect(JSON.stringify(bodies[1].input)).toContain("vale, open a session");
    expect(JSON.stringify(bodies[1].input)).toContain("Which service?");
    vi.unstubAllGlobals();
  });

  it("ignores background chatter without the name", async () => {
    const modelFetch = vi.fn(async () => fakeAgentReply("should not happen"));
    vi.stubGlobal("fetch", modelFetch);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    const text = await POST(
      new Request("http://localhost/api/voice", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "wake-ignore-1",
        },
        body: JSON.stringify({ transcript: "background tv noise" }),
      }),
    ).then((response) => response.text());
    expect(text).toContain("event: final");
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: reply");
    expect(text).not.toContain("event: board");
    expect(modelFetch).not.toHaveBeenCalled();
    const turns = logs.filter((line) => line.startsWith("[voice-turn]"));
    expect(turns).toHaveLength(1);
    expect(JSON.parse(turns[0].replace("[voice-turn] ", ""))).toMatchObject({
      modelSkipped: true,
      ignored: true,
    });
    spy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("accepts any request inside the same client window", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return fakeAgentReply(
          calls === 1 ? "Which service for Ana?" : "Done.",
        );
      }),
    );
    const postTranscript = (transcript: string) =>
      POST(
        new Request("http://localhost/api/voice", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "wake-window-1",
          },
          body: JSON.stringify({ transcript }),
        }),
      ).then((response) => response.text());
    expect(await postTranscript("vale, something for Ana")).toContain("event: reply");
    // Nameless completion of Vale's question executes.
    expect(await postTranscript("gel polish")).toContain("event: reply");
    // A nameless fresh request executes too while the window is open.
    expect(await postTranscript("tell me a joke")).toContain("event: reply");
    expect(calls).toBe(3);
    vi.unstubAllGlobals();
  });

  it("undoes without the name inside the window", async () => {
    const modelFetch = vi.fn(async () => fakeAgentReply("vale mismo"));
    vi.stubGlobal("fetch", modelFetch);
    const postTranscript = (transcript: string) =>
      POST(
        new Request("http://localhost/api/voice", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "wake-undo-1",
          },
          body: JSON.stringify({ transcript }),
        }),
      ).then((response) => response.text());
    expect(await postTranscript("vale, abre una sesion")).toContain("event: reply");
    expect(await postTranscript("deshazlo")).toContain("event: reply");
    expect(modelFetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("ignores the follow-up once the window expires", async () => {
    vi.stubEnv("VALE_ATTENTION_WINDOW_S", "0");
    vi.stubGlobal("fetch", stubAgent("vale mismo"));
    const postTranscript = (transcript: string) =>
      POST(
        new Request("http://localhost/api/voice", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "wake-expired-1",
          },
          body: JSON.stringify({ transcript }),
        }),
      ).then((response) => response.text());
    expect(await postTranscript("vale, abre una sesion")).toContain("event: reply");
    const ignored = await postTranscript("si");
    expect(ignored).toContain("event: done");
    expect(ignored).not.toContain("event: reply");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
