import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
import { startCapture } from "@/lib/capture";
import type { CaptureCallbacks } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

function burst(callbacks: CaptureCallbacks) {
  const frame = new Int16Array(960).fill(4000);
  callbacks.onFrame(frame);
  callbacks.onSpeechStart();
  for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
  callbacks.onSpeechEnd();
}

function answerTurn(final: string, reply: string) {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({ type: "transcript", transcript: final, final: true });
  ws.serverMessage({ type: "reply", text: reply });
  ws.serverMessage({ type: "done" });
}

function endStreamCount() {
  return FakeVoiceSocket.instances[0]
    .sentStrings()
    .filter((raw) => raw.includes("endStream")).length;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("five-turn hands-free conversation (fake-device fallback, B2)", () => {
  it("holds five turns with five replies in one session, one tap, no keyboard", async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
    });
    stubVoiceSocket();

    const seen: CaptureCallbacks[] = [];
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });

    const script: [string, string][] = [
      ["hi Vale", "Hello, how can I help."],
      ["book a refill", "Checking your slots now."],
      ["tomorrow morning", "Morning is open at ten."],
      ["perfect", "You are booked in."],
      ["thanks bye", "See you soon."],
    ];
    const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk debug />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(seen.length).toBe(1);
    });

    let n = 0;
    for (const [final, reply] of script) {
      burst(seen[0]);
      n += 1;
      await waitFor(() => {
        expect(endStreamCount()).toBeGreaterThanOrEqual(n);
      });
      answerTurn(final, reply);
      await waitFor(() => {
        expect(screen.getByText(final)).toBeTruthy();
      });
      await waitFor(() => {
        expect(screen.getByText(reply)).toBeTruthy();
      });
    }
    // Sixth burst with no answer: the session stays open, nothing posted.
    burst(seen[0]);

    expect(screen.getAllByText("You:")).toHaveLength(5);
    expect(screen.getAllByText("Vale:")).toHaveLength(5);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });
});
