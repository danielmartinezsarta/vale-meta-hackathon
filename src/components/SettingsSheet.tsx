"use client";

import { useEffect, useState } from "react";
import { WidgetSheet } from "@/components/WidgetSheet";
import { SegmentedControl } from "./SegmentedControl";
import {
  setSeamlessAvailable,
  setVoiceEngine,
  voiceEngine,
  type VoiceEngine,
} from "@/lib/speak";
import { uiStrings } from "@/lib/vale-ui";
import type { ValeLanguage } from "@/lib/vale-language";
import styles from "./ValeScreens.module.css";

/**
 * Settings sheet, voice section only: the output engine picker. Browser
 * is the default; Seamless stays disabled with a notice until the server
 * reports both SEAMLESS_URL and SEAMLESS_TOKEN. A stale saved Seamless
 * pick falls back to browser. The pick applies to the next Vale turn.
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
          const available =
            (data as { seamless: unknown }).seamless === true;
          setSeamless(available);
          setSeamlessAvailable(available);
          if (!available) {
            setVoiceEngine("browser");
            setEngine("browser");
          }
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
        <SegmentedControl<VoiceEngine>
          label={ui.voiceEngine}
          value={engine}
          onChange={pick}
          options={[
            { value: "browser", label: ui.browserVoice },
            { value: "seamless", label: ui.seamlessVoice, disabled: !seamless },
          ]}
        />
        {!seamless && <p>{ui.seamlessUnavailable}</p>}
        {!seamless && <p className={styles.sub}>{ui.seamlessEnableHint}</p>}
      </fieldset>
    </WidgetSheet>
  );
}
