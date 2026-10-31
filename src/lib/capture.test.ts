import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  floatToPcm16,
  resampleLinear,
  SpeechDetector,
  startCapture,
  unlockAudioContext,
  FRAME_SAMPLES,
  CAPTURE_RATE,
  PREROLL_FRAMES,
} from "./capture";

function toneFrame(amplitude = 5000, samples = FRAME_SAMPLES): Int16Array {
  const frame = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    frame[i] = Math.round(
      amplitude * Math.sin((2 * Math.PI * 440 * i) / CAPTURE_RATE),
    );
  }
  return frame;
}

describe("capture DSP", () => {
  it("encodes float to 16-bit PCM with clamping", () => {
    const out = floatToPcm16(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(16384);
    expect(out[2]).toBe(-16384);
    expect(out[3]).toBe(32767);
    expect(out[4]).toBe(-32768);
    expect(out[5]).toBe(32767);
    expect(out[6]).toBe(-32768);
  });

  it("resamples 16 kHz mono to 24 kHz mono", () => {
    const input = new Float32Array(160).fill(0.25);
    const out = resampleLinear(input, 16000);
    expect(out.length).toBe(240);
    for (const sample of out) expect(sample).toBeCloseTo(0.25, 5);
  });

  it("detects a speech burst bracketed by silence", () => {
    const detector = new SpeechDetector({ endSilenceMs: 200 });
    const silence = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < 10; i++) expect(detector.feed(silence)).toBe("silence");
    expect(detector.isSpeaking).toBe(false);

    expect(detector.feed(toneFrame())).toBe("speech-start");
    expect(detector.isSpeaking).toBe(true);
    expect(detector.feed(toneFrame())).toBe("speech");

    const tail: string[] = [];
    for (let i = 0; i < 10; i++) tail.push(detector.feed(silence));
    expect(tail.filter((event) => event === "speech-end")).toHaveLength(1);
    expect(detector.isSpeaking).toBe(false);
  });

  it("stays silent on digital silence (silence fixture never emits speech)", () => {
    const detector = new SpeechDetector();
    const silence = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < 125; i++) {
      expect(detector.feed(silence)).toBe("silence");
    }
    expect(detector.isSpeaking).toBe(false);
  });
});

describe("bug 2 VAD calibration (iPhone clipped phrase onsets)", () => {
  it("catches a soft onset on the first frame that the old threshold missed", () => {
    // Softest onset frame scores mean-abs 244.
    const softOnset = new Int16Array(FRAME_SAMPLES).fill(244);
    expect(new SpeechDetector({ threshold: 500 }).feed(softOnset)).toBe(
      "silence",
    );
    const detector = new SpeechDetector();
    expect(detector.feed(softOnset)).toBe("speech-start");
    expect(detector.isSpeaking).toBe(true);
  });

  it("keeps a full second of pre-roll for speech under the threshold", () => {
    expect(PREROLL_FRAMES).toBe(25);
    expect(PREROLL_FRAMES * 40).toBeGreaterThanOrEqual(1000);
  });

  it("a short pause inside a phrase does not split the turn", () => {
    const detector = new SpeechDetector();
    expect(detector.feed(toneFrame())).toBe("speech-start");
    const silence = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < 12; i++) {
      expect(detector.feed(silence)).toBe("speech");
    }
    expect(detector.isSpeaking).toBe(true);
    const tail: string[] = [];
    for (let i = 0; i < 8; i++) tail.push(detector.feed(silence));
    expect(tail.filter((event) => event === "speech-end")).toHaveLength(1);
    expect(detector.isSpeaking).toBe(false);
  });
});

describe("audio fixtures", () => {
  const root = process.cwd();
  it("hello.webm exists, is WebM, and carries audio", () => {
    const path = join(root, "fixtures/hello.webm");
    expect(existsSync(path)).toBe(true);
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    expect(statSync(path).size).toBeGreaterThan(5000);
  });

  it("silence.webm exists and is WebM", () => {
    const path = join(root, "fixtures/silence.webm");
    expect(existsSync(path)).toBe(true);
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  });
});

describe("end-of-turn pause (NEXT_PUBLIC_VAD_END_SILENCE_MS)", () => {
  const speechFrame = () => toneFrame(4000);
  const silenceFrame = () => new Int16Array(FRAME_SAMPLES);

  /** Feeds a phrase; counts speech-end splits (40 ms per frame). */
  const splits = (detector: SpeechDetector, frames: Int16Array[]): number => {
    let ends = 0;
    for (const frame of frames) {
      if (detector.feed(frame) === "speech-end") ends += 1;
    }
    return ends;
  };

  const phrase = (speechFrames: number, pauseFrames: number): Int16Array[] => {
    const frames: Int16Array[] = [];
    for (let i = 0; i < speechFrames; i++) frames.push(speechFrame());
    for (let i = 0; i < pauseFrames; i++) frames.push(silenceFrame());
    for (let i = 0; i < speechFrames; i++) frames.push(speechFrame());
    return frames;
  };

  it("defaults to 800 ms: slow phrases split, normal ones stay whole", () => {
    // 1000 ms mid-pause: a slow phrase becomes two turns at the default.
    expect(splits(new SpeechDetector(), phrase(8, 25))).toBe(1);
    // 200 ms mid-pause: normal rhythm stays one turn.
    expect(splits(new SpeechDetector(), phrase(8, 5))).toBe(0);
  });

  it("a longer pause keeps slow phrases in one turn without slowing normal ones", () => {
    // Same slow phrase under 1200 ms: one turn.
    expect(
      splits(new SpeechDetector({ endSilenceMs: 1200 }), phrase(8, 25)),
    ).toBe(0);
    // Normal rhythm unchanged at both settings.
    expect(
      splits(new SpeechDetector({ endSilenceMs: 1200 }), phrase(8, 5)),
    ).toBe(0);
    // A real stop (1800 ms) still splits, so turns do end.
    expect(
      splits(new SpeechDetector({ endSilenceMs: 1200 }), phrase(8, 45)),
    ).toBe(1);
  });
});

class FakeAudioNode {
  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** New contexts start suspended until resume() unlocks them. */
  static startSuspended = false;
  static resumeUnlocks = true;
  state = "running";
  sampleRate = CAPTURE_RATE;
  resumed = 0;
  closedCount = 0;
  destination = {};
  onaudioprocess: ((event: unknown) => void) | null = null;
  constructor(options?: { sampleRate?: number }) {
    if (options?.sampleRate) this.sampleRate = options.sampleRate;
    if (FakeAudioContext.startSuspended) this.state = "suspended";
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    this.resumed += 1;
    if (FakeAudioContext.resumeUnlocks) this.state = "running";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closedCount += 1;
    this.state = "closed";
    return Promise.resolve();
  }
  createMediaStreamSource(): FakeAudioNode {
    return new FakeAudioNode();
  }
  createScriptProcessor(): FakeAudioNode {
    return new FakeAudioNode();
  }
  createGain(): FakeAudioNode & { gain: { value: number } } {
    return Object.assign(new FakeAudioNode(), { gain: { value: 0 } });
  }
}

function stubAudio() {
  FakeAudioContext.instances = [];
  FakeAudioContext.startSuspended = false;
  FakeAudioContext.resumeUnlocks = true;
  vi.stubGlobal("window", {
    AudioContext: FakeAudioContext,
    setTimeout: (...args: [() => void, number]) =>
      (globalThis.setTimeout as typeof setTimeout)(...args),
  });
}

function quietCallbacks() {
  return {
    onFrame: () => {},
    onSpeechStart: () => {},
    onSpeechEnd: () => {},
    onBlocked: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("audio unlock lifecycle (two-tap cycle)", () => {
  it("unlocks in the tap, adopts the warmed context, and closes on stop", () => {
    stubAudio();
    unlockAudioContext();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].resumed).toBe(1);
    const handle = startCapture({} as MediaStream, quietCallbacks());
    // Adopted, not recreated.
    expect(FakeAudioContext.instances).toHaveLength(1);
    handle.stop();
    expect(FakeAudioContext.instances[0].closedCount).toBe(1);
  });

  it("two taps never leave two live contexts", () => {
    stubAudio();
    unlockAudioContext();
    const first = startCapture({} as MediaStream, quietCallbacks());
    first.stop();
    unlockAudioContext();
    const second = startCapture({} as MediaStream, quietCallbacks());
    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(
      FakeAudioContext.instances.filter((ctx) => ctx.state !== "closed"),
    ).toHaveLength(1);
    second.stop();
    expect(
      FakeAudioContext.instances.filter((ctx) => ctx.state !== "closed"),
    ).toHaveLength(0);
  });

  it("alerts once when the context stays suspended past the gesture", () => {
    stubAudio();
    FakeAudioContext.startSuspended = true;
    FakeAudioContext.resumeUnlocks = false;
    vi.useFakeTimers();
    const callbacks = quietCallbacks();
    const handle = startCapture({} as MediaStream, callbacks);
    vi.advanceTimersByTime(999);
    expect(callbacks.onBlocked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callbacks.onBlocked).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("stays quiet when resume unlocks the context", () => {
    stubAudio();
    FakeAudioContext.startSuspended = true;
    FakeAudioContext.resumeUnlocks = true;
    vi.useFakeTimers();
    const callbacks = quietCallbacks();
    const handle = startCapture({} as MediaStream, callbacks);
    vi.advanceTimersByTime(5000);
    expect(callbacks.onBlocked).not.toHaveBeenCalled();
    handle.stop();
  });
});
