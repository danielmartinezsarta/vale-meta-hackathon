import { describe, expect, it } from "vitest";
import { buildWidget } from "./widget";

describe("buildWidget (tool-derived screen cards)", () => {
  it("shows the month goal with amounts the voice never reads", () => {
    expect(
      buildWidget(
        "goal_progress",
        {},
        { earned_usd: 120, goal_usd: 600, month: "2026-10" },
        "en",
      ),
    ).toEqual({
      kind: "meta",
      title: "Month goal",
      lines: ["120.00 USD of 600.00 USD (20%)"],
    });
  });

  it("lists one line per appointment, or the empty day", () => {
    expect(
      buildWidget(
        "list_today",
        {},
        {
          appointments: [
            { client: "Ana", service: "Gel refill", day: "2026-10-31", time: "16:00" },
          ],
        },
        "en",
      ),
    ).toEqual({
      kind: "agenda",
      title: "Today",
      lines: ["16:00 — Ana"],
    });
    expect(
      buildWidget("list_today", {}, { appointments: [] }, "en"),
    ).toEqual({ kind: "agenda", title: "Today", lines: ["Nothing on the books."] });
  });

  it("shows private notes without text and booking details with them", () => {
    expect(
      buildWidget("add_note", { client_name: "Ana" }, { private: true }, "en"),
    ).toEqual({ kind: "note", title: "Private note saved.", lines: [] });
    expect(
      buildWidget(
        "create_appointment",
        { client_name: "Ana", day: "2026-11-03", time: "16:00" },
        { appointment_id: 7 },
        "en",
      ),
    ).toEqual({
      kind: "appointment",
      title: "Appointment",
      lines: ["Ana 2026-11-03 16:00"],
    });
  });

  it("breaks the quote into screen lines", () => {
    expect(
      buildWidget(
        "quote_price",
        { service_name: "Gel refill" },
        {
          service: "Gel refill",
          supplies_cost: 8.5,
          time_cost: 30,
          fixed_share: 2,
          final_price_usd: 45,
        },
        "en",
      ),
    ).toEqual({
      kind: "breakdown",
      title: "Gel refill",
      lines: [
        "Supplies 8.50 USD",
        "Time 30.00 USD",
        "Fixed 2.00 USD",
        "Total 45.00 USD",
      ],
    });
  });

  it("returns null for tools with nothing to show", () => {
    expect(buildWidget("read_stock", {}, {}, "en")).toBeNull();
    expect(buildWidget("quote_price", {}, {}, "en")).toBeNull();
    expect(buildWidget("goal_progress", {}, {}, "en")).toBeNull();
  });
});
