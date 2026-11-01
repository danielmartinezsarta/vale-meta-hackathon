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
  };
});

const mockStartCapture = vi.mocked(startCapture);
const mockSpeak = vi.mocked(speak);
const mockSpeakStream = vi.mocked(speakStream);
const mockFinishStream = vi.mocked(finishStream);
const mockStopSpeaking = vi.mocked(stopSpeaking);
/** Audibility the real (headless, silent) synth cannot report. */
const speakAudibleRef = { current: false };

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
  onSpeechEnd: () => void;
  onFrame?: (frame: Int16Array) => void;
}

let driver: CaptureDriver | null = null;

afterEach(() => {
  cleanup();
  FakeWs.instances = [];
  speakAudibleRef.current = false;
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
      return { stop: () => {}, state: () => "running" };
    });
    speakAudibleRef.current = false;

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    // The conversation socket is up before speech: no per-turn socket.
    FakeWs.instances[0].open();
    const ws = FakeWs.instances[0];
    const voiced = new Int16Array(960).fill(4000);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Listening");
    });

    // Her reply is audible: mic frames never reach the wire.
    speakAudibleRef.current = true;
    driver!.onFrame?.(voiced);
    driver!.onFrame?.(voiced);
    expect(ws.sentBinaryCount()).toBe(0);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Speaking");
    });

    // She settles: the same session captures again, no reconnect, no cut.
    speakAudibleRef.current = false;
    driver!.onSpeechStart();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    for (let i = 0; i < 8; i += 1) driver!.onFrame?.(voiced);
    driver!.onSpeechEnd();
    expect(ws.sentBinaryCount()).toBeGreaterThan(0);
    expect(FakeWs.instances).toHaveLength(1);
    // The posted turn claimed the state, so the mic-resume timer leaves it.
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Thinking");
    });
  });

  it("drops a sub-300ms blip before the wire: no turn, no cut, no window move", async () => {
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
      return { stop: () => {}, state: () => "running" };
    });
    speakAudibleRef.current = false;

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    FakeWs.instances[0].open();
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
    expect(mockStopSpeaking.mock.calls.length).toBe(stopsBefore);
    expect(screen.queryByRole("alert")).toBeNull();

    // The next real utterance flows as usual on a fresh turn.
    driver!.onSpeechStart();
    for (let i = 0; i < 8; i += 1) driver!.onFrame?.(voiced);
    driver!.onSpeechEnd();
    expect(endStreams()).toBe(1);
    expect(FakeWs.instances).toHaveLength(1);
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

  it("toggles the engine without starting a turn", () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    render(<TapToTalk />);
    const toggle = screen.getByRole("button", { name: "Use Seamless voice" });
    expect(toggle.textContent).toContain("Voice: browser");
    fireEvent.click(toggle);
    expect(voiceEngine()).toBe("seamless");
    expect(
      screen.getByRole("button", { name: "Use browser voice" }).textContent,
    ).toContain("Voice: Seamless");
    fireEvent.click(
      screen.getByRole("button", { name: "Use browser voice" }),
    );
    expect(voiceEngine()).toBe("browser");
  });

  it("requests echo cancellation and noise suppression on the mic", async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
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
      return { stop: () => {}, state: () => "running" };
    });

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Use Seamless voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    // The conversation socket is up before speech: no per-turn socket.
    FakeWs.instances[0].open();
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

  it("renders ignored turns dimmed with a label, never as dialogue", async () => {
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
      return { stop: () => {}, state: () => "running" };
    });

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    // The conversation socket is up before speech: no per-turn socket.
    FakeWs.instances[0].open();
    driver!.onSpeechStart();
    const ws = FakeWs.instances[0];
    for (let i = 0; i < 8; i += 1) driver!.onFrame?.(new Int16Array(960).fill(4000));
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "transcript", transcript: "noise", final: true });
    ws.serverMessage({ type: "ignored" });
    ws.serverMessage({ type: "done" });

    await waitFor(() => {
      expect(screen.getByText("ignored (no name)")).toBeDefined();
    });
    const item = screen.getByText("ignored (no name)").closest("li");
    expect(item?.getAttribute("style")).toContain("opacity");
    expect(screen.queryByText("You:")).toBeNull();
  });

  it("never lets the board displace the conversation", async () => {
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
      return { stop: () => {}, state: () => "running" };
    });

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    // The conversation socket is up before speech: no per-turn socket.
    FakeWs.instances[0].open();
    driver!.onSpeechStart();
    const ws = FakeWs.instances[0];
    for (let i = 0; i < 8; i += 1) driver!.onFrame?.(new Int16Array(960).fill(4000));
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "transcript", transcript: "vale, hi", final: true });
    ws.serverMessage({ type: "reply", text: "Hi, I am Vale." });
    ws.serverMessage({
      type: "board",
      board: { session: null, card: null, list: [] },
    });

    await waitFor(() => {
      expect(screen.getByText("Hi, I am Vale.")).toBeDefined();
    });
    const turns = screen.getByRole("list", { name: "Conversation turns" });
    const board = screen.getByRole("heading", { name: "Shopping list" });
    expect(
      turns.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
      return { stop: () => {}, state: () => "running" };
    });
    speakAudibleRef.current = false;

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Use Seamless voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    // The conversation socket is up before speech: no per-turn socket.
    FakeWs.instances[0].open();
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
});
