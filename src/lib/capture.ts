/**
 * Browser microphone capture: mono 16-bit PCM at 24 kHz (the native rate of
 * the realtime transcription engine), with a tiny energy-based voice activity
 * detector. Emits exactly one utterance per speech burst: pre-roll + speech
 * frames, bracketed by onSpeechStart/onSpeechEnd. Silence emits nothing, so
 * a silent turn never reaches the server (and never calls the model).
 */

export const CAPTURE_RATE = 24000;
/** 40 ms frames at 24 kHz mono. */
export const FRAME_SAMPLES = 960;
/** Pre-roll kept so the first consonant is not clipped. */
const PREROLL_FRAMES = 10;

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

/** Tiny energy VAD over 16-bit mono frames. */
export class SpeechDetector {
  private speaking = false;
  private quietFrames = 0;
  private readonly threshold: number;
  private readonly endSilenceFrames: number;

  constructor(
    options: { threshold?: number; endSilenceMs?: number; frameMs?: number } = {},
  ) {
    this.threshold = options.threshold ?? 500;
    const frameMs = options.frameMs ?? 40;
    this.endSilenceFrames = Math.max(
      1,
      Math.round((options.endSilenceMs ?? 1200) / frameMs),
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
}

export interface CaptureHandle {
  stop: () => void;
}

/**
 * Capture from a mic stream. Frames flow only inside an utterance
 * (pre-roll + speech up to speech-end); silence flows nowhere.
 */
export function startCapture(
  stream: MediaStream,
  callbacks: CaptureCallbacks,
  detectorOptions?: ConstructorParameters<typeof SpeechDetector>[0],
): CaptureHandle {
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) throw new Error("AudioContext is not supported.");
  const context = new AudioContextCtor({ sampleRate: CAPTURE_RATE });
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
