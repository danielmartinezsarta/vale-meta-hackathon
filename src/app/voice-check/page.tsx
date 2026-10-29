"use client";

import { useEffect, useRef, useState } from "react";
import { speak, stopSpeaking } from "@/lib/speak";

const PHRASE =
  "Hola, soy Vale. Te anoto para el relleno de gel mañana a las tres.";

// Temporary comparison page for the voice verdict: same invented phrase
// through the browser voice and through MMS on Modal. Removed once decided.
export default function VoiceCheck() {
  const [browserStatus, setBrowserStatus] = useState("Not played yet.");
  const [mmsStatus, setMmsStatus] = useState("Not played yet.");
  const mmsAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(
    () => () => {
      stopSpeaking();
      mmsAudioRef.current?.pause();
      mmsAudioRef.current = null;
    },
    [],
  );

  const playBrowser = () => {
    mmsAudioRef.current?.pause();
    const started = performance.now();
    speak(PHRASE);
    setBrowserStatus(
      `Playing with the browser voice (${Math.round(performance.now() - started)} ms to start).`,
    );
  };

  const playMms = async () => {
    stopSpeaking();
    mmsAudioRef.current?.pause();
    setMmsStatus("Generating with MMS...");
    const started = performance.now();
    try {
      const url = `/api/mms-voice?text=${encodeURIComponent(PHRASE)}`;
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
      mmsAudioRef.current = audio;
      await audio.play();
      setMmsStatus(
        `Playing the MMS voice (synthesis ${seconds ?? "?"} s, ${((performance.now() - started) / 1000).toFixed(1)} s total).`,
      );
    } catch {
      setMmsStatus("The MMS voice failed. Try again later.");
    }
  };

  return (
    <main>
      <h1>Vale voice check</h1>
      <p>Same invented phrase, two voices. Listen to both, then give the verdict.</p>
      <p>
        <q>{PHRASE}</q>
      </p>
      <section>
        <h2>Option A: browser voice</h2>
        <button type="button" onClick={playBrowser}>
          Play browser voice
        </button>
        <p>{browserStatus}</p>
      </section>
      <section>
        <h2>Option B: MMS voice</h2>
        <button type="button" onClick={playMms}>
          Play MMS voice
        </button>
        <p>{mmsStatus}</p>
      </section>
    </main>
  );
}
