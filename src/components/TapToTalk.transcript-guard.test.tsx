import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function stubSession() {
  driver = null;
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    driver = {
      onFrame: callbacks.onFrame,
      onSpeechStart: callbacks.onSpeechStart,
      onSpeechEnd: callbacks.onSpeechEnd,
    };
    return { stop: () => {}, state: () => "running", engine: () => "script" as const };
  });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  stubVoiceSocket();
}

function answerTurn(final: string, reply: string) {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({ type: "transcript", transcript: final.slice(0, 5), final: false });
  ws.serverMessage({ type: "transcript", transcript: final, final: true });
  ws.serverMessage({ type: "reply", text: reply });
  ws.serverMessage({ type: "done" });
}

function answerEmptyTurn() {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({ type: "transcript", transcript: "", final: true });
  ws.serverMessage({ type: "done" });
}

function burst() {
  const frame = new Int16Array(960).fill(4000);
  driver?.onFrame(frame);
  driver?.onSpeechStart();
  for (let i = 0; i < 8; i += 1) driver?.onFrame(frame);
  driver?.onSpeechEnd();
}

async function tap() {
  render(<TapToTalk autoStart />);
  await vi.advanceTimersByTimeAsync(300);
}

/** Flush the fetch -> SSE -> patchTurn microtask chain after a burst. */
async function flush() {
  await vi.advanceTimersByTimeAsync(500);
}

afterEach(() => {
  cleanup();
  driver = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("transcript guard: an empty turn never deletes a bubble", () => {
  it("a completed turn survives the quiet timeout", async () => {
    vi.useFakeTimers();
    stubSession();
    const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await tap();
    burst();
    answerTurn("Vale, agenda lista", "Listo, Daniel.");
    await flush();
    expect(screen.getByText("Vale, agenda lista")).toBeTruthy();
    expect(screen.getByText("Listo, Daniel.")).toBeTruthy();

    // Eight silent seconds: the quiet timeout must not eat the bubble.
    await vi.advanceTimersByTimeAsync(8500);
    expect(screen.getByText("Vale, agenda lista")).toBeTruthy();
    expect(screen.getByText("Listo, Daniel.")).toBeTruthy();
    expect(
      screen.getByLabelText("Conversation").querySelectorAll("li"),
    ).toHaveLength(2);
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });

  it("N empty turns after text leave the list intact", async () => {
    vi.useFakeTimers();
    stubSession();
    const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await tap();
    burst();
    answerTurn("Vale, agenda lista", "Listo, Daniel.");
    await flush();
    expect(screen.getByText("Vale, agenda lista")).toBeTruthy();

    // Idle past the quiet timeout, then three noise turns (ES 23:03:30Z
    // shape): none of them may touch the existing bubble, and none draws.
    await vi.advanceTimersByTimeAsync(8500);
    burst();
    answerEmptyTurn();
    await flush();
    burst();
    answerEmptyTurn();
    await flush();
    burst();
    answerEmptyTurn();
    await flush();

    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
    expect(screen.getByText("Vale, agenda lista")).toBeTruthy();
    expect(screen.getByText("Listo, Daniel.")).toBeTruthy();
    expect(
      screen.getByLabelText("Conversation").querySelectorAll("li"),
    ).toHaveLength(2);
  });
});
