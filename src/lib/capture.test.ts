import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  floatToPcm16,
  framePcmBlocks,
  resampleLinear,
  SpeechDetector,
  startCapture,
  unlockAudioContext,
  utteranceLoss,
  FRAME_SAMPLES,
  CAPTURE_RATE,
  PREROLL_FRAMES,
} from "./capture";
import {
  CAPTURE_WORKLET_NAME,
  captureWorkletSource,
} from "./capture-worklet-source";

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

describe("utterance accounting (lost blocks vs wall time)", () => {
  it("reports zero loss when frames match the clock", () => {
    expect(utteranceLoss(400, 10)).toBe(0);
    expect(utteranceLoss(0, 0)).toBe(0);
  });

  it("counts missing frames, never negative for surplus", () => {
    expect(utteranceLoss(1000, 20)).toBe(5);
    expect(utteranceLoss(400, 12)).toBe(0);
  });
});

describe("worklet processor source (AudioWorklet primary path)", () => {
  it("registers under the expected name with the pause/resume contract", () => {
    const source = captureWorkletSource();
    expect(source).toContain(CAPTURE_WORKLET_NAME);
    expect(source).toContain("registerProcessor");
    expect(source).toContain("960");
    expect(source).toContain("24000");
    expect(source).toContain('"pause"');
    expect(source).toContain('"resume"');
    expect(source).toContain('"frame"');
    expect(source).toContain('"beat"');
    expect(source).toContain("quanta");
  });
});

describe("framePcmBlocks (pure framing shared by both engines)", () => {
  it("carries a sub-frame tail into the next call", () => {
    const first = framePcmBlocks(
      new Float32Array(0),
      new Float32Array(5000).fill(0.5),
    );
    expect(first.frames).toHaveLength(5);
    expect(first.carry).toHaveLength(200);
    const second = framePcmBlocks(
      first.carry,
      new Float32Array(4120).fill(0.5),
    );
    // 200 carried + 4120 new = 4320 = 4.5 frames: 4 out, 480 held.
    expect(second.frames).toHaveLength(4);
    expect(second.carry).toHaveLength(480);
    // No sample lost across the joint: 5 + 4 frames + 480 tail = 9320 in.
    expect(
      second.frames.length * FRAME_SAMPLES +
        second.carry.length +
        first.frames.length * FRAME_SAMPLES,
    ).toBe(5000 + 4120);
  });
});

describe("remainder carry (every sample reaches the VAD)", () => {
  const countingCallbacks = () => {
    const seen = { samples: 0, frames: 0, out: [] as number[] };
    return {
      seen,
      callbacks: {
        onFrame: (frame: Int16Array) => {
          seen.samples += frame.length;
          seen.frames += 1;
          seen.out.push(...Array.from(frame));
        },
        onSpeechStart: () => {},
        onSpeechEnd: () => {},
      },
    };
  };

  it("keeps every sample: N blocks in = N*4096 samples out, zero loss", () => {
    stubAudio();
    const { seen, callbacks } = countingCallbacks();
    const handle = startCapture({} as MediaStream, callbacks);
    const process = liveProcessor();
    // 15 blocks = 61440 samples = exactly 64 frames: no tail held back.
    // Loud enough to trip the VAD: every frame reaches onFrame.
    for (let i = 0; i < 15; i++) process(block(0.5));
    handle.stop();
    expect(seen.frames).toBe(64);
    expect(seen.samples).toBe(15 * 4096);
  });

  it("concatenated output equals the input: no gaps at frame joints", () => {
    stubAudio();
    const { seen, callbacks } = countingCallbacks();
    const handle = startCapture({} as MediaStream, callbacks);
    const process = liveProcessor();
    // Exact multiple of the frame: the carry drains to zero by the end.
    const total = 15 * 4096;
    const ramp = new Float32Array(total);
    for (let i = 0; i < total; i++) ramp[i] = 0.2 + (0.6 * (i % 960)) / 960;
    for (let off = 0; off < total; off += 4096) {
      process({
        inputBuffer: {
          numberOfChannels: 1,
          getChannelData: () => ramp.subarray(off, off + 4096),
        },
      });
    }
    handle.stop();
    const expected = floatToPcm16(ramp);
    expect(seen.out).toEqual(Array.from(expected));
  });
});

const block = (value: number, length = 4096): unknown => ({
  inputBuffer: {
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(length).fill(value),
  },
});
const liveProcessor = (): ((event: unknown) => void) => {
  const node = FakeAudioNode.created[FakeAudioNode.created.length - 1];
  if (!node?.onaudioprocess) throw new Error("no live processor");
  return (event: unknown) => node.onaudioprocess?.(event);
};

describe("strict-turn pause (mute while Vale speaks)", () => {
  const counters = () => {
    const seen = { frames: 0, starts: 0, ends: 0, beats: 0 };
    return {
      seen,
      callbacks: {
        onFrame: () => void seen.frames++,
        onSpeechStart: () => void seen.starts++,
        onSpeechEnd: () => void seen.ends++,
        onHeartbeat: () => void seen.beats++,
        onBlocked: () => {},
      },
    };
  };

  it("pausing drops detector and frames but keeps the heartbeat", () => {
    stubAudio();
    const { seen, callbacks } = counters();
    const handle = startCapture({} as MediaStream, callbacks);
    const process = liveProcessor();
    process(block(0.5));
    expect(seen.starts).toBe(1);
    const framesWhileLive = seen.frames;
    expect(framesWhileLive).toBeGreaterThan(0);
    const beatsWhileLive = seen.beats;
    handle.setPaused?.(true);
    process(block(0.5));
    process(block(0.5));
    expect(seen.frames).toBe(framesWhileLive);
    expect(seen.starts).toBe(1);
    expect(seen.beats).toBeGreaterThan(beatsWhileLive);
    handle.stop();
  });

  it("a speech frozen by mute never closes after resume: no phantom turn", () => {
    stubAudio();
    const seen = { frames: 0, starts: 0, ends: 0 };
    const handle = startCapture({} as MediaStream, {
      onFrame: () => void seen.frames++,
      onSpeechStart: () => void seen.starts++,
      onSpeechEnd: () => void seen.ends++,
    });
    const process = liveProcessor();
    process(block(0.5)); // room tone trips speech-start
    expect(seen.starts).toBe(1);
    const framesAtMute = seen.frames;
    handle.setPaused?.(true);
    process(block(0.5));
    process(block(0.5));
    expect(seen.frames).toBe(framesAtMute);
    // She settles: the detector restarts fresh, so the following room
    // tone is silence, not the close of a stale speech.
    handle.setPaused?.(false);
    for (let i = 0; i < 25; i++) process(block(0));
    expect(seen.ends).toBe(0);
    expect(seen.frames).toBe(framesAtMute);
    expect(seen.starts).toBe(1);
    handle.stop();
  });

  it("resuming clears stale pre-roll so her voice never prefixes the turn", () => {
    stubAudio();
    // Control: silence fills pre-roll, then speech flushes it (25 + 4 frames).
    const control = counters();
    startCapture({} as MediaStream, control.callbacks);
    let process = liveProcessor();
    for (let i = 0; i < 30; i++) process(block(0));
    process(block(0.5));
    expect(control.seen.frames).toBe(25 + 4);
    // Paused path: the same silence is discarded on resume.
    stubAudio();
    const muted = counters();
    const handle = startCapture({} as MediaStream, muted.callbacks);
    process = liveProcessor();
    for (let i = 0; i < 30; i++) process(block(0));
    handle.setPaused?.(true);
    handle.setPaused?.(false);
    process(block(0.5));
    expect(muted.seen.frames).toBe(4);
    handle.stop();
  });
});

class FakeAudioNode {
  static created: FakeAudioNode[] = [];
  onaudioprocess: ((event: unknown) => void) | null = null;
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
    const node = new FakeAudioNode();
    FakeAudioNode.created.push(node);
    return node;
  }
  createGain(): FakeAudioNode & { gain: { value: number } } {
    return Object.assign(new FakeAudioNode(), { gain: { value: 0 } });
  }
}

function stubAudio() {
  FakeAudioContext.instances = [];
  FakeAudioNode.created = [];
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

  it("reports the live context state for the stall watchdog", () => {
    stubAudio();
    const handle = startCapture({} as MediaStream, quietCallbacks());
    expect(handle.state()).toBe("running");
    handle.stop();
    expect(handle.state()).toBe("closed");
  });
});
