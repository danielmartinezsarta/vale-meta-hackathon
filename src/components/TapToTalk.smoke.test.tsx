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
    expect(buttons).toHaveLength(4);
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

  it("marks the selected language with a visible active state", () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<TapToTalk />);

    const es = screen.getByRole("button", { name: "ES" });
    const en = screen.getByRole("button", { name: "EN" });
    expect(es.getAttribute("aria-pressed")).toBe("true");
    expect(es.style.fontWeight).toBe("bold");
    expect(en.getAttribute("aria-pressed")).toBe("false");
    expect(en.style.fontWeight).not.toBe("bold");

    fireEvent.click(en);
    expect(en.getAttribute("aria-pressed")).toBe("true");
    expect(en.style.fontWeight).toBe("bold");
    expect(es.getAttribute("aria-pressed")).toBe("false");
    expect(es.style.fontWeight).not.toBe("bold");

    vi.unstubAllGlobals();
  });
});
