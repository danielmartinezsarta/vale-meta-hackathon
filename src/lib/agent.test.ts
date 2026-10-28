// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_MODEL,
  SPOKEN_SYSTEM_PROMPT,
  runAgentTurn,
} from "./agent";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("agent turn", () => {
  it("returns spoken-style text without a tool call", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: unknown) => {
        bodies.push(
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
        );
        return sseResponse([
          { type: "response.output_text.delta", data: { delta: "Got it." } },
          completed("resp_1", [{ type: "output_text", text: "Got it." }]),
        ]);
      }),
    );

    const deltas: string[] = [];
    const result = await runAgentTurn({
      key: "test-key",
      transcript: "hello",
      onDelta: (text) => deltas.push(text),
    });

    expect(result.text).toBe("Got it.");
    expect(result.toolUsed).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(typeof result.firstTokenMs).toBe("number");
    expect(deltas.join("")).toBe("Got it.");
    // One request, cheapest reasoning, spoken prompt, no persistence tricks.
    expect(bodies).toHaveLength(1);
    expect(bodies[0].model).toBe(AGENT_MODEL);
    expect(bodies[0].reasoning).toEqual({ effort: "minimal" });
    expect(bodies[0].instructions).toBe(SPOKEN_SYSTEM_PROMPT);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/plain text/i);
    expect(SPOKEN_SYSTEM_PROMPT).toMatch(/no markdown/i);
  });

  it("calls the toy tool and answers with its result", async () => {
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
            completed("resp_1", [
              {
                type: "function_call",
                name: "get_invented_slots",
                arguments: '{"date":"2026-10-29"}',
                call_id: "call_1",
              },
            ]),
          ]);
        }
        return sseResponse([
          completed("resp_2", [
            { type: "output_text", text: "You have slots at 10:00 and 14:30." },
          ]),
        ]);
      }),
    );

    const result = await runAgentTurn({
      key: "test-key",
      transcript: "any slots tomorrow?",
    });

    expect(result.toolUsed).toBe("get_invented_slots");
    expect(result.text).toContain("10:00");
    expect(bodies).toHaveLength(2);
    const followUp = bodies[1];
    expect(followUp.previous_response_id).toBe("resp_1");
    const input = followUp.input as Record<string, unknown>[];
    expect(input[0].type).toBe("function_call_output");
    expect(input[0].call_id).toBe("call_1");
    expect(JSON.stringify(input[0].output)).toContain("2026-10-29");
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
  });

  it("surfaces model HTTP errors without leaking internals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(
      runAgentTurn({ key: "test-key", transcript: "hello" }),
    ).rejects.toThrow(/model error: 500/);
  });
});
