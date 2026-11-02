// Mic capture: mono 16-bit PCM at 24 kHz with energy VAD; silence emits nothing.

import {
  CAPTURE_WORKLET_NAME,
  captureWorkletSource,
} from "./capture-worklet-source";

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

/**
 * Slice resampled audio into whole 960-sample frames, carrying the
 * remainder into the next block instead of dropping it. A 4096-sample
 * block yields 4 frames and used to discard the last 256 samples
 * (6.3-13.9% of every turn); now the joints are exact and N blocks in
 * always produce N*4096 samples out. Pure: the same function feeds the
 * ScriptProcessor path, the AudioWorklet mirror, and the WAV replay probe.
 */
export function framePcmBlocks(
  carry: Float32Array,
  samples: Float32Array,
): { frames: Int16Array[]; carry: Float32Array } {
  const all =
    carry.length === 0
      ? samples
      : (() => {
          const joined = new Float32Array(carry.length + samples.length);
          joined.set(carry, 0);
          joined.set(samples, carry.length);
          return joined;
        })();
  const count = Math.floor(all.length / FRAME_SAMPLES);
  const frames: Int16Array[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(
      floatToPcm16(all.subarray(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES)),
    );
  }
  return { frames, carry: all.slice(count * FRAME_SAMPLES) };
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

/**
 * Per-utterance delivery accounting, from the trip to the end: how many
 * 960-sample frames the VAD saw against wall time, plus how many source
 * blocks the audio thread processed in that span (ScriptProcessor runs or
 * worklet quanta). lostBlocks > 0 means the main thread skipped blocks
 * under load; the worklet path should read zero by construction.
 */
export interface UtteranceStats {
  lostBlocks: number;
  srcBlocks: number;
}

/**
 * Frames missing against wall time, clamped: surplus frames (pre-roll
 * replay, VAD tail) never report negative loss.
 */
export function utteranceLoss(spanMs: number, framesOut: number): number {
  return Math.max(0, Math.round(spanMs / 40) - framesOut);
}

/**
 * Which audio thread feeds the VAD. The worklet runs off the main thread,
 * so occluded tabs and render bursts cannot skip mic blocks; the
 * ScriptProcessor runs on it and drops blocks under load. Logged per turn
 * so a lossy session names its engine instead of guessing.
 */
export type CaptureEngine = "worklet" | "script";

export interface CaptureCallbacks {
  onFrame: (frame: Int16Array) => void;
  onSpeechStart: () => void;
  onSpeechEnd: (stats?: UtteranceStats) => void;
  /** Fires once per startCapture with the engine above; keep it ref-only. */
  onEngine?: (engine: CaptureEngine) => void;
  /** Fires on every audio block, speech or silence: the stall watchdog. */
  onHeartbeat?: () => void;
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
      warmWorklet(prepared);
      return;
    }
    try {
      void prepared?.close().catch(() => {});
    } catch {
      /* already torn down */
    }
    prepared = new Ctor({ sampleRate: CAPTURE_RATE });
    void prepared.resume().catch(() => {});
    warmWorklet(prepared);
  } catch {
    /* unsupported here: startCapture throws the clear error */
  }
}

/**
 * Kill-switch for the AudioWorklet path (diagnosing iOS, A/B): "0" forces
 * the ScriptProcessor fallback. Reads once per warm, not per block.
 */
function workletEnabled(): boolean {
  try {
    return (
      typeof process === "undefined" ||
      process.env.NEXT_PUBLIC_CAPTURE_WORKLET !== "0"
    );
  } catch {
    return true;
  }
}

let workletModuleUrl: string | null = null;

/**
 * Fire-and-forget from the tap gesture: register the processor module on
 * the warmed context so startCapture finds it ready. Any failure (old
 * browser, blocked Blob URL) just leaves the ScriptProcessor fallback.
 */
function warmWorklet(context: AudioContext): void {
  try {
    const audioWorklet = (
      context as unknown as {
        audioWorklet?: { addModule: (url: string) => Promise<void> };
      }
    ).audioWorklet;
    if (!audioWorklet || !workletEnabled()) return;
    const flag = context as unknown as { __valeWorklet?: string };
    if (flag.__valeWorklet) return;
    flag.__valeWorklet = "warming";
    if (!workletModuleUrl) {
      workletModuleUrl = URL.createObjectURL(
        new Blob([captureWorkletSource()], { type: "application/javascript" }),
      );
    }
    const url = workletModuleUrl;
    void audioWorklet.addModule(url).then(
      () => {
        flag.__valeWorklet = "ready";
      },
      () => {
        flag.__valeWorklet = "failed";
      },
    );
  } catch {
    /* fallback below covers every failure */
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
  /** Live AudioContext state: the stall watchdog reports it, never blocks on it. */
  state: () => string;
  /** Which thread feeds this capture; the turn log persists it. */
  engine: () => CaptureEngine;
  /**
   * Strict turns: while paused, blocks still heartbeat (the watchdog stays
   * alive) but feed neither the detector nor the frames. Resuming clears
   * stale pre-roll so her just-finished voice never prefixes the next turn.
   * Optional so older test doubles still typecheck; startCapture always
   * provides it and the app guards the call.
   */
  setPaused?: (paused: boolean) => void;
}

/**
 * The worklet path is only taken when its module finished loading on this
 * context. Anything else (old browser, blocked Blob, tap-race) falls back
 * to the ScriptProcessor and the turn log says so via onEngine.
 */
export function isWorkletReady(context: AudioContext): boolean {
  try {
    return (
      workletEnabled() &&
      typeof context.audioWorklet !== "undefined" &&
      (context as unknown as { __valeWorklet?: string }).__valeWorklet ===
        "ready"
    );
  } catch {
    return false;
  }
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
  // Muted tap so capture runs without audible feedback.
  const mute = context.createGain();
  mute.gain.value = 0;
  mute.connect(context.destination);

  let detector = new SpeechDetector(detectorOptions);
  const preroll: Int16Array[] = [];
  // Per-utterance delivery accounting: trip wall time, frames the VAD saw,
  // replayed pre-roll among them, and source blocks spanned. Reset at every
  // trip; read at the end.
  let uttTripAt = 0;
  let uttFrames = 0;
  let uttReplayed = 0;
  let uttQuantaFirst = 0;
  let uttQuantaLast = 0;
  /**
   * Fresh listening after a mute: the detector froze mid-state while she
   * spoke (often mid-speech), and the pre-roll was just flushed. Without
   * this, post-resume room tone closes a stale speech and births a junk
   * turn that rides to Meta.
   */
  const resetListening = () => {
    detector = new SpeechDetector(detectorOptions);
    preroll.length = 0;
    carry = new Float32Array(0);
    uttTripAt = 0;
  };
  let stopped = false;
  let paused = false;
  /** Sub-frame remainder: the previous block's tail joins the next head. */
  let carry: Float32Array = new Float32Array(0);
  /** Source intake events: ScriptProcessor runs, or worklet quanta. */
  let runQuanta = 0;

  const heartbeat = () => {
    try {
      callbacks.onHeartbeat?.();
    } catch {
      /* the watchdog must never break capture */
    }
  };

  const emitLevelFloat = (mono: Float32Array) => {
    if (!callbacks.onLevel) return;
    let sum = 0;
    for (let i = 0; i < mono.length; i++) sum += Math.abs(mono[i]);
    const level = mono.length === 0 ? 0 : Math.min(1, sum / mono.length);
    try {
      callbacks.onLevel(level);
    } catch {
      /* meter must never break capture */
    }
  };

  const emitLevelPcm = (frame: Int16Array) => {
    if (!callbacks.onLevel) return;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += Math.abs(frame[i]);
    const level =
      frame.length === 0 ? 0 : Math.min(1, sum / frame.length / 32768);
    try {
      callbacks.onLevel(level);
    } catch {
      /* meter must never break capture */
    }
  };

  // Shared VAD path for both engines: the detector, the pre-roll and the
  // utterance accounting behave identically on ScriptProcessor blocks and
  // worklet frames.
  const feedFrame = (frame: Int16Array, quanta: number) => {
    const transition = detector.feed(frame);
    if (!detector.isSpeaking && transition === "silence") {
      preroll.push(frame);
      if (preroll.length > PREROLL_FRAMES) preroll.shift();
      return;
    }
    if (transition === "speech-start") {
      uttTripAt = Date.now();
      uttReplayed = preroll.length;
      uttFrames = preroll.length + 1;
      uttQuantaFirst = quanta;
      uttQuantaLast = quanta;
      for (const buffered of preroll) callbacks.onFrame(buffered);
      preroll.length = 0;
      callbacks.onSpeechStart();
      callbacks.onFrame(frame);
      return;
    }
    if (detector.isSpeaking) {
      uttFrames += 1;
      uttQuantaLast = quanta;
    }
    callbacks.onFrame(frame);
    if (transition === "speech-end") {
      const stats: UtteranceStats = {
        lostBlocks: utteranceLoss(Date.now() - uttTripAt, uttFrames - uttReplayed),
        srcBlocks: Math.max(0, uttQuantaLast - uttQuantaFirst + 1),
      };
      uttTripAt = 0;
      callbacks.onSpeechEnd(stats);
    }
  };

  const mixMono = (getChannelData: (ch: number) => Float32Array, channels: number, length: number): Float32Array => {
    const input = getChannelData(0);
    if (channels <= 1) return input;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < channels; ch++) {
      const data = getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += data[i];
    }
    for (let i = 0; i < length; i++) mono[i] /= channels;
    return mono;
  };

  let workletNode: AudioWorkletNode | null = null;
  let scriptProcessor: ScriptProcessorNode | null = null;
  try {
    const ready = isWorkletReady(context);
    if (ready) {
      const node = new AudioWorkletNode(context, CAPTURE_WORKLET_NAME);
      node.port.onmessage = (event: MessageEvent) => {
        const msg = event.data as {
          type?: string;
          pcm?: unknown;
          quanta?: unknown;
        } | null;
        if (!msg || stopped) return;
        if (msg.type === "beat") {
          heartbeat();
          return;
        }
        if (msg.type !== "frame" || !(msg.pcm instanceof ArrayBuffer)) return;
        // Belt and suspenders with the worklet-side pause: drop here too.
        if (paused) {
          heartbeat();
          return;
        }
        heartbeat();
        const frame = new Int16Array(msg.pcm);
        emitLevelPcm(frame);
        feedFrame(
          frame,
          typeof msg.quanta === "number" ? msg.quanta : 0,
        );
      };
      source.connect(node);
      node.connect(mute);
      workletNode = node;
    }
  } catch {
    workletNode = null;
  }

  if (!workletNode) {
    const processor = context.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(mute);
    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (stopped) return;
      runQuanta += 1;
      // Muted while Vale speaks: blocks still heartbeat, nothing else flows.
      if (paused) {
        heartbeat();
        return;
      }
      heartbeat();
      const input = event.inputBuffer.getChannelData(0);
      const mono = mixMono(
        (ch: number) => event.inputBuffer.getChannelData(ch),
        event.inputBuffer.numberOfChannels,
        input.length,
      );
      const resampled = resampleLinear(mono, actualRate);
      // Same samples as the VAD: no extra audio API.
      emitLevelFloat(mono);
      const sliced = framePcmBlocks(carry, resampled);
      carry = sliced.carry;
      for (const frame of sliced.frames) feedFrame(frame, runQuanta);
    };
    scriptProcessor = processor;
  }

  const engine: CaptureEngine = workletNode ? "worklet" : "script";
  try {
    callbacks.onEngine?.(engine);
  } catch {
    /* engine reporting never breaks capture */
  }

  return {
    engine: () => engine,
    stop() {
      stopped = true;
      try {
        try {
          workletNode?.port.close();
        } catch {
          /* already closed */
        }
        workletNode?.disconnect();
        scriptProcessor?.disconnect();
        source.disconnect();
        mute.disconnect();
      } catch {
        /* already torn down */
      }
      void context.close().catch(() => {});
    },
    setPaused(next: boolean) {
      paused = next;
      try {
        workletNode?.port.postMessage({ type: next ? "pause" : "resume" });
      } catch {
        /* torn down; the local flags still hold */
      }
      if (!next) resetListening();
    },
    state() {
      try {
        return context.state;
      } catch {
        return "unknown";
      }
    },
  };
}
