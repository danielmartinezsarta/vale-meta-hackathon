// Mic capture: mono 16-bit PCM at 24 kHz with energy VAD; silence emits nothing.

export const CAPTURE_RATE = 24000;
export const FRAME_SAMPLES = 960; // 40 ms frames at 24 kHz mono.
// 25 frames x 40 ms ≈ 1 s of pre-roll so a soft onset is never clipped.
export const PREROLL_FRAMES = 25;

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number = CAPTURE_RATE,
): Float32Array {
  if (fromRate === toRate) return input.slice();
  const length = Math.max(1, Math.floor((input.length * toRate) / fromRate));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = (i * fromRate) / toRate;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = pos - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

export type DetectorEvent = "silence" | "speech-start" | "speech" | "speech-end";

export class SpeechDetector {
  private speaking = false;
  private quietFrames = 0;
  private readonly threshold: number;
  private readonly endSilenceFrames: number;

  constructor(
    options: { threshold?: number; endSilenceMs?: number; frameMs?: number } = {},
  ) {
    // Mean-abs 200: the fixture's softest onset scores 244, silence scores 0.
    this.threshold = options.threshold ?? 200;
    const frameMs = options.frameMs ?? 40;
    // 800 ms: short pauses stay in one turn, longer ones split without losing audio.
    this.endSilenceFrames = Math.max(
      1,
      Math.round((options.endSilenceMs ?? 800) / frameMs),
    );
  }

  feed(frame: Int16Array): DetectorEvent {
    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += Math.abs(frame[i]);
    const rms = frame.length === 0 ? 0 : energy / frame.length;
    if (!this.speaking) {
      if (rms > this.threshold) {
        this.speaking = true;
        this.quietFrames = 0;
        return "speech-start";
      }
      return "silence";
    }
    if (rms > this.threshold) {
      this.quietFrames = 0;
      return "speech";
    }
    this.quietFrames += 1;
    if (this.quietFrames >= this.endSilenceFrames) {
      this.speaking = false;
      this.quietFrames = 0;
      return "speech-end";
    }
    return "speech";
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }
}

export interface CaptureCallbacks {
  onFrame: (frame: Int16Array) => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  /** Listening feedback, 0..1 mic level; optional. */
  onLevel?: (level: number) => void;
  /** The context never left "suspended": zeros would flow. Tap again. */
  onBlocked?: () => void;
}

/** Warm context adopted by the next startCapture. Only one lives at a time. */
let prepared: AudioContext | null = null;

function audioCtor(): typeof AudioContext | null {
  try {
    return (
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * Call synchronously inside the tap handler, before any await: resume() only
 * unlocks audio inside the user gesture. After an awaited getUserMedia iOS
 * keeps the context suspended and the ScriptProcessor delivers zeros.
 */
export function unlockAudioContext(): void {
  const Ctor = audioCtor();
  if (!Ctor) return;
  try {
    if (prepared && prepared.state !== "closed") {
      void prepared.resume().catch(() => {});
      return;
    }
    try {
      void prepared?.close().catch(() => {});
    } catch {
      /* already torn down */
    }
    prepared = new Ctor({ sampleRate: CAPTURE_RATE });
    void prepared.resume().catch(() => {});
  } catch {
    /* unsupported here: startCapture throws the clear error */
  }
}

function takePrepared(): AudioContext | null {
  const ctx = prepared;
  prepared = null;
  if (!ctx || ctx.state === "closed") return null;
  return ctx;
}

export interface CaptureHandle {
  stop: () => void;
}

export function startCapture(
  stream: MediaStream,
  callbacks: CaptureCallbacks,
  detectorOptions?: ConstructorParameters<typeof SpeechDetector>[0],
): CaptureHandle {
  const AudioContextCtor = audioCtor();
  if (!AudioContextCtor) throw new Error("AudioContext is not supported.");
  // Prefer the context warmed inside the tap gesture; a post-await resume
  // does not unlock iOS, so a context born here may stay suspended.
  const context = takePrepared() ?? new AudioContextCtor({ sampleRate: CAPTURE_RATE });
  try {
    void context.resume().catch(() => {});
  } catch {
    /* resume is best-effort; the watchdog below reports a stuck context */
  }
  let blockedNotified = false;
  window.setTimeout(() => {
    if (!stopped && !blockedNotified && context.state === "suspended") {
      blockedNotified = true;
      try {
        callbacks.onBlocked?.();
      } catch {
        /* the alert must never break capture */
      }
    }
  }, 1000);
  const actualRate = context.sampleRate;
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  // Muted tap so the processor runs without audible feedback.
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);

  const detector = new SpeechDetector(detectorOptions);
  const preroll: Int16Array[] = [];
  let stopped = false;

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    let mono = input;
    if (event.inputBuffer.numberOfChannels > 1) {
      mono = new Float32Array(input.length);
      for (let ch = 0; ch < event.inputBuffer.numberOfChannels; ch++) {
        const data = event.inputBuffer.getChannelData(ch);
        for (let i = 0; i < mono.length; i++) mono[i] += data[i];
      }
      for (let i = 0; i < mono.length; i++) {
        mono[i] /= event.inputBuffer.numberOfChannels;
      }
    }
    const resampled = resampleLinear(mono, actualRate);
    // Same samples as the VAD: no extra audio API.
    if (callbacks.onLevel) {
      let sum = 0;
      for (let i = 0; i < mono.length; i++) sum += Math.abs(mono[i]);
      const level = mono.length === 0 ? 0 : Math.min(1, sum / mono.length);
      try {
        callbacks.onLevel(level);
      } catch {
        /* meter must never break capture */
      }
    }
    for (let off = 0; off + FRAME_SAMPLES <= resampled.length; off += FRAME_SAMPLES) {
      const frame = floatToPcm16(resampled.subarray(off, off + FRAME_SAMPLES));
      const transition = detector.feed(frame);
      if (!detector.isSpeaking && transition === "silence") {
        preroll.push(frame);
        if (preroll.length > PREROLL_FRAMES) preroll.shift();
        continue;
      }
      if (transition === "speech-start") {
        for (const buffered of preroll) callbacks.onFrame(buffered);
        preroll.length = 0;
        callbacks.onSpeechStart();
      }
      callbacks.onFrame(frame);
      if (transition === "speech-end") callbacks.onSpeechEnd();
    }
  };

  return {
    stop() {
      stopped = true;
      try {
        processor.disconnect();
        source.disconnect();
        mute.disconnect();
      } catch {
        /* already torn down */
      }
      void context.close().catch(() => {});
    },
  };
}
