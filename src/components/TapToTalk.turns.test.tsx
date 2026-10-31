import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

function stubGetUserMedia() {
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => stream },
  });
  // No real sockets in tests: Node's WebSocket would dial localhost:3000,
  // so hide it and force the buffered-POST fallback path under test.
  vi.stubGlobal("WebSocket", undefined);
}

function sseBody(transcript: string, reply: string): { getReader: () => {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock: () => void;
} } {
  const encoder = new TextEncoder();
  const raw =
    `event: interim\ndata: {"transcript":"${transcript.slice(0, 5)}"}\n\n` +
    `event: final\ndata: {"transcript":"${transcript}","audioProcessedMs":800}\n\n` +
    `event: reply\ndata: {"text":${JSON.stringify(reply)}}\n\n` +
    "event: done\ndata: {}\n\n";
  const bytes = encoder.encode(raw);
  const first = bytes.slice(0, 13);
  const rest = bytes.slice(13);
  let step = 0;
  return {
    getReader: () => ({
      read: async () => {
        step += 1;
        if (step === 1) return { done: false, value: first };
        if (step === 2) return { done: false, value: rest };
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

describe("turn bubbles (fake-device fallback, no real mic)", () => {
  it("speaking twice yields two transcript bubbles and two replies slots", async () => {
    stubGetUserMedia();

    // Three bursts: two turns plus a third whose fetch hangs.
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      const frame = new Int16Array(960).fill(4000);
      let fired = 0;
      const fireNext = () => {
        if (fired >= 3) return;
        fired += 1;
        callbacks.onFrame(frame);
        callbacks.onSpeechStart();
        for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
        callbacks.onSpeechEnd();
        window.setTimeout(fireNext, 10);
      };
      window.setTimeout(fireNext, 0);
      return { stop: () => {}, state: () => "running" };
    });

    const turns: [string, string][] = [
      ["first final", "first reply from Vale"],
      ["second final", "second reply from Vale"],
    ];
    const fetchMock = vi.fn((..._args: unknown[]) => {
      const call = fetchMock.mock.calls.length;
      if (call > 2) return new Promise(() => {}); // third turn hangs: session waits
      const [transcript, reply] = turns[call - 1];
      return Promise.resolve({
        ok: true,
        body: sseBody(transcript, reply),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await waitFor(() => {
      expect(screen.getByText("first final")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("second final")).toBeTruthy();
    });

    expect(screen.getAllByText("You:")).toHaveLength(2);
    expect(screen.getAllByText("Vale:")).toHaveLength(2);
    expect(screen.getByText("first reply from Vale")).toBeTruthy();
    expect(screen.getByText("second reply from Vale")).toBeTruthy();

    expect(screen.queryByText("first")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });
});
