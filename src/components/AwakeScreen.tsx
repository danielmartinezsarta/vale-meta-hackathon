"use client";

import type { CSSProperties, ReactNode } from "react";
import { VoiceRobot } from "@/components/VoiceRobot";
import { valeVars, type HomeMode } from "@/lib/vale-theme";
import type { ValeState } from "@/lib/vale-state";
import type { Widget } from "@/lib/widget";
import { WidgetSheet } from "@/components/WidgetSheet";
import { WidgetCard } from "@/components/WidgetCard";
import type { ValeLanguage } from "@/lib/vale-language";
import styles from "./ValeScreens.module.css";

export interface AwakeBubble {
  id: string;
  text: string;
  from: "user" | "vale";
  ignored?: boolean;
  ignoredTag?: string;
}

/**
 * Vale awake, no session: big robot, mute, sleep, greeting, bubbles.
 * Sheets render above; session chrome lands with the session screen.
 */
export function AwakeScreen({
  mode,
  robotState,
  level,
  bubbles,
  widget,
  language,
  muted,
  notice,
  alert,
  onToggleMute,
  onSleep,
  onCloseWidget,
  onVote,
  children,
}: {
  mode: HomeMode;
  robotState: ValeState;
  level?: number;
  bubbles: AwakeBubble[];
  widget: Widget | null;
  language: ValeLanguage;
  muted: boolean;
  notice: string | null;
  alert: string | null;
  onToggleMute: () => void;
  onSleep: () => void;
  onCloseWidget: () => void;
  onVote: (vote: "yes" | "no") => void;
  children?: ReactNode;
}) {
  const visible = bubbles.slice(-3);
  return (
    <div className={`${styles.aw} ${styles.idle}`} style={valeVars(mode) as CSSProperties}>
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
        <div className={styles.cap}>Hi, I&apos;m Vale</div>
        <div className={styles.sub}>Just say it</div>
      </div>

      <ol className={styles.chat} role="log" aria-label="Conversation" aria-live="polite">
        {visible.map((bubble) =>
          bubble.ignored ? (
            <li key={bubble.id} className={styles.msgignored}>
              {bubble.text} <small>{bubble.ignoredTag}</small>
            </li>
          ) : (
            <li
              key={bubble.id}
              className={`${styles.msg} ${bubble.from === "user" ? styles.msguser : styles.msgvale}`}
            >
              <span className={styles.sronly}>
                {bubble.from === "user" ? "You:" : "Vale:"}
              </span>{" "}
              {bubble.text}
            </li>
          ),
        )}
      </ol>

      {widget && (
        <WidgetSheet
          size={widget.size}
          open
          onClose={onCloseWidget}
          label={widget.title}
        >
          <WidgetCard widget={widget} language={language} onVote={onVote} />
        </WidgetSheet>
      )}

      {children}

      {notice && <p role="status">{notice}</p>}

      {alert && <div role="alert">{alert}</div>}
    </div>
  );
}
