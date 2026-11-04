import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

function stubMic() {
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  stubVoiceSocket();
}

function answerEmptyTurn() {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({ type: "transcript", transcript: "", final: true });
  ws.serverMessage({ type: "done" });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("empty turns stay hidden (fix 1)", () => {
  it("an empty open turn draws no row and keeps the listening hint", async () => {
    stubMic();

    mockStartCapture.mockImplementation(() => ({
      stop: () => {},
      state: () => "running",
      engine: () => "script" as const,
    }));
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk autoStart />);

    await waitFor(() => {
      expect(
        screen.getByText("Listening"),
      ).toBeTruthy();
    });

    expect(
      screen.getByLabelText("Conversation").querySelectorAll("li"),
    ).toHaveLength(0);
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Put Vale to sleep" }));
    await waitFor(() => {
      expect(screen.getByText("Asleep")).toBeTruthy();
    });
  });

  it("a closed turn that never showed anything is pruned", async () => {
    stubMic();

    // Later turns stay silent so the session waits.
    let fired = false;
    mockStartCapture.mockImplementation((_stream, callbacks) => {
      if (fired) return { stop: () => {}, state: () => "running", engine: () => "script" as const };
      fired = true;
      const frame = new Int16Array(960).fill(4000);
      window.setTimeout(() => {
        callbacks.onFrame(frame);
        callbacks.onSpeechStart();
        for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
        callbacks.onSpeechEnd();
      }, 0);
      return { stop: () => {}, state: () => "running", engine: () => "script" as const };
    });

    const fetchMock = vi.fn(async () => new Response("no post", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TapToTalk autoStart />);

    await waitFor(() => {
      expect(
        FakeVoiceSocket.instances[0]
          .sentStrings()
          .some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });
    answerEmptyTurn();
    await waitFor(() => {
      expect(
        screen.getByText("Listening"),
      ).toBeTruthy();
    });
    expect(
      screen.getByLabelText("Conversation").querySelectorAll("li"),
    ).toHaveLength(0);
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Put Vale to sleep" }));
    await waitFor(() => {
      expect(screen.getByText("Asleep")).toBeTruthy();
    });
  });
});
