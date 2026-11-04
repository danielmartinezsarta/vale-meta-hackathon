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

function stubGetUserMedia() {
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => stream },
  });
  stubVoiceSocket();
}

function burst(callbacks: CaptureCallbacks) {
  const frame = new Int16Array(960).fill(4000);
  callbacks.onFrame(frame);
  callbacks.onSpeechStart();
  for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
  callbacks.onSpeechEnd();
}

function answerTurn(transcript: string, reply: string) {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({
    type: "transcript",
    transcript: transcript.slice(0, 5),
    final: false,
  });
  ws.serverMessage({ type: "transcript", transcript, final: true });
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

describe("turn bubbles (fake-device fallback, no real mic)", () => {
  it("speaking twice yields two transcript bubbles and two replies slots", async () => {
    stubGetUserMedia();

    const seen: CaptureCallbacks[] = [];
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });

    const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(seen.length).toBe(1);
    });

    burst(seen[0]);
    await waitFor(() => {
      expect(endStreamCount()).toBeGreaterThanOrEqual(1);
    });
    answerTurn("first final", "first reply from Vale");
    await waitFor(() => {
      expect(screen.getByText("first final")).toBeTruthy();
    });

    burst(seen[0]);
    await waitFor(() => {
      expect(endStreamCount()).toBeGreaterThanOrEqual(2);
    });
    answerTurn("second final", "second reply from Vale");
    await waitFor(() => {
      expect(screen.getByText("second final")).toBeTruthy();
    });

    // The awake screen shows the last 3 bubbles: Vale's first reply plus
    // the whole second turn.
    expect(screen.getAllByText("You:")).toHaveLength(1);
    expect(screen.getAllByText("Vale:")).toHaveLength(2);
    expect(screen.getByText("first reply from Vale")).toBeTruthy();
    expect(screen.getByText("second reply from Vale")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    expect(screen.queryByText("first")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Put Vale to sleep" }));
    await waitFor(() => {
      expect(screen.getByText("Asleep")).toBeTruthy();
    });
  });
});
