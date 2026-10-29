"use client";

import { useEffect, useRef, useState } from "react";
import { speak, stopSpeaking } from "@/lib/speak";

const PHRASE =
  "Hola, soy Vale. Te anoto para el relleno de gel mañana a las tres.";

type Voice = "browser" | "seamless";

// Temporary comparison page for the voice verdict: same invented phrase
// through the browser voice or Seamless voice 10. Removed once decided.
export default function VoiceCheck() {
  const [voice, setVoice] = useState<Voice>("browser");
  const [status, setStatus] = useState("Not played yet.");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(
    () => () => {
      stopSpeaking();
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const selectVoice = (next: Voice) => {
    setVoice(next);
    stopSpeaking();
    audioRef.current?.pause();
    setStatus("Not played yet.");
  };

  const play = async () => {
    if (voice === "browser") {
      audioRef.current?.pause();
      const started = performance.now();
      speak(PHRASE);
      setStatus(
        `Playing with the browser voice (${Math.round(performance.now() - started)} ms to start).`,
      );
      return;
    }
    stopSpeaking();
    audioRef.current?.pause();
    setStatus("Generating with Seamless voice 10...");
    const started = performance.now();
    try {
      const url = `/api/seamless-voice?text=${encodeURIComponent(PHRASE)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("bad status");
      const blob = await res.blob();
      const seconds = res.headers.get("X-Synthesis-Seconds");
      let audioUrl: string;
      try {
        audioUrl = URL.createObjectURL(blob);
      } catch {
        audioUrl = url;
      }
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      await audio.play();
      setStatus(
        `Playing Seamless voice 10 (synthesis ${seconds ?? "?"} s, ${((performance.now() - started) / 1000).toFixed(1)} s total).`,
      );
    } catch {
      setStatus("Seamless voice 10 failed. Try again later.");
    }
  };

  return (
    <main>
      <h1>Vale voice check</h1>
      <p>Same invented phrase, two voices. Listen to both, then give the verdict.</p>
      <p>
        <q>{PHRASE}</q>
      </p>
      <fieldset>
        <legend>Voice</legend>
        <label>
          <input
            type="radio"
            name="voice"
            checked={voice === "browser"}
            onChange={() => selectVoice("browser")}
          />
          Browser voice
        </label>
        <label>
          <input
            type="radio"
            name="voice"
            checked={voice === "seamless"}
            onChange={() => selectVoice("seamless")}
          />
          Seamless voice 10
        </label>
      </fieldset>
      <button type="button" onClick={play}>
        Play
      </button>
      <p>{status}</p>
    </main>
  );
}
