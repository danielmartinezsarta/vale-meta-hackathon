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

function answerTurn(final: string, reply: string) {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({ type: "transcript", transcript: final, final: true });
  ws.serverMessage({ type: "reply", text: reply });
  ws.serverMessage({ type: "done" });
}

function burst(callbacks: CaptureCallbacks) {
  const frame = new Int16Array(960).fill(4000);
  callbacks.onFrame(frame);
  callbacks.onSpeechStart();
  for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
  callbacks.onSpeechEnd();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("gapless turns on one capture (bug 2: inter-turn gap lost speech)", () => {
  it("two back-to-back bursts post two turns without restarting the mic", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () =>
          ({ getTracks: () => [] }) as unknown as MediaStream,
      },
    });
    stubVoiceSocket();
    const seen: CaptureCallbacks[] = [];
    const stopMock = vi.fn();
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return {
        stop: stopMock,
        state: () => "running",
        engine: () => "script" as const,
      };
    });

    const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk autoStart />);

    await waitFor(() => {
      expect(seen.length).toBe(1);
    });

    burst(seen[0]);
    answerTurn("first phrase here", "First reply.");
    await waitFor(() => {
      expect(screen.getByText("first phrase here")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("First reply.")).toBeTruthy();
    });

    burst(seen[0]);
    answerTurn("second phrase here", "Second reply.");
    await waitFor(() => {
      expect(screen.getByText("second phrase here")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("Second reply.")).toBeTruthy();
    });

    expect(mockStartCapture).toHaveBeenCalledTimes(1);
    expect(stopMock).not.toHaveBeenCalled();
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
    expect(screen.getAllByText("You:")).toHaveLength(1);
    expect(screen.getAllByText("Vale:")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Put Vale to sleep" }));
    await waitFor(() => {
      expect(screen.getByText("Asleep")).toBeTruthy();
    });
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
