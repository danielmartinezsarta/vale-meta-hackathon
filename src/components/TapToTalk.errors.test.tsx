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
          error: "La voz no está configurada. Intenta de nuevo más tarde.",
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
    expect(alert.textContent).toMatch(/configurada/i);
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
          "Perdón, tuve un problema. Toca para intentar de nuevo.",
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
    expect(alert.textContent).toMatch(/tuve un problema/i);
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
    expect(alert.textContent).toMatch(/perdió la conexión/i);
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
          error: "La voz no está configurada. Intenta de nuevo más tarde.",
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
    expect(alert.textContent).toMatch(/configurada/i);
    expect(alert.textContent).toMatch(/E-NET/);
  });
});
