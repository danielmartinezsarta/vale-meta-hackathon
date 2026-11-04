"use client";

import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { SettingsSheet } from "@/components/SettingsSheet";
import { uiStrings } from "@/lib/vale-ui";
import { VoiceRobot } from "@/components/VoiceRobot";
import { PhoneFrame } from "@/components/PhoneFrame";
import { valeVars, type HomeMode } from "@/lib/vale-theme";
import type { ValeState } from "@/lib/vale-state";
import type { Widget } from "@/lib/widget";
import { CareOverlay, ValeSheets, type SheetCallbacks } from "@/components/ValeSheets";
import { WidgetSheet } from "@/components/WidgetSheet";
import { WidgetCard } from "@/components/WidgetCard";
import type { ValeLanguage } from "@/lib/vale-language";
import styles from "./ValeScreens.module.css";

export interface ScreenBubble {
  id: string;
  text: string;
  from: "user" | "vale";
  /** Interim user text, still being heard: shows "Heard you". */
  live?: boolean;
}

/** Subtitle under her name on the awake screen: what she is doing now. */
function stateLabel(state: ValeState, bubbles: ScreenBubble[]): string {
  switch (state) {
    case "speaking":
      return "Speaking";
    case "thinking":
      return "Thinking";
    case "error":
      return "Didn't catch that";
    case "done":
      return "Listening";
    case "listening":
      return bubbles.some((bubble) => bubble.from === "user" && bubble.live)
        ? "Heard you"
        : "Listening";
    default:
      return "Asleep";
  }
}

/**
 * Shared chrome of the awake and session screens: background, mute and
 * sleep buttons, robot stage, bubbles, and the generic widget sheet.
 * Session-only chrome (timer, camera and photos sheets) arrives as slots.
 */
export function ValeScreenShell({
  frameClassName,
  mode,
  robotState,
  level,
  title,
  subtitle,
  bubbles,
  widget,
  language,
  muted,
  micMuted = false,
  notice,
  alert,
  actions,
  below,
  overlays,
  onToggleMute,
  onToggleMicMute,
  onSleep,
  onCloseWidget,
  onVote,
  sheetCallbacks,
}: {
  frameClassName?: string;
  mode: HomeMode;
  robotState: ValeState;
  level?: number;
  title: string;
  subtitle?: string;
  bubbles: ScreenBubble[];
  widget: Widget | null;
  language: ValeLanguage;
  muted: boolean;
  micMuted?: boolean;
  notice: string | null;
  alert: string | null;
  actions?: ReactNode;
  below?: ReactNode;
  overlays?: ReactNode;
  onToggleMute: () => void;
  onToggleMicMute?: () => void;
  onSleep: () => void;
  onCloseWidget: () => void;
  onVote: (vote: "yes" | "no") => void;
  sheetCallbacks?: SheetCallbacks;
}) {
  const visible = bubbles.slice(-3);
  const vars = valeVars(mode);
  const ui = uiStrings(language);
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <PhoneFrame background={vars["--aw-bg"]}>
    <div
      className={`${styles.aw} ${frameClassName ?? ""}`}
      style={vars as CSSProperties}
    >
      <div className={styles.awbg} aria-hidden="true" />

      <div className={styles.aside}>
        <button
          className={`${styles.abtn} ${styles.mute}`}
          type="button"
          aria-label={muted ? "Unmute Vale" : "Mute Vale"}
          aria-pressed={muted}
          onClick={onToggleMute}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <g
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" />
              <path className={styles.wave} d="M15.5 9a4.2 4.2 0 010 6M18 6.5a8 8 0 010 11" />
              <path className={styles.slash} d="M4 4l16 16" />
            </g>
          </svg>
        </button>
        {onToggleMicMute && (
          <button
            className={`${styles.abtn} ${styles.mute}`}
            type="button"
            aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={micMuted}
            onClick={onToggleMicMute}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <g
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="2.5" width="6" height="11" rx="3" />
                <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
                <path d="M12 17.5V21" />
                <path className={styles.slash} d="M4 4l16 16" />
              </g>
            </svg>
          </button>
        )}
        {actions}
        <button
          className={`${styles.abtn} ${styles.mute}`}
          type="button"
          aria-label={ui.settings}
          onClick={() => setSettingsOpen(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <g
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="3.2" />
              <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" />
            </g>
          </svg>
        </button>
      </div>

      <button
        className={`${styles.abtn} ${styles.aclose}`}
        type="button"
        aria-label="Put Vale to sleep"
        onClick={onSleep}
      >
        <span className={styles.zzz} aria-hidden="true">
          <i>z</i>
          <i>z</i>
          <i>z</i>
        </span>
      </button>

      <div className={styles.stage}>
        <VoiceRobot state={robotState} level={level} className={styles.robot} />
        <div className={styles.cap}>{widget?.kind === "good_job" ? "Good job!" : title}</div>
        {widget?.kind === "good_job" ? (
          <div className={styles.sub}>Don&apos;t forget to hydrate and do some stretching before moving on.</div>
        ) : (
          <div className={styles.sub}>{subtitle ?? stateLabel(robotState, visible)}</div>
        )}
      </div>

      {widget?.kind === "good_job" ? (
        <CareOverlay />
      ) : (
      <ol className={styles.chat} role="log" aria-label="Conversation" aria-live="polite">
        {visible.map((bubble) => (
          <li
            key={bubble.id}
            className={`${styles.msg} ${bubble.from === "user" ? styles.msguser : styles.msgvale}`}
          >
            <span className={styles.sronly}>
              {bubble.from === "user" ? "You:" : "Vale:"}
            </span>{" "}
            {bubble.text}
          </li>
        ))}
      </ol>
      )}

      {below}

      {overlays}

      {widget &&
        (widget.kind === "confirm" ? (
          <WidgetSheet size={widget.size} onClose={onCloseWidget} label={widget.title}>
            <WidgetCard widget={widget} language={language} onVote={onVote} />
          </WidgetSheet>
        ) : (
          <>
            {widget.kind === "goal" && (
              <div className="aw-scrim is-open" role="presentation" onClick={onCloseWidget} />
            )}
            <ValeSheets widget={widget} onClose={onCloseWidget} {...sheetCallbacks} />
          </>
        ))}

      {notice && <p role="status">{notice}</p>}

      {alert && <div role="alert">{alert}</div>}

      {settingsOpen && (
        <SettingsSheet language={language} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
    </PhoneFrame>
  );
}
