import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finishStream,
  isSpeaking,
  pickVoice,
  setVoiceEngine,
  speak,
  speakStream,
  splitSentences,
  stopSpeaking,
} from "./speak";

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
    const { synth, utterances } = stubSpeechSynthesis([fakeVoice("es-CO")]);
    speak("Hola, soy Vale.");
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(utterances).toEqual(["Hola, soy Vale."]);
  });

  it("queues one utterance per sentence, in order", () => {
    const { synth, utterances } = stubSpeechSynthesis([fakeVoice("es-CO")]);
    speak("Primera. ¿Segunda? Tercera");
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    expect(utterances).toEqual(["Primera.", "¿Segunda?", "Tercera"]);
  });

  it("splits on sentence marks and breaks overlong chunks", () => {
    expect(splitSentences("Hola. ¿Cómo estás? Bien")).toEqual([
      "Hola.",
      "¿Cómo estás?",
      "Bien",
    ]);
    expect(splitSentences("   ")).toEqual([]);
    const long = `Inicio, ${"palabra ".repeat(120)}fin.`;
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 400)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toContain("fin.");
  });

  it("prefers the Colombian voice, then neutral, then any Spanish", () => {
    const co = fakeVoice("es-CO");
    const mx = fakeVoice("es-MX");
    const us = fakeVoice("en-US");
    expect(pickVoice([mx, us, co], "es")).toBe(co);
    expect(pickVoice([mx, us], "es")).toBe(mx);
    expect(pickVoice([fakeVoice("es-ES"), us], "es")).toEqual(
      expect.objectContaining({ lang: "es-ES" }),
    );
    expect(pickVoice([us], "es")).toBeNull();
  });

  it("defaults to English voices and keeps Spanish opt-in", () => {
    const co = fakeVoice("es-CO");
    const us = fakeVoice("en-US");
    expect(pickVoice([co, us], "en")).toBe(us);
    expect(pickVoice([co], "en")).toBeNull();
    expect(pickVoice([co, us])).toBe(us);
    expect(pickVoice([co, us], "es")).toBe(co);
  });

  it("sets the utterance language to English without a matching voice", () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("es-CO")]);
    speak("Hello", "en");
    const utterance = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.lang).toBe("en-US");
  });

  it("sets the utterance language to Spanish even without a matching voice", () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("en-US")]);
    speak("Hola", "es");
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
    expect(() => stopSpeaking("test")).not.toThrow();
  });

  it("stopSpeaking cuts the audio in progress", () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("es-CO")]);
    speak("Hola");
    stopSpeaking("test");
    expect(synth.cancel).toHaveBeenCalledTimes(2);
  });

  it("waits for late voices instead of speaking voiceless", async () => {
    let current: SpeechSynthesisVoice[] = [];
    const listeners: (() => void)[] = [];
    const { synth } = stubSpeechSynthesis();
    synth.getVoices = vi.fn(() => current);
    (synth as unknown as { addEventListener: unknown }).addEventListener = vi.fn(
      (_event: string, handler: () => void) => {
        listeners.push(handler);
      },
    );
    speak("Hola", "es");
    expect(synth.speak).not.toHaveBeenCalled();
    current = [fakeVoice("es-CO")];
    listeners.forEach((handler) => handler());
    await vi.waitFor(() => {
      expect(synth.speak).toHaveBeenCalledTimes(1);
    });
    const utterance = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.voice).toEqual(
      expect.objectContaining({ lang: "es-CO" }),
    );
  });
});

describe("seamless voice engine", () => {
  const WAV = new Blob(["fake-wav"], { type: "audio/wav" });

  function stubAudio() {
    const played: string[] = [];
    const paused: string[] = [];
    const instances: { src: string }[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        src: string;
        onended: (() => void) | null = null;
        constructor(src: string) {
          this.src = src;
          instances.push(this);
        }
        play(): Promise<void> {
          played.push(this.src);
          return Promise.resolve();
        }
        pause(): void {
          paused.push(this.src);
        }
      },
    );
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:seamless",
      revokeObjectURL: () => {},
    });
    return { played, paused, instances };
  }

  it("plays proxy audio when the engine is seamless", async () => {
    stubSpeechSynthesis();
    const { played } = stubAudio();
    const fetchStub = vi.fn(async (_url: unknown) => new Response(WAV));
    vi.stubGlobal("fetch", fetchStub);
    try {
      setVoiceEngine("seamless");
      speak("Hola, soy Vale.");
      await vi.waitFor(() => {
        expect(played).toHaveLength(1);
      });
      const url = String(fetchStub.mock.calls[0][0]);
      expect(url).toContain("/api/seamless-voice");
      expect(url).toContain("speaker=10");
      expect(url).toContain(encodeURIComponent("Hola, soy Vale."));
    } finally {
      setVoiceEngine("browser");
    }
  });

  it("falls back to the browser voice when the proxy fails", async () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("es-CO")]);
    stubAudio();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 502 })),
    );
    try {
      setVoiceEngine("seamless");
      speak("Hola");
      await vi.waitFor(() => {
        expect(synth.speak).toHaveBeenCalledTimes(1);
      });
    } finally {
      setVoiceEngine("browser");
    }
  });

  it("stopSpeaking pauses seamless audio in flight", async () => {
    stubSpeechSynthesis();
    const { played, paused } = stubAudio();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(WAV)));
    try {
      setVoiceEngine("seamless");
      speak("Hola");
      await vi.waitFor(() => {
        expect(played).toHaveLength(1);
      });
      stopSpeaking("test");
      expect(paused).toHaveLength(1);
    } finally {
      setVoiceEngine("browser");
    }
  });

  it("reports true while seamless audio is in flight", async () => {
    stubSpeechSynthesis();
    const { played } = stubAudio();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(WAV)));
    expect(isSpeaking()).toBe(false);
    try {
      setVoiceEngine("seamless");
      speak("Hola");
      await vi.waitFor(() => {
        expect(played).toHaveLength(1);
      });
      expect(isSpeaking()).toBe(true);
      stopSpeaking("test");
      expect(isSpeaking()).toBe(false);
    } finally {
      setVoiceEngine("browser");
    }
  });

  it("fetches the first sentence first and chains the rest on ending", async () => {
    stubSpeechSynthesis();
    const { played, instances } = stubAudio();
    const fetchStub = vi.fn(async (_url: unknown) => new Response(WAV));
    vi.stubGlobal("fetch", fetchStub);
    try {
      setVoiceEngine("seamless");
      speak("Una. Dos.");
      await vi.waitFor(() => {
        expect(played).toHaveLength(1);
      });
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(String(fetchStub.mock.calls[0][0])).toContain(
        encodeURIComponent("Una."),
      );
      // Ending the first audio cues the second fetch, not a replay.
      const first = instances as unknown as {
        onended: (() => void) | null;
      }[];
      first[0]?.onended?.();
      await vi.waitFor(() => {
        expect(played).toHaveLength(2);
      });
      expect(fetchStub).toHaveBeenCalledTimes(2);
      expect(String(fetchStub.mock.calls[1][0])).toContain(
        encodeURIComponent("Dos."),
      );
    } finally {
      setVoiceEngine("browser");
    }
  });

  it("never plays a seamless reply stopped before arrival", async () => {
    stubSpeechSynthesis();
    const { played } = stubAudio();
    const fetchStub = vi.fn(
      async (_url: unknown): Promise<Response> =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(WAV)), 10);
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      setVoiceEngine("seamless");
      speak("Hola");
      await vi.waitFor(() => {
        expect(fetchStub).toHaveBeenCalledTimes(1);
      });
      stopSpeaking("test");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(played).toHaveLength(0);
    } finally {
      setVoiceEngine("browser");
    }
  });
});

describe("streamed speech", () => {
  it("speaks complete sentences as deltas arrive and the tail on finish", () => {
    const { synth, utterances } = stubSpeechSynthesis([fakeVoice("en-US")]);
    speakStream("Hello there. How");
    expect(synth.cancel).not.toHaveBeenCalled();
    expect(utterances).toEqual(["Hello there."]);
    speakStream(" are you?");
    expect(utterances).toEqual(["Hello there."]);
    finishStream();
    expect(utterances).toEqual(["Hello there.", "How are you?"]);
  });

  it("holds a single incomplete sentence until the finish", () => {
    const { utterances } = stubSpeechSynthesis([fakeVoice("en-US")]);
    speakStream("One thing");
    expect(utterances).toEqual([]);
    finishStream();
    expect(utterances).toEqual(["One thing"]);
  });

  it("flushes nothing when the turn never streamed", () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("en-US")]);
    finishStream();
    expect(synth.speak).not.toHaveBeenCalled();
  });
});
