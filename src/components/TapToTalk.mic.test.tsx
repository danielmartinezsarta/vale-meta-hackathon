// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
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
  vi.stubGlobal("WebSocket", undefined);
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

function boardSse(transcript: string): string {
  return (
    `event: final\ndata: {"transcript":${JSON.stringify(transcript)}}\n\n` +
    `event: board\ndata: {"board":{"session":{"id":7,"clientName":"David","serviceName":"Gel manicure","startedAt":${JSON.stringify(STARTED_AT)}},"card":null,"list":[]}}\n\n` +
    "event: done\ndata: {}\n\n"
  );
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
    stubVoice((body) => boardSse("vale open a session"));
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
    expect(screen.getByPlaceholderText("Type to Vale")).toBeTruthy();
    // Session untouched: timer still live, no stop happened.
    expect(screen.getByRole("timer", { name: "Session time" })).toBeTruthy();
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
    expect(screen.getByPlaceholderText("Type to Vale")).toBeTruthy();
  });

  it("sends zero voice turns while muted", async () => {
    const track = makeTrack();
    stubMic(track);
    stubSpeech();
    const calls = stubVoice((body) => boardSse("vale open a session"));
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "running",
      engine: () => "script" as const,
    }));
    await goLiveWithSession();
    // Pipeline alive: the loud turn posted audio before the mute.
    expect(
      calls.filter((call) => call.contentType.includes("audio/")),
    ).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    calls.length = 0;
    fireSilentFrames(20);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(calls.filter((call) => call.contentType.includes("audio/"))).toHaveLength(0);
  });

  it("unmutes instantly, hides the field, and keeps listening", async () => {
    const track = makeTrack();
    stubMic(track);
    stubSpeech();
    stubVoice((body) => boardSse("vale open a session"));
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
    expect(screen.queryByPlaceholderText("Type to Vale")).toBeNull();
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
    const input = screen.getByPlaceholderText("Type to Vale");
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
});
