import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { VoiceControls } from "./VoiceControls";

afterEach(() => {
  cleanup();
});

describe("TapToTalk smoke", () => {
  it("renders the awake screen and starts the mic with no prompt", async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<TapToTalk autoStart />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(4);
    expect(
      screen.getByRole("button", { name: "Mute Vale" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Mute microphone" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Put Vale to sleep" }),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    vi.unstubAllGlobals();
  });

  it("shows voice controls instead of a language switch", () => {
    render(<VoiceControls />);

    expect(screen.queryByRole("button", { name: "ES" })).toBeNull();
    expect(screen.queryByRole("button", { name: "EN" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Voice" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Speed" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Pitch" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Test" })).toBeDefined();
  });
});
