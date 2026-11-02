"use client";

import type { CSSProperties, ReactNode } from "react";
import { VoiceRobot } from "@/components/VoiceRobot";
import { PhoneFrame } from "@/components/PhoneFrame";
import { valeVars, type HomeMode } from "@/lib/vale-theme";
import type { ValeState } from "@/lib/vale-state";
import type { Widget } from "@/lib/widget";
import { WidgetSheet } from "@/components/WidgetSheet";
import { WidgetCard } from "@/components/WidgetCard";
import type { ValeLanguage } from "@/lib/vale-language";
import styles from "./ValeScreens.module.css";

export interface ScreenBubble {
  id: string;
  text: string;
  from: "user" | "vale";
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
  notice,
  alert,
  actions,
  below,
  overlays,
  onToggleMute,
  onSleep,
  onCloseWidget,
  onVote,
}: {
  frameClassName?: string;
  mode: HomeMode;
  robotState: ValeState;
  level?: number;
  title: string;
  subtitle: string;
  bubbles: ScreenBubble[];
  widget: Widget | null;
  language: ValeLanguage;
  muted: boolean;
  notice: string | null;
  alert: string | null;
  actions?: ReactNode;
  below?: ReactNode;
  overlays?: ReactNode;
  onToggleMute: () => void;
  onSleep: () => void;
  onCloseWidget: () => void;
  onVote: (vote: "yes" | "no") => void;
}) {
  const visible = bubbles.slice(-3);
  const vars = valeVars(mode);
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
        {actions}
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
        <div className={styles.cap}>{title}</div>
        <div className={styles.sub}>{subtitle}</div>
      </div>

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

      {below}

      {overlays}

      {widget && (
        <WidgetSheet size={widget.size} onClose={onCloseWidget} label={widget.title}>
          <WidgetCard widget={widget} language={language} onVote={onVote} />
        </WidgetSheet>
      )}

      {notice && <p role="status">{notice}</p>}

      {alert && <div role="alert">{alert}</div>}
    </div>
    </PhoneFrame>
  );
}
