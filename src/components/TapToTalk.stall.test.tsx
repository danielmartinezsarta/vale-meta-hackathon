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
    return { stop: () => {}, state: () => "running" };
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
  // No real sockets in tests: hide WebSocket to force the POST path.
  vi.stubGlobal("WebSocket", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  stubSession();
  render(<TapToTalk />);
  fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
  await vi.advanceTimersByTimeAsync(0);
}

function sessionAlive() {
  expect(
    screen.getByRole("button", { name: "Stop" }),
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
    // Three silent minutes: a heartbeat every 2 s proves aliveness.
    for (let elapsed = 0; elapsed < 180000; elapsed += 2000) {
      driver?.onHeartbeat?.();
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(mockStartCapture).toHaveBeenCalledTimes(1);
    sessionAlive();
    // Then the processor dies: one restart, still no alert.
    await vi.advanceTimersByTimeAsync(6500);
    expect(mockStartCapture).toHaveBeenCalledTimes(2);
    sessionAlive();
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
