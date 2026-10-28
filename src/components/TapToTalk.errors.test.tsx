import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
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
  callbacks.onFrame(frame);
  callbacks.onSpeechEnd();
}

function setupDevice() {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () =>
        ({ getTracks: () => [] }) as unknown as MediaStream,
    },
  });
  const seen: CaptureCallbacks[] = [];
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    seen.push(callbacks);
    return { stop: () => {} };
  });
  return seen;
}

function errorSse(message: string, code?: string): { getReader: () => {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock: () => void;
} } {
  const raw =
    'event: final\ndata: {"transcript":"book a refill","audioProcessedMs":800}\n\n' +
    `event: error\ndata: ${JSON.stringify({ message, code })}\n\n`;
  const bytes = new TextEncoder().encode(raw);
  let served = false;
  return {
    getReader: () => ({
      read: async () => {
        if (!served) {
          served = true;
          return { done: false, value: bytes };
        }
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

describe("plain-language errors (fake-device fallback)", () => {
  it("shows the not-configured message when the key is missing (test 22)", async () => {
    const seen = setupDevice();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({
          error: "Voice service is not configured. Try again later.",
        }),
      })) as unknown as typeof fetch,
    );

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not configured/i);
    expect(alert.textContent).not.toMatch(/at .*:[0-9]+/);
    expect(screen.queryByText("You:")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Tap to talk" }),
    ).toBeTruthy();
  });

  it("keeps the transcript bubble on model error (test 25)", async () => {
    const seen = setupDevice();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        body: errorSse(
          "Sorry, I had trouble answering. Tap to try again.",
          "E-MODEL",
        ),
      })) as unknown as typeof fetch,
    );

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/trouble answering/i);
    expect(alert.textContent).toMatch(/E-MODEL/);
    expect(screen.getByText("book a refill")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Tap to talk" }),
    ).toBeTruthy();
  });

  it("shows the service code when the connection drops (E-NET)", async () => {
    const seen = setupDevice();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    burst(seen[0]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Connection lost/i);
    expect(alert.textContent).toMatch(/E-NET/);
  });

  it("shows the meter while live and the code on the not-configured error", async () => {
    const seen = setupDevice();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({
          error: "Voice service is not configured. Try again later.",
          code: "E-NET",
        }),
      })) as unknown as typeof fetch,
    );

    render(<TapToTalk />);
    fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
    expect(
      screen.getByRole("meter", { name: "Microphone level" }),
    ).toBeTruthy();
    burst(seen[0]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not configured/i);
    expect(alert.textContent).toMatch(/E-NET/);
  });
});
