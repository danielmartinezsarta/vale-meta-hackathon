import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeWavPcm16Mono,
  sanitizeAudioStem,
  saveTurnWav,
  turnAudioDir,
} from "./turn-audio";

const dir = join(tmpdir(), `vale-audio-test-${process.pid}`);

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("turn audio evidence", () => {
  it("encodes a playable 24 kHz mono WAV header", () => {
    const samples = Buffer.from([1, 0, 255, 127]);
    const wav = encodeWavPcm16Mono(samples, 24000);
    expect(wav.length).toBe(44 + samples.length);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(44).equals(samples)).toBe(true);
  });

  it("saves one WAV per turn and nothing for silence", () => {
    vi.stubEnv("VALE_AUDIO_DIR", dir);
    expect(turnAudioDir()).toBe(dir);
    const frame = new Uint8Array(960 * 2).fill(7);
    const path = saveTurnWav("vale.test+1", [frame, frame]);
    expect(path).not.toBeNull();
    expect(path as string).toContain("vale-test-1");
    expect(existsSync(path as string)).toBe(true);
    expect(readFileSync(path as string).length).toBe(44 + frame.length * 2);
    expect(saveTurnWav("vale", [])).toBeNull();
  });

  it("falls back to a safe stem for hostile client ids", () => {
    expect(sanitizeAudioStem("../../../etc")).toBe("etc");
    expect(sanitizeAudioStem("!!!")).toBe("turn");
    expect(sanitizeAudioStem("Client 42")).toBe("client-42");
  });
});
