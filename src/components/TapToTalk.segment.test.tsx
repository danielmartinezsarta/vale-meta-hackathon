import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
import { startCapture } from "@/lib/capture";
import type { CaptureCallbacks } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

const seen: CaptureCallbacks[] = [];

function tapSession() {
  seen.length = 0;
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  stubVoiceSocket();
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    seen.push(callbacks);
    return { stop: () => {}, state: () => "running", engine: () => "script" as const };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("no post", { status: 500 })),
  );
  render(<TapToTalk debug />);
  fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
}

async function waitForCapture() {
  await waitFor(() => {
    expect(seen.length).toBe(1);
  });
}

function voicedFrame() {
  return new Int16Array(960).fill(4000);
}

function sentStrings(): string[] {
  return FakeVoiceSocket.instances[0].sent.filter(
    (item): item is string => typeof item === "string",
  );
}

function sentBinaryCount(): number {
  return FakeVoiceSocket.instances[0].sent.filter(
    (item) => item instanceof ArrayBuffer,
  ).length;
}

function endStreamCount(): number {
  return sentStrings().filter((raw) => raw.includes("endStream")).length;
}

function endStreamTag(): string | null {
  for (const raw of sentStrings()) {
    try {
      const message = JSON.parse(raw) as { type?: unknown; turn?: unknown };
      if (message.type === "endStream" && typeof message.turn === "string") {
        return message.turn;
      }
    } catch {
      /* not JSON */
    }
  }
  return null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client segment invariant (one transport, VAD-owned ends)", () => {
  it("releases on 8 of the last 10 voiced frames, not on cumulative counts", async () => {
    tapSession();
    await waitForCapture();
    // 7 voiced + 3 silent: the old cumulative hold would already ride.
    seen[0].onSpeechStart();
    for (let i = 0; i < 7; i += 1) seen[0].onFrame(voicedFrame());
    for (let i = 0; i < 3; i += 1) seen[0].onFrame(new Int16Array(960));
    expect(sentBinaryCount()).toBe(0);
    // 8 more voiced: the window reaches 8/10 and the segment rides.
    for (let i = 0; i < 8; i += 1) seen[0].onFrame(voicedFrame());
    expect(sentBinaryCount()).toBeGreaterThan(0);
  });

  it("noise never opens a turn: no endStream, no bubble, no alert", async () => {
    tapSession();
    await waitForCapture();
    seen[0].onSpeechStart();
    for (let i = 0; i < 8; i += 1) seen[0].onFrame(new Int16Array(960));
    seen[0].onSpeechEnd();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Listening");
    });
    expect(endStreamCount()).toBe(0);
    expect(screen.queryByText("You:")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a done for the capturing turn is dropped; the live turn survives", async () => {
    tapSession();
    await waitForCapture();
    seen[0].onSpeechStart();
    for (let i = 0; i < 8; i += 1) seen[0].onFrame(voicedFrame());
    // Released but speech never ended: a foreign done must not touch it.
    FakeVoiceSocket.instances[0].serverMessage({ type: "done" });
    seen[0].onSpeechEnd();
    await waitFor(() => {
      expect(endStreamCount()).toBe(1);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a tagged done settles its turn; an unknown tag is dropped", async () => {
    tapSession();
    await waitForCapture();
    seen[0].onSpeechStart();
    for (let i = 0; i < 8; i += 1) seen[0].onFrame(voicedFrame());
    seen[0].onSpeechEnd();
    await waitFor(() => {
      expect(endStreamCount()).toBe(1);
    });
    const tag = endStreamTag();
    expect(tag).toMatch(/^t\d+$/);
    FakeVoiceSocket.instances[0].serverMessage({ type: "done", turn: tag });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Listening");
    });
    expect(screen.queryByRole("alert")).toBeNull();
    // Unknown tag: no turn matches, nothing happens, session stays live.
    FakeVoiceSocket.instances[0].serverMessage({
      type: "transcript",
      transcript: "stray",
      final: true,
      turn: "t999",
    });
    expect(screen.queryByText("stray")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });
});
