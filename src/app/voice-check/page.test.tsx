import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VoiceCheck from "./page";
import { speak } from "@/lib/speak";

vi.mock("@/lib/speak", () => ({
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
}));

const mockSpeak = vi.mocked(speak);

class FakeAudio {
  static last: FakeAudio | null = null;
  src: string;
  play = vi.fn(async () => {});
  pause = vi.fn(() => {});
  constructor(src?: string) {
    this.src = src ?? "";
    FakeAudio.last = this;
  }
}

const PHRASE =
  "Hola, soy Vale. Te anoto para el relleno de gel mañana a las tres.";

afterEach(() => {
  cleanup();
  FakeAudio.last = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voice check page", () => {
  it("plays the same phrase through the browser voice by default", () => {
    render(<VoiceCheck />);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(mockSpeak).toHaveBeenCalledWith(PHRASE);
    expect(screen.getByText(/Playing with the browser voice/)).toBeTruthy();
  });

  it("plays the same phrase through Seamless voice 10 when selected", async () => {
    const fetchMock = vi.fn(
      async (..._args: unknown[]) =>
        new Response(new Uint8Array([1, 2, 3]).buffer, {
          headers: { "X-Synthesis-Seconds": "6.15" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", { createObjectURL: () => "blob:fake" });

    render(<VoiceCheck />);
    fireEvent.click(screen.getByRole("radio", { name: "Seamless voice 10" }));
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => {
      expect(FakeAudio.last).not.toBeNull();
    });
    expect(FakeAudio.last!.play).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/api/seamless-voice?text=${encodeURIComponent(PHRASE)}`,
    );
    await waitFor(() => {
      expect(screen.getByText(/Playing Seamless voice 10/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText(/synthesis 6.15 s/)).toBeTruthy();
    });
  });
});
