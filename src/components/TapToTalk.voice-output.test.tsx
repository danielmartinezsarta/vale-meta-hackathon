import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";
import { finishStream, isSpeaking, setVoiceEngine, speak, speakStream, stopSpeaking, voiceEngine } from "@/lib/speak";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

vi.mock("@/lib/speak", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/speak")>();
  return {
    ...actual,
    speak: vi.fn((...args: Parameters<typeof actual.speak>) =>
      actual.speak(...args),
    ),
    speakStream: vi.fn((...args: Parameters<typeof actual.speakStream>) =>
      actual.speakStream(...args),
    ),
    finishStream: vi.fn((...args: Parameters<typeof actual.finishStream>) =>
      actual.finishStream(...args),
    ),
    stopSpeaking: vi.fn((...args: Parameters<typeof actual.stopSpeaking>) =>
      actual.stopSpeaking(...args),
    ),
    isSpeaking: vi.fn(
      (...args: Parameters<typeof actual.isSpeaking>) =>
        speakAudibleRef.current || actual.isSpeaking(...args),
    ),
    // Strict turns: the mock voice never reports its end through the
    // estimate, so the suite drives settled-ness directly.
    speechSettled: vi.fn(() => !speakAudibleRef.current),
    // The real-end notice: captured so the suite fires it by hand.
    onSpeechSettled: vi.fn((fn: () => void) => {
      settleListener = fn;
      return () => {
        settleListener = null;
      };
    }),
  };
});

const mockStartCapture = vi.mocked(startCapture);
const mockSpeak = vi.mocked(speak);
const mockSpeakStream = vi.mocked(speakStream);
const mockFinishStream = vi.mocked(finishStream);
const mockStopSpeaking = vi.mocked(stopSpeaking);
/** Audibility the real (headless, silent) synth cannot report. */
const speakAudibleRef = { current: false };
/** The live real-end subscriber; the suite fires it by hand. */
let settleListener: (() => void) | null = null;

class FakeWs {
  static instances: FakeWs[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  url: string;
  constructor(url = "") {
    this.url = url;
    FakeWs.instances.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  sentStrings(): string[] {
    return this.sent.filter((item) => typeof item === "string") as string[];
  }
  sentBinaryCount(): number {
    return this.sent.filter((item) => item instanceof ArrayBuffer).length;
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  serverMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

interface CaptureDriver {
  onSpeechStart: () => void;
  onSpeechEnd: (stats?: { lostBlocks: number; srcBlocks: number }) => void;
  onFrame?: (frame: Int16Array) => void;
}

let driver: CaptureDriver | null = null;

afterEach(() => {
  cleanup();
  FakeWs.instances = [];
  driver = null;
  speakAudibleRef.current = false;
  settleListener = null;
  setVoiceEngine("browser");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("browser voice output", () => {
  it("never captures while she speaks and re-listens after she settles", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no post", { status: 500 })));
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      driver = {
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
        onFrame: callbacks.onFrame,
      };
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });
    speakAudibleRef.current = false;

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    // The conversation socket is up before speech: no per-turn socket.
    FakeWs.instances[0].open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    const ws = FakeWs.instances[0];
    const voiced = new Int16Array(960).fill(4000);
    await waitFor(() => {
      expect(screen.getByText("Listening")).toBeTruthy();
    });

    // Her reply is audible: mic frames never reach the wire.
    speakAudibleRef.current = true;
    driver!.onFrame?.(voiced);
    driver!.onFrame?.(voiced);
    expect(ws.sentBinaryCount()).toBe(0);
    await waitFor(() => {
      expect(screen.getByText("Speaking")).toBeTruthy();
    });

    // She settles: the same session captures again, no reconnect, no cut.
    speakAudibleRef.current = false;
    driver!.onSpeechStart();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    for (let i = 0; i < 8; i += 1) driver!.onFrame?.(voiced);
    driver!.onSpeechEnd({ lostBlocks: 0, srcBlocks: 9 });
    expect(ws.sentBinaryCount()).toBeGreaterThan(0);
    expect(FakeWs.instances).toHaveLength(1);
    // The posted turn claimed the state, so the mic-resume timer leaves it.
    await waitFor(() => {
      expect(screen.getByText("Thinking")).toBeTruthy();
    });
    // The turn's endStream carries delivery accounting, not just audio.
    const endStreams = ws
      .sentStrings()
      .map((raw) => JSON.parse(raw))
      .filter((msg) => msg.type === "endStream");
    expect(endStreams.length).toBeGreaterThan(0);
    const endPayload = endStreams[endStreams.length - 1];
    for (const key of [
      "peakLevel",
      "voicedMs",
      "mutedMs",
      "valeState",
      "lostBlocks",
      "srcBlocks",
    ]) {
      expect(endPayload, key).toHaveProperty(key);
    }
    expect(endPayload.voicedMs).toBeGreaterThan(0);
    expect(endPayload.srcBlocks).toBe(9);
    expect(endPayload.lostBlocks).toBe(0);
    // The shared turn id rides every close frame for the server log.
    expect(endPayload.turn).toMatch(/^t\d+$/);
  });

  it("a sub-300ms blip never opens a socket: zero binary frames on the wire", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no post", { status: 500 })));
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      driver = {
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
        onFrame: callbacks.onFrame,
      };
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });
    speakAudibleRef.current = false;

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    FakeWs.instances[0].open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    const ws = FakeWs.instances[0];
    const endStreams = () =>
      ws.sentStrings().filter((raw) => raw.includes("endStream")).length;

    // Two voiced frames (80 ms): a mic blip, not Daniel.
    driver!.onSpeechStart();
    const voiced = new Int16Array(960).fill(4000);
    driver!.onFrame?.(voiced);
    driver!.onFrame?.(voiced);
    const stopsBefore = mockStopSpeaking.mock.calls.length;
    driver!.onSpeechEnd();
    // Nothing reached the wire, no bubble, no alert: the session lives on.
    expect(endStreams()).toBe(0);
    // Retention: only the session socket exists; the blip opened no turn
    // socket and sent zero binary frames (the old code streamed them live
    // on the open conversation socket before killing the turn).
    expect(FakeWs.instances).toHaveLength(1);
    expect(
      FakeWs.instances.flatMap((ws) => ws.sent).filter(
        (message) => message instanceof ArrayBuffer,
      ),
    ).toHaveLength(0);
    expect(mockStopSpeaking.mock.calls.length).toBe(stopsBefore);
    expect(screen.queryByRole("alert")).toBeNull();

    // The next real utterance flows as usual on a fresh turn.
    driver!.onSpeechStart();
    for (let i = 0; i < 8; i += 1) driver!.onFrame?.(voiced);
    driver!.onSpeechEnd();
    expect(endStreams()).toBe(1);
    expect(FakeWs.instances).toHaveLength(1);
    expect(FakeWs.instances[0].sentBinaryCount()).toBeGreaterThan(0);
  });
});

describe("voice engine switch", () => {
  function stubSeamlessPlayback() {
    const played: string[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:seamless",
      revokeObjectURL: () => {},
    });
    vi.stubGlobal(
      "Audio",
      class {
        src: string;
        onended: (() => void) | null = null;
        constructor(src: string) {
          this.src = src;
        }
        play(): Promise<void> {
          played.push(this.src);
          return Promise.resolve();
        }
        pause(): void {}
      },
    );
    return { played };
  }

  it("switches the engine through the module without starting a turn", () => {
    expect(voiceEngine()).toBe("browser");
    setVoiceEngine("seamless");
    expect(voiceEngine()).toBe("seamless");
    setVoiceEngine("browser");
    expect(voiceEngine()).toBe("browser");
  });

  it("requests echo cancellation and noise suppression on the mic", async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    });
  });

  it("plays the reply through Seamless when the engine is on", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["fake-wav"]))),
    );
    const { played } = stubSeamlessPlayback();
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      driver = {
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
        onFrame: callbacks.onFrame,
      };
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });

    setVoiceEngine("seamless");
    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    // The conversation socket is up before speech: no per-turn socket.
    FakeWs.instances[0].open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    driver!.onSpeechStart();
    const ws = FakeWs.instances[0];
    for (let i = 0; i < 8; i += 1) driver!.onFrame?.(new Int16Array(960).fill(4000));
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "reply", text: "Session open." });
    await waitFor(() => {
      expect(played).toHaveLength(1);
    });
    expect(mockSpeak).toHaveBeenCalledWith("Session open.", "en");
    expect(mockSpeak).toHaveBeenCalledWith("Session open.", "en");
  });

  it("keeps ignored turns off the screens, never as dialogue", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      driver = {
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
        onFrame: callbacks.onFrame,
      };
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    // The conversation socket is up before speech: no per-turn socket.
    FakeWs.instances[0].open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    driver!.onSpeechStart();
    const ws = FakeWs.instances[0];
    for (let i = 0; i < 8; i += 1) driver!.onFrame?.(new Int16Array(960).fill(4000));
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "transcript", transcript: "noise", final: true });
    ws.serverMessage({ type: "ignored" });
    ws.serverMessage({ type: "done" });

    await waitFor(() => {
      expect(screen.queryByText("ignored (no name)")).toBeNull();
    });
    expect(screen.queryByText("noise")).toBeNull();
    expect(screen.queryByText("You:")).toBeNull();
  });

  it("never lets board updates displace the conversation", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      driver = {
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
        onFrame: callbacks.onFrame,
      };
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    // The conversation socket is up before speech: no per-turn socket.
    FakeWs.instances[0].open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    driver!.onSpeechStart();
    const ws = FakeWs.instances[0];
    for (let i = 0; i < 8; i += 1) driver!.onFrame?.(new Int16Array(960).fill(4000));
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "transcript", transcript: "vale, hi", final: true });
    ws.serverMessage({ type: "reply", text: "Hi, I am Vale." });
    ws.serverMessage({
      type: "board",
      board: {
        session: {
          id: 7,
          clientName: "David",
          serviceName: "Gel manicure",
          startedAt: "2026-11-04T00:00:00.000Z",
        },
        card: null,
        list: [],
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Hi, I am Vale.")).toBeDefined();
    });
    // A board refresh lands mid-conversation: bubbles stand.
    ws.serverMessage({
      type: "board",
      board: {
        session: {
          id: 7,
          clientName: "David",
          serviceName: "Gel manicure",
          startedAt: "2026-11-04T00:00:00.000Z",
        },
        card: null,
        list: [],
      },
    });
    await waitFor(() => {
      expect(screen.getByText("vale, hi")).toBeDefined();
    });
    expect(screen.getByText("Hi, I am Vale.")).toBeDefined();
    expect(screen.getByRole("log", { name: "Conversation" })).toBeDefined();
  });

  it("holds her reply through speaker echo, then serves the next turn", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["fake-wav"]))),
    );
    const { played } = stubSeamlessPlayback();
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      driver = {
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
        onFrame: callbacks.onFrame,
      };
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });
    speakAudibleRef.current = false;

    setVoiceEngine("seamless");
    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    // The conversation socket is up before speech: no per-turn socket.
    FakeWs.instances[0].open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    const ws = FakeWs.instances[0];
    const voiced = new Int16Array(960).fill(4000);
    const voice = (n: number) => {
      for (let i = 0; i < n; i += 1) driver!.onFrame?.(voiced);
    };
    driver!.onSpeechStart();
    voice(8);
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "reply", text: "Vale, I hear you." });
    await waitFor(() => {
      expect(screen.getByText("Vale, I hear you.")).toBeDefined();
    });
    ws.serverMessage({ type: "done" });

    // The speaker echo trips speech start while the reply is audible:
    // nothing is captured and the reply stays put.
    speakAudibleRef.current = true;
    mockStopSpeaking.mockClear();
    mockSpeak.mockClear();
    const playedBefore = played.length;
    const binaryBefore = ws.sentBinaryCount();
    const stringsBefore = ws.sentStrings().length;
    driver!.onSpeechStart();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    expect(screen.getByText("Vale, I hear you.")).toBeDefined();
    voice(8);
    expect(ws.sentBinaryCount()).toBe(binaryBefore);
    // The echo ends with the reply still playing: no turn, no wire traffic.
    driver!.onSpeechEnd();
    expect(ws.sentStrings()).toHaveLength(stringsBefore);
    expect(FakeWs.instances).toHaveLength(1);
    expect(screen.getByText("Vale, I hear you.")).toBeDefined();

    // She settles: the same session captures again, no reconnect, no cut.
    speakAudibleRef.current = false;
    driver!.onSpeechStart();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    expect(screen.getByText("Vale, I hear you.")).toBeDefined();
    voice(8);
    expect(ws.sentBinaryCount()).toBeGreaterThan(binaryBefore);
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "reply", text: "On it." });
    await waitFor(() => {
      expect(screen.getByText("On it.")).toBeDefined();
    });
    ws.serverMessage({ type: "done" });
    // One session socket all along; her first reply stood until the next
    // turn replaced it, and the new reply is spoken, never cut.
    expect(FakeWs.instances).toHaveLength(1);
    expect(played).toHaveLength(playedBefore + 1);
    expect(mockStopSpeaking).not.toHaveBeenCalled();
  });

  it("reopens the mic within 300 ms of her real last word", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no post", { status: 500 })));
    const setPausedSpy = vi.fn();
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      driver = {
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
        onFrame: callbacks.onFrame,
      };
      return {
        stop: () => {},
        state: () => "running",
        engine: () => "script" as const,
        setPaused: setPausedSpy,
      };
    });
    speakAudibleRef.current = false;

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    FakeWs.instances[0].open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    const ws = FakeWs.instances[0];
    await waitFor(() => {
      expect(screen.getByText("Listening")).toBeTruthy();
    });
    await waitFor(() => {
      expect(settleListener).not.toBeNull();
    });

    // Her reply is audible: frames mute the mic and the face speaks.
    speakAudibleRef.current = true;
    const voiced = new Int16Array(960).fill(4000);
    driver!.onSpeechStart();
    for (let i = 0; i < 8; i += 1) driver!.onFrame?.(voiced);
    driver!.onSpeechEnd();
    expect(setPausedSpy).toHaveBeenCalledWith(true);
    ws.serverMessage({ type: "reply", text: "On it." });
    await waitFor(() => {
      expect(screen.getByText("Speaking")).toBeTruthy();
    });

    // Her voice really ends: face, mic and server anchor follow at once.
    speakAudibleRef.current = false;
    settleListener!();
    await waitFor(() => {
      expect(screen.getByText("Listening")).toBeTruthy();
    });
    await waitFor(() => {
      expect(setPausedSpy).toHaveBeenCalledWith(false);
    });
    const spoken = ws
      .sentStrings()
      .map((raw) => JSON.parse(raw))
      .filter((msg) => msg.type === "spoken");
    expect(spoken).toHaveLength(1);
  });
});
