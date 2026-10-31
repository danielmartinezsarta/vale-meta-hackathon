import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";
import { finishStream, setVoiceEngine, speak, speakStream, stopSpeaking, voiceEngine } from "@/lib/speak";

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
  };
});

const mockStartCapture = vi.mocked(startCapture);
const mockSpeak = vi.mocked(speak);
const mockSpeakStream = vi.mocked(speakStream);
const mockFinishStream = vi.mocked(finishStream);
const mockStopSpeaking = vi.mocked(stopSpeaking);

class FakeWs {
  static instances: FakeWs[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeWs.instances.push(this);
  }
  send(): void {}
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
}

let driver: CaptureDriver | null = null;

afterEach(() => {
  cleanup();
  FakeWs.instances = [];
  setVoiceEngine("browser");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("browser voice output", () => {
  it("speaks the final reply and stops when Daniel talks", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no post", { status: 500 })));
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      driver = {
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
      };
      return { stop: () => {} };
    });

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    driver!.onSpeechStart();
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    ws.open();
    driver!.onSpeechEnd();

    // Deltas paint the screen and stream to the speaker at once.
    ws.serverMessage({ type: "reply-delta", text: "Te anoto mañana " });
    ws.serverMessage({ type: "reply-delta", text: "a las tres." });
    expect(mockSpeakStream).toHaveBeenCalledTimes(2);
    expect(mockSpeakStream).toHaveBeenCalledWith("Te anoto mañana ", "es");
    expect(mockSpeak).not.toHaveBeenCalled();

    // The final reply only flushes the streamed tail, never re-speaks.
    ws.serverMessage({ type: "reply", text: "Te anoto mañana a las tres." });
    await waitFor(() => {
      expect(mockFinishStream).toHaveBeenCalledTimes(1);
    });
    expect(mockSpeak).not.toHaveBeenCalled();

    // Daniel talks again: the audio cuts at once.
    driver!.onSpeechStart();
    expect(mockStopSpeaking).toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole("button", { name: "Use Seamless voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    driver!.onSpeechStart();
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    ws.open();
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
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    driver!.onSpeechStart();
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    ws.open();
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
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    driver!.onSpeechStart();
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    ws.open();
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

  it("does not cut its own reply on echo and drops the echo turn", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["fake-wav"]))),
    );
    stubSeamlessPlayback();
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      driver = {
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
      };
      return { stop: () => {} };
    });

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Use Seamless voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    driver!.onSpeechStart();
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    ws.open();
    driver!.onSpeechEnd();
    ws.serverMessage({ type: "reply", text: "Te escucho." });
    await waitFor(() => {
      expect(screen.getByText("Te escucho.")).toBeDefined();
    });

    // The speaker echo trips speech start while the reply is audible.
    mockStopSpeaking.mockClear();
    mockSpeak.mockClear();
    driver!.onSpeechStart();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
    expect(screen.getByText("Te escucho.")).toBeDefined();

    // The echo ends with the reply still playing: echo turn dropped silently,
    // the original reply untouched, nothing new spoken.
    driver!.onSpeechEnd();
    await waitFor(() => {
      expect(FakeWs.instances[1].readyState).toBe(3);
    });
    expect(screen.getByText("Te escucho.")).toBeDefined();
    expect(mockSpeak).not.toHaveBeenCalled();
    expect(mockStopSpeaking).not.toHaveBeenCalled();
  });
});
