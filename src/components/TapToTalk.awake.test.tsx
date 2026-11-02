import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

function stubGetUserMedia() {
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => stream },
  });
  // No real sockets in tests: Node's WebSocket would dial localhost:3000,
  // so hide it and force the buffered-POST fallback path under test.
  vi.stubGlobal("WebSocket", undefined);
}

function sseBody(transcript: string, reply: string, widget = false): {
  getReader: () => {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock: () => void;
  };
} {
  const encoder = new TextEncoder();
  const raw =
    `event: interim\ndata: {"transcript":"${transcript.slice(0, 5)}"}\n\n` +
    `event: final\ndata: {"transcript":"${transcript}","audioProcessedMs":800}\n\n` +
    (widget
      ? `event: widget\ndata: {"widget":{"kind":"note","title":"Note saved","lines":[],"size":"half"}}\n\n`
      : "") +
    `event: reply\ndata: {"text":${JSON.stringify(reply)}}\n\n` +
    "event: done\ndata: {}\n\n";
  const bytes = encoder.encode(raw);
  const first = bytes.slice(0, 13);
  const rest = bytes.slice(13);
  let step = 0;
  return {
    getReader: () => ({
      read: async () => {
        step += 1;
        if (step === 1) return { done: false, value: first };
        if (step === 2) return { done: false, value: rest };
        return { done: true, value: undefined };
      },
      releaseLock: () => {},
    }),
  };
}

function driveTurns(
  utterances: string[],
  replies: string[],
  withWidget = false,
) {
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    const frame = new Int16Array(960).fill(4000);
    let fired = 0;
    const fireNext = () => {
      if (fired >= utterances.length) return;
      fired += 1;
      callbacks.onFrame(frame);
      callbacks.onSpeechStart();
      for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
      callbacks.onSpeechEnd();
      window.setTimeout(fireNext, 10);
    };
    window.setTimeout(fireNext, 0);
    return { stop: () => {}, state: () => "running" };
  });
  const fetchMock = vi.fn((..._args: unknown[]) => {
    const call = fetchMock.mock.calls.length;
    const transcript = utterances[Math.min(call - 1, utterances.length - 1)];
    const reply = replies[Math.min(call - 1, replies.length - 1)];
    return Promise.resolve({
      ok: true,
      body: sseBody(transcript, reply, withWidget && call === 1),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("awake screen (VoiceRobot, bubbles, sheets)", () => {
  it("wakes straight into a live session with greeting and bubbles", async () => {
    stubGetUserMedia();
    driveTurns(["first final"], ["first reply from Vale"]);
    const onSleep = vi.fn();
    render(<TapToTalk autoStart onSleep={onSleep} />);

    expect(screen.getByText("Hi, I'm Vale")).toBeTruthy();
    expect(screen.getByText("Just say it")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Put Vale to sleep" }),
    ).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("first final")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("first reply from Vale")).toBeTruthy();
    });
    expect(screen.getByText("You:")).toBeTruthy();
    expect(screen.getByText("Vale:")).toBeTruthy();
  });

  it("keeps at most three bubbles, dropping the oldest", async () => {
    stubGetUserMedia();
    driveTurns(
      ["one", "two"],
      ["reply one from Vale", "reply two from Vale"],
    );
    render(<TapToTalk autoStart />);

    await waitFor(() => {
      expect(screen.getByText("reply two from Vale")).toBeTruthy();
    });
    // Two turns are four bubbles; only the last three stay on screen.
    expect(screen.queryByText("one")).toBeNull();
    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.getByText("reply one from Vale")).toBeTruthy();
    expect(screen.getByText("reply two from Vale")).toBeTruthy();
  });

  it("mutes her voice but keeps the reply text, and sleeps from zzz", async () => {
    stubGetUserMedia();
    driveTurns(["quiet please"], ["still shown"]);
    const onSleep = vi.fn();
    render(<TapToTalk autoStart onSleep={onSleep} />);

    const mute = screen.getByRole("button", { name: "Mute Vale" });
    fireEvent.click(mute);
    expect(
      screen.getByRole("button", { name: "Unmute Vale" }),
    ).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("still shown")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Put Vale to sleep" }));
    expect(onSleep).toHaveBeenCalledTimes(1);
  });

  it("opens the tool widget in a half sheet and closes it", async () => {
    stubGetUserMedia();
    driveTurns(["note this"], ["saved"], true);
    render(<TapToTalk autoStart />);

    const sheet = await screen.findByRole("dialog", { name: "Note saved" });
    expect(sheet.getAttribute("data-size")).toBe("half");
    fireEvent.click(screen.getByRole("button", { name: "Close Note saved" }));
    expect(screen.queryByRole("dialog", { name: "Note saved" })).toBeNull();
  });
});
