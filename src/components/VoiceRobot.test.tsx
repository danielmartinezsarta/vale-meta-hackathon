// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { VoiceRobot } from "./VoiceRobot";

function smileTransform(state: "idle" | "listening" | "thinking" | "speaking" | "done" | "error"): string | null {
  const { container } = render(<VoiceRobot state={state} />);
  // The mouth group carries the per-state scale; the error state swaps the
  // path itself for a frown.
  const smile = container.querySelector('path[d^="M112"]');
  return smile?.closest("g")?.getAttribute("transform") ?? null;
}

describe("robot face", () => {
  it("draws a distinct mouth per state", () => {
    const idle = smileTransform("idle");
    const listening = smileTransform("listening");
    const thinking = smileTransform("thinking");
    expect(idle).toContain("scale(1.000 1.000)");
    expect(listening).toContain("scale(0.900 0.800)");
    expect(thinking).toContain("scale(0.800 0.500)");
    expect(new Set([idle, listening, thinking]).size).toBe(3);
  });

  it("frowns on error", () => {
    const { container } = render(<VoiceRobot state="error" />);
    const smile = container.querySelector('path[d^="M112"]');
    expect(smile?.getAttribute("d")).toContain("130 A8 8 0 0 1 128 130");
  });
});
