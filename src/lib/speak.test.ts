import { describe, expect, it } from "vitest";
import { speak } from "./speak";

describe("speak stub", () => {
  it("accepts a string and returns without error or audio", () => {
    expect(() => speak("hello")).not.toThrow();
    expect(speak("hello")).toBeUndefined();
  });
});
