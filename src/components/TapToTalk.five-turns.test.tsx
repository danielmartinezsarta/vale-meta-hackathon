import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";

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

    // Fake device: one capture for the whole session fires one burst per
    // turn on the same callbacks (six bursts: five turns plus a sixth
    // whose fetch hangs, so the session stays open).
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      const frame = new Int16Array(960).fill(4000);
      let fired = 0;
      const fireNext = () => {
        if (fired >= 6) return;
        fired += 1;
        callbacks.onFrame(frame);
        callbacks.onSpeechStart();
        callbacks.onFrame(frame);
        callbacks.onSpeechEnd();
        window.setTimeout(fireNext, 10);
      };
      window.setTimeout(fireNext, 0);
      return { stop: () => {} };
    });

    const script: [string, string][] = [
      ["hi Vale", "Hello, how can I help."],
      ["book a refill", "Checking your slots now."],
      ["tomorrow morning", "Morning is open at ten."],
      ["perfect", "You are booked in."],
      ["thanks bye", "See you soon."],
    ];
    const fetchMock = vi.fn(() => {
      const call = fetchMock.mock.calls.length;
      if (call > script.length) {
        return new Promise(() => {}); // sixth turn waits: session stays open
      }
      const [final, reply] = script[call - 1];
      return Promise.resolve({ ok: true, body: sseTurn(final, reply) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk />);
    // Exactly one tap for the whole conversation.
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    for (const [final, reply] of script) {
      await waitFor(() => {
        expect(screen.getByText(final)).toBeTruthy();
      });
      await waitFor(() => {
        expect(screen.getByText(reply)).toBeTruthy();
      });
    }

    // Five transcript bubbles and five Vale replies, all in one session.
    expect(screen.getAllByText("You:")).toHaveLength(5);
    expect(screen.getAllByText("Vale:")).toHaveLength(5);
    // The sixth burst posts a sixth turn whose fetch hangs: the session
    // stays open on the same capture. Wait for the post (burst cadence
    // is independent of reply rendering).
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });
});
