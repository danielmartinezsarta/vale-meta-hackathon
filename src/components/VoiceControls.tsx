"use client";

import { useEffect, useState } from "react";
import {
  PITCH_MAX,
  PITCH_MIN,
  RATE_MAX,
  RATE_MIN,
  getBrowserVoices,
  getVoicePrefs,
  preferredVoice,
  previewVoice,
  setVoiceForLanguage,
  setVoicePrefs,
} from "@/lib/speak";
import type { ValeLanguage } from "@/lib/vale-language";

/** Runtime voice controls: one voice per language, speed, pitch and a Test button. English only. */
export function VoiceControls({ language = "en" }: { language?: ValeLanguage }) {
  const [voices, setVoices] = useState<{ name: string; lang: string }[]>([]);
  const [prefs, setPrefs] = useState(() => getVoicePrefs());

  useEffect(() => {
    let live = true;
    void getBrowserVoices(language).then((list) => {
      if (live) setVoices(list);
    });
    return () => {
      live = false;
    };
  }, [language]);

  // The selector shows only the active language; each language keeps hers.
  const selected =
    preferredVoice(language) !== null &&
    voices.some((voice) => voice.name === preferredVoice(language))
      ? (preferredVoice(language) as string)
      : "";
  return (
    <fieldset>
      <legend>Voice</legend>{" "}
      <label>
        Voice{" "}
        <select
          aria-label="Voice"
          value={selected}
          onChange={(event) => {
            const voice = event.target.value === "" ? null : event.target.value;
            setPrefs(setVoiceForLanguage(language, voice));
          }}
        >
          <option value="">System default</option>
          {voices.map((voice) => (
            <option key={voice.name} value={voice.name}>
              {voice.name}
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        Speed{" "}
        <input
          type="range"
          aria-label="Speed"
          min={RATE_MIN}
          max={RATE_MAX}
          step={0.1}
          value={prefs.rate}
          onChange={(event) => {
            setPrefs(setVoicePrefs({ rate: Number(event.target.value) }));
          }}
        />{" "}
        {prefs.rate.toFixed(1)}x
      </label>{" "}
      <label>
        Pitch{" "}
        <input
          type="range"
          aria-label="Pitch"
          min={PITCH_MIN}
          max={PITCH_MAX}
          step={0.1}
          value={prefs.pitch}
          onChange={(event) => {
            setPrefs(setVoicePrefs({ pitch: Number(event.target.value) }));
          }}
        />{" "}
        {prefs.pitch.toFixed(1)}x
      </label>{" "}
      <button type="button" onClick={() => previewVoice(language)}>
        Test
      </button>
    </fieldset>
  );
}
