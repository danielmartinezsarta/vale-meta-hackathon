import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";
import type { CaptureCallbacks } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

function sseTurn(final: string, reply: string): { getReader: () => {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock: () => void;
} } {
  const raw =
    `event: final\ndata: {"transcript":${JSON.stringify(final)},"audioProcessedMs":800}\n\n` +
    `event: reply\ndata: {"text":${JSON.stringify(reply)}}\n\n` +
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
    // No real sockets in tests: Node's WebSocket would dial localhost:3000,
    // so hide it and force the buffered-POST fallback path under test.
    vi.stubGlobal("WebSocket", undefined);
    const seen: CaptureCallbacks[] = [];
    const stopMock = vi.fn();
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return { stop: stopMock, state: () => "running" };
    });

    const fetchMock = vi.fn((..._args: unknown[]) => {
      const call = fetchMock.mock.calls.length;
      if (call === 1)
        return Promise.resolve({
          ok: true,
          body: sseTurn("first phrase here", "First reply."),
        });
      if (call === 2)
        return Promise.resolve({
          ok: true,
          body: sseTurn("second phrase here", "Second reply."),
        });
      return new Promise(() => {}); // session waits for a third turn
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await waitFor(() => {
      expect(seen.length).toBe(1);
    });

    burst(seen[0]);
    await waitFor(() => {
      expect(screen.getByText("first phrase here")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("First reply.")).toBeTruthy();
    });

    burst(seen[0]);
    await waitFor(() => {
      expect(screen.getByText("second phrase here")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("Second reply.")).toBeTruthy();
    });

    expect(mockStartCapture).toHaveBeenCalledTimes(1);
    expect(stopMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("You:")).toHaveLength(2);
    expect(screen.getAllByText("Vale:")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
