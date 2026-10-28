import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";

vi.mock("@/lib/capture", () => ({
  // jsdom has no AudioContext.
  startCapture: vi.fn(() => ({ stop: () => {} })),
}));

function stubGetUserMedia(impl: (...args: never[]) => unknown) {
  const getUserMedia = vi.fn(impl);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return getUserMedia;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("microphone permission", () => {
  it("requests the mic only after the first tap and goes live when granted", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = stubGetUserMedia(async () => stream);

    render(<TapToTalk />);
    expect(getUserMedia).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(
      await screen.findByText(/microphone is on/i),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows how to re-enable the mic when denied, with no prompt loop", async () => {
    const denied = new DOMException("denied", "NotAllowedError");
    const getUserMedia = stubGetUserMedia(async () => {
      throw denied;
    });

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/microphone is blocked/i);
    expect(alert.textContent).toMatch(/iPhone.*Safari/i);
    expect(alert.textContent).toMatch(/Chrome/i);
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // Tapping again retries once more, still no loop.
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("shows a plain error when no microphone is available", async () => {
    const missing = new DOMException("no device", "NotFoundError");
    stubGetUserMedia(async () => {
      throw missing;
    });

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/something went wrong/i);
    expect(alert.textContent).not.toMatch(/NotFoundError|stack/i);
  });
});
