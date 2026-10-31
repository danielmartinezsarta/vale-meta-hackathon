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
});
