import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live turn over one socket (no buffered upload)", () => {
  it("streams a speech burst live, interim still renders, never POSTs", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    stubVoiceSocket();

    // One speech burst on the first capture only; later turns stay silent.
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

    render(<TapToTalk debug />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await waitFor(() => {
      expect(FakeVoiceSocket.instances).toHaveLength(1);
    });
    const ws = FakeVoiceSocket.instances[0];
    // The burst rides the socket live: binary audio, one JSON endStream.
    await waitFor(() => {
      expect(ws.sentBinaryCount()).toBeGreaterThan(0);
    });
    ws.serverMessage({ type: "transcript", transcript: "hello", final: false });
    await waitFor(() => {
      expect(screen.getByText("hello")).toBeTruthy();
    });
    await waitFor(() => {
      expect(
        ws.sentStrings().some((raw) => raw.includes("endStream")),
      ).toBe(true);
    });

    ws.serverMessage({
      type: "transcript",
      transcript: "hello refill",
      final: true,
    });
    await waitFor(() => {
      expect(screen.getByText("hello refill")).toBeTruthy();
    });
    ws.serverMessage({ type: "reply", text: "Booked in." });
    await waitFor(() => {
      expect(screen.getByText("Booked in.")).toBeTruthy();
    });
    ws.serverMessage({ type: "done" });

    // One transport: the POST upload path never fires.
    expect(fetchMock).not.toHaveBeenCalled();

    // Interim is replaced by the final.
    expect(screen.queryByText("hello")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Tap to talk" })).toBeTruthy();
    });
  });
});
