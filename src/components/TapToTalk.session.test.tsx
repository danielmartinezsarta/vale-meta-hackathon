import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { SessionScreen } from "./SessionScreen";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

function stubGetUserMedia() {
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => stream },
  });
  vi.stubGlobal("WebSocket", undefined);
}

const STARTED_AT = new Date(Date.now() - 3723 * 1000).toISOString();

function sseBody(transcript: string, reply: string): {
  getReader: () => {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock: () => void;
  };
} {
  const encoder = new TextEncoder();
  const raw =
    `event: interim\ndata: {"transcript":"${transcript.slice(0, 5)}"}\n\n` +
    `event: final\ndata: {"transcript":"${transcript}","audioProcessedMs":800}\n\n` +
    `event: reply\ndata: {"text":${JSON.stringify(reply)}}\n\n` +
    `event: board\ndata: {"board":{"session":{"clientName":"Daniel","serviceName":"Gel manicure","startedAt":${JSON.stringify(STARTED_AT)}},"card":null,"list":[]}}\n\n` +
    "event: done\ndata: {}\n\n";
  const bytes = encoder.encode(raw);
  const first = bytes.slice(0, 13);
  const rest = bytes.slice(13);
  let step = 0;
  return {
    getReader: () => ({
      read: async () => {
        step += 1;
        if (step === 1) return { done: false, value: first };
        if (step === 2) return { done: false, value: rest };
        return { done: true, value: undefined };
      },
      releaseLock: () => {},
    }),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("in-session screen (names, stopwatch, sheets)", () => {
  function driveSession() {
    stubGetUserMedia();
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      const frame = new Int16Array(960).fill(4000);
      window.setTimeout(() => {
        callbacks.onFrame(frame);
        callbacks.onSpeechStart();
        for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
        callbacks.onSpeechEnd();
      }, 0);
      return { stop: () => {}, state: () => "running" };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        body: sseBody("vale open a session", "Done, session open."),
      })),
    );
  }

  it("shows the client, service and running stopwatch once the table opens", async () => {
    driveSession();
    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(screen.getByText("Daniel")).toBeTruthy();
    });
    expect(screen.getByText("Gel manicure")).toBeTruthy();
    expect(screen.getByRole("timer", { name: "Session time" })).toBeTruthy();
    expect(screen.getByText(/01:02:0[3-9]/)).toBeTruthy();
  });

  it("opens the camera options and fires the photo type", async () => {
    const onPhotoType = vi.fn();
    render(
      <SessionScreen
        mode="day"
        robotState="idle"
        bubbles={[]}
        widget={null}
        language="en"
        session={{ clientName: "Daniel", serviceName: "Gel manicure", startedAt: STARTED_AT }}
        muted={false}
        notice={null}
        alert={null}
        onToggleMute={() => {}}
        onSleep={() => {}}
        onPhotoType={onPhotoType}
        onCloseWidget={() => {}}
        onVote={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    expect(
      screen.getByRole("dialog", { name: "Photo type" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Final photo"));
    expect(onPhotoType).toHaveBeenCalledWith("final");
  });

  it("opens the full photos sheet with the Muse Image preview tag", () => {
    render(
      <SessionScreen
        mode="day"
        robotState="idle"
        bubbles={[]}
        widget={null}
        language="en"
        session={{ clientName: "Daniel", serviceName: "Gel manicure", startedAt: STARTED_AT }}
        muted={false}
        notice={null}
        alert={null}
        onToggleMute={() => {}}
        onSleep={() => {}}
        onPhotoType={() => {}}
        onCloseWidget={() => {}}
        onVote={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Photos: before, reference and expected result",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Photos" })).toBeTruthy();
    expect(screen.getByText("Preview by Muse Image")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close photos" }));
    expect(screen.queryByRole("dialog", { name: "Photos" })).toBeNull();
  });
});
