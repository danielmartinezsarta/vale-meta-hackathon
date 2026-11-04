#!/usr/bin/env python3
"""Build the demo's fake-mic audio from the committed run.

Reads every transcript in replay/demo-run.json, speaks each with macOS
`say`, converts to 48 kHz mono WAV, and stitches them with leading,
trailing, and inter-utterance silence. Fails loud without say/afconvert.
Usage: make-speech-wav.py <demo-run.json> <out.wav>
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import wave


def need(binary: str) -> None:
    if shutil.which(binary) is None:
        raise SystemExit(f"demo needs {binary} to build the fake-mic audio")


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: make-speech-wav.py <demo-run.json> <out.wav>")
    run_path, out_path = sys.argv[1], sys.argv[2]
    need("say")
    need("afconvert")
    with open(run_path, encoding="utf-8") as handle:
        run = json.load(handle)
    transcripts = [str(turn["transcript"]) for turn in run["turns"]]
    if not transcripts:
        raise SystemExit("demo run has no turns; refusing to build silence")

    tmp = tempfile.mkdtemp(prefix="replay-wav-")
    wavs: list[str] = []
    try:
        for index, text in enumerate(transcripts):
            aiff = os.path.join(tmp, f"t{index:02d}.aiff")
            wav = os.path.join(tmp, f"t{index:02d}.wav")
            run(["say", "-v", "Samantha", "-o", aiff, text])
            run(["afconvert", "-f", "WAVE", "-d", "LEI16@48000", "-c", "1", aiff, wav])
            wavs.append(wav)

        out = wave.open(out_path, "wb")
        try:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(48000)

            def silence(seconds: float) -> None:
                count = int(48000 * seconds)
                out.writeframes(struct.pack(f"<{count}h", *([0] * count)))

            def normalized(path: str, peak: int = 16000) -> bytes:
                with wave.open(path, "rb") as source:
                    raw = source.readframes(source.getnframes())
                count = len(raw) // 2
                samples = struct.unpack(f"<{count}h", raw)
                loudest = max([abs(sample) for sample in samples] or [1])
                return struct.pack(
                    f"<{count}h",
                    *[int(sample / loudest * peak) for sample in samples],
                )

            silence(10)
            for wav in wavs:
                out.writeframes(normalized(wav))
                silence(4)
            silence(10)
        finally:
            out.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"speech wav: {out_path} ({len(transcripts)} turns)")


if __name__ == "__main__":
    main()
