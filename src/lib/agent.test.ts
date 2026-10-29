// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_MODEL,
  PRIVACY_LINE,
  SPOKEN_SYSTEM_PROMPT,
  runAgentTurn,
} from "./agent";
import { freshTestDb } from "./db";
import { VALE_TOOLS, runValeTool } from "./vale-tools";

function sseResponse(events: { type: string; data: unknown }[]): Response {
  const raw = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
    .join("");
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function completed(
  id: string,
  output: unknown[],
  usage = { input_tokens: 100, output_tokens: 20 },
): { type: string; data: unknown } {
  return {
    type: "response.completed",
    data: { response: { id, output, usage } },
  };
}

function toolCall(id: string, name: string, args: unknown, callId: string) {
  return completed(id, [
    {
      type: "function_call",
      name,
      arguments: JSON.stringify(args),
      call_id: callId,
    },
  ]);
}

function spoken(id: string, text: string) {
  return completed(id, [
    { type: "message", content: [{ type: "output_text", text }] },
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("agent prompt", () => {
  it("states the confirm, undo and privacy rules", () => {
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/plain text/i);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/no markdown/i);
    expect(SPOKEN_SYSTEM_PROMPT).toContain("¿lo guardo?");
    expect(SPOKEN_SYSTEM_PROMPT).toContain("deshazlo");
    expect(SPOKEN_SYSTEM_PROMPT).toContain("undo_last_write");
    expect(SPOKEN_SYSTEM_PROMPT).toContain("Nota privada guardada.");
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/never claim a write happened/i);
  });

  it("sends the Vale tools with the cheapest reasoning mode", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        return sseResponse([
          { type: "response.output_text.delta", data: { delta: "Hola." } },
          spoken("resp_1", "Hola."),
        ]);
      }),
    );

    const result = await runAgentTurn({ key: "test-key", transcript: "hola", db: freshTestDb() });

    expect(result.text).toBe("Hola.");
    expect(result.toolUsed).toBeNull();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].model).toBe(AGENT_MODEL);
    expect(bodies[0].reasoning).toEqual({ effort: "minimal" });
    expect(bodies[0].instructions).toBe(SPOKEN_SYSTEM_PROMPT);
    expect(bodies[0].tools).toEqual(VALE_TOOLS);
  });
});

describe("agent turn with tools", () => {
  it("executes the called tool against the database", async () => {
    const db = freshTestDb();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        const body = JSON.parse(
          (init as { body: string }).body,
        ) as Record<string, unknown>;
        bodies.push(body);
        if (bodies.length === 1) {
          return sseResponse([
            toolCall("resp_1", "add_note", { client_name: "Ana", text: "prefiere viernes" }, "call_1"),
          ]);
        }
        return sseResponse([spoken("resp_2", "Nota guardada en la ficha de Ana.")]);
      }),
    );

    const result = await runAgentTurn({ key: "test-key", transcript: "anota que prefiere viernes", db });

    expect(result.toolUsed).toBe("add_note");
    expect(result.text).toBe("Nota guardada en la ficha de Ana.");
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    const followUp = bodies[1];
    expect(followUp.previous_response_id).toBe("resp_1");
    const input = followUp.input as Record<string, unknown>[];
    expect(input[0].type).toBe("function_call_output");
    expect(JSON.parse(input[0].output as string).ok).toBe(true);
    const notes = db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number };
    expect(notes.n).toBe(1);
    db.close();
  });

  it("ignores function_call_arguments deltas and streams only reply text", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(JSON.parse((init as { body: string }).body) as Record<string, unknown>);
        if (bodies.length === 1) {
          return sseResponse([
            {
              type: "response.function_call_arguments.delta",
              data: { delta: '{"name":"Ana"}' },
            },
            toolCall("resp_1", "find_client", { name: "Ana" }, "call_1"),
          ]);
        }
        return sseResponse([
          { type: "response.output_text.delta", data: { delta: "Esta es " } },
          { type: "response.output_text.delta", data: { delta: "la ficha." } },
          spoken("resp_2", "Esta es la ficha."),
        ]);
      }),
    );

    const deltas: string[] = [];
    const result = await runAgentTurn({
      key: "test-key",
      transcript: "busca a ana",
      db: freshTestDb(),
      onDelta: (text) => deltas.push(text),
    });

    expect(result.text).toBe("Esta es la ficha.");
    expect(deltas.join("")).toBe("Esta es la ficha.");
    expect(deltas.join("")).not.toContain("Ana");
  });

  it("appends the privacy line once per session for health notes", async () => {
    const db = freshTestDb();
    runValeTool(db, "open_session", { client_name: "Ana", service_name: "Retiro de gel" });
    const stubHealthTurn = () => {
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init: unknown) => {
          bodies.push(JSON.parse((init as { body: string }).body) as Record<string, unknown>);
          if (bodies.length === 1) {
            return sseResponse([
              toolCall("resp_1", "add_note", { client_name: "Ana", text: "onicolisis", kind: "health" }, "call_1"),
            ]);
          }
          return sseResponse([spoken("resp_2", "Nota privada guardada.")]);
        }),
      );
    };

    stubHealthTurn();
    const first = await runAgentTurn({ key: "test-key", transcript: "anota onicolisis", db });
    expect(first.text).toBe(`Nota privada guardada. ${PRIVACY_LINE}`);

    stubHealthTurn();
    const second = await runAgentTurn({ key: "test-key", transcript: "anota otra cosa de salud", db });
    expect(second.text).toBe("Nota privada guardada.");
    expect(second.text).not.toContain("infraestructura dedicada");
    db.close();
  });

  it("surfaces model HTTP errors without leaking internals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(
      runAgentTurn({ key: "test-key", transcript: "hello", db: freshTestDb() }),
    ).rejects.toThrow(/model error: 500/);
  });
});
