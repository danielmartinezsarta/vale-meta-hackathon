"use client";

import { useEffect, useState } from "react";
import { ManageField, ManageShell } from "./ManageShell";
import { manageGet, managePost } from "./manageApi";
import {
  setSeamlessAvailable,
  setVoiceEngine,
  voiceEngine,
  type VoiceEngine,
} from "@/lib/speak";
import { uiStrings } from "@/lib/vale-ui";
import type { ValeLanguage } from "@/lib/vale-language";
import styles from "./ManageScreens.module.css";

/**
 * Preferences: profile name (the seed stays "demo" until edited),
 * language, and the voice picker with the same engine and Seamless
 * availability check as the Settings sheet.
 */
export function PreferencesScreen({
  onBack,
  language,
  onLanguageChange,
}: {
  onBack: () => void;
  language: ValeLanguage;
  onLanguageChange: (next: ValeLanguage) => void;
}) {
  const ui = uiStrings(language);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [engine, setEngine] = useState<VoiceEngine>(() => voiceEngine());
  const [seamless, setSeamless] = useState(false);

  useEffect(() => {
    let live = true;
    manageGet<{ name: string }>("profile")
      .then((data) => {
        if (live) setName(data.name);
      })
      .catch(() => {
        if (live) setNotice("Could not load the profile.");
      });
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

  const save = async () => {
    try {
      const result = await managePost("profile", { name });
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  };

  return (
    <ManageShell title="Preferences" onBack={onBack} notice={notice} actionLabel="Save" onAction={save}>
      <div style={{ display: "contents" }}>
        <ManageField label="Name">
          <input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        </ManageField>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>Language</legend>
          <label>
            <input type="radio" name="prefs-language" value="en" checked={language === "en"} onChange={() => onLanguageChange("en")} />{" "}
            EN
          </label>{" "}
          <label>
            <input type="radio" name="prefs-language" value="es" checked={language === "es"} onChange={() => onLanguageChange("es")} />{" "}
            ES
          </label>
        </fieldset>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>{ui.voiceEngine}</legend>
          <label>
            <input type="radio" name="prefs-voice-engine" value="browser" checked={engine === "browser"} onChange={() => pick("browser")} />{" "}
            {ui.browserVoice}
          </label>{" "}
          <label>
            <input
              type="radio"
              name="prefs-voice-engine"
              value="seamless"
              checked={engine === "seamless"}
              disabled={!seamless}
              onChange={() => pick("seamless")}
            />{" "}
            {ui.seamlessVoice}
          </label>
          {!seamless && <p>{ui.seamlessUnavailable}</p>}
          {!seamless && <p className={styles.sub}>{ui.seamlessEnableHint}</p>}
        </fieldset>
      </div>
    </ManageShell>
  );
}
