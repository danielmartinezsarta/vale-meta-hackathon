// @vitest-environment node
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_MODEL,
  PROMPT_CACHE_KEY,
  SPOKEN_SYSTEM_PROMPT,
  buildInstructions,
  buildStateFacts,
  contractWidgetFor,
  runAgentTurn,
  sessionContext,
  toolWaitPhrase,
} from "./agent";
import { freshTestDb, recordTurn, recentTurns } from "./db";
import { refreshClientBrief } from "./client-briefs";
import { seedBirthday } from "./seed-dates";
import { openSession } from "./vale-tools";
import {
  clearPendingAction,
  setPendingAction,
  takePendingAction,
} from "./pending-action";
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
  it("states the confirm and privacy rules; tool routing lives in the tools", () => {
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/plain text/i);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/no markdown/i);
    expect(SPOKEN_SYSTEM_PROMPT).toContain("Should I save it?");
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/never claim a write happened/i);
    expect(SPOKEN_SYSTEM_PROMPT).toContain("Notes save at once, health notes stay private: confirm briefly");
    // How-to belongs to the tool, not the base: undo routing rides its description.
    const undo = VALE_TOOLS.find((tool) => tool.name === "undo_last");
    expect(undo?.description).toContain("deshazlo");
    expect(undo?.description).toContain("undo it");
  });

  it("orders direct action without asking and asks only on doubt", () => {
    // Right-away dispatch rides the tool description, not the base.
    const open = VALE_TOOLS.find((tool) => tool.name === "session_open");
    expect(open?.description).toMatch(/right away/i);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/in doubt/i);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/ambiguous/i);
    expect(SPOKEN_SYSTEM_PROMPT).not.toMatch(/need a short confirmation first/);
  });

  it("maps photo_preview_design to the photo_preview widget contract", () => {
    const preview = VALE_TOOLS.find((tool) => tool.name === "photo_preview_design");
    expect(preview?.parameters).toEqual({ type: "object", properties: {}, required: [] });
    const data = { before: "b", reference: "r", expected: "e" };
    expect(contractWidgetFor("photo_preview_design", {}, data)).toEqual({
      tool: "photo_preview",
      args: {},
      data,
    });
    expect(contractWidgetFor("photo_show", {}, data)).toEqual({
      tool: "photo_show",
      args: {},
      data,
    });
  });

  it("names the wait line for image generation only", () => {
    expect(toolWaitPhrase("photo_preview_design", "en")).toBe(
      "Give me a moment, creating your preview…",
    );
    expect(toolWaitPhrase("photo_preview_design", "es")).toBe(
      "Dame un momento, estoy creando tu vista previa…",
    );
    expect(toolWaitPhrase("session_open", "en")).toBeNull();
    expect(toolWaitPhrase("unknown_tool", "en")).toBeNull();
  });

  it("fires onToolStart before the tool runs", async () => {
    const db = freshTestDb();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? sseResponse([toolCall("resp_1", "session_open", { client_name: "Ana" }, "call_1")])
          : sseResponse([spoken("resp_2", "Done.")]);
      })
    );
    const started: string[] = [];
    const result = await runAgentTurn({
      key: "test-key",
      transcript: "vale, open a session for Ana",
      language: "en",
      db,
      onToolStart: (tool) => started.push(tool),
    });
    expect(started).toEqual(["session_open"]);
    expect(result.toolUsed).toBe("session_open");
    db.close();
  });

  it("answers today in one round, naming appointments and reminders", async () => {
    const db = freshTestDb();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return sseResponse([toolCall("resp_1", "agenda_show", { range: "today" }, "call_1")]);
      }),
    );
    const result = await runAgentTurn({
      key: "test-key",
      transcript: "what do I have today",
      language: "en",
      db,
    });
    expect(calls).toBe(1);
    expect(result.toolUsed).toBe("agenda_show");
    expect(result.text).toContain("David at 3 PM");
    expect(result.text).toContain("Reminders:");
    expect(result.text).toContain("Buy acetone");
    expect(result.text).toContain("cleaning company");
    db.close();
  });

  it("still runs a second round for other agenda ranges", async () => {
    const db = freshTestDb();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? sseResponse([toolCall("resp_1", "agenda_show", { range: "week" }, "call_1")])
          : sseResponse([spoken("resp_2", "A busy week.")]);
      }),
    );
    const result = await runAgentTurn({
      key: "test-key",
      transcript: "what do I have this week",
      language: "en",
      db,
    });
    expect(calls).toBe(2);
    expect(result.toolUsed).toBe("agenda_show");
    expect(result.text).toBe("A busy week.");
    db.close();
  });

  it("carries the warm coworker persona and capabilities in English", () => {
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/trusted colleague/i);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/a coworker, not a friend/i);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/You can:/);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/Greet briefly and varied/);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/outside nails/);
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
    // The static prompt opens the instructions; the live session facts ride after it.
    expect(String(bodies[0].instructions).startsWith(SPOKEN_SYSTEM_PROMPT)).toBe(true);
    expect(String(bodies[0].instructions)).toContain("Session context");
    expect(bodies[0].tools).toEqual(VALE_TOOLS);
    // Sparse live turns share the holder: explicit cache affinity.
    expect(bodies[0].prompt_cache_key).toBe(PROMPT_CACHE_KEY);
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
            toolCall("resp_1", "client_note_add", { client_name: "Ana", text: "prefiere viernes" }, "call_1"),
          ]);
        }
        return sseResponse([spoken("resp_2", "Nota guardada en la ficha de Ana.")]);
      }),
    );

    const result = await runAgentTurn({ key: "test-key", transcript: "anota que prefiere viernes", language: "es", db });

    expect(result.toolUsed).toBe("client_note_add");
    expect(result.text).toBe("Nota guardada en la ficha de Ana.");
    expect(bodies).toHaveLength(1);
    const anaId = (db.prepare("SELECT id FROM clients WHERE name = ?").get("Ana") as { id: number }).id;
    const notes = db.prepare("SELECT COUNT(*) AS n FROM notes WHERE client_id = ?").get(anaId) as { n: number };
    expect(notes.n).toBe(1);
    db.close();
  });

  it("logs each tool call with its args and the shared turn id", async () => {
    const db = freshTestDb();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? sseResponse([
              toolCall("resp_1", "client_note_add", { client_name: "Ana", text: "prefiere viernes" }, "call_1"),
            ])
          : sseResponse([spoken("resp_2", "Nota guardada.")]);
      }),
    );
    const saved = process.env.VALE_EVENTLOG_PATH;
    const file = join(tmpdir(), `agent-events-${Date.now()}.jsonl`);
    const seen: string[] = [];
    const savedLog = console.log;
    console.log = (line: string) => void seen.push(line);
    try {
      process.env.VALE_EVENTLOG_PATH = file;
      const result = await runAgentTurn({
        key: "test-key",
        transcript: "anota que prefiere viernes",
        language: "es",
        db,
        turn: "t042",
      });
      expect(result.toolUsed).toBe("client_note_add");
      const tools = seen.filter((line) => line.includes("| TOOL "));
      expect(tools).toHaveLength(1);
      expect(tools[0]).toContain("t042");
      expect(tools[0]).toContain("tool=client_note_add");
      const rows = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const tool = rows.find((row) => row.process === "TOOL");
      expect(tool).toMatchObject({ turn: "t042", status: "ok" });
      expect(tool.args).toEqual({ client_name: "Ana", text: "prefiere viernes" });
      expect(tool.detail).toEqual({ tool: "client_note_add" });
    } finally {
      console.log = savedLog;
      if (saved === undefined) delete process.env.VALE_EVENTLOG_PATH;
      else process.env.VALE_EVENTLOG_PATH = saved;
      rmSync(file, { force: true });
      db.close();
    }
  });

  it("resends the call with its output on the second round, chainless", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        if (bodies.length === 1) {
          return sseResponse([
            toolCall("resp_1", "shopping_show", {}, "call_9"),
          ]);
        }
        return sseResponse([spoken("resp_2", "You have top coat.")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "vale, read the shopping list",
      language: "en",
      db: freshTestDb(),
    });

    expect(result.text).toBe("You have top coat.");
    expect(bodies).toHaveLength(2);
    const second = bodies[1].input as Record<string, unknown>[];
    // The prefix resends so the API resolves the call_id without a chain.
    expect(second[0]).toMatchObject({ type: "message", role: "user" });
    expect(second[second.length - 2]).toMatchObject({
      type: "function_call",
      call_id: "call_9",
      name: "shopping_show",
    });
    expect(second[second.length - 1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_9",
    });
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
            "session_open",
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
    expect(result.toolUsed).toBe("session_open");
    expect(result.text).toBe("Sesión abierta con Ana.");
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
            toolCall("resp_1", "client_card_show", { name: "Ana" }, "call_1"),
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

    // The card answers itself in one round: no second-round narration.
    expect(result.text).toBe("Ana's card is on screen.");
    expect(deltas.join("")).toBe("");
    expect(deltas.join("")).not.toContain("Ana");
  });

  it("confirms a health note with exactly the private-note line", async () => {
    const db = freshTestDb();
    runValeTool(db, "session_open", { client_name: "Ana", service_name: "Retiro de gel" });
    const stubHealthTurn = () => {
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init: unknown) => {
          bodies.push(JSON.parse((init as { body: string }).body) as Record<string, unknown>);
          if (bodies.length === 1) {
            return sseResponse([
              toolCall("resp_1", "client_note_add", { client_name: "Ana", text: "onicolisis", kind: "health_note" }, "call_1"),
            ]);
          }
          return sseResponse([spoken("resp_2", "Nota privada guardada.")]);
        }),
      );
    };

    stubHealthTurn();
    const first = await runAgentTurn({ key: "test-key", transcript: "anota onicolisis", language: "es", db });
    expect(first.text).toBe("Nota privada guardada.");

    stubHealthTurn();
    const second = await runAgentTurn({ key: "test-key", transcript: "anota otra cosa de salud", language: "es", db });
    expect(second.text).toBe("Nota privada guardada.");
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
            { type: "response.output_text.delta", data: { delta: "Abro la agenda ahora." } },
            toolCall("resp_1", "agenda_show", { range: "week" }, "call_1"),
          ]);
        }
        return sseResponse([
          { type: "response.output_text.delta", data: { delta: "Esta es " } },
          { type: "response.output_text.delta", data: { delta: "la semana." } },
          spoken("resp_2", "Esta es la semana."),
        ]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "qué tengo esta semana",
      db: freshTestDb(),
      onDelta: (text) => deltas.push(text),
    });

    expect(result.text).toBe("Esta es la semana.");
    expect(deltas.join("")).toBe("Esta es la semana.");
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
    expect(input[2]).toMatchObject({ role: "user" });
    expect(JSON.stringify(input[2])).toContain("and the note?");
    // No bare strings: user turns ride input_text, assistant turns output_text.
    for (const item of input) {
      expect(typeof item).toBe("object");
    }
    expect(JSON.stringify(input[0])).toContain("input_text");
    expect(JSON.stringify(input[1])).toContain("output_text");
    expect(JSON.stringify(input[2])).toContain("input_text");
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
            toolCall("resp_mem", "client_create", { name: "Laura" }, "call_m"),
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
    expect(created.toolUsed).toBe("client_create");

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
              "session_open",
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
      { tool: "client_create", args: { name: "Vera" } },
      {
        tool: "session_open",
        args: {
          client_name: "Vera",
          service_name: "Gel removal",
        },
      },
    ]);
    clearPendingAction("pend-agent");
  });

  it("clears a stale pending proposal on a text-only turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([spoken("resp_1", "Which day next month?")]),
      ),
    );
    setPendingAction("stale-agent", [
      {
        tool: "agenda_create_appointment",
        args: { client_name: "Mia", day: "2026-10-31", time: "18:00" },
      },
    ]);

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "book her again next month",
      language: "en",
      slotKey: "stale-agent",
      db: freshTestDb(),
    });

    expect(result.text).toBe("Which day next month?");
    expect(takePendingAction("stale-agent")).toBeUndefined();
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
  it("uses one English prompt; only the output line switches", () => {
    expect(buildInstructions()).toBe(buildInstructions("en"));
    const es = buildInstructions("es");
    const en = buildInstructions("en");
    // Same base, different output line.
    expect(es).toContain("You are Vale, a hands-free voice helper");
    expect(en).toContain("You are Vale, a hands-free voice helper");
    expect(es).toContain("reply only in Spanish");
    expect(es).toContain("Nunca respondas en otro idioma");
    expect(en).toContain("reply only in English");
    expect(en).not.toContain("Nunca respondas");
    expect(es).toBe(SPOKEN_SYSTEM_PROMPT);
  });

  it("answers only in English under the EN setting, never in Spanish", () => {
    const instructions = buildInstructions("en");
    expect(instructions).toContain("only in English");
    expect(instructions).toContain("Should I save it?");
    expect(instructions).not.toContain("Nunca respondas");
    expect(instructions).not.toContain("¿lo guardo?");
  });

  it("caps length, bans endearments and names the user", () => {
    const instructions = buildInstructions("en");
    expect(instructions).toContain("25 words");
    expect(instructions).toContain("Never use terms of endearment");
    expect(instructions).toContain("a coworker, not a friend");
    for (const word of [
      "love",
      "darling",
      "honey",
      "dear",
      "sweetie",
      "babe",
      "hun",
    ]) {
      expect(instructions).toContain(word);
    }
    expect(
      buildStateFacts("2026-10-31", "Daniel", "", ""),
    ).toContain("The user's name is Daniel");
    expect(
      buildStateFacts("2026-10-31", "Maria", "", ""),
    ).toContain("The user's name is Maria");
  });

  it("names the open session and asks instead of closing unasked", () => {
    expect(SPOKEN_SYSTEM_PROMPT).toContain("A refused write is never a license");
  });

  it("keeps the stable base before the volatile state facts", () => {
    const base = buildInstructions("en");
    const state = buildStateFacts("2026-10-31", "Daniel", "slot", "session");
    expect(base).toContain("You are Vale, a hands-free voice helper");
    expect(base).not.toContain("Today is");
    expect(base).not.toContain("The user's name is");
    expect(state).toContain("Today is 2026-10-31");
    expect(state).toContain("slot");
  });

  it("grounds the turn in the open session without filtering it", () => {
    const at = new Date("2026-10-31T16:30:00.000Z");
    const empty = freshTestDb();
    expect(sessionContext(empty, at)).toContain("No session is open");
    expect(sessionContext(empty, at)).toContain("2026-10-31");
    expect(sessionContext(empty, at)).toContain("never invent one");
    empty.close();

    const db = freshTestDb();
    const opened = openSession(db, {
      client_name: "Ana",
      service_name: "retiro",
    });
    expect(opened.ok).toBe(true);
    const line = sessionContext(db, at);
    expect(line).toContain("Open session");
    expect(line).toContain("Ana");
    expect(line).toContain("America/Bogota");
    expect(line).toContain("belongs to the session client");
    expect(line).toContain("leaves the session untouched");
    expect(line).toContain("never use the session");
    db.close();
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

  it("says exactly the private-note line in English under the EN setting", async () => {
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
              "client_note_add",
              { client_name: "Ana", text: "onicólisis", kind: "health_note" },
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

    expect(result.text).toBe("Private note saved.");
  });

  it("returns a screen card for goal and quote reads, never from text", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        if (bodies.length === 1) {
          return sseResponse([
            toolCall("resp_1", "goal_show", {}, "call_g"),
          ]);
        }
        return sseResponse([spoken("resp_2", "Here is your goal.")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "vale, how is my goal",
      language: "en",
      db: freshTestDb(),
    });

    expect(result.widget).toEqual({
      kind: "goal",
      title: "Monthly goal",
      size: "half",
      data: { name: null, goal: 2500, earned: 112.6 },
    });
    expect(result.text).toBe("Here is your goal.");
  });

  it("returns a confirm card for the doubt-turn proposal", async () => {
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
              "session_open",
              { client_name: "Vera", service_name: "Gel removal" },
              "call_d",
            ),
          ]);
        }
        return sseResponse([spoken("resp_d2", "Should I save it?")]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "vale abre sesión con Vera para retiro",
      slotKey: "pend-agent-widget",
      db: freshTestDb(),
    });

    expect(result.widget).toEqual({
      kind: "confirm",
      title: "Open session with Vera for Gel removal?",
      size: "half",
      data: {},
    });
    clearPendingAction("pend-agent-widget");
  });

  it("clarifies a bare yes with nothing pending instead of rewriting", async () => {
    const modelFetch = vi.fn(async () => sseResponse([spoken("resp_x", "Done.")]));
    vi.stubGlobal("fetch", modelFetch);
    const db = freshTestDb();
    const result = await runAgentTurn({
      key: "test-key",
      transcript: "sí",
      language: "es",
      slotKey: "pend-bare-yes",
      db,
    });
    expect(result.text).toBe("¿Qué quieres que confirme?");
    expect(result.toolUsed).toBeNull();
    expect(modelFetch).not.toHaveBeenCalled();
    db.close();
  });

  it("sends a yes answering Vale's own open question to the model", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        return sseResponse([spoken("resp_y", "Closing Emma, opening Chloe.")]);
      }),
    );
    const db = freshTestDb();
    const result = await runAgentTurn({
      key: "test-key",
      transcript: "yes",
      language: "en",
      slotKey: "pend-open-question",
      db,
      history: [
        { role: "user", text: "Vale, open a session with Chloe for gel refill", tool: null },
        {
          role: "vale",
          text: "Emma's session is still open. Should I close it and open Chloe for gel refill?",
          tool: null,
        },
      ],
    });
    expect(result.text).toBe("Closing Emma, opening Chloe.");
    expect(bodies).toHaveLength(1);
    expect(String(bodies[0].instructions)).toContain("just said yes to your last question");
    db.close();
  });

describe("client card privacy (HACK-005)", () => {
  const CARD_SECRETS = [
    "+1-555-0101",
    "david@example.com",
    seedBirthday(5, 1990),
    "HO HO HO",
    "latex",
    "Rangers",
    "Prefers dark matte designs",
  ];

  function stubCardCall(bodies: Record<string, unknown>[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(JSON.parse((init as { body: string }).body) as Record<string, unknown>);
        return sseResponse([toolCall("resp_1", "client_card_show", { name: "David" }, "call_1")]);
      }),
    );
  }

  it("answers the card in one round with no client details in any Meta input", async () => {
    const db = freshTestDb();
    db.prepare(
      "INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES ((SELECT id FROM clients WHERE name = 'David'), 'Hockey fan, ask about the Rangers', 'note', 0)",
    ).run();
    const bodies: Record<string, unknown>[] = [];
    stubCardCall(bodies);
    const result = await runAgentTurn({
      key: "test-key",
      transcript: "David is here",
      language: "en",
      slotKey: "card-leak-1",
      db,
    });
    expect(result.toolUsed).toBe("client_card_show");
    expect(result.text).toBe("David's card is on screen.");
    expect(result.widget?.kind).toBe("client_card");
    expect(bodies).toHaveLength(1);
    const seen = JSON.stringify(bodies);
    for (const secret of CARD_SECRETS) expect(seen).not.toContain(secret);
    db.close();
  });

  it("names the wait line for reading the record privately", () => {
    expect(toolWaitPhrase("client_summary", "en")).toBe(
      "Give me a few seconds, I'm reading the client's record privately.",
    );
    expect(toolWaitPhrase("client_summary", "es")).toBe(
      "Dame unos segundos, estoy leyendo la ficha en privado.",
    );
    expect(contractWidgetFor("client_summary", {}, { card: { name: "David" }, brief: null })).toEqual({
      tool: "find_client",
      args: { client_name: "David" },
      data: { id: undefined, name: "David", notes: [] },
    });
  });

  it("answers the brief in one round and stores only its label in history", async () => {
    const SUMMARY_BRIEF = {
      spoken:
        "David comes every 3 weeks and likes dark matte. He also has a health note; it's on screen.",
      summary: ["Prefers dark matte designs", "Hockey fan, ask about the Rangers"],
      has_health_note: true,
    };
    const db = freshTestDb();
    vi.stubEnv("GLIMMER_URL", "https://glimmer.test");
    vi.stubEnv("GLIMMER_TOKEN", "secret");
    const davidId = (db.prepare("SELECT id FROM clients WHERE name = ?").get("David") as { id: number }).id;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(SUMMARY_BRIEF) } }] }),
      })),
    );
    await refreshClientBrief(db, davidId, fetch);
    vi.unstubAllEnvs();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(JSON.parse((init as { body: string }).body) as Record<string, unknown>);
        return sseResponse([toolCall("resp_1", "client_summary", { name: "David" }, "call_1")]);
      }),
    );
    const result = await runAgentTurn({
      key: "test-key",
      transcript: "David is here, what do I have on him?",
      language: "en",
      slotKey: "brief-leak-1",
      db,
    });
    expect(result.toolUsed).toBe("client_summary");
    expect(result.text).toBe(SUMMARY_BRIEF.spoken);
    expect(result.widget?.kind).toBe("client_card");
    expect(bodies).toHaveLength(1);
    // The route stores the reply in history: only the label may land there.
    recordTurn(db, "brief-client", "user", "David is here, what do I have on him?");
    recordTurn(db, "brief-client", "vale", result.text, result.toolUsed);
    const history = recentTurns(db, "brief-client");
    expect(history[1].text).toBe("(client summary shown)");
    // Next turn: no record text, note text or summary text reaches Meta.
    bodies.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(JSON.parse((init as { body: string }).body) as Record<string, unknown>);
        return sseResponse([spoken("resp_2", "Anything else?")]);
      }),
    );
    await runAgentTurn({
      key: "test-key",
      transcript: "thanks",
      language: "en",
      slotKey: "brief-leak-2",
      db,
      history,
    });
    expect(bodies).toHaveLength(1);
    const seen = JSON.stringify(bodies);
    for (const secret of [...CARD_SECRETS, SUMMARY_BRIEF.spoken, ...SUMMARY_BRIEF.summary]) {
      expect(seen).not.toContain(secret);
    }
    db.close();
  });

  it("keeps client details out of the history fed back to Meta", async () => {
    const db = freshTestDb();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(JSON.parse((init as { body: string }).body) as Record<string, unknown>);
        return sseResponse([spoken("resp_2", "Anything else?")]);
      }),
    );
    await runAgentTurn({
      key: "test-key",
      transcript: "thanks",
      language: "en",
      slotKey: "card-leak-2",
      db,
      history: [
        { role: "user", text: "David is here", tool: null },
        { role: "vale", text: "David's card is on screen.", tool: "client_card_show" },
      ],
    });
    expect(bodies).toHaveLength(1);
    const seen = JSON.stringify(bodies);
    for (const secret of CARD_SECRETS) expect(seen).not.toContain(secret);
    db.close();
  });

  it("still clarifies a yes when Vale's question already ran a tool", async () => {
    const modelFetch = vi.fn(async () => sseResponse([spoken("resp_z", "Done.")]));
    vi.stubGlobal("fetch", modelFetch);
    const db = freshTestDb();
    const result = await runAgentTurn({
      key: "test-key",
      transcript: "yes",
      language: "en",
      slotKey: "pend-acted-question",
      db,
      history: [
        { role: "user", text: "Vale, save a note for Emma", tool: null },
        { role: "vale", text: "Saved. Anything else?", tool: "client_note_add" },
      ],
    });
    expect(result.text).toBe("What would you like me to confirm?");
    expect(result.toolUsed).toBeNull();
    expect(modelFetch).not.toHaveBeenCalled();
    db.close();
  });
});
});
