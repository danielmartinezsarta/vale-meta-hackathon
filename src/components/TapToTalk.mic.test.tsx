// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
  unlockAudioContext: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);
const STARTED_AT = new Date(Date.now() - 3723 * 1000).toISOString();

function stubSpeech() {
  vi.stubGlobal("speechSynthesis", {
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      text: string;
      constructor(text: string) {
        this.text = text;
      }
    },
  );
}

function makeTrack() {
  return {
    enabled: true,
    readyState: "live",
    kind: "audio",
    stop: vi.fn(),
  };
}

function stubMic(track: { enabled: boolean }) {
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [track],
    getAudioTracks: () => [track],
  }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  stubVoiceSocket();
  return getUserMedia;
}

interface VoiceCall {
  url: string;
  contentType: string;
  body: string;
}

function stubVoice(sender: (body: string) => string): VoiceCall[] {
  const calls: VoiceCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const bodyText = typeof init?.body === "string" ? init.body : "";
      calls.push({
        url: String(url),
        contentType: headers.get("content-type") ?? "",
        body: bodyText,
      });
      return new Response(new TextEncoder().encode(sender(bodyText)), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
  return calls;
}

function noAudioPost() {
  const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function answerBoardTurn(transcript: string) {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({ type: "transcript", transcript, final: true });
  ws.serverMessage({
    type: "board",
    board: {
      session: {
        id: 7,
        clientName: "David",
        serviceName: "Gel manicure",
        startedAt: STARTED_AT,
      },
      card: null,
      list: [],
    },
  });
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

function typedSse(): string {
  return (
    'event: final\ndata: {"transcript":"show my photos"}\n\n' +
    'event: reply\ndata: {"text":"Here are your photos."}\n\n' +
    'event: widget\ndata: {"widget":{"kind":"photos","title":"Photos","size":"full","data":{"before":null,"reference":null,"expected":null}}}\n\n' +
    "event: done\ndata: {}\n\n"
  );
}

/** Loud frames open a session through the stubbed voice route. */
function fireLoudTurn() {
  const callbacks = mockStartCapture.mock.calls[0][1];
  const frame = new Int16Array(960).fill(4000);
  callbacks.onFrame(frame);
  callbacks.onSpeechStart();
  for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
  callbacks.onSpeechEnd();
}

function fireSilentFrames(count: number) {
  const callbacks = mockStartCapture.mock.calls[0][1];
  for (let i = 0; i < count; i += 1) callbacks.onFrame(new Int16Array(960));
}

async function goLive(): Promise<void> {
  render(<TapToTalk autoStart />);
  await waitFor(() => {
    expect(mockStartCapture).toHaveBeenCalled();
  });
}

async function goLiveWithSession(): Promise<void> {
  await goLive();
  fireLoudTurn();
  await waitForEndStream(1);
  answerBoardTurn("vale open a session");
  await waitFor(() => {
    expect(screen.getByRole("timer", { name: "Session time" })).toBeTruthy();
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mic mute (track toggle, session stays live)", () => {
  it("mutes by disabling tracks and keeps the session running", async () => {
    const track = makeTrack();
    stubMic(track);
    stubSpeech();
    const fetchMock = noAudioPost();
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "running",
      engine: () => "script" as const,
    }));
    await goLiveWithSession();
    expect(track.enabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(track.enabled).toBe(false);
    expect(screen.getByRole("button", { name: "Unmute microphone" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Type to Vale…")).toBeTruthy();
    // Session untouched: timer still live, no stop happened.
    expect(screen.getByRole("timer", { name: "Session time" })).toBeTruthy();
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });

  it("starts deaf when muted before the session exists", async () => {
    const track = makeTrack();
    const getUserMedia = stubMic(track);
    stubSpeech();
    stubVoice(() => "event: done\ndata: {}\n\n");
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "running",
      engine: () => "script" as const,
    }));
    render(<TapToTalk autoStart />);
    // Mute wins the race with the in-flight getUserMedia: the ref mirror
    // (not the stale tap closure) decides the fresh tracks.
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(mockStartCapture).toHaveBeenCalled();
    });
    expect(track.enabled).toBe(false);
    expect(screen.getByPlaceholderText("Type to Vale…")).toBeTruthy();
  });

  it("sends zero voice turns while muted", async () => {
    const track = makeTrack();
    stubMic(track);
    stubSpeech();
    noAudioPost();
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "running",
      engine: () => "script" as const,
    }));
    await goLiveWithSession();
    const ws = FakeVoiceSocket.instances[0];
    // Pipeline alive: the loud turn rode the socket before the mute.
    expect(
      ws.sent.filter((item) => item instanceof ArrayBuffer).length,
    ).toBeGreaterThan(0);
    const framesBefore = ws.sent.length;
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    fireSilentFrames(20);
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Silent frames never leave the device, muted or not.
    expect(ws.sent.length).toBe(framesBefore);
  });

  it("unmutes instantly, hides the field, and keeps listening", async () => {
    const track = makeTrack();
    stubMic(track);
    stubSpeech();
    noAudioPost();
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "running",
      engine: () => "script" as const,
    }));
    await goLiveWithSession();
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(track.enabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    expect(track.enabled).toBe(true);
    expect(screen.queryByPlaceholderText("Type to Vale…")).toBeNull();
    expect(screen.getByRole("timer", { name: "Session time" })).toBeTruthy();
  });

  it("runs a typed turn and renders its widget", async () => {
    const track = makeTrack();
    stubMic(track);
    stubSpeech();
    const calls = stubVoice((bodyText) => {
      try {
        const body = JSON.parse(bodyText) as { typed?: boolean };
        if (body.typed === true) return typedSse();
      } catch {
        /* fall through */
      }
      return "event: done\ndata: {}\n\n";
    });
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "running",
      engine: () => "script" as const,
    }));
    await goLive();
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    const input = screen.getByPlaceholderText("Type to Vale…");
    fireEvent.change(input, { target: { value: "show my photos" } });
    const form = input.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    const typed = calls.find((call) => {
      try {
        return (JSON.parse(call.body) as { typed?: boolean }).typed === true;
      } catch {
        return false;
      }
    });
    expect(typed).toBeDefined();
    expect(JSON.parse(typed?.body ?? "{}").transcript).toBe("show my photos");
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Photos" })).toBeTruthy();
    });
    expect(screen.getByText("Here are your photos.")).toBeTruthy();
  });

  it("dims the send button while empty and sends on click", async () => {
    const track = makeTrack();
    stubMic(track);
    stubSpeech();
    const calls = stubVoice(() => "event: done\ndata: {}\n\n");
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "running",
      engine: () => "script" as const,
    }));
    await goLive();
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    const send = screen.getByRole("button", { name: "Send message" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByPlaceholderText("Type to Vale…");
    fireEvent.change(input, { target: { value: "  hello  " } });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => {
      expect(
        calls.some((call) => {
          try {
            const body = JSON.parse(call.body) as { typed?: boolean; transcript?: unknown };
            return body.typed === true && body.transcript === "hello";
          } catch {
            return false;
          }
        }),
      ).toBe(true);
    });
    // Cleared and still open: the chip stays while the mic is muted.
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByPlaceholderText("Type to Vale…")).toBeTruthy();
  });
});

describe("muted mic (no mic errors while muted)", () => {
  it("shows no alert when capture reports blocked while muted", async () => {
    const track = makeTrack();
    stubMic(track);
    stubSpeech();
    stubVoice(() => "event: done\ndata: {}\n\n");
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "suspended",
      engine: () => "script" as const,
    }));
    await goLiveWithSession();
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    const callbacks = mockStartCapture.mock.calls[0][1];
    callbacks.onBlocked?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // No alert, session kept: the timer still runs and typing still works.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("timer", { name: "Session time" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Type to Vale…")).toBeTruthy();
  });

  it("keeps today's alert when capture reports blocked while unmuted", async () => {
    const track = makeTrack();
    stubMic(track);
    stubSpeech();
    stubVoice(() => "event: done\ndata: {}\n\n");
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "suspended",
      engine: () => "script" as const,
    }));
    await goLiveWithSession();
    const callbacks = mockStartCapture.mock.calls[0][1];
    callbacks.onBlocked?.();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/didn't start/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("resumes capture in the unmute gesture", async () => {
    const track = makeTrack();
    stubMic(track);
    stubSpeech();
    stubVoice(() => "event: done\ndata: {}\n\n");
    const resume = vi.fn();
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      resume,
      state: () => "suspended",
      engine: () => "script" as const,
    }));
    await goLiveWithSession();
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(resume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    expect(resume).toHaveBeenCalledTimes(1);
  });
});


