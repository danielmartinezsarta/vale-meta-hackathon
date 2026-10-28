import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";
import type { CaptureCallbacks } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(() => ({ stop: () => {} })),
}));

const mockStartCapture = vi.mocked(startCapture);

function burst(callbacks: CaptureCallbacks) {
  const frame = new Int16Array(960).fill(4000);
  callbacks.onFrame(frame);
  callbacks.onSpeechStart();
  callbacks.onFrame(frame);
  callbacks.onSpeechEnd();
}

function sseTurn(): { getReader: () => {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock: () => void;
} } {
  const raw =
    'event: final\ndata: {"transcript":"book a refill","audioProcessedMs":800}\n\n' +
    'event: reply\ndata: {"text":"You are booked in."}\n\n' +
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

describe("interruption (fake-device fallback)", () => {
  it("dismisses a shown reply within ~300ms when speech starts", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () =>
          ({ getTracks: () => [] }) as unknown as MediaStream,
      },
    });
    const seen: CaptureCallbacks[] = [];
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return { stop: () => {} };
    });
    const fetchMock = vi.fn(() => {
      if (fetchMock.mock.calls.length > 1) {
        return new Promise(() => {}); // later turns hang: session waits
      }
      return Promise.resolve({
        ok: true,
        body: sseTurn(),
      } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);

    const reply = await screen.findByText("You are booked in.");
    expect(reply).toBeTruthy();

    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(1);
    });
    const started = performance.now();
    burst(seen[1]);
    await waitFor(() => {
      expect(screen.queryByText("You are booked in.")).toBeNull();
    });
    expect(performance.now() - started).toBeLessThan(300);

    // The transcript bubble survives the interruption.
    expect(screen.getByText("book a refill")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  });
});
