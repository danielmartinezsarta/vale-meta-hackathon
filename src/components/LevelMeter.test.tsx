import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LevelMeter } from "./LevelMeter";

afterEach(() => {
  cleanup();
});

describe("LevelMeter (instant listening feedback)", () => {
  it("reports the level through accessible meter semantics", () => {
    const { rerender } = render(<LevelMeter level={0} />);
    const meter = screen.getByRole("meter", { name: "Microphone level" });
    expect(meter.getAttribute("aria-valuenow")).toBe("0");

    rerender(<LevelMeter level={0.5} />);
    expect(
      screen.getByRole("meter", { name: "Microphone level" }).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("50");
  });

  it("clamps out-of-range levels and stays flat (no glow or gradient)", () => {
    render(<LevelMeter level={2} />);
    const meter = screen.getByRole("meter", { name: "Microphone level" });
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
    expect(meter.innerHTML).not.toMatch(/gradient|glow|shadow|animate/i);
  });
});
