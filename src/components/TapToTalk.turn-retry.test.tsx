import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

/** Scriptable stand-in for the browser WebSocket (proposal A bridge). */
class FakeWs {
  static instances: FakeWs[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Mid-turn drop after a live connection. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  serverMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  sentStrings(): string[] {
    return this.sent.filter((item) => typeof item === "string") as string[];
  }
}

interface CaptureDriver {
  onFrame: (frame: Int16Array) => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

let driver: CaptureDriver | null = null;

function stubSessionOnce() {
  driver = null;
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    if (!driver) {
      driver = {
        onFrame: callbacks.onFrame,
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
      };
    }
    return { stop: () => {} };
  });
}

function speechFrame(): Int16Array {
  return new Int16Array(960).fill(4000);
}

// Buffered-POST answer for the retried turn: final, reply, done.
function sseRetryTurn() {
  const raw =
    `event: final\ndata: {"transcript":"second final","audioProcessedMs":800}\n\n` +
    `event: reply\ndata: {"text":"second reply from Vale"}\n\n` +
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
  FakeWs.instances = [];
  driver = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pre-final cut retries once over POST on the same turn (fix 2)", () => {
  it("cut twice before the final: the reply still arrives under its own turn", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, body: sseRetryTurn() }),
    );
    vi.stubGlobal("fetch", fetchMock);
    stubSessionOnce();

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });

    // First turn completes cleanly over the bridge.
    driver!.onFrame(speechFrame());
    driver!.onSpeechStart();
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const first = FakeWs.instances[0];
    first.open();
    driver!.onFrame(speechFrame());
    driver!.onSpeechEnd();
    first.serverMessage({
      type: "transcript",
      transcript: "first final",
      final: true,
    });
    first.serverMessage({ type: "reply", text: "first reply from Vale" });
    first.serverMessage({ type: "done" });
    await waitFor(() => {
      expect(screen.getByText("first reply from Vale")).toBeTruthy();
    });

    // Second turn: speech ends, then the socket drops twice pre-final.
    driver!.onFrame(speechFrame());
    driver!.onSpeechStart();
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(2);
    });
    const second = FakeWs.instances[1];
    second.open();
    driver!.onFrame(speechFrame());
    driver!.onSpeechEnd();
    await waitFor(() => {
      expect(
        second.sentStrings().some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });

    // First drop: reopen once. Second drop, still no final: one POST retry.
    second.drop();
    await waitFor(
      () => {
        expect(FakeWs.instances).toHaveLength(3);
      },
      { timeout: 3000 },
    );
    const third = FakeWs.instances[2];
    third.open();
    third.drop();

    // The retried turn answers over POST under its own id: a single agent
    // call, and the earlier turn keeps its own reply.
    await waitFor(() => {
      expect(screen.getByText("second reply from Vale")).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("first reply from Vale")).toBeTruthy();
    expect(screen.getByText("second final")).toBeTruthy();
    expect(screen.getAllByText("Vale:")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });
});
