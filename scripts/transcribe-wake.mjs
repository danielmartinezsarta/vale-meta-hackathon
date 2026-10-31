// One-shot wake-word transcription pass (HACK-017, Daniel's adjustment 1).
// Usage: META_API_KEY=... node scripts/transcribe-wake.mjs <audio-dir>
// For each audio file: afconvert to 24 kHz mono PCM, stream once through Meta
// Voice Transcribe (PUSH_TO_TALK), print file, exact final transcript and
// audioProcessedMs. Run ONCE per recording set; results go in the report.
// The key travels only inside the WS handshake, never in output.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import WebSocket from "ws";

const ASR_URL = process.env.META_ASR_URL || "wss://api.meta.ai/v1/asr/realtime";
const KEY = process.env.META_API_KEY;
const dir = process.argv[2];
if (!KEY || !dir) {
  console.error("usage: META_API_KEY=... node scripts/transcribe-wake.mjs <audio-dir>");
  process.exit(1);
}

function toPcm24kMono(file) {
  const tmp = mkdtempSync(join(tmpdir(), "wake-"));
  const out = join(tmp, "audio.wav");
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", file, out]);
  const wav = readFileSync(out);
  rmSync(tmp, { recursive: true, force: true });
  // Read the data chunk, not a fixed header: afconvert writes extra chunks.
  const marker = wav.indexOf(Buffer.from("data"));
  if (marker < 0) throw new Error("no data chunk in converted wav");
  return wav.subarray(marker + 8, marker + 8 + wav.readUInt32LE(marker + 4));
}

function transcribeOnce(pcm) {
  return new Promise((resolve, reject) => {
    let endStreamAt = 0;
    const timer = setTimeout(() => reject(new Error("timeout waiting for final")), 60000);
    const ws = new WebSocket(ASR_URL);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          authorization: { accessToken: `Bearer ${KEY}` },
          audioEncoding: "PCM_24KHZ",
          model: "muse-voice-transcribe-1.0",
          mode: "PUSH_TO_TALK",
        }),
      );
    });
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.sessionId && !message.type) {
        for (let i = 0; i < pcm.length; i += 4800) ws.send(pcm.subarray(i, i + 4800));
        ws.send(JSON.stringify({ type: "endStream" }));
        endStreamAt = Date.now();
      } else if (message.type === "transcript" && message.final) {
        clearTimeout(timer);
        ws.close();
        // End-of-voice to final transcript: the valid ASR latency metric.
        resolve({
          transcript: message.transcript,
          audioProcessedMs: message.audioProcessedMs ?? null,
          asrLatencyMs: endStreamAt === 0 ? null : Date.now() - endStreamAt,
        });
      } else if (message.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(message.message ?? "transcription error"));
      }
    });
    ws.on("error", reject);
  });
}

const files = readdirSync(dir)
  .filter((f) => /\.(wav|aiff|aif|m4a|mp3|caf|opus|ogg)$/i.test(f))
  .sort();
for (const file of files) {
  try {
    const result = await transcribeOnce(toPcm24kMono(join(dir, file)));
    console.log(JSON.stringify({ file: basename(file), ...result }));
  } catch (error) {
    console.log(JSON.stringify({ file: basename(file), error: String(error) }));
  }
}
