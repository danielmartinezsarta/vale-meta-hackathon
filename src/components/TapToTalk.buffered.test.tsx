import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

function sseWithInterim(final: string, reply: string) {
  const raw =
    `event: interim\ndata: {"transcript":${JSON.stringify(final.slice(0, 5))}}\n\n` +
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buffered turn upload (Safari iOS has no streaming request body)", () => {
  it("posts one Blob/Uint8Array body without duplex, interim still renders", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    // No real sockets in tests: Node's WebSocket would dial localhost:3000,
    // so hide it and force the buffered-POST fallback path under test.
    vi.stubGlobal("WebSocket", undefined);

    // One speech burst on the first capture only; later turns stay silent.
    let fired = false;
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      if (fired) return { stop: () => {}, state: () => "running" };
      fired = true;
      const frame = new Int16Array(960).fill(4000);
      window.setTimeout(() => {
        callbacks.onFrame(frame);
        callbacks.onSpeechStart();
        for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
        callbacks.onSpeechEnd();
      }, 0);
      return { stop: () => {}, state: () => "running" };
    });

    const fetchMock = vi.fn((..._args: unknown[]) => {
      if (fetchMock.mock.calls.length > 1) return new Promise(() => {}); // second turn hangs
      return Promise.resolve({ ok: true, body: sseWithInterim("hello refill", "Booked in.") });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await waitFor(() => {
      expect(screen.getByText("hello refill")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("Booked in.")).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(
      options.body instanceof Blob || options.body instanceof Uint8Array,
    ).toBe(true);
    expect(options.body instanceof ReadableStream).toBe(false);
    // No streaming-upload flag: Safari iOS rejects `duplex: "half"`.
    expect(options).not.toHaveProperty("duplex");

    // Interim is replaced by the final.
    expect(screen.queryByText("hello")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });
});
