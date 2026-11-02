"use client";

import type { ValeState } from "@/lib/vale-state";
import type { Widget } from "@/lib/widget";
import type { ValeLanguage } from "@/lib/vale-language";
import type { HomeMode } from "@/lib/vale-theme";
import {
  ValeScreenShell,
  type ScreenBubble,
} from "@/components/ValeScreenShell";
import styles from "./ValeScreens.module.css";

/** Awake-screen bubbles: the session screen reuses the same shape. */
export type AwakeBubble = ScreenBubble;

/**
 * Vale awake, no session: big robot, mute, sleep, greeting, bubbles.
 * Session chrome lands with the session screen.
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
}) {
  return (
    <ValeScreenShell
      frameClassName={styles.awake}
      mode={mode}
      robotState={robotState}
      level={level}
      title="Hi, I'm Vale"
      subtitle="Just say it"
      bubbles={bubbles}
      widget={widget}
      language={language}
      muted={muted}
      notice={notice}
      alert={alert}
      onToggleMute={onToggleMute}
      onSleep={onSleep}
      onCloseWidget={onCloseWidget}
      onVote={onVote}
    />
  );
}
