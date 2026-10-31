import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { VoiceControls } from "./VoiceControls";
import { setVoicePrefs } from "@/lib/speak";

function fakeVoice(name: string, lang: string): SpeechSynthesisVoice {
  return { name, lang } as SpeechSynthesisVoice;
}

function stubSpeechSynthesis(voices: SpeechSynthesisVoice[]) {
  const synth = {
    cancel: vi.fn(),
    getVoices: vi.fn(() => voices),
    speak: vi.fn(),
  };
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      text: string;
      lang = "";
      voice: SpeechSynthesisVoice | null = null;
      rate = 1;
      pitch = 1;
      constructor(text: string) {
        this.text = text;
      }
    },
  );
  vi.stubGlobal("speechSynthesis", synth);
  Object.defineProperty(window, "speechSynthesis", {
    value: synth,
    configurable: true,
    writable: true,
  });
  return { synth };
}

const VOICES = [
  fakeVoice("Albert", "en-US"),
  fakeVoice("Ava (Premium)", "en-US"),
  fakeVoice("Google US English", "en-US"),
  fakeVoice("Jorge", "es-MX"),
];

function renderTalk() {
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  render(<TapToTalk />);
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem("vale-voice");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voice controls", () => {
  it("lists English voices without jokes or other languages", async () => {
    stubSpeechSynthesis(VOICES);
    renderTalk();
    const select = screen.getByRole("combobox", { name: "Voice" });
    await waitFor(() => {
      expect(select.querySelectorAll("option")).toHaveLength(3);
    });
    const names = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(names).toContain("Ava (Premium)");
    expect(names).toContain("Google US English");
    expect(names).not.toContain("Albert");
    expect(names).not.toContain("Jorge");
  });

  it("persists the picked voice and logs it", async () => {
    stubSpeechSynthesis(VOICES);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(String(line));
    });
    try {
      renderTalk();
      const select = screen.getByRole("combobox", { name: "Voice" });
      await waitFor(() => {
        expect(select.querySelectorAll("option")).toHaveLength(3);
      });
      fireEvent.change(select, { target: { value: "Google US English" } });
      expect(JSON.parse(window.localStorage.getItem("vale-voice") ?? "{}")).toMatchObject({
        voiceEn: "Google US English",
      });
      expect(logs.some((line) => line.startsWith("[voice] using:"))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("clamps speed and pitch to the allowed range", async () => {
    stubSpeechSynthesis(VOICES);
    renderTalk();
    const speed = screen.getByRole("slider", { name: "Speed" });
    const pitch = screen.getByRole("slider", { name: "Pitch" });
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Voice" })).toBeDefined();
    });
    fireEvent.change(speed, { target: { value: "2.0" } });
    fireEvent.change(pitch, { target: { value: "0.1" } });
    expect((speed as HTMLInputElement).value).toBe("1.3");
    expect((pitch as HTMLInputElement).value).toBe("0.8");
    expect(JSON.parse(window.localStorage.getItem("vale-voice") ?? "{}")).toMatchObject({
      rateEn: 1.3,
      pitchEn: 0.8,
    });
  });

  it("tests the picked voice at the picked speed", async () => {
    const { synth } = stubSpeechSynthesis(VOICES);
    renderTalk();
    const select = screen.getByRole("combobox", { name: "Voice" });
    await waitFor(() => {
      expect(select.querySelectorAll("option")).toHaveLength(3);
    });
    fireEvent.change(select, { target: { value: "Ava (Premium)" } });
    fireEvent.change(screen.getByRole("slider", { name: "Speed" }), {
      target: { value: "1.2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => {
      expect(synth.speak).toHaveBeenCalled();
    });
    const said = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance & {
      voice: SpeechSynthesisVoice;
      rate: number;
    };
    expect(said.text).toContain("Vah-leh");
    expect(said.text).not.toContain("Vale");
    expect(said.voice.name).toBe("Ava (Premium)");
    expect(said.rate).toBe(1.2);
  });

  it("shows only Spanish voices for Spanish and saves per language", async () => {
    stubSpeechSynthesis(VOICES);
    render(<VoiceControls language="es" />);
    const select = screen.getByRole("combobox", { name: "Voice" });
    await waitFor(() => {
      expect(select.querySelectorAll("option")).toHaveLength(2);
    });
    const names = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(names).toContain("Jorge");
    expect(names).not.toContain("Ava (Premium)");
    fireEvent.change(select, { target: { value: "Jorge" } });
    expect(JSON.parse(window.localStorage.getItem("vale-voice") ?? "{}")).toMatchObject({
      voiceEs: "Jorge",
    });
  });

  it("switches the voice list and prosody with the language selector", async () => {
    setVoicePrefs({
      voiceEn: null,
      voiceEs: null,
      rateEn: 0.9,
      pitchEn: 0.9,
      rateEs: 0.9,
      pitchEs: 0.9,
    });
    stubSpeechSynthesis(VOICES);
    renderTalk();
    const select = screen.getByRole("combobox", { name: "Voice" });
    await waitFor(() => {
      expect(select.querySelectorAll("option")).toHaveLength(3);
    });
    // English default: Ava on top, no Jorge.
    expect(
      [...select.querySelectorAll("option")].map((o) => o.textContent),
    ).toContain("Ava (Premium)");
    fireEvent.click(screen.getByRole("radio", { name: "Espa\u00f1ol" }));
    await waitFor(() => {
      expect(select.querySelectorAll("option")).toHaveLength(2);
    });
    expect(
      [...select.querySelectorAll("option")].map((o) => o.textContent),
    ).toContain("Jorge");
    // Spanish prosody loads its own pair and keeps it across switching.
    const speed = screen.getByRole("slider", { name: "Speed" });
    fireEvent.change(speed, { target: { value: "1.1" } });
    expect((speed as HTMLInputElement).value).toBe("1.1");
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    await waitFor(() => {
      expect(select.querySelectorAll("option")).toHaveLength(3);
    });
    expect(
      (screen.getByRole("slider", { name: "Speed" }) as HTMLInputElement).value,
    ).toBe("0.9");
    fireEvent.click(screen.getByRole("radio", { name: "Espa\u00f1ol" }));
    await waitFor(() => {
      expect(select.querySelectorAll("option")).toHaveLength(2);
    });
    expect(
      (screen.getByRole("slider", { name: "Speed" }) as HTMLInputElement).value,
    ).toBe("1.1");
  });
});
