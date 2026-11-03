import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  clockDrifted,
  ensureCaptureReady,
  floatToPcm16,
  framePcmBlocks,
  isWorkletReady,
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
  designLowpassKernel,
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
    // 1000 ms of silence ends the turn once, not before.
    for (let i = 0; i < 13; i++) tail.push(detector.feed(silence));
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

  it("defaults to 1000 ms: slow phrases split, normal ones stay whole", () => {
    // 1200 ms mid-pause: a slow phrase becomes two turns at the default.
    expect(splits(new SpeechDetector(), phrase(8, 30))).toBe(1);
    // 960 ms mid-pause: unhurried rhythm stays one turn.
    expect(splits(new SpeechDetector(), phrase(8, 24))).toBe(0);
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

describe("capture engine reporting (worklet vs ScriptProcessor)", () => {
  it("reports script when the context has no worklet module", () => {
    stubAudio();
    const engines: string[] = [];
    const handle = startCapture({} as MediaStream, {
      ...quietCallbacks(),
      onEngine: (engine) => engines.push(engine),
    });
    expect(handle.engine()).toBe("script");
    expect(engines).toEqual(["script"]);
    handle.stop();
  });

  it("isWorkletReady needs the warmed module flag on the context", () => {
    stubAudio();
    expect(isWorkletReady({} as AudioContext)).toBe(false);
    expect(
      isWorkletReady({ audioWorklet: {} } as unknown as AudioContext),
    ).toBe(false);
    expect(
      isWorkletReady(
        { audioWorklet: {}, __valeWorklet: "warming" } as unknown as AudioContext,
      ),
    ).toBe(false);
    expect(
      isWorkletReady(
        { audioWorklet: {}, __valeWorklet: "ready" } as unknown as AudioContext,
      ),
    ).toBe(true);
  });

  it("the kill-switch forces the fallback even with a ready module", () => {
    stubAudio();
    vi.stubEnv("NEXT_PUBLIC_CAPTURE_WORKLET", "0");
    try {
      expect(
        isWorkletReady(
          { audioWorklet: {}, __valeWorklet: "ready" } as unknown as AudioContext,
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
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

  it("pausing suspends the session and resume reopens it", () => {
    stubAudio();
    const handle = startCapture({} as MediaStream, quietCallbacks());
    const context = FakeAudioContext.instances[0];
    const resumedBefore = context.resumed;
    handle.setPaused?.(true);
    expect(context.suspended).toBe(1);
    expect(context.state).toBe("suspended");
    handle.setPaused?.(false);
    expect(context.resumed).toBe(resumedBefore + 1);
    expect(context.state).toBe("running");
    handle.stop();
  });

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

  it("opens the turn before replaying its pre-roll", () => {
    stubAudio();
    const order: string[] = [];
    startCapture({} as MediaStream, {
      ...quietCallbacks(),
      onFrame: () => void order.push("frame"),
      onSpeechStart: () => void order.push("start"),
    });
    const process = liveProcessor();
    for (let i = 0; i < 30; i++) process(block(0));
    process(block(0.5));
    // A speech-opened turn wipes pending frames: the turn must exist first.
    expect(order[0]).toBe("start");
    expect(order.filter((kind) => kind === "frame").length).toBeGreaterThan(0);
  });

  it("resuming parks frames in the ring while the VAD stays deaf", () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_000_000;
    nowSpy.mockImplementation(() => now);
    try {
      stubAudio();
      const muted = counters();
      const handle = startCapture({} as MediaStream, muted.callbacks);
      const process = liveProcessor();
      for (let i = 0; i < 30; i++) process(block(0));
      handle.setPaused?.(true);
      handle.setPaused?.(false);
      // Inside the 300 ms window even sustained speech never trips.
      process(block(0.5));
      expect(muted.seen.frames).toBe(0);
      expect(muted.seen.starts).toBe(0);
      for (let i = 0; i < 8; i++) process(block(0.5));
      expect(muted.seen.starts).toBe(0);
      expect(muted.seen.frames).toBe(0);
      // Past the window the parked ring replays first, then live flows.
      now += 300;
      for (let i = 0; i < 8; i++) process(block(0.5));
      expect(muted.seen.starts).toBe(1);
      expect(muted.seen.frames).toBeGreaterThan(8);
      handle.stop();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

class FakeAudioNode {
  static created: FakeAudioNode[] = [];
  onaudioprocess: ((event: unknown) => void) | null = null;
  connect(): void {}
  disconnect(): void {}
}

class FakeWorkletNode {
  static instances: FakeWorkletNode[] = [];
  port: {
    onmessage: ((event: unknown) => void) | null;
    postMessage: () => void;
    close: () => void;
  };
  constructor() {
    this.port = { onmessage: null, postMessage: () => {}, close: () => {} };
    FakeWorkletNode.instances.push(this);
  }
  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** New contexts start suspended until resume() unlocks them. */
  static startSuspended = false;
  static resumeUnlocks = true;
  /** Device rate the fake mic runs at; the context must adopt it, unforced. */
  static deviceRate = CAPTURE_RATE;
  /** Per-test worklet module loader; undefined keeps the ScriptProcessor. */
  static workletStub:
    | { addModule: (url: string) => Promise<void> }
    | undefined = undefined;
  state = "running";
  sampleRate = CAPTURE_RATE;
  audioWorklet:
    | { addModule: (url: string) => Promise<void> }
    | undefined = FakeAudioContext.workletStub;
  requestedOptions: { sampleRate?: number } | undefined;
  resumed = 0;
  suspended = 0;
  closedCount = 0;
  destination = {};
  onaudioprocess: ((event: unknown) => void) | null = null;
  constructor(options?: { sampleRate?: number }) {
    this.requestedOptions = options;
    this.sampleRate = options?.sampleRate ?? FakeAudioContext.deviceRate;
    if (FakeAudioContext.startSuspended) this.state = "suspended";
    FakeAudioContext.instances.push(this);
  }
  resume(): Promise<void> {
    this.resumed += 1;
    if (FakeAudioContext.resumeUnlocks) this.state = "running";
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspended += 1;
    this.state = "suspended";
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
  FakeWorkletNode.instances = [];
  FakeAudioContext.startSuspended = false;
  FakeAudioContext.resumeUnlocks = true;
  FakeAudioContext.deviceRate = CAPTURE_RATE;
  FakeAudioContext.workletStub = undefined;
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

describe("native-rate capture (no forced 24 kHz context)", () => {
  it("unlockAudioContext warms a context without a sampleRate option", () => {
    stubAudio();
    unlockAudioContext();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(
      FakeAudioContext.instances[0].requestedOptions,
    ).toBeUndefined();
    // Consume the warmed context so the next test builds its own.
    startCapture({} as MediaStream, quietCallbacks()).stop();
  });

  it("startCapture creates its context without a sampleRate option", () => {
    stubAudio();
    // Drain any warmed leftover from an earlier test.
    startCapture({} as MediaStream, quietCallbacks()).stop();
    FakeAudioContext.instances = [];
    const handle = startCapture({} as MediaStream, quietCallbacks());
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(
      FakeAudioContext.instances[0].requestedOptions,
    ).toBeUndefined();
    handle.stop();
  });

  it("a 48 kHz device keeps its rate: the worklet decimates, not the context", () => {
    stubAudio();
    FakeAudioContext.deviceRate = 48000;
    const handle = startCapture({} as MediaStream, quietCallbacks());
    expect(FakeAudioContext.instances[0].sampleRate).toBe(48000);
    handle.stop();
  });
});

describe("worklet low-pass decimation", () => {
  const kernel = designLowpassKernel(48000, 24000, 24);

  it("has unity DC gain and symmetric taps", () => {
    expect(kernel).toHaveLength(49);
    const sum = kernel.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    for (let n = 0; n < kernel.length; n++) {
      expect(kernel[n]).toBeCloseTo(kernel[kernel.length - 1 - n], 12);
    }
  });

  const firDecimate = (input: Float32Array): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 480; i++) {
      const center = i * 2;
      let acc = 0;
      for (let k = 0; k < kernel.length; k++) {
        acc += (input[center - 24 + k] ?? 0) * kernel[k];
      }
      out.push(acc);
    }
    return out;
  };
  const tone = (hz: number): Float32Array => {
    const buf = new Float32Array(984);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.sin((2 * Math.PI * hz * i) / 48000);
    }
    return buf;
  };
  const rms = (xs: number[]): number =>
    Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);

  it("passes 1 kHz near unity", () => {
    expect(rms(firDecimate(tone(1000)))).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it("stops 18 kHz deep in the stopband", () => {
    expect(rms(firDecimate(tone(18000)))).toBeLessThan(0.05);
  });

  it("the shipped module embeds the tested kernel", () => {
    const source = captureWorkletSource();
    expect(source).toContain("designLowpassKernel");
    expect(source).toContain("sinc");
  });

  it("the shipped module parses as plain JavaScript", async () => {
    const { Script } = await import("node:vm");
    // Compiles only: the worklet globals resolve on the audio thread.
    expect(() => new Script(captureWorkletSource())).not.toThrow();
  });

  it("the shipped module constructs and posts 24 kHz frames", async () => {
    const { Script } = await import("node:vm");
    // The bundler minifies the embedded kernel (designLowpassKernel becomes
    // n) while the constructor calls it by literal template name: simulate
    // that rename before executing, or a silent ReferenceError ships.
    const shipped = captureWorkletSource().replace(
      "function designLowpassKernel(",
      "function n(",
    );
    expect(shipped).not.toContain("function designLowpassKernel(");
    const posted: { type: string; pcm?: ArrayBuffer; quanta?: number }[] = [];
    let Processor: new () => {
      port: { onmessage: null; postMessage: (m: unknown) => void };
      process: (inputs: Float32Array[][]) => boolean;
    };
    const sandbox = {
      sampleRate: 48000,
      currentTime: 0,
      AudioWorkletProcessor: class {
        port = {
          onmessage: null,
          postMessage: (m: { type: string; pcm?: ArrayBuffer }) =>
            void posted.push(m),
        };
      },
      registerProcessor: (
        _name: string,
        cls: typeof Processor,
      ) => void (Processor = cls),
    };
    new Script(shipped).runInNewContext(sandbox);
    const node = new Processor!();
    // 16 quanta of DC 0.5 at 48 kHz: the first 960-sample frame must come out.
    for (let q = 0; q < 16; q++) {
      sandbox.currentTime = q * 0.002;
      expect(
        node.process([[new Float32Array(128).fill(0.5)]]),
      ).toBe(true);
    }
    const frames = posted.filter((m) => m.type === "frame");
    expect(frames.length).toBeGreaterThan(0);
    const pcm = new Int16Array(frames[0].pcm!);
    expect(pcm).toHaveLength(960);
    let sum = 0;
    for (const v of pcm) sum += v;
    // DC survives the low-pass near unity: 0.5 * 32767 ≈ 16384.
    expect(sum / pcm.length).toBeGreaterThan(14000);
  });
});

describe("clock watchdog (drift below 0.95 rebuilds the context)", () => {
  it("flags only a slow context over a full 2 s window", () => {
    expect(clockDrifted(96000, 48000, 2000)).toBe(false);
    expect(clockDrifted(90000, 48000, 2000)).toBe(true);
    expect(clockDrifted(0, 48000, 2000)).toBe(true);
    expect(clockDrifted(0, 48000, 1999)).toBe(false);
    expect(clockDrifted(96000, 0, 2000)).toBe(false);
  });

  const beat = (quanta: number) => {
    const node = FakeWorkletNode.instances.at(-1);
    node?.port.onmessage?.({ data: { type: "beat", quanta } });
  };
  const flushRebuild = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  /** Worklet path on a 48 kHz device with controllable wall time. */
  const startWorklet48k = (callbacks: Parameters<typeof startCapture>[1]) => {
    stubAudio();
    FakeAudioContext.deviceRate = 48000;
    FakeAudioContext.workletStub = { addModule: async () => {} };
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    // jsdom has no Blob-URL factory; the module URL is a browser concern.
    const urlAny = URL as unknown as Record<string, unknown>;
    const origCreateObjectURL = urlAny.createObjectURL;
    urlAny.createObjectURL = () => "blob:test-worklet";
    try {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      unlockAudioContext();
      (FakeAudioContext.instances[0] as unknown as Record<string, unknown>)[
        "__valeWorklet"
      ] = "ready";
      return startCapture({} as MediaStream, callbacks);
    } finally {
      urlAny.createObjectURL = origCreateObjectURL;
    }
  };

  it("rebuilds the context and worklet when audio runs slower than the wall", async () => {
    const rebuilds: number[] = [];
    let beats = 0;
    const handle = startWorklet48k({
      ...quietCallbacks(),
      onClockRebuild: (total) => rebuilds.push(total),
      onHeartbeat: () => void beats++,
    });
    expect(handle.engine()).toBe("worklet");
    // Healthy: 2.5 s of audio over 2.5 s of wall time.
    beat(0);
    expect(beats).toBe(1);
    vi.setSystemTime(1_002_500);
    beat(938);
    expect(rebuilds).toEqual([]);
    expect(FakeAudioContext.instances).toHaveLength(1);
    // Drift: 3 more s of wall time with the same quantum counter.
    vi.setSystemTime(1_005_500);
    beat(938);
    await flushRebuild();
    expect(rebuilds).toEqual([1]);
    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(FakeAudioContext.instances[0].closedCount).toBe(1);
    expect(handle.engine()).toBe("worklet");
    // The rebuilt graph delivers: beats flow on the new node, no new trip.
    const delivered = beats;
    beat(1010);
    expect(beats).toBe(delivered + 1);
    vi.setSystemTime(1_008_000);
    beat(1948);
    await flushRebuild();
    expect(rebuilds).toEqual([1]);
    expect(FakeAudioContext.instances).toHaveLength(2);
    handle.stop();
  });

  it("muted spans re-anchor the window instead of tripping the rebuild", async () => {
    const rebuilds: number[] = [];
    const handle = startWorklet48k({
      ...quietCallbacks(),
      onClockRebuild: (total) => rebuilds.push(total),
    });
    beat(0);
    handle.setPaused?.(true);
    vi.setSystemTime(1_006_000);
    beat(10);
    handle.setPaused?.(false);
    await flushRebuild();
    expect(rebuilds).toEqual([]);
    expect(FakeAudioContext.instances).toHaveLength(1);
    handle.stop();
  });

  it("warns the client before the detector resets", async () => {
    const interrupts: number[] = [];
    const rebuilds: number[] = [];
    const handle = startWorklet48k({
      ...quietCallbacks(),
      onInterrupt: () => void interrupts.push(1),
      onClockRebuild: (total) => rebuilds.push(total),
    });
    beat(0);
    vi.setSystemTime(1_006_000);
    beat(938);
    await flushRebuild();
    expect(rebuilds).toEqual([1]);
    expect(interrupts).toEqual([1]);
    handle.stop();
  });
});

describe("worklet readiness wait (no engine coin-flip)", () => {
  /** Drain any warmed leftover, then warm a fresh context with a stub. */
  const warmWith = (
    stub: { addModule: (url: string) => Promise<void> } | undefined,
  ) => {
    stubAudio();
    try {
      startCapture({} as MediaStream, quietCallbacks()).stop();
    } catch {
      /* no prepared context to drain */
    }
    FakeAudioContext.instances = [];
    FakeAudioContext.workletStub = stub;
    // jsdom has no Blob-URL factory; the module URL is a browser concern.
    const urlAny = URL as unknown as Record<string, unknown>;
    if (typeof urlAny.createObjectURL !== "function") {
      urlAny.createObjectURL = () => "blob:test-worklet";
    }
    unlockAudioContext();
  };

  it("resolves true when the warmed module is already ready", async () => {
    warmWith({ addModule: async () => {} });
    (FakeAudioContext.instances[0] as unknown as Record<string, unknown>)[
      "__valeWorklet"
    ] = "ready";
    await expect(ensureCaptureReady(50)).resolves.toBe(true);
  });

  it("waits for a warming module instead of falling back", async () => {
    warmWith({ addModule: async () => {} });
    // Still warming here: only the wait settles it to ready.
    expect(
      FakeAudioContext.instances[0] as unknown as Record<string, unknown>,
    ).not.toHaveProperty("__valeWorklet", "ready");
    await expect(ensureCaptureReady()).resolves.toBe(true);
  });

  it("times out to the fallback when the module never loads", async () => {
    warmWith({ addModule: () => new Promise<void>(() => {}) });
    await expect(ensureCaptureReady(30)).resolves.toBe(false);
  });

  it("stays on the fallback without AudioWorklet support", async () => {
    warmWith(undefined);
    await expect(ensureCaptureReady(10)).resolves.toBe(false);
  });

  it("stays on the fallback when the kill-switch is set", async () => {
    warmWith({ addModule: async () => {} });
    vi.stubEnv("NEXT_PUBLIC_CAPTURE_WORKLET", "0");
    try {
      await expect(ensureCaptureReady(10)).resolves.toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
