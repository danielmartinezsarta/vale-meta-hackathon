import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";
import type { CaptureCallbacks } from "@/lib/capture";
import { stopSpeaking } from "@/lib/speak";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(() => ({ stop: () => {} })),
}));

vi.mock("@/lib/speak", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speak")>();
  return {
    ...actual,
    stopSpeaking: vi.fn(),
    // Strict turns: the mock voice never reports its end through the
    // estimate, so the suite drives settled-ness directly.
    speechSettled: vi.fn(() => !speakAudibleRef.current),
  };
});

const mockStartCapture = vi.mocked(startCapture);
const mockStopSpeaking = vi.mocked(stopSpeaking);
/** Audibility the real (headless, silent) synth cannot report. */
const speakAudibleRef = { current: false };

function burst(callbacks: CaptureCallbacks) {
  const frame = new Int16Array(960).fill(4000);
  callbacks.onFrame(frame);
  callbacks.onSpeechStart();
  for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
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
  it("keeps a shown reply when speech starts: no dismiss, no cut", async () => {
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
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return { stop: () => {}, state: () => "running" };
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

    await waitFor(() => {
      expect(screen.getByText("book a refill")).toBeTruthy();
    });
    expect(screen.queryByText("You are booked in.")).toBeNull();

    turn.replyGate.resolve();
    await screen.findByText("You are booked in.");

    // Strict turns: speech while she speaks changes nothing on screen.
    // Past the old ~300 ms dismiss window the reply still stands and her
    // voice is never cut.
    speakAudibleRef.current = true;
    seen[0].onSpeechStart();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.getByText("You are booked in.")).toBeDefined();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    expect(screen.getByText("book a refill")).toBeTruthy();

    speakAudibleRef.current = false;
    turn.doneGate.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  });
});
