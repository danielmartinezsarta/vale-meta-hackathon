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
  it("transcribes over its audible reply and cuts only on a named, dissimilar interrupt", async () => {
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
      return { stop: () => {} };
    });
    speakAudibleRef.current = false;

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
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
    const frame = new Int16Array(960);
    const endStreams = () =>
      ws.sentStrings().filter((raw) => raw.includes("endStream")).length;

    // Silence: speech cuts nothing (nothing to cut) and the turn rides the
    // conversation socket, never the buffered POST.
    driver!.onSpeechStart();
    expect(mockStopSpeaking).toHaveBeenCalledTimes(1);
    driver!.onFrame?.(frame);
    driver!.onSpeechEnd();
    expect(endStreams()).toBe(1);

    // Deltas paint the screen and stream to the speaker at once. The reply is
    // still streaming: no reply, no done, the turn stays open.
    ws.serverMessage({ type: "reply-delta", text: "Te anoto mañana " });
    ws.serverMessage({ type: "reply-delta", text: "a las tres." });
    expect(mockSpeakStream).toHaveBeenCalledTimes(2);
    expect(mockSpeakStream).toHaveBeenCalledWith("Te anoto mañana ", "es");
    expect(mockSpeak).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText("Te anoto mañana a las tres.")).toBeDefined();
    });

    // Her reply audible: speech without the name is transcribed, never cut,
    // and never dismisses her text. The server bins it as echo (gate:eco).
    speakAudibleRef.current = true;
    mockStopSpeaking.mockClear();
    const binaryBefore = ws.sentBinaryCount();
    driver!.onSpeechStart();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    expect(FakeWs.instances).toHaveLength(1);
    driver!.onFrame?.(frame);
    driver!.onFrame?.(frame);
    expect(ws.sentBinaryCount()).toBeGreaterThan(binaryBefore);
    driver!.onSpeechEnd();
    expect(endStreams()).toBe(2);
    ws.serverMessage({
      type: "transcript",
      transcript: "Hey there great to hear you",
    });
    ws.serverMessage({ type: "ignored" });
    ws.serverMessage({ type: "done" });
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    expect(screen.getByText("Te anoto mañana a las tres.")).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText("ignorado (sin nombre)")).toBeDefined();
    });

    // A named, dissimilar interrupt cuts her voice mid-sentence and dismisses
    // the streaming text.
    driver!.onSpeechStart();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    driver!.onFrame?.(frame);
    ws.serverMessage({
      type: "transcript",
      transcript: "Vale, book it November first",
    });
    expect(mockStopSpeaking).toHaveBeenCalledTimes(1);
    expect(mockStopSpeaking).toHaveBeenCalledWith("barge-in");
    await waitFor(() => {
      expect(screen.queryByText("Te anoto mañana a las tres.")).toBeNull();
    });
    driver!.onSpeechEnd();
    expect(endStreams()).toBe(3);
    ws.serverMessage({ type: "reply-delta", text: "Listo, " });
    ws.serverMessage({ type: "reply", text: "Listo, te agendo." });
    await waitFor(() => {
      expect(screen.getByText("Listo, te agendo.")).toBeDefined();
    });
    ws.serverMessage({ type: "done" });

    // Speech within 500 ms after her last audible frame still counts as
    // audible: no cut, no dismiss.
    driver!.onFrame?.(frame);
    speakAudibleRef.current = false;
    driver!.onSpeechStart();
    driver!.onFrame?.(frame);
    expect(mockStopSpeaking).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Listo, te agendo.")).toBeDefined();
    driver!.onSpeechEnd();
    expect(endStreams()).toBe(4);
    ws.serverMessage({ type: "ignored" });
    ws.serverMessage({ type: "done" });
    await waitFor(() => {
      expect(screen.getByText("Listo, te agendo.")).toBeDefined();
    });
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
      };
      return { stop: () => {} };
    });

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Seamless voice" }));
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
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
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "reply", text: "Sesión abierta." });
    await waitFor(() => {
      expect(played).toHaveLength(1);
    });
    expect(mockSpeak).toHaveBeenCalledWith("Sesión abierta.", "es");
    expect(mockSpeak).toHaveBeenCalledWith("Sesión abierta.", "es");
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
      };
      return { stop: () => {} };
    });

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
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
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "transcript", transcript: "ruido", final: true });
    ws.serverMessage({ type: "ignored" });
    ws.serverMessage({ type: "done" });

    await waitFor(() => {
      expect(screen.getByText("ignorado (sin nombre)")).toBeDefined();
    });
    const item = screen.getByText("ignorado (sin nombre)").closest("li");
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
      };
      return { stop: () => {} };
    });

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
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
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "transcript", transcript: "vale, hola", final: true });
    ws.serverMessage({ type: "reply", text: "Hola, soy Vale." });
    ws.serverMessage({
      type: "board",
      board: { session: null, card: null, list: [] },
    });

    await waitFor(() => {
      expect(screen.getByText("Hola, soy Vale.")).toBeDefined();
    });
    const turns = screen.getByRole("list", { name: "Conversation turns" });
    const board = screen.getByRole("heading", { name: "Lista de compras" });
    expect(
      turns.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("transcribes its audible reply as an ignored echo turn", async () => {
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
      return { stop: () => {} };
    });
    speakAudibleRef.current = false;

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Seamless voice" }));
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
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
    const frame = new Int16Array(960);
    driver!.onSpeechStart();
    driver!.onFrame?.(frame);
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "reply", text: "Vale, te escucho." });
    await waitFor(() => {
      expect(screen.getByText("Vale, te escucho.")).toBeDefined();
    });
    ws.serverMessage({ type: "done" });

    // The speaker echo trips speech start while the reply is audible: a
    // partial echo naming her is still echo, so no cut, no dismiss.
    speakAudibleRef.current = true;
    mockStopSpeaking.mockClear();
    mockSpeak.mockClear();
    const playedBefore = played.length;
    const binaryBefore = ws.sentBinaryCount();
    driver!.onSpeechStart();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    expect(screen.getByText("Vale, te escucho.")).toBeDefined();
    driver!.onFrame?.(frame);
    expect(ws.sentBinaryCount()).toBeGreaterThan(binaryBefore);
    ws.serverMessage({ type: "transcript", transcript: "Vale, te" });
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    expect(screen.getByText("Vale, te escucho.")).toBeDefined();

    // The echo ends with the reply still playing: transcribed and ignored
    // server-side, the original reply untouched, nothing new spoken.
    const endStreamsBefore = ws
      .sentStrings()
      .filter((raw) => raw.includes("endStream")).length;
    driver!.onSpeechEnd();
    expect(
      ws.sentStrings().filter((raw) => raw.includes("endStream")),
    ).toHaveLength(endStreamsBefore + 1);
    ws.serverMessage({ type: "ignored" });
    ws.serverMessage({ type: "done" });
    // No second socket, the original reply untouched, nothing new spoken.
    expect(FakeWs.instances).toHaveLength(1);
    expect(screen.getByText("Vale, te escucho.")).toBeDefined();
    expect(played).toHaveLength(playedBefore);
    expect(mockSpeak).not.toHaveBeenCalled();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
  });
});
