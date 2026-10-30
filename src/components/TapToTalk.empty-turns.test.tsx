import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

function stubMic() {
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  // No real sockets in tests: Node's WebSocket would dial localhost:3000,
  // so hide it and force the buffered-POST fallback path under test.
  vi.stubGlobal("WebSocket", undefined);
}

function sseEmptyTurn() {
  const raw =
    `event: final\ndata: {"transcript":"","audioProcessedMs":800}\n\n` +
    "event: done\ndata: {}\n\n";
  const bytes = new TextEncoder().encode(raw);
  let served = false;
  return {
    getReader: () => ({
      read: async () => {
        if (!served) {
          served = true;
          return { done: false, value: bytes };
        }
        return { done: true, value: undefined };
      },
      releaseLock: () => {},
    }),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("empty turns stay hidden (fix 1)", () => {
  it("an empty open turn draws no row and keeps the listening hint", async () => {
    stubMic();

    mockStartCapture.mockImplementation(() => ({ stop: () => {} }));
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await waitFor(() => {
      expect(
        screen.getByText("Tu micrófono está encendido. Adelante, te escucho."),
      ).toBeTruthy();
    });

    expect(
      screen.getByLabelText("Conversation turns").querySelectorAll("li"),
    ).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });

  it("a closed turn that never showed anything is pruned", async () => {
    stubMic();

    // Later turns stay silent so the session waits.
    let fired = false;
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      if (fired) return { stop: () => {} };
      fired = true;
      const frame = new Int16Array(960).fill(4000);
      window.setTimeout(() => {
        callbacks.onFrame(frame);
        callbacks.onSpeechStart();
        callbacks.onFrame(frame);
        callbacks.onSpeechEnd();
      }, 0);
      return { stop: () => {} };
    });

    const fetchMock = vi.fn((..._args: unknown[]) => {
      if (fetchMock.mock.calls.length > 1) return new Promise(() => {});
      return Promise.resolve({ ok: true, body: sseEmptyTurn() });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        screen.getByText("Tu micrófono está encendido. Adelante, te escucho."),
      ).toBeTruthy();
    });
    expect(
      screen.getByLabelText("Conversation turns").querySelectorAll("li"),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });
});
