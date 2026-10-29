import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";
import { setVoiceEngine, speak, stopSpeaking, voiceEngine } from "@/lib/speak";

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
    stopSpeaking: vi.fn((...args: Parameters<typeof actual.stopSpeaking>) =>
      actual.stopSpeaking(...args),
    ),
  };
});

const mockStartCapture = vi.mocked(startCapture);
const mockSpeak = vi.mocked(speak);
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

    // Deltas paint the screen but stay silent.
    ws.serverMessage({ type: "reply-delta", text: "Te anoto mañana " });
    ws.serverMessage({ type: "reply-delta", text: "a las tres." });
    expect(mockSpeak).not.toHaveBeenCalled();

    // The final reply speaks once, word for word.
    ws.serverMessage({ type: "reply", text: "Te anoto mañana a las tres." });
    await waitFor(() => {
      expect(mockSpeak).toHaveBeenCalledTimes(1);
    });
    expect(mockSpeak).toHaveBeenCalledWith("Te anoto mañana a las tres.");

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
    expect(mockSpeak).toHaveBeenCalledWith("Sesión abierta.");
    expect(mockSpeak).toHaveBeenCalledWith("Sesión abierta.");
  });
});
