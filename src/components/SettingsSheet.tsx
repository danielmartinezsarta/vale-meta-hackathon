"use client";

import { useEffect, useState } from "react";
import { WidgetSheet } from "@/components/WidgetSheet";
import { setVoiceEngine, voiceEngine, type VoiceEngine } from "@/lib/speak";
import { uiStrings } from "@/lib/vale-ui";
import type { ValeLanguage } from "@/lib/vale-language";

/**
 * Settings sheet, voice section only: the output engine picker. Browser
 * is the default; Seamless stays disabled with a notice until the server
 * reports SEAMLESS_URL. The pick applies to the next Vale turn, no reload.
 */
export function SettingsSheet({
  language,
  onClose,
}: {
  language: ValeLanguage;
  onClose: () => void;
}) {
  const ui = uiStrings(language);
  const [engine, setEngine] = useState<VoiceEngine>(() => voiceEngine());
  const [seamless, setSeamless] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/status")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (!live) return;
        if (data !== null && typeof data === "object" && "seamless" in data) {
          setSeamless((data as { seamless: unknown }).seamless === true);
        }
      })
      .catch(() => {
        /* unreachable server: Seamless stays disabled */
      });
    return () => {
      live = false;
    };
  }, []);

  const pick = (next: VoiceEngine) => {
    setVoiceEngine(next);
    setEngine(next);
  };

  return (
    <WidgetSheet size="half" onClose={onClose} label={ui.settings}>
      <fieldset>
        <legend>{ui.voiceEngine}</legend>
        <label>
          <input
            type="radio"
            name="vale-voice-engine"
            value="browser"
            checked={engine === "browser"}
            onChange={() => pick("browser")}
          />{" "}
          {ui.browserVoice}
        </label>
        <label>
          <input
            type="radio"
            name="vale-voice-engine"
            value="seamless"
            checked={engine === "seamless"}
            disabled={!seamless}
            onChange={() => pick("seamless")}
          />{" "}
          {ui.seamlessVoice}
        </label>
        {!seamless && <p>{ui.seamlessUnavailable}</p>}
      </fieldset>
    </WidgetSheet>
  );
}
