import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
import { startCapture } from "@/lib/capture";
import type { CaptureCallbacks } from "@/lib/capture";
import { stopSpeaking } from "@/lib/speak";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(() => ({ stop: () => {} })),
}));

vi.mock("@/lib/speak", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speak")>();
  return {
    ...actual,
    stopSpeaking: vi.fn(),
    // Strict turns: the mock voice never reports its end through the
    // estimate, so the suite drives settled-ness directly.
    speechSettled: vi.fn(() => !speakAudibleRef.current),
  };
});

const mockStartCapture = vi.mocked(startCapture);
const mockStopSpeaking = vi.mocked(stopSpeaking);
/** Audibility the real (headless, silent) synth cannot report. */
const speakAudibleRef = { current: false };

function burst(callbacks: CaptureCallbacks) {
  const frame = new Int16Array(960).fill(4000);
  callbacks.onFrame(frame);
  callbacks.onSpeechStart();
  for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
  callbacks.onSpeechEnd();
}

function noAudioPost() {
  const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function liveSocket() {
  return FakeVoiceSocket.instances[0];
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("interruption (fake-device fallback)", () => {
  it("keeps a shown reply when speech starts: no dismiss, no cut", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () =>
          ({ getTracks: () => [] }) as unknown as MediaStream,
      },
    });
    // No real sockets in tests: Node's WebSocket would dial localhost:3000,
    // so hide it and force the buffered-POST fallback path under test.
    stubVoiceSocket();
    const seen: CaptureCallbacks[] = [];
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });
    const fetchMock = noAudioPost();

    render(<TapToTalk debug />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);
    liveSocket().serverMessage({
      type: "transcript",
      transcript: "book a refill",
      final: true,
    });

    await waitFor(() => {
      expect(screen.getByText("book a refill")).toBeTruthy();
    });
    expect(screen.queryByText("You are booked in.")).toBeNull();

    liveSocket().serverMessage({ type: "reply", text: "You are booked in." });
    await screen.findByText("You are booked in.");

    // Strict turns: speech while she speaks changes nothing on screen.
    // Past the old ~300 ms dismiss window the reply still stands and her
    // voice is never cut.
    speakAudibleRef.current = true;
    seen[0].onSpeechStart();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.getByText("You are booked in.")).toBeDefined();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    expect(screen.getByText("book a refill")).toBeTruthy();

    speakAudibleRef.current = false;
    liveSocket().serverMessage({ type: "done" });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  });

  it("holds the open turn while muted: no quiet churn, no vad notice", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: async () =>
            ({ getTracks: () => [] }) as unknown as MediaStream,
        },
      });
      stubVoiceSocket();
      const seen: CaptureCallbacks[] = [];
      mockStartCapture.mockImplementation((_stream, callbacks) => {
        seen.push(callbacks);
        return { stop: () => {}, state: () => "running", engine: () => "script" as const };
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      render(<TapToTalk debug />);
      fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
      // The /voice gate polls every 50 ms: advance past one poll.
      await vi.advanceTimersByTimeAsync(100);
      expect(seen.length).toBeGreaterThan(0);
      // Her voice: the watch mutes within one tick and stays muted.
      speakAudibleRef.current = true;
      await vi.advanceTimersByTimeAsync(300);
      // Two full quiet windows with the VAD frozen: the turn never churns,
      // so the two-strike silence banner never shows and she is never cut.
      await vi.advanceTimersByTimeAsync(20000);
      expect(
        screen.queryByText("I didn't hear you. Speak, I'm listening."),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Stop" }),
      ).toBeTruthy();
      expect(mockStopSpeaking).not.toHaveBeenCalled();
    } finally {
      speakAudibleRef.current = false;
      vi.useRealTimers();
    }
  });
});
