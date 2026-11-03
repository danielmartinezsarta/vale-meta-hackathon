import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
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
function answerIgnoredNotice() {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({
    type: "notice",
    message: "I didn't hear you. Speak, I'm listening.",
    code: "E-VAD",
  });
  ws.serverMessage({ type: "done" });
}

function answerReply(text: string) {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({ type: "reply", text });
  ws.serverMessage({ type: "done" });
}

function answerIgnoredTurn(transcript: string) {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({ type: "transcript", transcript, final: true });
  ws.serverMessage({ type: "ignored" });
  ws.serverMessage({ type: "done" });
}

async function waitForEndStream(count: number) {
  await waitFor(() => {
    const ends = FakeVoiceSocket.instances[0]
      .sentStrings()
      .filter((raw) => raw.includes("endStream")).length;
    expect(ends).toBeGreaterThanOrEqual(count);
  });
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
      stubVoiceSocket();
      const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
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
      await waitForEndStream(1);
      answerIgnoredTurn("background chat here");
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
    stubVoiceSocket();
    const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
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

    // A voiced turn rides the socket and answers as usual.
    speak(voiceFrame());
    await waitForEndStream(1);
    answerReply("Done.");
    // Settled back to listening with the reply bubble standing.
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Listening");
    });
    expect(vadBanner()).toBeNull();

    // Silent blips never leave the device: no socket traffic, no banner.
    blip();
    blip();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Listening");
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vadBanner()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // The next voiced turn still rides on a fresh turn.
    speak(voiceFrame());
    await waitForEndStream(2);
    answerIgnoredNotice();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Listening");
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });
});
