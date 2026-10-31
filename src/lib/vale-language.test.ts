import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  parseLanguage,
  turnErrorText,
} from "./vale-language";

describe("closed language set", () => {
  it("defaults to English and keeps only es or en", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
    expect(parseLanguage("en")).toBe("en");
    expect(parseLanguage("es")).toBe("es");
    expect(parseLanguage("it")).toBe("en");
    expect(parseLanguage("")).toBe("en");
    expect(parseLanguage(undefined)).toBe("en");
    expect(parseLanguage(null)).toBe("en");
    expect(parseLanguage(42)).toBe("en");
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

  it("keeps English when the caller passes nothing", () => {
    expect(turnErrorText("lost")).toBe(turnErrorText("lost", "en"));
  });
});
