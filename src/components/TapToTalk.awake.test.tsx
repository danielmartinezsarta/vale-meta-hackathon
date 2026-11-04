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

function stubGetUserMedia() {
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => stream },
  });
  stubVoiceSocket();
}

const seen: CaptureCallbacks[] = [];

function driveTurns() {
  seen.length = 0;
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    seen.push(callbacks);
    return { stop: () => {}, state: () => "running", engine: () => "script" as const };
  });
  const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function burstOnce() {
  const frame = new Int16Array(960).fill(4000);
  seen[0].onFrame(frame);
  seen[0].onSpeechStart();
  for (let i = 0; i < 8; i += 1) seen[0].onFrame(frame);
  seen[0].onSpeechEnd();
}

function answerFullTurn(final: string, reply: string, widget = false) {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({ type: "transcript", transcript: final.slice(0, 5), final: false });
  ws.serverMessage({ type: "transcript", transcript: final, final: true });
  if (widget) {
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "note",
        title: "Note saved",
        size: "half",
        data: { text: "Likes neon colors", client: "David" },
      },
    });
  }
  ws.serverMessage({ type: "reply", text: reply });
  ws.serverMessage({ type: "done" });
}

async function waitForEndStream(count: number) {
  await waitFor(() => {
    const ends = FakeVoiceSocket.instances[0]
      .sentStrings()
      .filter((raw) => raw.includes("endStream")).length;
    expect(ends).toBeGreaterThanOrEqual(count);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("awake screen (VoiceRobot, bubbles, sheets)", () => {
  it("wakes straight into a live session with greeting and bubbles", async () => {
    stubGetUserMedia();
    const fetchMock = driveTurns();
    const onSleep = vi.fn();
    render(<TapToTalk autoStart onSleep={onSleep} />);

    expect(screen.getByText("Hi, I'm Vale")).toBeTruthy();
    expect(screen.getByText("Asleep")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Put Vale to sleep" }),
    ).toBeTruthy();

    await waitFor(() => {
      expect(seen.length).toBe(1);
    });
    burstOnce();
    await waitForEndStream(1);
    answerFullTurn("first final", "first reply from Vale");
    await waitFor(() => {
      expect(screen.getByText("first final")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("first reply from Vale")).toBeTruthy();
    });
    expect(screen.getByText("You:")).toBeTruthy();
    expect(screen.getByText("Vale:")).toBeTruthy();
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });

  it("never shows ignored turns on the screen, not even as a label", async () => {
    stubGetUserMedia();
    const fetchMock = driveTurns();
    render(<TapToTalk autoStart />);

    await waitFor(() => {
      expect(screen.getByText("Hi, I'm Vale")).toBeTruthy();
    });
    await waitFor(() => {
      expect(seen.length).toBe(1);
    });
    burstOnce();
    await waitForEndStream(1);
    // The turn really rode the wire (no vacuous pass) but leaves no trace.
    const ws = FakeVoiceSocket.instances[0];
    ws.serverMessage({
      type: "transcript",
      transcript: "background chat here",
      final: true,
    });
    ws.serverMessage({ type: "ignored" });
    ws.serverMessage({ type: "done" });
    await waitFor(() => {
      expect(
        ws.sentStrings().some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });
    expect(screen.queryByText("background chat here")).toBeNull();
    expect(screen.queryByText("background chat")).toBeNull();
    expect(screen.queryByText("ignored (no name)")).toBeNull();
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });

  it("keeps at most three bubbles, dropping the oldest", async () => {
    stubGetUserMedia();
    const fetchMock = driveTurns();
    render(<TapToTalk autoStart />);

    await waitFor(() => {
      expect(seen.length).toBe(1);
    });
    burstOnce();
    await waitForEndStream(1);
    answerFullTurn("one", "reply one from Vale");
    burstOnce();
    await waitForEndStream(2);
    answerFullTurn("two", "reply two from Vale");
    await waitFor(() => {
      expect(screen.getByText("reply two from Vale")).toBeTruthy();
    });
    // Two turns are four bubbles; only the last three stay on screen.
    expect(screen.queryByText("one")).toBeNull();
    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.getByText("reply one from Vale")).toBeTruthy();
    expect(screen.getByText("reply two from Vale")).toBeTruthy();
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });

  it("mutes her voice but keeps the reply text, and sleeps from zzz", async () => {
    stubGetUserMedia();
    driveTurns();
    const onSleep = vi.fn();
    render(<TapToTalk autoStart onSleep={onSleep} />);

    const mute = screen.getByRole("button", { name: "Mute Vale" });
    fireEvent.click(mute);
    expect(
      screen.getByRole("button", { name: "Unmute Vale" }),
    ).toBeTruthy();

    await waitFor(() => {
      expect(seen.length).toBe(1);
    });
    burstOnce();
    await waitForEndStream(1);
    answerFullTurn("quiet please", "still shown");
    await waitFor(() => {
      expect(screen.getByText("still shown")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Put Vale to sleep" }));
    expect(onSleep).toHaveBeenCalledTimes(1);
  });

  it("opens the tool widget and closes it on a spoken close order", async () => {
    stubGetUserMedia();
    driveTurns();
    render(<TapToTalk autoStart />);

    await waitFor(() => {
      expect(seen.length).toBe(1);
    });
    burstOnce();
    await waitForEndStream(1);
    answerFullTurn("note this", "saved", true);
    await screen.findByText("Note saved");
    expect(screen.getByText("Likes neon colors")).toBeTruthy();
    burstOnce();
    await waitForEndStream(2);
    const ws = FakeVoiceSocket.instances[0];
    ws.serverMessage({ type: "transcript", transcript: "close it", final: true });
    ws.serverMessage({ type: "done" });
    await waitFor(() => {
      expect(screen.queryByText("Note saved")).toBeNull();
    });
  });
});
