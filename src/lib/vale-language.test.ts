import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  parseLanguage,
  turnErrorText,
} from "./vale-language";

describe("closed language set", () => {
  it("defaults to Spanish and keeps only es or en", () => {
    expect(DEFAULT_LANGUAGE).toBe("es");
    expect(parseLanguage("en")).toBe("en");
    expect(parseLanguage("es")).toBe("es");
    expect(parseLanguage("it")).toBe("es");
    expect(parseLanguage("")).toBe("es");
    expect(parseLanguage(undefined)).toBe("es");
    expect(parseLanguage(null)).toBe("es");
    expect(parseLanguage(42)).toBe("es");
  });

  it("names every turn error in both languages", () => {
    expect(turnErrorText("setup", "es")).toContain("configurada");
    expect(turnErrorText("setup", "en")).toContain("set up");
    expect(turnErrorText("timeout", "es")).toContain("agotó");
    expect(turnErrorText("timeout", "en")).toContain("ran out");
    expect(turnErrorText("lost", "es")).toContain("conexión");
    expect(turnErrorText("lost", "en")).toContain("dropped");
    expect(turnErrorText("model", "es")).toContain("Perdón");
    expect(turnErrorText("model", "en")).toContain("Sorry");
    expect(turnErrorText("vad-tap", "es")).toContain("Toca y habla");
    expect(turnErrorText("vad-tap", "en")).toContain("Tap and speak");
    expect(turnErrorText("vad-continue", "es")).toContain("te escucho");
    expect(turnErrorText("vad-continue", "en")).toContain("listening");
  });

  it("keeps Spanish when the caller passes nothing", () => {
    expect(turnErrorText("lost")).toBe(turnErrorText("lost", "es"));
  });
});
