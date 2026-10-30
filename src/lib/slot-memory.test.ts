import { describe, expect, it } from "vitest";
import {
  clearSlots,
  getSlots,
  slotContext,
  updateSlotsFromTool,
} from "./slot-memory";

describe("slot memory", () => {
  it("records client and service from a successful open_session", () => {
    updateSlotsFromTool(
      "slot-open",
      "open_session",
      { client_name: "Ana", service_name: "esmaltado" },
      true,
      undefined,
    );
    expect(getSlots("slot-open")).toEqual({
      client: "Ana",
      service: "esmaltado",
    });
    expect(slotContext("slot-open", "es")).toBe(
      "En curso: clienta Ana; servicio esmaltado. No repreguntes lo dado.",
    );
    expect(slotContext("slot-open", "en")).toBe(
      "Ongoing: client Ana; service esmaltado. Don't ask again for what's known.",
    );
  });

  it("ignores doubt, merges create_client, clears on close", () => {
    updateSlotsFromTool(
      "slot-merge",
      "open_session",
      { client_name: "X" },
      false,
      undefined,
    );
    expect(getSlots("slot-merge")).toEqual({});
    expect(slotContext("slot-merge", "es")).toBe("");
    updateSlotsFromTool(
      "slot-merge",
      "create_client",
      { name: "Laura" },
      true,
      undefined,
    );
    expect(getSlots("slot-merge")).toEqual({ client: "Laura" });
    expect(slotContext("slot-merge", "en")).toBe(
      "Ongoing: client Laura. Don't ask again for what's known.",
    );
    updateSlotsFromTool("slot-merge", "close_session", {}, true, undefined);
    expect(getSlots("slot-merge")).toEqual({});
    clearSlots("slot-open");
    clearSlots("slot-merge");
  });

  it("takes the matched name from find_client and add_note", () => {
    updateSlotsFromTool("slot-card", "find_client", { name: "an" }, true, {
      name: "Ana",
    });
    expect(getSlots("slot-card")).toEqual({ client: "Ana" });
    updateSlotsFromTool(
      "slot-card",
      "add_note",
      { client_name: "Ana", text: "prefiere viernes" },
      true,
      undefined,
    );
    expect(getSlots("slot-card")).toEqual({ client: "Ana" });
    clearSlots("slot-card");
  });
});
