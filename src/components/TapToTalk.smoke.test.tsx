import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";

afterEach(() => {
  cleanup();
});

describe("TapToTalk smoke", () => {
  it("renders the tap target and the voice switch with no mic prompt", () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<TapToTalk />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
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

  it("shows voice controls instead of a language switch", () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<TapToTalk />);

    expect(screen.queryByRole("button", { name: "ES" })).toBeNull();
    expect(screen.queryByRole("button", { name: "EN" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Voice" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Speed" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Pitch" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Test" })).toBeDefined();

    vi.unstubAllGlobals();
  });
});
