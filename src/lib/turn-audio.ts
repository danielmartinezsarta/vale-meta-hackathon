import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_RATE } from "./capture";

/**
 * Per-turn audio evidence: every completed turn keeps its mic PCM as a WAV
 * so Daniel can hear what the gate actually judged (her echo vs his voice,
 * cut vs silence). Written server-side for both ingress paths (WS bridge
 * and POST route); never served, never committed.
 */

/** 24 kHz mono 16-bit PCM, matching the capture frames both paths carry. */
export const TURN_AUDIO_RATE = CAPTURE_RATE;
export const TURN_AUDIO_CHANNELS = 1;
export const TURN_AUDIO_BITS = 16;

/** data/audio under the repo; VALE_AUDIO_DIR points tests at tmp. */
/**
 * Muted-start junk: the mic spent most of the turn muted (her tail) and
 * what arrived is flat — amplified room tone, not Daniel. Such a turn
 * never reaches the model: the ASR pennies are already spent by live
 * streaming, but the reply, the writes and the confusion are all avoided,
 * and the turn stays measurable in the log instead of vanishing.
 *
 * The flatness bar is deliberately low (peak/mean < 3): voice is spiky
 * (the …-3 turn reads 6.8) while room tone sits near 1-2, and the muted
 * dominance plus the 500 ms floor keep fast yeses and short turns safe.
 */
export function isMutedJunkTurn(
  samples: Int16Array,
  mutedMs: number | null,
  audioMs: number,
): boolean {
  if (mutedMs === null || mutedMs < 0) return false;
  if (!(audioMs > 500)) return false;
  if (!(mutedMs > audioMs / 2)) return false;
  const FRAME = 960;
  const frames = Math.floor(samples.length / FRAME);
  if (frames === 0) return false;
  let peak = 0;
  let total = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * FRAME;
    for (let i = 0; i < FRAME; i++) sum += Math.abs(samples[base + i]);
    const mean = sum / FRAME;
    total += mean;
    if (mean > peak) peak = mean;
  }
  const overall = total / frames;
  if (overall <= 0) return true;
  return peak / overall < 3;
}

export function turnAudioDir(): string {
  const override = process.env.VALE_AUDIO_DIR?.trim();
  if (override) return override;
  return join(process.cwd(), "data", "audio");
}

/** File stem safe for any client id; uniqueness comes from the timestamp. */
export function sanitizeAudioStem(raw: string): string {
  const stem = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return stem === "" ? "turn" : stem;
}

/** Minimal WAV header + raw PCM: playable anywhere, no dependency. */
export function encodeWavPcm16Mono(samples: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(TURN_AUDIO_CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(
    (sampleRate * TURN_AUDIO_CHANNELS * TURN_AUDIO_BITS) / 8,
    28,
  );
  header.writeUInt16LE((TURN_AUDIO_CHANNELS * TURN_AUDIO_BITS) / 8, 32);
  header.writeUInt16LE(TURN_AUDIO_BITS, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

/**
 * Persist one turn's PCM frames; returns the file path for the turn log,
 * null when there is nothing to keep or the disk refuses. Never throws.
 */
export function saveTurnWav(
  stem: string,
  chunks: readonly Uint8Array[],
  sampleRate: number = TURN_AUDIO_RATE,
): string | null {
  try {
    const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
    if (total === 0) return null;
    const dir = turnAudioDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${sanitizeAudioStem(stem)}.wav`);
    writeFileSync(
      path,
      encodeWavPcm16Mono(Buffer.concat(chunks.map((c) => Buffer.from(c))), sampleRate),
    );
    return path;
  } catch {
    return null;
  }
}
