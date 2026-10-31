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
  fail(): void {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
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
    return { stop: () => {}, state: () => "running" };
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

describe("live bridge (TapToTalk over WebSocket, conversation socket)", () => {
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

    // Session start dials one conversation socket.
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    expect(ws.url).toContain("/voice");
    ws.open();
    expect(ws.sentStrings()).toContain(
      JSON.stringify({ type: "language", language: "en" }),
    );
    expect(ws.sentStrings()).toContain(JSON.stringify({ type: "wake" }));

    driver!.onFrame(speechFrame());
    driver!.onSpeechStart();
    // No per-turn socket while the conversation socket is up.
    expect(FakeWs.instances).toHaveLength(1);

    for (let i = 0; i < 8; i += 1) driver!.onFrame(speechFrame());
    expect(ws.sentBinaryCount()).toBeGreaterThan(0);

    // End of speech: a JSON control ends the turn (never audio bytes).
    driver!.onSpeechEnd();
    await waitFor(() => {
      expect(
        ws.sentStrings().some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });

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

    // Whole turn over the socket: the POST fallback never fired.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the selector language when the socket opens, EN by default", async () => {
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
    FakeWs.instances[0].open();
    expect(FakeWs.instances[0].sentStrings()).toContain(
      JSON.stringify({ type: "language", language: "en" }),
    );

    // Switch to Spanish and tap again: the new session socket carries ES.
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(2);
    });
    FakeWs.instances[1].open();
    expect(FakeWs.instances[1].sentStrings()).toContain(
      JSON.stringify({ type: "language", language: "en" }),
    );
  });

  it("falls back to POST when the conversation socket drops mid-turn", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    const raw =
      `event: final\ndata: {"transcript":"fallback final","audioProcessedMs":800}\n\n` +
      `event: reply\ndata: {"text":"fallback reply"}\n\n` +
      "event: done\ndata: {}\n\n";
    const bytes = new TextEncoder().encode(raw);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    stubSessionOnce();

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const first = FakeWs.instances[0];
    expect(first.url).toContain("/voice");
    first.open();
    driver!.onSpeechStart();
    for (let i = 0; i < 8; i += 1) driver!.onFrame(speechFrame());

    // Drop before speech end: the turn falls back to POST, no alert.
    first.drop();
    driver!.onSpeechEnd();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText("fallback reply")).toBeTruthy();
    });
    expect(screen.queryByRole("alert")).toBeNull();
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
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    expect(ws.url).toContain("/voice");
    ws.open();
    driver!.onSpeechStart();
    for (let i = 0; i < 8; i += 1) driver!.onFrame(speechFrame());
    driver!.onSpeechEnd();
    await waitFor(() => {
      expect(
        ws.sentStrings().some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });

    ws.serverMessage({
      type: "error",
      message: "Se perdió la conexión. Toca para intentar de nuevo.",
      code: "E-ASR",
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toContain("Se perdió la conexión");
    expect(screen.getByRole("alert").textContent).not.toContain("E-ASR");
  });
});
