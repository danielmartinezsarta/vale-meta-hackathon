import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function stubSession() {
  driver = null;
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    driver = {
      onFrame: callbacks.onFrame,
      onSpeechStart: callbacks.onSpeechStart,
      onSpeechEnd: callbacks.onSpeechEnd,
    };
    return { stop: () => {}, state: () => "running" };
  });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  // No real sockets in tests: hide WebSocket to force the POST path.
  vi.stubGlobal("WebSocket", undefined);
}

function sseReader(raw: string): { getReader: () => {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock: () => void;
} } {
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

function sseTurn(final: string, reply: string): unknown {
  const raw =
    `event: interim\ndata: {"transcript":"${final.slice(0, 5)}"}\n\n` +
    `event: final\ndata: {"transcript":${JSON.stringify(final)},"audioProcessedMs":800}\n\n` +
    `event: reply\ndata: {"text":${JSON.stringify(reply)}}\n\n` +
    "event: done\ndata: {}\n\n";
  return sseReader(raw);
}

function sseEmptyTurn(): unknown {
  const raw =
    `event: final\ndata: {"transcript":"","audioProcessedMs":800}\n\n` +
    "event: done\ndata: {}\n\n";
  return sseReader(raw);
}

function burst() {
  const frame = new Int16Array(960).fill(4000);
  driver?.onFrame(frame);
  driver?.onSpeechStart();
  for (let i = 0; i < 8; i += 1) driver?.onFrame(frame);
  driver?.onSpeechEnd();
}

async function tap() {
  render(<TapToTalk />);
  fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
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
    const fetchMock = vi.fn(() => {
      if (fetchMock.mock.calls.length > 1) return new Promise(() => {});
      return Promise.resolve({ ok: true, body: sseTurn("Vale, agenda lista", "Listo, Daniel.") });
    });
    vi.stubGlobal("fetch", fetchMock);

    await tap();
    burst();
    await flush();
    expect(screen.getByText("Vale, agenda lista")).toBeTruthy();
    expect(screen.getByText("Listo, Daniel.")).toBeTruthy();

    // Eight silent seconds: the quiet timeout must not eat the bubble.
    await vi.advanceTimersByTimeAsync(8500);
    expect(screen.getByText("Vale, agenda lista")).toBeTruthy();
    expect(screen.getByText("Listo, Daniel.")).toBeTruthy();
    expect(
      screen.getByLabelText("Conversation turns").querySelectorAll("li"),
    ).toHaveLength(1);
  });

  it("N empty turns after text leave the list intact", async () => {
    vi.useFakeTimers();
    stubSession();
    const fetchMock = vi.fn(() => {
      const call = fetchMock.mock.calls.length;
      if (call === 1) {
        return Promise.resolve({ ok: true, body: sseTurn("Vale, agenda lista", "Listo, Daniel.") });
      }
      if (call <= 4) return Promise.resolve({ ok: true, body: sseEmptyTurn() });
      return new Promise(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    await tap();
    burst();
    await flush();
    expect(screen.getByText("Vale, agenda lista")).toBeTruthy();

    // Idle past the quiet timeout, then three noise turns (ES 23:03:30Z
    // shape): none of them may touch the existing bubble, and none draws.
    await vi.advanceTimersByTimeAsync(8500);
    burst();
    await flush();
    burst();
    await flush();
    burst();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByText("Vale, agenda lista")).toBeTruthy();
    expect(screen.getByText("Listo, Daniel.")).toBeTruthy();
    expect(
      screen.getByLabelText("Conversation turns").querySelectorAll("li"),
    ).toHaveLength(1);
  });
});
