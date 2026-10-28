/**
 * One toy tool with invented demo data. The agent may call it when asked
 * about booking availability; the reply must use its result.
 */

export interface ToyToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOY_TOOL: ToyToolDefinition = {
  type: "function",
  name: "get_invented_slots",
  description:
    "Look up invented demo booking slots for a nail appointment on a given date.",
  parameters: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "Calendar date like 2026-10-29.",
      },
    },
    required: ["date"],
  },
};

export interface InventedSlots {
  date: string;
  slots: string[];
}

/** Executor: deterministic invented slots, no external calls. */
export function runToyTool(name: string, args: unknown): InventedSlots {
  if (name !== TOY_TOOL.name) throw new Error(`unknown tool: ${name}`);
  const params = (args ?? {}) as { date?: unknown };
  const date = typeof params.date === "string" && params.date.trim() !== ""
    ? params.date.trim().slice(0, 10)
    : "soon";
  // Invented demo data: derived from the date string, nothing real.
  const morning = date.length % 2 === 0 ? "10:00" : "09:30";
  return { date, slots: [morning, "14:30"] };
}
