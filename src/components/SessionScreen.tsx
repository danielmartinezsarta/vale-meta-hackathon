"use client";

import { useEffect, useState } from "react";
import type { ValeState } from "@/lib/vale-state";
import type { Widget } from "@/lib/widget";
import type { ValeLanguage } from "@/lib/vale-language";
import type { HomeMode } from "@/lib/vale-theme";
import { sessionClock } from "@/lib/session-clock";
import { ValeScreenShell } from "@/components/ValeScreenShell";
import type { SheetCallbacks } from "@/components/ValeSheets";
import type { AwakeBubble } from "@/components/AwakeScreen";
import styles from "./ValeScreens.module.css";

export interface ValeSession {
  id: number;
  clientName: string;
  serviceName: string;
  startedAt: string;
}

/**
 * Vale in session: client and service under the robot, bubbles, stopwatch,
 * camera and photos sheets. Health and money widgets keep the half sheet.
 */
export function SessionScreen({
  mode,
  robotState,
  level,
  bubbles,
  widget,
  language,
  session,
  muted,
  notice,
  alert,
  onToggleMute,
  onSleep,
  onOpenWidget,
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
  session: ValeSession;
  muted: boolean;
  notice: string | null;
  alert: string | null;
  onToggleMute: () => void;
  onSleep: () => void;
  onOpenWidget: (widget: Widget) => void;
  onCloseWidget: () => void;
  onVote: (vote: "yes" | "no") => void;
  sheetCallbacks?: SheetCallbacks;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <ValeScreenShell
      mode={mode}
      robotState={robotState}
      level={level}
      title={session.clientName}
      subtitle={session.serviceName}
      bubbles={bubbles}
      widget={widget}
      language={language}
      muted={muted}
      notice={notice}
      alert={alert}
      onToggleMute={onToggleMute}
      onSleep={onSleep}
      onCloseWidget={onCloseWidget}
      sheetCallbacks={sheetCallbacks}
      onVote={onVote}
      actions={
        <>
          <button
            className={styles.abtn}
            type="button"
            aria-label="Open camera"
            onClick={() =>
              onOpenWidget({
                kind: "camera_save_as",
                title: "Save photo as",
                size: "half",
                data: {},
              })
            }
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <g
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 8.5A2.5 2.5 0 016.5 6h1.8l1.2-1.8h5L15.7 6h1.8A2.5 2.5 0 0120 8.5v8a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 16.5z" />
                <circle cx="12" cy="12.5" r="3.4" />
              </g>
            </svg>
          </button>
          <button
            className={styles.abtn}
            type="button"
            aria-label="Photos: before, reference and expected result"
            onClick={() => {
              if (sheetCallbacks?.onPhotos) {
                sheetCallbacks.onPhotos();
              } else {
                onOpenWidget({
                  kind: "photos",
                  title: "Photos",
                  size: "full",
                  data: { before: null, reference: null, expected: null },
                });
              }
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <g
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="4" y="5" width="16" height="14" rx="3" />
                <circle cx="9" cy="10" r="1.6" />
                <path d="M4 16.5l4.5-4 3.5 3 3-2.5L20 16" />
              </g>
            </svg>
          </button>
        </>
      }
      below={
        <div className={styles.timer} role="timer" aria-label="Session time">
          <span className={styles.tlabel}>
            <i className={styles.tdot} aria-hidden="true" />
            Session
          </span>
          <span className={styles.ttime}>{sessionClock(session.startedAt, now)}</span>
        </div>
      }
    />
  );
}
