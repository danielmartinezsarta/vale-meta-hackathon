import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
import { startCapture } from "@/lib/capture";
import type { CaptureCallbacks } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(() => ({ stop: () => {} })),
}));

const mockStartCapture = vi.mocked(startCapture);

function burst(callbacks: CaptureCallbacks) {
  const frame = new Int16Array(960).fill(4000);
  callbacks.onFrame(frame);
  callbacks.onSpeechStart();
  for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
  callbacks.onSpeechEnd();
}

function setupDevice() {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () =>
        ({ getTracks: () => [] }) as unknown as MediaStream,
    },
  });
  stubVoiceSocket();
  const seen: CaptureCallbacks[] = [];
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    seen.push(callbacks);
    return { stop: () => {}, state: () => "running", engine: () => "script" as const };
  });
  return seen;
}

function noAudioPost() {
  const fetchMock = vi.fn(
    async () => new Response("no post", { status: 500 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function liveSocket() {
  return FakeVoiceSocket.instances[0];
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("plain-language errors (fake-device fallback)", () => {
  it("shows the not-configured message when the key is missing (test 22)", async () => {
    const seen = setupDevice();
    const fetchMock = noAudioPost();

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);
    liveSocket().serverMessage({
      type: "error",
      message: "La voz no está configurada. Intenta de nuevo más tarde.",
      code: "E-NET",
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/configurada/i);
    expect(alert.textContent).not.toMatch(/at .*:[0-9]+/);
    expect(screen.queryByText("You:")).toBeNull();
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });

  it("keeps the transcript bubble on model error (test 25)", async () => {
    const seen = setupDevice();
    const fetchMock = noAudioPost();

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);
    liveSocket().serverMessage({
      type: "transcript",
      transcript: "book a refill",
      final: true,
    });
    liveSocket().serverMessage({
      type: "error",
      message: "Tuve un problema.",
      code: "E-MODEL",
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/tuve un problema/i);
    expect(alert.textContent).not.toMatch(/E-MODEL/);
    expect(screen.getByText("book a refill")).toBeTruthy();
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });

  it("voices the five-nails tool failure as her reply, not an alert", async () => {
    const seen = setupDevice();
    const fetchMock = noAudioPost();
    const message = "I need a photo with all five nails visible.";

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);
    liveSocket().serverMessage({
      type: "transcript",
      transcript: "check my nails",
      final: true,
    });
    liveSocket().serverMessage({ type: "reply", text: message });
    liveSocket().serverMessage({ type: "done" });

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    // Success path: the session stays live instead of ending with an alert.
    expect(screen.getByRole("button", { name: "Put Vale to sleep" })).toBeTruthy();
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });

  it("retries the session from the error alert icon without reloading", async () => {
    const seen = setupDevice();
    const fetchMock = noAudioPost();

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    expect(mockStartCapture).toHaveBeenCalledTimes(1);
    burst(seen[0]);
    liveSocket().serverMessage({
      type: "error",
      message: "Connection lost.",
      code: "E-NET",
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/connection lost/i);
    const retry = screen.getByRole("button", { name: "Try again" });
    // Alert row: one-line text first, retry icon inline at its right.
    expect(retry.previousElementSibling?.textContent).toMatch(/connection lost/i);
    fireEvent.click(retry);

    await waitFor(() => {
      expect(mockStartCapture).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });

  it("hides the service code when the connection drops (E-NET)", async () => {
    const seen = setupDevice();
    const fetchMock = noAudioPost();

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);
    liveSocket().serverMessage({
      type: "error",
      message: "Connection lost.",
      code: "E-NET",
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/connection lost/i);
    expect(alert.textContent).not.toMatch(/E-NET/);
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });

  it("shows the meter while live and no code on the not-configured error", async () => {
    const seen = setupDevice();
    const fetchMock = noAudioPost();

    render(<TapToTalk autoStart />);
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);
    liveSocket().serverMessage({
      type: "error",
      message: "La voz no está configurada. Intenta de nuevo más tarde.",
      code: "E-NET",
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/configurada/i);
    expect(alert.textContent).not.toMatch(/E-NET/);
    // Mount reads /api/status; turns still never POST.
    expect(
      fetchMock.mock.calls.every((call) =>
        String(call.at(0)).includes("/api/status"),
      ),
    ).toBe(true);
  });
});
