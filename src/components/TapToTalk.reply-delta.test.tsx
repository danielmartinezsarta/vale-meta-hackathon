import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

class FakeWs {
  static instances: FakeWs[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
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
  onFrame: (frame: Int16Array) => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

let driver: CaptureDriver | null = null;

function stubSessionOnce() {
  driver = null;
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    if (!driver) {
      driver = {
        onFrame: callbacks.onFrame,
        onSpeechStart: callbacks.onSpeechStart,
        onSpeechEnd: callbacks.onSpeechEnd,
      };
    }
    return { stop: () => {} };
  });
}

function speechFrame(): Int16Array {
  return new Int16Array(960).fill(4000);
}

afterEach(() => {
  cleanup();
  FakeWs.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reply streaming (transient output fix)", () => {
  it("appends reply-delta fragments instead of replacing", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no post", { status: 500 })));
    stubSessionOnce();

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
    driver!.onFrame(speechFrame());
    driver!.onSpeechStart();
    for (let i = 0; i < 8; i += 1) driver!.onFrame(speechFrame());
    driver!.onSpeechEnd();

    ws.serverMessage({ type: "transcript", transcript: "five november", final: true });
    await waitFor(() => {
      expect(screen.getByText("five november")).toBeTruthy();
    });

    ws.serverMessage({ type: "reply-delta", text: "El cinco de noviembre tengo " });
    await waitFor(() => {
      expect(screen.getByText("El cinco de noviembre tengo")).toBeTruthy();
    });
    ws.serverMessage({ type: "reply-delta", text: "a las diez." });
    await waitFor(() => {
      expect(screen.getByText("El cinco de noviembre tengo a las diez.")).toBeTruthy();
    });

    // The final reply paints the complete text.
    ws.serverMessage({ type: "reply", text: "El cinco de noviembre tengo a las diez." });
    await waitFor(() => {
      expect(screen.getByText("El cinco de noviembre tengo a las diez.")).toBeTruthy();
    });
    ws.serverMessage({ type: "done" });
  });
});
