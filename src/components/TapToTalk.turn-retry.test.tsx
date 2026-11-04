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
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  serverMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  sentStrings(): string[] {
    return this.sent.filter((item) => typeof item === "string") as string[];
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
    return { stop: () => {}, state: () => "running", engine: () => "script" as const };
  });
}

function speechFrame(): Int16Array {
  return new Int16Array(960).fill(4000);
}

function answerTurn(
  ws: FakeWs,
  transcript: string,
  reply: string,
) {
  ws.serverMessage({ type: "transcript", transcript, final: true });
  ws.serverMessage({ type: "reply", text: reply });
  ws.serverMessage({ type: "done" });
}

afterEach(() => {
  cleanup();
  FakeWs.instances = [];
  driver = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("socket drop reconnects on the same path, never POSTs", () => {
  it("drop mid-turn and drop after the end: the reply still arrives under its own turn", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    stubSessionOnce();

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const first = FakeWs.instances[0];
    expect(first.url).toContain("/voice");
    first.open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });

    driver!.onFrame(speechFrame());
    driver!.onSpeechStart();
    for (let i = 0; i < 8; i += 1) driver!.onFrame(speechFrame());
    driver!.onSpeechEnd();
    answerTurn(first, "first final", "first reply from Vale");
    await waitFor(() => {
      expect(screen.getByText("first reply from Vale")).toBeTruthy();
    });

    // Drop mid-turn: backoff redials /voice and replays the buffered turn.
    driver!.onFrame(speechFrame());
    driver!.onSpeechStart();
    for (let i = 0; i < 8; i += 1) driver!.onFrame(speechFrame());
    first.drop();
    await waitFor(
      () => {
        expect(FakeWs.instances).toHaveLength(2);
      },
      { timeout: 5000 },
    );
    const second = FakeWs.instances[1];
    expect(second.url).toContain("/voice");
    second.open();
    driver!.onSpeechEnd();
    await waitFor(() => {
      expect(
        second.sentStrings().some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });
    // The live turn replayed on reconnect: buffered frames rode again.
    expect(
      second.sent.filter((item) => item instanceof ArrayBuffer).length,
    ).toBeGreaterThan(0);
    answerTurn(second, "second final", "second reply from Vale");

    await waitFor(() => {
      expect(screen.getByText("second reply from Vale")).toBeTruthy();
    });
    // One transport: two /voice sockets total, no POST, no alert.
    expect(FakeWs.instances).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("first reply from Vale")).toBeTruthy();
    expect(screen.getByText("second final")).toBeTruthy();
    expect(screen.getAllByText("Vale:")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Put Vale to sleep" }));
    await waitFor(() => {
      expect(screen.getByText("Asleep")).toBeTruthy();
    });
  });
});
