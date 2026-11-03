import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
import { SessionScreen } from "./SessionScreen";
import { startCapture } from "@/lib/capture";
import type { CaptureCallbacks } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

function stubGetUserMedia() {
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => stream },
  });
  stubVoiceSocket();
}

const STARTED_AT = new Date(Date.now() - 3723 * 1000).toISOString();

function answerSessionTurn(transcript: string, reply: string) {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({ type: "transcript", transcript, final: true });
  ws.serverMessage({ type: "reply", text: reply });
  ws.serverMessage({
    type: "board",
    board: {
      session: {
        clientName: "David",
        serviceName: "Gel manicure",
        startedAt: STARTED_AT,
      },
      card: null,
      list: [],
    },
  });
  ws.serverMessage({ type: "done" });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("in-session screen (names, stopwatch, sheets)", () => {
  const seen: CaptureCallbacks[] = [];
  function driveSession() {
    seen.length = 0;
    stubGetUserMedia();
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      seen.push(callbacks);
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no post", { status: 500 })),
    );
  }

  function burstOnce() {
    const frame = new Int16Array(960).fill(4000);
    seen[0].onFrame(frame);
    seen[0].onSpeechStart();
    for (let i = 0; i < 8; i += 1) seen[0].onFrame(frame);
    seen[0].onSpeechEnd();
  }

  it("shows the client, service and running stopwatch once the table opens", async () => {
    driveSession();
    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(seen.length).toBe(1);
    });
    burstOnce();
    await waitFor(() => {
      expect(
        FakeVoiceSocket.instances[0]
          .sentStrings()
          .some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });
    answerSessionTurn("vale open a session", "Done, session open.");
    await waitFor(() => {
      expect(screen.getByText("David")).toBeTruthy();
    });
    expect(screen.getByText("Gel manicure")).toBeTruthy();
    expect(screen.getByRole("timer", { name: "Session time" })).toBeTruthy();
    expect(screen.getByText(/01:02:0[3-9]/)).toBeTruthy();
  });

  it("opens the camera sheet through the widget", async () => {
    const onOpenWidget = vi.fn();
    render(
      <SessionScreen
        mode="day"
        robotState="idle"
        bubbles={[]}
        widget={null}
        language="en"
        session={{ id: 7, clientName: "David", serviceName: "Gel manicure", startedAt: STARTED_AT }}
        muted={false}
        notice={null}
        alert={null}
        onToggleMute={() => {}}
        onSleep={() => {}}
        onOpenWidget={onOpenWidget}
        onCloseWidget={() => {}}
        onVote={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    expect(onOpenWidget).toHaveBeenCalledWith({
      kind: "camera_save_as",
      title: "Save photo as",
      size: "half",
      data: {},
    });
  });

  it("opens the full photos sheet with the Muse Image tag", () => {
    const onOpenPhotos = vi.fn();
    render(
      <SessionScreen
        mode="day"
        robotState="idle"
        bubbles={[]}
        widget={null}
        language="en"
        session={{ id: 7, clientName: "David", serviceName: "Gel manicure", startedAt: STARTED_AT }}
        muted={false}
        notice={null}
        alert={null}
        onToggleMute={() => {}}
        onSleep={() => {}}
        onOpenWidget={onOpenPhotos}
        onCloseWidget={() => {}}
        onVote={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Photos: before, reference and expected result",
      }),
    );
    expect(onOpenPhotos).toHaveBeenCalledWith({
      kind: "photos",
      title: "Photos",
      size: "full",
      data: { before: null, reference: null, expected: null, final: null },
    });
  });
});

describe("already-open session on connect", () => {
  class FakeWs {
    static instances: FakeWs[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
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

  it("shows the running session with its timer before any turn", async () => {
    FakeWs.instances = [];
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    vi.stubGlobal("WebSocket", FakeWs);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no post", { status: 500 })));
    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "running",
      engine: () => "script" as const,
    }));
    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(FakeWs.instances).toHaveLength(1);
    });
    const ws = FakeWs.instances[0];
    ws.open();
    // The server sends the current board right on connect.
    ws.serverMessage({
      type: "board",
      board: {
        session: {
          clientName: "David",
          serviceName: "Gel manicure",
          startedAt: STARTED_AT,
        },
        card: null,
        list: [],
      },
    });
    await waitFor(() => {
      expect(screen.getByText("David")).toBeTruthy();
    });
    expect(screen.getByText("Gel manicure")).toBeTruthy();
    expect(screen.getByRole("timer", { name: "Session time" })).toBeTruthy();
    expect(screen.getByText(/01:02:0[3-9]/)).toBeTruthy();
  });
});
