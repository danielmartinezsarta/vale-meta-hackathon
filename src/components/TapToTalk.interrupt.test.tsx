import { cleanup, fireEvent, render, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
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

function noAudioPost() {
  const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function liveSocket() {
  return FakeVoiceSocket.instances[0];
}

function sentEndStream(): boolean {
  return liveSocket()
    .sent.filter((item): item is string => typeof item === "string")
    .some((raw) => raw.includes("endStream"));
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
    stubVoiceSocket();
    const seen: CaptureCallbacks[] = [];
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });
    const fetchMock = noAudioPost();

    render(<TapToTalk autoStart />);

    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);
    liveSocket().serverMessage({
      type: "transcript",
      transcript: "book a refill",
      final: true,
    });

    await waitFor(() => {
      expect(screen.getByText("book a refill")).toBeTruthy();
    });
    expect(screen.queryByText("You are booked in.")).toBeNull();

    liveSocket().serverMessage({ type: "reply", text: "You are booked in." });
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
    liveSocket().serverMessage({ type: "done" });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Put Vale to sleep" }));
  });

  it("pausing for her voice closes the released segment with endStream first", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () =>
          ({ getTracks: () => [] }) as unknown as MediaStream,
      },
    });
    stubVoiceSocket();
    noAudioPost();
    const seen: CaptureCallbacks[] = [];
    const pauses: boolean[] = [];
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return {
        stop: () => {},
        state: () => "running",
        engine: () => "script" as const,
        setPaused: (value: boolean) => void pauses.push(value),
      };
    });

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    // Released but speech never ended: her voice cuts in mid-segment.
    seen[0].onSpeechStart();
    const voiced = new Int16Array(960).fill(4000);
    for (let i = 0; i < 8; i += 1) seen[0].onFrame(voiced);
    speakAudibleRef.current = true;
    seen[0].onFrame(voiced);
    // The segment ends explicitly before the pause, never silently.
    await waitFor(() => {
      expect(sentEndStream()).toBe(true);
    });
    expect(pauses).toContain(true);
    expect(screen.queryByRole("alert")).toBeNull();
    speakAudibleRef.current = false;
  });

  it("a rebuild closes the released segment with endStream first", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () =>
          ({ getTracks: () => [] }) as unknown as MediaStream,
      },
    });
    stubVoiceSocket();
    noAudioPost();
    const seen: CaptureCallbacks[] = [];
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    seen[0].onSpeechStart();
    const voiced = new Int16Array(960).fill(4000);
    for (let i = 0; i < 8; i += 1) seen[0].onFrame(voiced);
    seen[0].onInterrupt?.();
    // The detector reset never strands the segment: endStream rode first.
    await waitFor(() => {
      expect(sentEndStream()).toBe(true);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("holds the open turn while muted: no quiet churn, no vad notice", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: async () =>
            ({ getTracks: () => [] }) as unknown as MediaStream,
        },
      });
      stubVoiceSocket();
      const seen: CaptureCallbacks[] = [];
      mockStartCapture.mockImplementation((_stream, callbacks) => {
        seen.push(callbacks);
        return { stop: () => {}, state: () => "running", engine: () => "script" as const };
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      render(<TapToTalk autoStart />);
      // The /voice gate polls every 50 ms: advance past one poll.
      await vi.advanceTimersByTimeAsync(100);
      expect(seen.length).toBeGreaterThan(0);
      // Her voice: the watch mutes within one tick and stays muted.
      speakAudibleRef.current = true;
      await vi.advanceTimersByTimeAsync(300);
      // Two full quiet windows with the VAD frozen: the turn never churns,
      // so the two-strike silence banner never shows and she is never cut.
      await vi.advanceTimersByTimeAsync(20000);
      expect(
        screen.queryByText("I didn't hear you. Speak, I'm listening."),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Put Vale to sleep" }),
      ).toBeTruthy();
      expect(mockStopSpeaking).not.toHaveBeenCalled();
    } finally {
      speakAudibleRef.current = false;
      vi.useRealTimers();
    }
  });

  it(
    "schedules the summary chain while speaking: good job after 5 s, close after 5 s",
    { timeout: 30000 },
    async () => {
      try {
        vi.stubGlobal("navigator", {
          mediaDevices: {
            getUserMedia: async () =>
              ({ getTracks: () => [] }) as unknown as MediaStream,
          },
        });
        stubVoiceSocket();
        render(<TapToTalk autoStart />);
        // She speaks before the summary lands: the chain must not wait on it.
        speakAudibleRef.current = true;
        await screen.findByText("Speaking", undefined, { timeout: 5000 });
        liveSocket().serverMessage({
          type: "widget",
          widget: {
            kind: "session_summary",
            title: "Session summary",
            size: "full",
            data: {
              client: "David",
              date: "Nov 2, 2026",
              service: { name: "Gel removal", price: 24 },
              extras: [],
              suggested: 24,
              charged: 24,
              earned: null,
              stdMinutes: null,
              timeTotal: "11m",
              timeParts: [],
              costs: [],
              fixedDetail: null,
            },
          },
        });
        // The summary shows even while she speaks the close line.
        await screen.findByText("Session summary");
        // Past the summary window she is still speaking, yet goodbye takes over.
        await screen.findByText("Good job!", undefined, { timeout: 8000 });
        // After the goodbye window the sheet closes on its own.
        await waitForElementToBeRemoved(() => screen.queryByText("Good job!"), {
          timeout: 8000,
        });
      } finally {
        speakAudibleRef.current = false;
      }
    },
  );
});
