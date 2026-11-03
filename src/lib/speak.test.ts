import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SPEECH_END_MARGIN_MS,
  SPEECH_MS_PER_CHAR,
  availableVoices,
  cleanSpokenText,
  estimateSpeechMs,
  finishStream,
  getVoicePrefs,
  isSpeaking,
  loadVoicePrefs,
  onSpeechSettled,
  pickVoice,
  preferredVoice,
  prosodyFor,
  prosodyForVoice,
  setVoiceEngine,
  setVoiceForLanguage,
  setVoicePrefs,
  primeSpokenAudio,
  speak,
  speakStream,
  speechSettled,
  splitSentences,
  spokenText,
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

/** Fire the utterance end the real voice reports (onend or onerror). */
function fireUtteranceEnd(utterance: SpeechSynthesisUtterance): void {
  const end = (
    utterance as unknown as {
      onend: ((this: unknown, ev: unknown) => void) | null;
    }
  ).onend;
  end?.call(utterance, {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("speak with the browser voice", () => {
  it("speaks the full text once", async () => {
    const { synth, utterances } = stubSpeechSynthesis([fakeVoice("es-CO")]);
    speak("Hola, soy Vale.", "es");
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(synth.speak).toHaveBeenCalledTimes(1);
    });
    expect(utterances).toEqual(["Hola, soy Vale."]);
  });

  it("queues one utterance per sentence, in order", async () => {
    const { synth, utterances } = stubSpeechSynthesis([fakeVoice("es-CO")]);
    speak("Primera. ¿Segunda? Tercera");
    expect(synth.cancel).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(utterances).toEqual(["Primera.", "¿Segunda?", "Tercera"]);
    });
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

  it("sets the utterance language to English without a matching voice", async () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("es-CO")]);
    speak("Hello", "en");
    await vi.waitFor(() => {
      expect(synth.speak).toHaveBeenCalledTimes(1);
    });
    const utterance = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.lang).toBe("en-US");
  });

  it("sets the utterance language to Spanish even without a matching voice", async () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("en-US")]);
    speak("Hola", "es");
    await vi.waitFor(() => {
      expect(synth.speak).toHaveBeenCalledTimes(1);
    });
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
      speak("Hola, soy Vale.", "es");
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

  it("forces a sentence end when iOS drops onended", async () => {
    stubSpeechSynthesis();
    const { played, instances } = stubAudio();
    const fetchStub = vi.fn(async (_url: unknown) => new Response(WAV));
    vi.stubGlobal("fetch", fetchStub);
    vi.useFakeTimers();
    try {
      setVoiceEngine("seamless");
      speak("Una. Dos.");
      await vi.advanceTimersByTimeAsync(100);
      expect(played).toHaveLength(1);
      expect(isSpeaking()).toBe(true);
      // No onended ever fires (the iOS field case): past estimate +
      // grace the watchdog ends the sentence and cues the next fetch.
      await vi.advanceTimersByTimeAsync(9000);
      expect(fetchStub).toHaveBeenCalledTimes(2);
      expect(played).toHaveLength(2);
      expect(isSpeaking()).toBe(true);
      // Ending the last audio settles the chain: the mic reopens.
      const audios = instances as unknown as {
        onended: (() => void) | null;
      }[];
      audios[1]?.onended?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(isSpeaking()).toBe(false);
    } finally {
      setVoiceEngine("browser");
      vi.useRealTimers();
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
  it("speaks complete sentences as deltas arrive and the tail on finish", async () => {
    const { synth, utterances } = stubSpeechSynthesis([fakeVoice("en-US")]);
    speakStream("Hello there. How");
    expect(synth.cancel).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(utterances).toEqual(["Hello there."]);
    });
    speakStream(" are you?");
    finishStream();
    await vi.waitFor(() => {
      expect(utterances).toEqual(["Hello there.", "How are you?"]);
    });
  });

  it("holds a single incomplete sentence until the finish", async () => {
    const { utterances } = stubSpeechSynthesis([fakeVoice("en-US")]);
    speakStream("One thing");
    finishStream();
    await vi.waitFor(() => {
      expect(utterances).toEqual(["One thing"]);
    });
  });

  it("flushes nothing when the turn never streamed", () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("en-US")]);
    finishStream();
    expect(synth.speak).not.toHaveBeenCalled();
  });
});

function namedVoice(name: string, lang = "en-US"): SpeechSynthesisVoice {
  return { name, lang } as SpeechSynthesisVoice;
}

describe("Daniel's voice order (browser voice)", () => {
  it("prefers Premium over Enhanced over plain, Ava before Zoe", () => {
    const avaPremium = namedVoice("Ava (Premium)");
    const list = [
      namedVoice("Samantha"),
      namedVoice("Zoe (Premium)"),
      namedVoice("Ava (Enhanced)"),
      namedVoice("Google US English"),
      avaPremium,
    ];
    expect(pickVoice(list, "en")).toBe(avaPremium);
    expect(
      pickVoice(
        [namedVoice("Zoe (Enhanced)"), namedVoice("Ava (Enhanced)")],
        "en",
      )?.name,
    ).toBe("Ava (Enhanced)");
    expect(
      pickVoice(
        [namedVoice("Samantha"), namedVoice("Samantha (Enhanced)")],
        "en",
      )?.name,
    ).toBe("Samantha (Enhanced)");
  });

  it("discards macOS joke voices even when they match en-US", () => {
    expect(
      pickVoice(
        [namedVoice("Albert", "en-US"), namedVoice("Google US English", "en-US")],
        "en",
      )?.name,
    ).toBe("Google US English");
    expect(
      pickVoice(
        [namedVoice("Zarvox", "en-US"), namedVoice("Boing", "en-US")],
        "en",
      ),
    ).toBeNull();
  });

  it("falls back to the first en-US voice when no name matches", () => {
    expect(
      pickVoice(
        [namedVoice("Daniel", "en-US"), namedVoice("Karen", "en-US")],
        "en",
      )?.name,
    ).toBe("Daniel");
  });

  it("speaks at rate 0.9 with pitch 0.9 through the chosen voice", async () => {
    const { synth } = stubSpeechSynthesis([namedVoice("Ava (Premium)")]);
    speak("Hi there.", "en");
    await vi.waitFor(() => {
      expect(synth.speak).toHaveBeenCalledTimes(1);
    });
    const utterance = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.rate).toBe(0.9);
    expect(utterance.pitch).toBe(0.9);
    expect(utterance.voice).toEqual(
      expect.objectContaining({ name: "Ava (Premium)" }),
    );
  });

  it("logs the chosen voice once per page load", async () => {
    vi.resetModules();
    const fresh = await import("./speak");
    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((line: string) => {
        logs.push(String(line));
      });
    try {
      stubSpeechSynthesis([namedVoice("Ava (Premium)")]);
      fresh.speak("Hi there.");
      fresh.speak("Again.");
      await vi.waitFor(() => {
        expect(logs.length).toBeGreaterThan(0);
      });
      expect(logs.filter((line) => line.startsWith("[voice] using:"))).toHaveLength(1);
      expect(logs[0]).toContain("Ava (Premium)");
      expect(logs[0]).toContain("en-US");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("cleanSpokenText", () => {
  it("strips markdown, bullets, links and emoji but keeps accents", () => {
    expect(cleanSpokenText("Hey *Emma*, ready?")).toBe("Hey Emma, ready?");
    expect(cleanSpokenText("# Today\n- gel refill\n2. top coat")).toBe(
      "Today gel refill top coat",
    );
    expect(cleanSpokenText("Nice 🎉, see [slots](https://x/y)!")).toBe(
      "Nice , see slots!",
    );
    expect(cleanSpokenText("Café mañana, ¿vienes?")).toBe(
      "Café mañana, ¿vienes?",
    );
  });
});

describe("one voice per language (lead round p2)", () => {
  it("lists only the active language, jokes excluded", () => {
    const voices = [
      namedVoice("Ava (Premium)", "en-US"),
      namedVoice("Albert", "en-US"),
      namedVoice("Jorge", "es-MX"),
    ];
    expect(availableVoices(voices, "en").map((v) => v.name)).toEqual([
      "Ava (Premium)",
    ]);
    expect(availableVoices(voices, "es").map((v) => v.name)).toEqual(["Jorge"]);
  });

  it("picks Paulina, then Marisol, for Spanish", () => {
    const paulina = namedVoice("Paulina (Enhanced)", "es-MX");
    const marisol = namedVoice("Marisol (Premium)", "es-ES");
    const jorge = namedVoice("Jorge", "es-MX");
    expect(pickVoice([jorge, marisol, paulina], "es")).toBe(paulina);
    expect(pickVoice([jorge, marisol], "es")).toBe(marisol);
    expect(pickVoice([jorge], "es")).toBe(jorge);
    expect(
      availableVoices([jorge, marisol, paulina], "es").map((v) => v.name),
    ).toEqual(["Paulina (Enhanced)", "Marisol (Premium)", "Jorge"]);
  });

  it("keeps speed and pitch per language", () => {
    window.localStorage.removeItem("vale-voice");
    setVoicePrefs({ rateEn: 1.2, rateEs: 0.8, pitchEn: 1.1, pitchEs: 0.9 });
    expect(prosodyFor("en")).toEqual({ rate: 1.2, pitch: 1.1 });
    expect(prosodyFor("es")).toEqual({ rate: 0.8, pitch: 0.9 });
    setVoicePrefs({ rateEs: 1.0 });
    // The other language keeps hers.
    expect(prosodyFor("en")).toEqual({ rate: 1.2, pitch: 1.1 });
    expect(prosodyFor("es")).toEqual({ rate: 1.0, pitch: 0.9 });
  });

  it("saves each language separately and migrates the legacy single voice", () => {
    window.localStorage.removeItem("vale-voice");
    setVoicePrefs({ voiceEn: null, voiceEs: null, rateEn: 0.9, pitchEn: 0.9, rateEs: 0.9, pitchEs: 0.9 });
    setVoiceForLanguage("en", "Ava (Premium)");
    setVoiceForLanguage("es", "Jorge");
    expect(preferredVoice("en")).toBe("Ava (Premium)");
    expect(preferredVoice("es")).toBe("Jorge");
    setVoiceForLanguage("en", "Zoe (Premium)");
    expect(preferredVoice("en")).toBe("Zoe (Premium)");
    expect(preferredVoice("es")).toBe("Jorge");
    window.localStorage.setItem(
      "vale-voice",
      JSON.stringify({ voice: "Samantha" }),
    );
    // Legacy shape still loads: the old single voice becomes English.
    expect(loadVoicePrefs().voiceEn).toBe("Samantha");
    expect(loadVoicePrefs().voiceEs).toBeNull();
    expect(getVoicePrefs().rateEn).toBe(0.9);
    expect(getVoicePrefs().rateEs).toBe(0.9);
    expect(getVoicePrefs().pitchEn).toBe(0.9);
    expect(getVoicePrefs().pitchEs).toBe(0.9);
  });

  it("spells her name out in English TTS only", () => {
    expect(spokenText("Hi, I'm Vale.", "en")).toBe("Hi, I'm Vah-leh.");
    expect(spokenText("Hola, soy Vale.", "es")).toBe("Hola, soy Vale.");
    expect(spokenText("Vale, Vale, all Vale.", "en")).toBe(
      "Vah-leh, Vah-leh, all Vah-leh.",
    );
  });

  it("speaks the Vah-leh spelling through the English voice", async () => {
    const { utterances } = stubSpeechSynthesis([namedVoice("Ava (Premium)")]);
    window.localStorage.removeItem("vale-voice");
    setVoicePrefs({ voiceEn: null, voiceEs: null, rateEn: 0.9, pitchEn: 0.9, rateEs: 0.9, pitchEs: 0.9 });
    speak("Hi, I'm Vale.", "en");
    await vi.waitFor(() => {
      expect(utterances).toEqual(["Hi, I'm Vah-leh."]);
    });
  });

  it("settles the moment the voice really ends, not at the estimate", async () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("en-US")]);
    speak("Hello.", "en");
    await vi.waitFor(() => {
      expect(synth.speak).toHaveBeenCalledTimes(1);
    });
    // The 150 ms/char + 2.5 s estimate is still owed: no real end yet.
    expect(speechSettled()).toBe(false);
    const only = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    fireUtteranceEnd(only);
    expect(speechSettled()).toBe(true);
  });

  it("waits for the last queued utterance before settling", async () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("en-US")]);
    speak("Hi, I am Vale. Tell me what you need.", "en");
    await vi.waitFor(() => {
      expect(synth.speak).toHaveBeenCalledTimes(2);
    });
    const first = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    const second = synth.speak.mock.calls[1][0] as SpeechSynthesisUtterance;
    fireUtteranceEnd(first);
    expect(speechSettled()).toBe(false);
    fireUtteranceEnd(second);
    expect(speechSettled()).toBe(true);
  });

  it("ignores the ended reply once a newer one is queued", async () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("en-US")]);
    speak("First reply here.", "en");
    await vi.waitFor(() => {
      expect(synth.speak).toHaveBeenCalledTimes(1);
    });
    const stale = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    speak("Second.", "en");
    await vi.waitFor(() => {
      expect(synth.speak).toHaveBeenCalledTimes(2);
    });
    fireUtteranceEnd(stale);
    expect(speechSettled()).toBe(false);
    const current = synth.speak.mock.calls[1][0] as SpeechSynthesisUtterance;
    fireUtteranceEnd(current);
    expect(speechSettled()).toBe(true);
  });

  it("settles when synth.speaking goes quiet without an end event", async () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("en-US")]);
    const live = synth as unknown as { speaking: boolean };
    speak("Hello.", "en");
    await vi.waitFor(() => {
      expect(synth.speak).toHaveBeenCalledTimes(1);
    });
    live.speaking = true;
    expect(speechSettled()).toBe(false);
    live.speaking = false;
    expect(speechSettled()).toBe(true);
    live.speaking = false;
  });

  it("notifies settle listeners once at the real end", async () => {
    const { synth } = stubSpeechSynthesis([fakeVoice("en-US")]);
    const heard: number[] = [];
    const release = onSpeechSettled(() => {
      heard.push(Date.now());
    });
    try {
      speak("Hello.", "en");
      await vi.waitFor(() => {
        expect(synth.speak).toHaveBeenCalledTimes(1);
      });
      const only = synth.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
      fireUtteranceEnd(only);
      expect(heard).toHaveLength(1);
      expect(speechSettled()).toBe(true);
    } finally {
      release();
    }
  });

  it("caps speech end by phrase length, never cutting real speech", () => {
    expect(estimateSpeechMs("", 1)).toBe(0);
    expect(estimateSpeechMs("   ", 1)).toBe(0);
    // 11 chars at 150 ms/char plus the margin.
    expect(estimateSpeechMs("Hola Daniel", 1)).toBe(
      11 * SPEECH_MS_PER_CHAR + SPEECH_END_MARGIN_MS,
    );
    // A slower rate stretches the cap instead of cutting her off.
    expect(estimateSpeechMs("Hola Daniel", 0.5)).toBe(
      Math.ceil((11 * SPEECH_MS_PER_CHAR) / 0.5) + SPEECH_END_MARGIN_MS,
    );
    // A 25-word reply still fits far inside its cap.
    const reply = "All set, timer is running for Nina. Take your time.".repeat(2);
    expect(estimateSpeechMs(reply, 0.9)).toBeGreaterThan(2 * reply.length * 70);
  });
});

describe("tuned prosody only for Ava and Paulina (HACK-024)", () => {
  it("uses the picked rate and pitch for Ava and Paulina", () => {
    window.localStorage.removeItem("vale-voice");
    setVoicePrefs({ rateEn: 1.2, rateEs: 0.8, pitchEn: 1.1, pitchEs: 0.9 });
    expect(prosodyForVoice(namedVoice("Ava (Premium)"), "en")).toEqual({ rate: 1.2, pitch: 1.1 });
    expect(prosodyForVoice(namedVoice("Ava (Enhanced)"), "en")).toEqual({ rate: 1.2, pitch: 1.1 });
    expect(prosodyForVoice(namedVoice("Paulina (Enhanced)"), "es")).toEqual({ rate: 0.8, pitch: 0.9 });
  });

  it("stays neutral at 1.0/1.0 for a list with neither Ava nor Paulina", () => {
    window.localStorage.removeItem("vale-voice");
    setVoicePrefs({ rateEn: 1.2, rateEs: 0.8, pitchEn: 1.1, pitchEs: 0.9 });
    const list = [
      namedVoice("Samantha"),
      namedVoice("Zoe (Premium)"),
      namedVoice("Google US English"),
      namedVoice("Marisol (Premium)", "es-ES"),
      namedVoice("Jorge", "es-MX"),
    ];
    for (const voice of list) {
      expect(prosodyForVoice(voice, "en")).toEqual({ rate: 1, pitch: 1 });
      expect(prosodyForVoice(voice, "es")).toEqual({ rate: 1, pitch: 1 });
    }
    expect(prosodyForVoice(null, "en")).toEqual({ rate: 1, pitch: 1 });
  });
});

describe("primeSpokenAudio (iOS gesture unlock)", () => {
  it("speaks a zero-volume utterance and plays silent audio", () => {
    const { synth } = stubSpeechSynthesis();
    const played: string[] = [];
    const audioCtor = class {
      url: string;
      volume = 1;
      onended: (() => void) | null = null;
      constructor(url: string) {
        this.url = url;
      }
      play(): Promise<void> {
        played.push(this.url);
        return Promise.resolve();
      }
    };
    vi.stubGlobal("Audio", audioCtor);
    const urlAny = URL as unknown as Record<string, unknown>;
    const origCreateObjectURL = urlAny.createObjectURL;
    const minted: string[] = [];
    urlAny.createObjectURL = () => {
      const url = `blob:prime-${minted.length}`;
      minted.push(url);
      return url;
    };
    try {
      primeSpokenAudio();
      expect(synth.speak).toHaveBeenCalledTimes(1);
      const said = synth.speak.mock.calls[0][0] as unknown as Record<
        string,
        unknown
      >;
      expect(said.text).toBe(" ");
      expect(said.volume).toBe(0);
      expect(minted).toHaveLength(1);
      expect(played).toEqual(minted);
    } finally {
      urlAny.createObjectURL = origCreateObjectURL;
      vi.unstubAllGlobals();
    }
  });

  it("clears a warm utterance that never ends, and leaves an ended one", () => {
    const { synth } = stubSpeechSynthesis();
    vi.useFakeTimers();
    try {
      primeSpokenAudio();
      // The pre-clear runs once up front; the fallback has not fired yet.
      expect(synth.cancel).toHaveBeenCalledTimes(1);
      const said = synth.speak.mock.calls[0][0] as unknown as {
        onend: (() => void) | null;
      };
      expect(typeof said.onend).toBe("function");
      // A stuck warm trips the fallback clear.
      vi.advanceTimersByTime(2000);
      expect(synth.cancel).toHaveBeenCalledTimes(2);
      // A warm that ended on its own needs no clear.
      vi.clearAllMocks();
      primeSpokenAudio();
      const saidAgain = synth.speak.mock.calls[0][0] as unknown as {
        onend: (() => void) | null;
      };
      saidAgain.onend?.();
      vi.advanceTimersByTime(5000);
      expect(synth.cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
