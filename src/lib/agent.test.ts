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

describe("agent clean retry", () => {
  it("retries once without the chain after a 400 with no tool yet", async () => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        calls += 1;
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        if (calls === 1) return new Response("bad chain", { status: 400 });
        return sseResponse([spoken("resp_2", "Listo.")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "hola",
      previousResponseId: "resp_stale",
      db: freshTestDb(),
    });

    expect(calls).toBe(2);
    expect(bodies[0].previous_response_id).toBe("resp_stale");
    expect(bodies[1].previous_response_id).toBeUndefined();
    expect(result.responseId).toBe("resp_2");
  });

  it("does not retry when a write already completed before the 400", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return sseResponse([
            toolCall("resp_1", "create_client", { name: "Noa" }, "call_1"),
          ]);
        }
        return new Response("bad round", { status: 400 });
      }),
    );

    await expect(
      runAgentTurn({ key: "test-key", transcript: "hola", db: freshTestDb() }),
    ).rejects.toThrow(/model error: 400/);
    expect(calls).toBe(2);
  });

  it("retries clean when only a read or a doubt ran before the 400", async () => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        calls += 1;
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        if (calls === 1) {
          return sseResponse([
            toolCall("resp_1", "find_client", { name: "Zzz" }, "call_1"),
          ]);
        }
        if (calls === 2) {
          return new Response("stale chain", { status: 400 });
        }
        return sseResponse([spoken("resp_3", "Ya quedó.")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "hola",
      previousResponseId: "resp_stale",
      db: freshTestDb(),
    });

    expect(calls).toBe(3);
    expect(bodies[0].previous_response_id).toBe("resp_stale");
    expect(bodies[2].previous_response_id).toBeUndefined();
    expect(result.text).toBe("Ya quedó.");
  });

  it("does not retry non-chain errors", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response("nope", { status: 500 });
      }),
    );

    await expect(
      runAgentTurn({
        key: "test-key",
        transcript: "hola",
        previousResponseId: "resp_0",
        db: freshTestDb(),
      }),
    ).rejects.toThrow(/model error: 500/);
    expect(calls).toBe(1);
  });

  it("retries clean when a failed event names a stale chain", async () => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        calls += 1;
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        if (calls === 1) {
          return sseResponse([
            {
              type: "response.failed",
              data: {
                error: "previous_response_id invalid: response not found",
              },
            },
          ]);
        }
        return sseResponse([spoken("resp_2", "Hola de nuevo.")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "hola",
      previousResponseId: "resp_stale",
      db: freshTestDb(),
    });

    expect(calls).toBe(2);
    expect(bodies[1].previous_response_id).toBeUndefined();
    expect(result.text).toBe("Hola de nuevo.");
    expect(result.responseId).toBe("resp_2");
  });

  it("logs each failed attempt with its chain state for the next audit", async () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((line: unknown) => {
        errors.push(String(line));
      });
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("nope", { status: 500 })),
      );
      await expect(
        runAgentTurn({
          key: "test-key",
          transcript: "hola",
          previousResponseId: "resp_0",
          db: freshTestDb(),
        }),
      ).rejects.toThrow(/model error: 500/);
      expect(
        errors.some((line) =>
          line.includes("[agent] attempt 0 (chained) failed"),
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
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
      slotKey: "mem-int",
      db: freshTestDb(),
    });
    expect(bodies).toHaveLength(3);
    expect(String(bodies[2].instructions)).toContain(
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

  it("marks the chain to continue after questions and doubt, not after writes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([spoken("resp_1", "Hola, dime.")])),
    );
    const ask = await runAgentTurn({
      key: "test-key",
      transcript: "hola",
      db: freshTestDb(),
    });
    expect(ask.chainNext).toBe(true);
  });
});

describe("agent response chaining", () => {
  it("returns the last round id and sends a prior id on the first request", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        if (bodies.length === 1) {
          return sseResponse([
            toolCall("resp_1", "find_client", { name: "Ana" }, "call_1"),
          ]);
        }
        return sseResponse([spoken("resp_2", "Esta es la ficha.")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "sí",
      previousResponseId: "resp_0",
      db: freshTestDb(),
    });

    expect(bodies[0].previous_response_id).toBe("resp_0");
    expect(result.responseId).toBe("resp_2");
    expect(result.toolUsed).toBe("find_client");
    expect(result.chainNext).toBe(false);
  });

  it("keeps the chain when the tool reports doubt", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return sseResponse([
            toolCall("resp_1", "add_to_shopping_list", { item_name: "esmalte" }, "call_1"),
          ]);
        }
        return sseResponse([spoken("resp_2", "¿Cuál?")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "agrega esmalte",
      db: freshTestDb(),
    });

    expect(result.toolUsed).toBe("add_to_shopping_list");
    expect(result.chainNext).toBe(true);
  });
});

describe("closed reply language", () => {
  it("keeps the historic Spanish prompt as the default", () => {
    expect(buildInstructions()).toBe(SPOKEN_SYSTEM_PROMPT);
    expect(buildInstructions("es")).toBe(SPOKEN_SYSTEM_PROMPT);
  });

  it("greets with variety and states capabilities, never rigid templates", () => {
    expect(buildInstructions("es")).toMatch(/Saluda variado/);
    expect(buildInstructions("es")).toContain("sin preguntar datos");
    expect(buildInstructions("es")).not.toContain("gets exactly Hola");
    expect(buildInstructions("en")).toMatch(/variety/);
    expect(buildInstructions("en")).not.toContain("gets exactly Hi");
    expect(buildInstructions("en")).toMatch(/No prices or appointments yet/);
    expect(buildInstructions("es")).toMatch(/fuera de uñas/);
    expect(buildInstructions("en")).toMatch(/outside nails/);
  });

  it("answers only in English under the EN setting, never in Spanish", () => {
    const instructions = buildInstructions("en");
    expect(instructions).toContain("only in English");
    expect(instructions).toContain("Should I save it?");
    expect(instructions).toContain("Which service should I do for Ana?");
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
