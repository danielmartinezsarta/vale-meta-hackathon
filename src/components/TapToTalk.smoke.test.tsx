import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";

describe("TapToTalk smoke", () => {
  it("renders the tap target and the voice switch with no mic prompt", () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<TapToTalk />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Tap to talk" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Use Seamless voice" }),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
