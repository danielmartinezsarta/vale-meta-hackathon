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
    return { stop: () => {}, state: () => "running", engine: () => "script" as const };
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

    render(<TapToTalk autoStart />);

    // Session start dials one conversation socket; capture waits for it.
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    expect(ws.url).toContain("/voice");
    ws.open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
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

    render(<TapToTalk autoStart />);

    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    FakeWs.instances[0].open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    expect(FakeWs.instances[0].sentStrings()).toContain(
      JSON.stringify({ type: "language", language: "en" }),
    );
  });

  it("sends the saved Spanish language when the socket opens", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no post", { status: 500 })));
    stubSessionOnce();
    window.localStorage.setItem("vale-language", "es");

    render(<TapToTalk autoStart />);

    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    FakeWs.instances[0].open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
    expect(FakeWs.instances[0].sentStrings()).toContain(
      JSON.stringify({ type: "language", language: "es" }),
    );
    window.localStorage.removeItem("vale-language");
  });

  it("reconnects when the conversation socket drops mid-turn, never POSTs", async () => {
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
    driver!.onSpeechStart();
    for (let i = 0; i < 8; i += 1) driver!.onFrame(speechFrame());
    expect(first.sentBinaryCount()).toBeGreaterThan(0);

    // Drop before speech end: backoff redials the same path, no alert.
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
    // The live turn replays on reconnect: buffered frames ride again.
    expect(second.sentBinaryCount()).toBeGreaterThan(0);

    driver!.onSpeechEnd();
    await waitFor(() => {
      expect(
        second.sentStrings().some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });

    second.serverMessage({
      type: "transcript",
      transcript: "reconnected final",
      final: true,
    });
    await waitFor(() => {
      expect(screen.getByText("reconnected final")).toBeTruthy();
    });
    second.serverMessage({ type: "reply", text: "reconnected reply" });
    await waitFor(() => {
      expect(screen.getByText("reconnected reply")).toBeTruthy();
    });
    second.serverMessage({ type: "done" });

    // One transport: no per-turn socket, no POST, no alert.
    expect(FakeWs.instances.every((ws) => ws.url.includes("/voice"))).toBe(
      true,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a visible error and captures nothing when /voice never opens", async () => {
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
    // Hanging in CONNECTING: the socket never opens.

    await waitFor(
      () => {
        expect(screen.getByRole("alert")).toBeTruthy();
      },
      { timeout: 8000 },
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "The connection dropped",
    );
    // Nothing captured, nothing posted: no socket opens for a blip.
    expect(mockStartCapture).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWs.instances).toHaveLength(1);
  });

  it("shows the server error code on screen when the bridge fails", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no post", { status: 500 })));
    stubSessionOnce();

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    expect(ws.url).toContain("/voice");
    ws.open();
    await waitFor(() => {
      expect(driver).not.toBeNull();
    });
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
