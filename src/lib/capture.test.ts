import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  floatToPcm16,
  resampleLinear,
  SpeechDetector,
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
