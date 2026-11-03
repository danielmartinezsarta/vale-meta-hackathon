/**
 * AudioWorklet processor source for Vale capture.
 *
 * Runs on the realtime audio thread (128-sample quanta), off the main
 * thread that ScriptProcessor blocks: page work (her voice, state renders,
 * bubbles) can no longer skip a mic block. It mirrors the main-thread DSP
 * in capture.ts (mono mix, windowed-sinc low-pass resample to 24 kHz,
 * 960-sample frames)
 * and reports its own quantum counter so the main thread can account
 * processed blocks against wall time per turn.
 *
 * Self-contained by necessity: worklet modules load from a Blob URL and
 * cannot import. Keep the math identical to capture.ts when touching either.
 */

export const CAPTURE_WORKLET_NAME = "vale-capture";

/**
 * Windowed-sinc low-pass for the worklet decimation, pure so tests pin it.
 * Cutoff at the target Nyquist, Blackman window, unity DC gain. The module
 * below embeds this exact function (stringified), so the tested math is the
 * shipped math. Self-contained by necessity: no imports, no closures.
 */
/**
 * Plain JS plus JSDoc on purpose: the module below embeds this exact
 * function (stringified), and an AudioWorklet module parses no TypeScript.
 * @param {number} fromRate device rate feeding the worklet
 * @param {number} toRate Meta rate, 24000
 * @param {number} halfTaps half the kernel width
 * @returns {number[]} unity-gain low-pass taps
 */
export function designLowpassKernel(
  fromRate = 48000,
  toRate = 24000,
  halfTaps = 24,
) {
  const cutoff = toRate / (2 * fromRate);
  const taps = halfTaps * 2 + 1;
  const kernel = new Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - halfTaps;
    const x = 2 * cutoff * k;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const windowed =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
    kernel[n] = 2 * cutoff * sinc * windowed;
    sum += kernel[n];
  }
  for (let n = 0; n < taps; n++) kernel[n] /= sum;
  return kernel;
}

/** Half-width of the decimation kernel: 49 taps at 48 kHz. */
const KERNEL_HALF_TAPS = 24;

/** Frames per message, 40 ms at 24 kHz: the VAD frame, same as main. */
const WORKLET_FRAME = 960;
/** Target rate: matches CAPTURE_RATE in capture.ts. */
const WORKLET_RATE = 24000;
/** Heartbeat while paused (the watchdog): ~1 post per second. */
const WORKLET_BEAT_EVERY_S = 1;

export function captureWorkletSource(): string {
  return `
"use strict";
// Re-bind under a stable name: the bundler minifies the function itself
// (designLowpassKernel becomes n), while the constructor below calls it by
// this literal name. Without this line the worklet dies with a silent
// ReferenceError and never posts a frame.
const designLowpassKernel = ${designLowpassKernel};
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
    // Decimation kernel for the actual device rate; linear interpolation
    // at 2:1 would alias everything above 12 kHz straight into her voice.
    this.kernel = designLowpassKernel(sampleRate, ${WORKLET_RATE}, ${KERNEL_HALF_TAPS});
    this.half = (${KERNEL_HALF_TAPS});
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
    const ratio = fromRate / ${WORKLET_RATE};
    const last = samples.length - 1;
    const out = new Float32Array(${WORKLET_FRAME});
    for (let i = 0; i < ${WORKLET_FRAME}; i++) {
      const center = Math.round(i * ratio);
      let acc = 0;
      for (let k = 0; k < this.kernel.length; k++) {
        const idx = center - this.half + k;
        const clamped = idx < 0 ? 0 : idx > last ? last : idx;
        acc += samples[clamped] * this.kernel[k];
      }
      out[i] = acc;
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
    const need =
      Math.round((${WORKLET_FRAME} * sampleRate) / ${WORKLET_RATE}) +
      1 +
      this.half;
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
