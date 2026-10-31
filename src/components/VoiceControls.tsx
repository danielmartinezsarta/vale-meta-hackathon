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
  prosodyFor,
  setVoiceForLanguage,
  setVoicePrefs,
} from "@/lib/speak";
import type { ValeLanguage } from "@/lib/vale-language";

/** Runtime voice controls: one voice per language, speed, pitch and a Test button. English only. */
export function VoiceControls({ language = "en" }: { language?: ValeLanguage }) {
  const [voices, setVoices] = useState<{ name: string; lang: string }[]>([]);
  // Rerender trigger; values always read fresh so a language switch loads hers.
  const [, setPrefs] = useState(() => getVoicePrefs());

  useEffect(() => {
    let live = true;
    void getBrowserVoices(language).then((list) => {
      if (live) setVoices(list);
    });
    return () => {
      live = false;
    };
  }, [language]);

  // The selector shows only the active language; each language keeps hers,
  // voice and prosody both. Switching language loads its own saved pair.
  const selected =
    preferredVoice(language) !== null &&
    voices.some((voice) => voice.name === preferredVoice(language))
      ? (preferredVoice(language) as string)
      : "";
  const prosody = prosodyFor(language);
  const setProsody = (patch: { rate?: number; pitch?: number }) =>
    setPrefs(
      setVoicePrefs(
        language === "es"
          ? { rateEs: patch.rate, pitchEs: patch.pitch }
          : { rateEn: patch.rate, pitchEn: patch.pitch },
      ),
    );
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
          value={prosody.rate}
          onChange={(event) => {
            setProsody({ rate: Number(event.target.value) });
          }}
        />{" "}
        {prosody.rate.toFixed(1)}x
      </label>{" "}
      <label>
        Pitch{" "}
        <input
          type="range"
          aria-label="Pitch"
          min={PITCH_MIN}
          max={PITCH_MAX}
          step={0.1}
          value={prosody.pitch}
          onChange={(event) => {
            setProsody({ pitch: Number(event.target.value) });
          }}
        />{" "}
        {prosody.pitch.toFixed(1)}x
      </label>{" "}
      <button type="button" onClick={() => previewVoice(language)}>
        Test
      </button>
    </fieldset>
  );
}
