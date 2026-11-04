"use client";

import type { ReactNode } from "react";
import type { ValeState } from "@/lib/vale-state";
import type { Widget } from "@/lib/widget";
import type { ValeLanguage } from "@/lib/vale-language";
import type { HomeMode } from "@/lib/vale-theme";
import {
  ValeScreenShell,
  type ScreenBubble,
} from "@/components/ValeScreenShell";
import type { SheetCallbacks } from "@/components/ValeSheets";
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
  micMuted,
  typedField,
  onToggleMute,
  onToggleMicMute,
  onSleep,
  onRetry,
  onCloseWidget,
  onVote,
  sheetCallbacks,
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
  micMuted?: boolean;
  typedField?: ReactNode;
  onToggleMute: () => void;
  onToggleMicMute?: () => void;
  onSleep: () => void;
  onRetry?: () => void;
  onCloseWidget: () => void;
  onVote: (vote: "yes" | "no") => void;
  sheetCallbacks?: SheetCallbacks;
}) {
  return (
    <ValeScreenShell
      frameClassName={styles.awake}
      mode={mode}
      robotState={robotState}
      level={level}
      title="Hi, I'm Vale"
      bubbles={bubbles}
      widget={widget}
      language={language}
      muted={muted}
      micMuted={micMuted}
      notice={notice}
      alert={alert}
      onToggleMute={onToggleMute}
      onToggleMicMute={onToggleMicMute}
      onSleep={onSleep}
      onRetry={onRetry}
      onCloseWidget={onCloseWidget}
      sheetCallbacks={sheetCallbacks}
      onVote={onVote}
      below={micMuted ? typedField : null}
    />
  );
}
