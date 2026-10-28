import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

/** Scriptable stand-in for the browser WebSocket (proposal A bridge). */
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
  /** Never connects: refused, like a blocked upgrade. */
  fail(): void {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
  }
  /** Mid-turn drop after a live connection. */
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
  sentBinaryCount(): number {
    return this.sent.filter((item) => item instanceof ArrayBuffer).length;
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

describe("live bridge (TapToTalk over WebSocket, proposal A)", () => {
  it("streams frames live, shows CUMULATIVE partials, freezes the final and replies", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    stubSessionOnce();

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });

    // Speech starts: one bridge socket for the turn, no POST.
    driver!.onFrame(speechFrame());
    driver!.onSpeechStart();
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    expect(ws.url).toContain("/api/voice");
    ws.open();

    // Live audio streams as binary while the person still speaks.
    driver!.onFrame(speechFrame());
    expect(ws.sentBinaryCount()).toBeGreaterThan(0);

    // End of speech: a JSON control ends the turn (never audio bytes).
    driver!.onSpeechEnd();
    await waitFor(() => {
      expect(
        ws.sentStrings().some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });

    // CUMULATIVE partials replace the interim bubble while talking.
    ws.serverMessage({ type: "transcript", transcript: "hel", final: false });
    await waitFor(() => {
      expect(screen.getByText("hel")).toBeTruthy();
    });
    ws.serverMessage({
      type: "transcript",
      transcript: "hello refill",
      final: true,
    });
    await waitFor(() => {
      expect(screen.getByText("hello refill")).toBeTruthy();
    });
    expect(screen.queryByText("hel")).toBeNull();

    ws.serverMessage({ type: "reply", text: "Booked in." });
    await waitFor(() => {
      expect(screen.getByText("Booked in.")).toBeTruthy();
    });
    ws.serverMessage({ type: "done" });

    // The whole turn ran over the socket: the POST fallback never fired.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reopens once after a mid-turn drop and replays the buffered audio", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    stubSessionOnce();

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    driver!.onSpeechStart();
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const first = FakeWs.instances[0];
    first.open();
    driver!.onFrame(speechFrame());
    driver!.onSpeechEnd();
    await waitFor(() => {
      expect(
        first.sentStrings().some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });

    // Drop before any final: the client reopens once and replays the turn.
    first.drop();
    await waitFor(
      () => {
        expect(FakeWs.instances).toHaveLength(2);
      },
      { timeout: 3000 },
    );
    const second = FakeWs.instances[1];
    second.open();
    await waitFor(() => {
      expect(second.sentBinaryCount()).toBeGreaterThan(0);
    });
    expect(
      second.sentStrings().some((raw) => raw.includes("endStream")),
    ).toBe(true);

    second.serverMessage({
      type: "transcript",
      transcript: "hello refill",
      final: true,
    });
    await waitFor(() => {
      expect(screen.getByText("hello refill")).toBeTruthy();
    });
    second.serverMessage({ type: "reply", text: "Booked in." });
    await waitFor(() => {
      expect(screen.getByText("Booked in.")).toBeTruthy();
    });
    second.serverMessage({ type: "done" });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server error code on screen when the bridge fails", async () => {
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
    driver!.onSpeechStart();
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    ws.open();
    driver!.onFrame(speechFrame());
    driver!.onSpeechEnd();

    ws.serverMessage({
      type: "error",
      message: "Connection lost. Tap to try again.",
      code: "E-ASR",
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toContain("(E-ASR)");
  });
});
