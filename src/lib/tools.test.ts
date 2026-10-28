import { describe, expect, it } from "vitest";
import { TOY_TOOL, runToyTool } from "./tools";

describe("toy tool", () => {
  it("exposes one function tool for invented booking slots", () => {
    expect(TOY_TOOL.type).toBe("function");
    expect(TOY_TOOL.name).toBe("get_invented_slots");
    expect(JSON.stringify(TOY_TOOL.parameters)).toContain("date");
  });

  it("returns invented slots for a date", () => {
    const result = runToyTool("get_invented_slots", { date: "2026-10-29" });
    expect(result.date).toBe("2026-10-29");
    expect(result.slots.length).toBeGreaterThan(0);
  });

  it("rejects unknown tools", () => {
    expect(() => runToyTool("book_real_flight", {})).toThrow(/unknown tool/);
  });
});
