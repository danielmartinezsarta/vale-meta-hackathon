import { describe, expect, it } from "vitest";
import {
  buildWidget,
  formatDay,
  formatMinutes,
  formatVisit,
  initials,
  usdWhole,
  widgetTitle,
  WIDGET_SIZE,
} from "./widget";

const NO_DB = undefined;

describe("buildWidget (typed payloads per kind)", () => {
  it("stamps the fixed half/full size and English title per kind", () => {
    expect(WIDGET_SIZE.client_card).toBe("full");
    expect(WIDGET_SIZE.goal).toBe("half");
    expect(WIDGET_SIZE.booked).toBe("half");
    expect(WIDGET_SIZE.session_summary).toBe("full");
    expect(widgetTitle("price")).toBe("Price");
    expect(widgetTitle("note")).toBe("Note saved");
  });

  it("builds the goal payload from earned and target", () => {
    expect(
      buildWidget("goal_progress", {}, { earned_usd: 120, goal_usd: 600 }, NO_DB),
    ).toEqual({
      kind: "goal",
      title: "Monthly goal",
      size: "half",
      data: { name: null, goal: 600, earned: 120 },
    });
  });

  it("builds the client card with health first, notes next", () => {
    expect(
      buildWidget(
        "find_client",
        {},
        {
          id: 1,
          name: "David",
          notes: [
            { id: 1, kind: "general", text: "Always on time" },
            { id: 2, kind: "health", text: "Allergic to monomer" },
            { id: 3, kind: "health", text: null },
          ],
        },
        NO_DB,
      ),
    ).toEqual({
      kind: "client_card",
      title: "Client card",
      size: "full",
      data: {
        name: "David",
        birthday: null,
        sex: null,
        phone: null,
        email: null,
        visits: [],
        visitsMore: 0,
        healthNotes: ["Allergic to monomer"],
        noteTags: ["Always on time"],
      },
    });
  });

  it("builds health and regular notes from the call args", () => {
    expect(
      buildWidget("add_note", { client_name: "David", text: "Allergic to monomer", kind: "health" }, { ok: true }, NO_DB),
    ).toEqual({
      kind: "health_note",
      title: "Health note",
      size: "half",
      data: { text: "Allergic to monomer", client: "David" },
    });
    expect(
      buildWidget("add_note", { client_name: "David", text: "Likes neon colors" }, { ok: true }, NO_DB),
    ).toEqual({
      kind: "note",
      title: "Note saved",
      size: "half",
      data: { text: "Likes neon colors", client: "David" },
    });
  });

  it("builds the price payload with null extras until priced", () => {
    expect(
      buildWidget(
        "quote_price",
        { service_name: "Gel manicure" },
        { service: "Gel manicure", final_price_usd: 35 },
        NO_DB,
      ),
    ).toEqual({
      kind: "price",
      title: "Price",
      size: "half",
      data: { service: "Gel manicure", extras: null, suggested: 35 },
    });
  });

  it("builds the booked payload from the call args", () => {
    const data = { appointment_id: 7, off_hours: false };
    const args = {
      client_name: "David",
      service_name: "Gel manicure",
      day: "2026-11-27",
      time: "15:00",
    };
    for (const tool of ["create_appointment", "move_appointment"]) {
      expect(buildWidget(tool, args, data, NO_DB)).toEqual({
        kind: "booked",
        title: "Appointment booked",
        size: "half",
        data: { client: "David", service: "Gel manicure", day: "2026-11-27", time: "15:00" },
      });
    }
  });

  it("fills the card health block from the store past the masked feed", () => {
    const store = {
      prepare: (sql: string) =>
        sql.includes("FROM notes")
          ? { get: () => null, all: () => [{ text: "Allergic to monomer" }] }
          : { get: () => null, all: () => [] },
    };
    expect(
      buildWidget(
        "find_client",
        {},
        { id: 186, name: "David", notes: [{ kind: "health", text: null, masked: true }] },
        store,
      )?.data,
    ).toMatchObject({ healthNotes: ["Allergic to monomer"] });
  });

  it("returns no sheet for the day plan and session open", () => {
    expect(buildWidget("list_today", {}, { appointments: [] }, NO_DB)).toBeNull();
    expect(buildWidget("next_appointment", {}, {}, NO_DB)).toBeNull();
    expect(buildWidget("open_session", {}, {}, NO_DB)).toBeNull();
    expect(buildWidget("no_such_tool", {}, {}, NO_DB)).toBeNull();
  });

  it("formats money, days, visits, minutes, and initials Ali-style", () => {
    expect(usdWhole(35)).toBe("$35");
    expect(usdWhole(2000)).toBe("$2,000");
    expect(formatDay("2026-11-27")).toBe("Friday, November 27");
    expect(formatVisit("2026-10-12")).toBe("Oct 12, 2026");
    expect(formatMinutes(72)).toBe("1h 12m");
    expect(formatMinutes(6)).toBe("6m");
    expect(initials("David")).toBe("D");
    expect(initials("Ana Beltran")).toBe("AB");
  });
});
