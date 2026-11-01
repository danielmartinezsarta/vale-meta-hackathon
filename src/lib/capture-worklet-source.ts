/**
 * AudioWorklet processor source for Vale capture.
 *
 * Runs on the realtime audio thread (128-sample quanta), off the main
 * thread that ScriptProcessor blocks: page work (her voice, state renders,
 * bubbles) can no longer skip a mic block. It mirrors the main-thread DSP
 * in capture.ts (mono mix, linear resample to 24 kHz, 960-sample frames)
 * and reports its own quantum counter so the main thread can account
 * processed blocks against wall time per turn.
 *
 * Self-contained by necessity: worklet modules load from a Blob URL and
 * cannot import. Keep the math identical to capture.ts when touching either.
 */

export const CAPTURE_WORKLET_NAME = "vale-capture";

/** Frames per message, 40 ms at 24 kHz: the VAD frame, same as main. */
const WORKLET_FRAME = 960;
/** Target rate: matches CAPTURE_RATE in capture.ts. */
const WORKLET_RATE = 24000;
/** Heartbeat while paused (the watchdog): ~1 post per second. */
const WORKLET_BEAT_EVERY_S = 1;

export function captureWorkletSource(): string {
  return `
"use strict";
class ValeCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // Input-rate mono samples waiting to become 960-sample 24 kHz frames.
    this.acc = [];
    // Output samples owed: fractional, so odd rates never drift.
    this.budget = 0;
    this.quanta = 0;
    this.paused = false;
    this.lastBeat = 0;
    this.port.onmessage = (event) => {
      const type = event && event.data && event.data.type;
      if (type === "pause") this.paused = true;
      if (type === "resume") {
        this.paused = false;
        // Same contract as the main-thread pre-roll flush: her just-finished
        // voice never prefixes the next turn.
        this.acc.length = 0;
        this.budget = 0;
      }
    };
  }
  monoMix(input) {
    const out = new Float32Array(128);
    const channels = input.length;
    for (let i = 0; i < 128; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c][i] || 0;
      out[i] = sum / channels;
    }
    return out;
  }
  resampleTo24k(samples, fromRate) {
    const out = new Float32Array(${WORKLET_FRAME});
    for (let i = 0; i < ${WORKLET_FRAME}; i++) {
      const pos = (i * fromRate) / ${WORKLET_RATE};
      const lo = Math.floor(pos);
      const hi = Math.min(lo + 1, samples.length - 1);
      const frac = pos - lo;
      const a = samples[lo] === undefined ? 0 : samples[lo];
      const b = samples[hi] === undefined ? 0 : samples[hi];
      out[i] = a * (1 - frac) + b * frac;
    }
    return out;
  }
  toPcm16(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const clamped = Math.max(-1, Math.min(1, input[i]));
      out[i] =
        clamped < 0
          ? Math.round(clamped * 32768)
          : Math.round(clamped * 32767);
    }
    return out;
  }
  beat() {
    this.port.postMessage({ type: "beat", quanta: this.quanta });
    this.lastBeat = currentTime;
  }
  process(inputs) {
    this.quanta += 1;
    const input = inputs && inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const mixed = this.monoMix(input);
    for (let i = 0; i < mixed.length; i++) this.acc.push(mixed[i]);
    this.budget += (mixed.length * ${WORKLET_RATE}) / sampleRate;
    if (this.paused) {
      if (currentTime - this.lastBeat >= ${WORKLET_BEAT_EVERY_S}) this.beat();
      return true;
    }
    const need = Math.round((${WORKLET_FRAME} * sampleRate) / ${WORKLET_RATE}) + 1;
    while (this.budget >= ${WORKLET_FRAME} && this.acc.length >= need) {
      const slice = this.acc.slice(0, need);
      const frame = this.resampleTo24k(slice, sampleRate);
      const pcm = this.toPcm16(frame);
      this.port.postMessage(
        { type: "frame", pcm: pcm.buffer, quanta: this.quanta },
        [pcm.buffer],
      );
      const consumed = Math.round((${WORKLET_FRAME} * sampleRate) / ${WORKLET_RATE});
      this.acc.splice(0, consumed);
      this.budget -= ${WORKLET_FRAME};
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(CAPTURE_WORKLET_NAME)}, ValeCapture);
`;
}
