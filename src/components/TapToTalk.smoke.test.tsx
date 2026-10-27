import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";

describe("TapToTalk smoke", () => {
  it("renders one tap target with permission context and no mic prompt", () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<TapToTalk />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Tap to talk" }),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    // No mic prompt before the first tap.
    expect(getUserMedia).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
