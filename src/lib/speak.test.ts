import { afterEach, describe, expect, it, vi } from "vitest";
import { pickVoice, speak, stopSpeaking } from "./speak";

function fakeVoice(lang: string): SpeechSynthesisVoice {
  return { lang } as SpeechSynthesisVoice;
}

function stubSpeechSynthesis(voices: SpeechSynthesisVoice[] = []) {
  const utterances: string[] = [];
  const synth = {
    cancel: vi.fn(),
    getVoices: vi.fn(() => voices),
    speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
      utterances.push(utterance.text);
    }),
  };
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      text: string;
      lang = "";
      voice: SpeechSynthesisVoice | null = null;
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
  return { synth, utterances };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("speak with the browser voice", () => {
  it("speaks the full text once", () => {
    const { synth, utterances } = stubSpeechSynthesis();
    speak("Hola, soy Vale.");
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(utterances).toEqual(["Hola, soy Vale."]);
  });

  it("prefers the Colombian voice, then neutral, then any Spanish", () => {
    const co = fakeVoice("es-CO");
    const mx = fakeVoice("es-MX");
    const us = fakeVoice("en-US");
    expect(pickVoice([mx, us, co])).toBe(co);
    expect(pickVoice([mx, us])).toBe(mx);
    expect(pickVoice([fakeVoice("es-ES"), us])).toEqual(
      expect.objectContaining({ lang: "es-ES" }),
    );
    expect(pickVoice([us])).toBeNull();
  });

  it("sets the utterance language to Spanish even without a matching voice", () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("en-US")]);
    speak("Hola");
    const utterance = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.lang).toBe("es-CO");
  });

  it("ignores empty text", () => {
    const { synth } = stubSpeechSynthesis();
    speak("   ");
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("stays silent without the browser API", () => {
    expect(() => speak("hello")).not.toThrow();
    expect(speak("hello")).toBeUndefined();
    expect(() => stopSpeaking()).not.toThrow();
  });

  it("stopSpeaking cuts the audio in progress", () => {
    const { synth } = stubSpeechSynthesis();
    speak("Hola");
    stopSpeaking();
    expect(synth.cancel).toHaveBeenCalledTimes(2);
  });
});
