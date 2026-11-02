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
    return { stop: () => {}, state: () => "running", engine: () => "script" as const };
  });
}

function voiceFrame(): Int16Array {
  return new Int16Array(960).fill(4000);
}

function silentFrame(): Int16Array {
  return new Int16Array(960).fill(0);
}

// The server no longer sends E-VAD notices; feeding one proves the client
// ignores it instead of showing a banner.
function sseIgnoredNotice() {
  const raw =
    `event: notice\ndata: {"message":"I didn't hear you. Speak, I'm listening.","code":"E-VAD"}\n\n` +
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

function sseReply(text: string) {
  const raw =
    `event: reply\ndata: {"text":${JSON.stringify(text)}}\n\n` +
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

const LISTENING_HINT = "Your microphone is on. Go ahead, I'm listening.";
const VAD_BANNER_TEXT = "didn't hear you";

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

describe("silence never banners (vad-continue removed)", () => {
  it("a discarded turn never seeds the silence banner", async () => {
    vi.stubEnv("NEXT_PUBLIC_QUIET_WINDOW_MS", "100");
    try {
      vi.stubGlobal("navigator", {
        mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
      });
      vi.stubGlobal("WebSocket", undefined);
      const ignoredBody = () => {
        const bytes = new TextEncoder().encode(
          `event: interim\ndata: {"transcript":"background"}\n\n` +
            `event: final\ndata: {"transcript":"background chat here","audioProcessedMs":800}\n\n` +
            `event: ignored\ndata: {}\n\n` +
            `event: done\ndata: {}\n\n`,
        );
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
      };
      const fetchMock = vi.fn(() =>
        Promise.resolve({ ok: true, body: ignoredBody() })
      );
      vi.stubGlobal("fetch", fetchMock);
      stubSessionOnce();

      render(<TapToTalk debug />);
      fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
      await waitFor(() => {
        expect(driver).not.toBeNull();
      });

      // One silent window: the streak sits at 1.
      await new Promise((resolve) => setTimeout(resolve, 150));
      // A heard-but-discarded turn: voice frames in, server ignores it.
      driver!.onFrame(voiceFrame());
      driver!.onSpeechStart();
      for (let i = 0; i < 8; i += 1) driver!.onFrame(voiceFrame());
      driver!.onSpeechEnd();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      // Let the done event re-arm the window before measuring it.
      await new Promise((resolve) => setTimeout(resolve, 40));
      // One more silent window: the discard reset the streak, so no banner.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(vadBanner()).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("drops silent blips locally: no post, no banner, session alive", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    // No real sockets in tests: Node's WebSocket would dial localhost:3000,
    // so hide it and force the buffered-POST fallback path under test.
    vi.stubGlobal("WebSocket", undefined);
    // First posted turn gets a reply, later ones the E-VAD notice.
    const bodies = [sseReply("Done."), sseIgnoredNotice(), sseIgnoredNotice()];
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        body: bodies[Math.min(fetchMock.mock.calls.length, 2)],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    stubSessionOnce();

    render(<TapToTalk debug />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });

    const speak = (frame: Int16Array) => {
      driver!.onFrame(frame);
      driver!.onSpeechStart();
      for (let i = 0; i < 8; i += 1) driver!.onFrame(frame);
      driver!.onSpeechEnd();
    };
    const blip = () => {
      driver!.onSpeechStart();
      driver!.onFrame(silentFrame());
      driver!.onFrame(silentFrame());
      driver!.onSpeechEnd();
    };

    // A voiced turn posts and answers as usual.
    speak(voiceFrame());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText(LISTENING_HINT)).toBeTruthy();
    });
    expect(vadBanner()).toBeNull();

    // Silent blips never leave the device: no post, no banner, no alert.
    blip();
    blip();
    await waitFor(() => {
      expect(screen.getByText(LISTENING_HINT)).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vadBanner()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // The next voiced turn still posts on a fresh turn.
    speak(voiceFrame());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(LISTENING_HINT)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });
});
