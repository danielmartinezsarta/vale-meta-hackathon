// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_MODEL,
  PRIVACY_LINE,
  PRIVACY_LINE_EN,
  SPOKEN_SYSTEM_PROMPT,
  buildInstructions,
  runAgentTurn,
} from "./agent";
import { freshTestDb } from "./db";
import { clearPendingAction, takePendingAction } from "./pending-action";
import { clearSlots } from "./slot-memory";
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

  it("orders direct action without asking and asks only on doubt", () => {
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/right away/i);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/in doubt/i);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/ambiguous/i);
    expect(SPOKEN_SYSTEM_PROMPT).not.toMatch(/need a short confirmation first/);
  });

  it("speaks always de tú with persona, capabilities and tone examples", () => {
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/siempre de tú/i);
    expect(SPOKEN_SYSTEM_PROMPT).not.toContain("Never invent other wordings");
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/Hoy puedes:/);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/Precio y agenda/);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/Ejemplos de tono \(no guion\)/);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/¿qué puedes hacer\?/);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/Saluda variado/);
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

    const result = await runAgentTurn({ key: "test-key", transcript: "hola", language: "es", db: freshTestDb() });

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

    const result = await runAgentTurn({ key: "test-key", transcript: "anota que prefiere viernes", language: "es", db });

    expect(result.toolUsed).toBe("add_note");
    expect(result.text).toBe("Nota guardada en la ficha de Ana Beltran.");
    expect(bodies).toHaveLength(1);
    const notes = db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number };
    expect(notes.n).toBe(1);
    db.close();
  });

  it("answers a successful write without a second model round", async () => {
    const db = freshTestDb();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        return sseResponse([
          toolCall(
            "resp_1",
            "open_session",
            { client_name: "Ana", service_name: "Gel refill" },
            "call_1",
          ),
        ]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "vale, open a session for Ana",
      language: "es",
      db,
    });

    expect(bodies).toHaveLength(1);
    expect(result.toolUsed).toBe("open_session");
    expect(result.text).toBe("Sesión abierta con Ana Beltran.");
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
    const first = await runAgentTurn({ key: "test-key", transcript: "anota onicolisis", language: "es", db });
    expect(first.text).toBe(`Nota privada guardada. ${PRIVACY_LINE}`);

    stubHealthTurn();
    const second = await runAgentTurn({ key: "test-key", transcript: "anota otra cosa de salud", language: "es", db });
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

describe("agent narration buffering", () => {
  it("holds pre-tool narration back and streams tool-free rounds", async () => {
    const deltas: string[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return sseResponse([
            { type: "response.output_text.delta", data: { delta: "Abro la sesión ahora." } },
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

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "busca a ana",
      db: freshTestDb(),
      onDelta: (text) => deltas.push(text),
    });

    expect(result.text).toBe("Esta es la ficha.");
    expect(deltas.join("")).toBe("Esta es la ficha.");
    expect(deltas.join("")).not.toContain("Abro");
  });
});

describe("agent single attempt", () => {
  it("throws on a 400 without retrying", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response("bad round", { status: 400 });
      }),
    );

    await expect(
      runAgentTurn({ key: "test-key", transcript: "hola", db: freshTestDb() }),
    ).rejects.toThrow(/model error: 400/);
    expect(calls).toBe(1);
  });

  it("throws on a 500 without retrying", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response("nope", { status: 500 });
      }),
    );

    await expect(
      runAgentTurn({ key: "test-key", transcript: "hola", db: freshTestDb() }),
    ).rejects.toThrow(/model error: 500/);
    expect(calls).toBe(1);
  });

  it("throws when a failed event names a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            type: "response.failed",
            data: { error: "previous_response_id invalid: gone" },
          },
        ]),
      ),
    );

    await expect(
      runAgentTurn({ key: "test-key", transcript: "hola", db: freshTestDb() }),
    ).rejects.toThrow(/model error/);
  });

  it("sends the conversation history in the input, never a chained id", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        return sseResponse([spoken("resp_9", "Claro, Emma.")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "and the note?",
      history: [
        { role: "user", text: "Vale, open a session for Emma", tool: null },
        { role: "vale", text: "Which service for Emma?", tool: null },
      ],
      db: freshTestDb(),
    });

    expect(result.text).toBe("Claro, Emma.");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].previous_response_id).toBeUndefined();
    const input = bodies[0].input as unknown[];
    expect(input).toHaveLength(3);
    expect(input[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(input[0])).toContain("Vale, open a session for Emma");
    expect(input[1]).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(input[1])).toContain("Which service for Emma?");
    expect(input[2]).toBe("and the note?");
  });

  it("injects the known slots into the next turn instead of re-asking", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        if (bodies.length === 1) {
          return sseResponse([
            toolCall("resp_mem", "create_client", { name: "Laura" }, "call_m"),
          ]);
        }
        return sseResponse([spoken("resp_mem2", "Lista, Laura registrada.")]);
      }),
    );

    const created = await runAgentTurn({
      key: "test-key",
      transcript: "vale registra a Laura",
      slotKey: "mem-int",
      db: freshTestDb(),
    });
    expect(created.toolUsed).toBe("create_client");

    await runAgentTurn({
      key: "test-key",
      transcript: "vale abre sesión para esmaltado",
      language: "es",
      slotKey: "mem-int",
      db: freshTestDb(),
    });
    expect(bodies).toHaveLength(2);
    expect(String(bodies[1].instructions)).toContain(
      "En curso: clienta Laura. No repreguntes lo dado.",
    );
    clearSlots("mem-int");
  });

  it("stores the combined proposal when a doubt turn names it all", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        if (bodies.length === 1) {
          return sseResponse([
            toolCall(
              "resp_doubt",
              "open_session",
              { client_name: "Vera", service_name: "Gel removal" },
              "call_d",
            ),
          ]);
        }
        return sseResponse([spoken("resp_d2", "¿La registro y abro?")]);
      }),
    );

    await runAgentTurn({
      key: "test-key",
      transcript: "vale abre sesión con Vera para retiro",
      slotKey: "pend-agent",
      db: freshTestDb(),
    });

    expect(takePendingAction("pend-agent")).toEqual([
      { tool: "create_client", args: { name: "Vera" } },
      {
        tool: "open_session",
        args: {
          client_name: "Vera",
          service_name: "Gel removal",
        },
      },
    ]);
    clearPendingAction("pend-agent");
  });

  it("reports the tool it used with no chain state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([spoken("resp_1", "Hola, dime.")])),
    );
    const ask = await runAgentTurn({
      key: "test-key",
      transcript: "hola",
      db: freshTestDb(),
    });
    expect(ask.toolUsed).toBeNull();
    expect(ask).not.toHaveProperty("chainNext");
  });
});

describe("closed reply language", () => {
  it("keeps the historic Spanish prompt available in Spanish", () => {
    expect(buildInstructions()).toBe(buildInstructions("en"));
    expect(buildInstructions("es")).toBe(SPOKEN_SYSTEM_PROMPT);
  });

  it("keeps templates and tone examples out of the English prompt", () => {
    expect(buildInstructions("es")).toMatch(/Saluda variado/);
    expect(buildInstructions("en")).not.toMatch(/variety/);
    expect(buildInstructions("en")).not.toContain("gets exactly Hi");
    expect(buildInstructions("en")).not.toContain("Which service should I do for Ana?");
    expect(buildInstructions("en")).not.toMatch(/outside nails/);
    expect(buildInstructions("en")).not.toMatch(/what can you do/);
  });

  it("answers only in English under the EN setting, never in Spanish", () => {
    const instructions = buildInstructions("en");
    expect(instructions).toContain("only in English");
    expect(instructions).toContain("Should I save it?");
    expect(instructions).toContain("Private note saved.");
    expect(instructions).toContain("undo it");
    expect(instructions).not.toContain("¿lo guardo?");
    expect(instructions).not.toContain("deshazlo");
    expect(instructions).not.toContain("¿Para qué clienta es");
  });

  it("sends the English instructions to the model when selected", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        return sseResponse([spoken("resp_en", "All set.")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "vale, open a session",
      language: "en",
      db: freshTestDb(),
    });

    expect(result.text).toBe("All set.");
    expect(bodies).toHaveLength(1);
    expect(String(bodies[0].instructions)).toContain("only in English");
    expect(String(bodies[0].instructions)).not.toContain("¿lo guardo?");
  });

  it("holds Spanish even when the transcript arrives in Italian", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        return sseResponse([spoken("resp_it", "¿Para qué clienta es?")]);
      }),
    );

    await runAgentTurn({
      key: "test-key",
      transcript: "Vale, apri una sessione con Ana",
      language: "es",
      db: freshTestDb(),
    });

    expect(bodies).toHaveLength(1);
    expect(String(bodies[0].instructions)).toContain(
      "Nunca respondas en otro idioma",
    );
  });

  it("says the privacy line in English under the EN setting", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        if (bodies.length === 1) {
          return sseResponse([
            toolCall(
              "resp_h",
              "add_note",
              { client_name: "Ana", text: "onicólisis", kind: "health" },
              "call_h",
            ),
          ]);
        }
        return sseResponse([spoken("resp_h2", "Private note saved.")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "note onycholysis for Ana",
      language: "en",
      db: freshTestDb(),
    });

    expect(result.text).toContain("Private note saved.");
    expect(result.text).toContain(PRIVACY_LINE_EN);
    expect(result.text).not.toContain(PRIVACY_LINE);
  });
});
