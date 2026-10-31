import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

interface CaptureDriver {
  onFrame: (frame: Int16Array) => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

let driver: CaptureDriver | null = null;

function stubSessionOnce() {
  driver = null;
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    if (!driver) {
      driver = {
        onFrame: callbacks.onFrame,
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
      };
    }
    return { stop: () => {} };
  });
}

function voiceFrame(): Int16Array {
  return new Int16Array(960).fill(4000);
}

function silentFrame(): Int16Array {
  return new Int16Array(960).fill(0);
}

function sseVadNotice() {
  const raw =
    `event: notice\ndata: {"message":"No te escuché. Habla y te escucho.","code":"E-VAD"}\n\n` +
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

const LISTENING_HINT = "Tu micrófono está encendido. Adelante, te escucho.";
const VAD_BANNER_TEXT = "No te escuché.";

function vadBanner(): HTMLElement | null {
  const status = screen.queryByRole("status");
  return status && status.textContent?.includes(VAD_BANNER_TEXT)
    ? status
    : null;
}

afterEach(() => {
  cleanup();
  driver = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("silence-aware E-VAD banner (fix 3)", () => {
  it("stays quiet with voice or single silence, shows only on repeated silence", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    // No real sockets in tests: Node's WebSocket would dial localhost:3000,
    // so hide it and force the buffered-POST fallback path under test.
    vi.stubGlobal("WebSocket", undefined);
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, body: sseVadNotice() }),
    );
    vi.stubGlobal("fetch", fetchMock);
    stubSessionOnce();

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });

    const speak = (frame: Int16Array) => {
      driver!.onFrame(frame);
      driver!.onSpeechStart();
      driver!.onFrame(frame);
      driver!.onSpeechEnd();
    };

    speak(voiceFrame());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText(LISTENING_HINT)).toBeTruthy();
    });
    expect(vadBanner()).toBeNull();

    speak(silentFrame());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(LISTENING_HINT)).toBeTruthy();
    });
    expect(vadBanner()).toBeNull();

    speak(silentFrame());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(vadBanner()).not.toBeNull();
    });
    expect(vadBanner()?.textContent).toContain("No te escuché");
    expect(vadBanner()?.textContent).not.toContain("E-VAD");

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });
});
