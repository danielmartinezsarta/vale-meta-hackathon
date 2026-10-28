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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((response) => {
    resolve = response;
  });
  return { promise, resolve };
}

function gatedTurn() {
  const replyGate = deferred<void>();
  const doneGate = deferred<void>();
  const encoder = new TextEncoder();
  const state = { step: 0 };
  const body = {
    getReader: () => ({
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        state.step += 1;
        if (state.step === 1) {
          return {
            done: false,
            value: encoder.encode(
              'event: final\ndata: {"transcript":"book a refill","audioProcessedMs":800}\n\n',
            ),
          };
        }
        if (state.step === 2) {
          await replyGate.promise;
          return {
            done: false,
            value: encoder.encode(
              'event: reply\ndata: {"text":"You are booked in."}\n\n',
            ),
          };
        }
        if (state.step === 3) {
          await doneGate.promise;
          return { done: true, value: undefined };
        }
        return { done: true, value: undefined };
      },
      releaseLock: () => {},
    }),
  };
  return { body, replyGate, doneGate };
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
    const turn = gatedTurn();
    const fetchMock = vi.fn(() => {
      if (fetchMock.mock.calls.length > 1) {
        return new Promise(() => {}); // later turns hang: session waits
      }
      return Promise.resolve({ ok: true, body: turn.body });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);

    // Final lands, reply still on its way: nothing to dismiss yet.
    await waitFor(() => {
      expect(screen.getByText("book a refill")).toBeTruthy();
    });
    expect(screen.queryByText("You are booked in.")).toBeNull();

    // The reply arrives and is displayed while the turn stays open.
    turn.replyGate.resolve();
    await screen.findByText("You are booked in.");

    // The user speaks over the displayed reply: it goes away fast.
    const started = performance.now();
    seen[0].onSpeechStart();
    await waitFor(() => {
      expect(screen.queryByText("You are booked in.")).toBeNull();
    });
    expect(performance.now() - started).toBeLessThan(300);

    // The transcript bubble survives the interruption.
    expect(screen.getByText("book a refill")).toBeTruthy();

    turn.doneGate.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  });
});
