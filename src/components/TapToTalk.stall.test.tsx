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
  onHeartbeat?: () => void;
}

let driver: CaptureDriver | null = null;

function stubSession() {
  driver = null;
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    driver = {
      onFrame: callbacks.onFrame,
      onSpeechStart: callbacks.onSpeechStart,
      onSpeechEnd: callbacks.onSpeechEnd,
      onHeartbeat: callbacks.onHeartbeat,
    };
    return { stop: () => {}, state: () => "running", engine: () => "script" as const };
  });
}

afterEach(() => {
  cleanup();
  driver = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function tapToTalk() {
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  stubVoiceSocket();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  stubSession();
  render(<TapToTalk autoStart />);
  // Flush the async getUserMedia continuation: advance(0) alone does not
  // commit the live render once the session owns more than one interval,
  // so run past the first session tick (no turn effects at this silence).
  await vi.advanceTimersByTimeAsync(300);
}

function sessionAlive() {
  expect(
    screen.getByRole("button", { name: "Put Vale to sleep" }),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
}

describe("capture stall watchdog (lead round p1)", () => {
  it("restarts capture after 5 s without audio blocks, session stays live", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    try {
      await tapToTalk();
      expect(mockStartCapture).toHaveBeenCalledTimes(1);
      // Dead processor: no heartbeats at all. The watchdog ticks every
      // 2 s and restarts past 5 s without blocks.
      await vi.advanceTimersByTimeAsync(6500);
      expect(mockStartCapture).toHaveBeenCalledTimes(2);
      expect(
        logs.some((line) => line.startsWith("[capture] stall-restart")),
      ).toBe(true);
      sessionAlive();
    } finally {
      spy.mockRestore();
    }
  });

  it("a live heartbeat never restarts, even across a 3-minute pause", async () => {
    vi.useFakeTimers();
    await tapToTalk();
    expect(mockStartCapture).toHaveBeenCalledTimes(1);
    // Three silent minutes: a heartbeat every 2 s proves aliveness. Sync
    // advances cost no real event-loop rounds, so parallel load cannot
    // starve the 5 s real-time budget; one async flush settles renders.
    for (let elapsed = 0; elapsed < 180000; elapsed += 2000) {
      driver?.onHeartbeat?.();
      vi.advanceTimersByTime(2000);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(mockStartCapture).toHaveBeenCalledTimes(1);
    sessionAlive();
    // Then the processor dies: one restart, still no alert.
    vi.advanceTimersByTime(6500);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockStartCapture).toHaveBeenCalledTimes(2);
    sessionAlive();
  });

  it("a stall closes the released segment with endStream before restarting", async () => {
    vi.useFakeTimers();
    try {
      await tapToTalk();
      expect(mockStartCapture).toHaveBeenCalledTimes(1);
      // A released segment is in flight when the processor dies: the
      // restart must not strand it without its endStream.
      const voiced = new Int16Array(960).fill(4000);
      driver?.onSpeechStart();
      for (let i = 0; i < 8; i += 1) driver?.onFrame(voiced);
      vi.advanceTimersByTime(6500);
      await vi.advanceTimersByTimeAsync(0);
      const ends = FakeVoiceSocket.instances[0]
        .sent.filter((item): item is string => typeof item === "string")
        .filter((raw) => raw.includes("endStream")).length;
      expect(ends).toBe(1);
      expect(mockStartCapture).toHaveBeenCalledTimes(2);
      sessionAlive();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hidden tab logs capture state and the session survives", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    try {
      await tapToTalk();
      driver?.onHeartbeat?.();
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(
        logs.some((line) => line.startsWith("[capture] visibility")),
      ).toBe(true);
      sessionAlive();
    } finally {
      spy.mockRestore();
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "prerender",
      });
    }
  });
});
