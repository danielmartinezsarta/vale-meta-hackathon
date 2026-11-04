import { describe, expect, it } from "vitest";
import { uiStrings } from "./vale-ui";

describe("interface dictionary", () => {
  it("covers every chrome string in both languages with no empties", () => {
    for (const language of ["en", "es"] as const) {
      const ui = uiStrings(language);
      for (const [key, value] of Object.entries(ui)) {
        if (typeof value === "string") {
          expect(value.trim(), `${language}.${key}`).not.toBe("");
        }
      }
      expect(ui.cardFor("Ana")).toContain("Ana");
    }
  });

  it("shows the in-progress session in the screen language", () => {
    expect(uiStrings("en").sessionNow).toBe("Session in progress");
    expect(uiStrings("es").sessionNow).toBe("Sesión en curso");
  });

  it("names every Vale state in both languages with no empties", () => {
    const states = [
      "idle",
      "listening",
      "thinking",
      "speaking",
      "done",
      "error",
    ] as const;
    for (const language of ["en", "es"] as const) {
      const ui = uiStrings(language);
      for (const state of states) {
        expect(ui.valeState(state).trim(), `${language}.${state}`).not.toBe("");
      }
    }
    expect(uiStrings("en").valeState("listening")).toBe("Listening");
    expect(uiStrings("en").valeState("done")).toBe("Done");
    expect(uiStrings("es").valeState("speaking")).toBe("Hablando");
  });
});
