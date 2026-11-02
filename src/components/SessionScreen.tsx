"use client";

import { useEffect, useState } from "react";
import type { ValeState } from "@/lib/vale-state";
import type { Widget } from "@/lib/widget";
import type { ValeLanguage } from "@/lib/vale-language";
import type { HomeMode } from "@/lib/vale-theme";
import { sessionClock } from "@/lib/session-clock";
import { ValeScreenShell } from "@/components/ValeScreenShell";
import type { AwakeBubble } from "@/components/AwakeScreen";
import styles from "./ValeScreens.module.css";

export interface ValeSession {
  clientName: string;
  serviceName: string;
  startedAt: string;
}

const PHOTO_CHOICES = [
  { type: "before", title: "Before", hint: "Before the service starts" },
  { type: "final", title: "Final photo", hint: "The finished design" },
] as const;

export type PhotoType = (typeof PHOTO_CHOICES)[number]["type"];

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
  onPhotoType,
  onCloseWidget,
  onVote,
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
  onPhotoType: (type: PhotoType) => void;
  onCloseWidget: () => void;
  onVote: (vote: "yes" | "no") => void;
}) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const sheetOpen = cameraOpen || photosOpen;
  const closeSheets = () => {
    setCameraOpen(false);
    setPhotosOpen(false);
  };

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
      onVote={onVote}
      actions={
        <>
          <button
            className={styles.abtn}
            type="button"
            aria-label="Open camera"
            onClick={() => {
              setPhotosOpen(false);
              setCameraOpen(true);
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
              setCameraOpen(false);
              setPhotosOpen(true);
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
      overlays={
        <>
          {/* Backdrop is mouse-only; keyboard closes with Escape or the X. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className={`${styles.scrim} ${sheetOpen ? styles.scrimisopen : ""}`}
            onClick={closeSheets}
          />
          <section
            className={`${styles.psheet} ${cameraOpen ? styles.psheetopen : ""}`}
            role="dialog"
            aria-label="Photo type"
            aria-hidden={cameraOpen ? "false" : "true"}
          >
            <div className={styles.pgrab} aria-hidden="true" />
            <div className={styles.phead}>
              <span className={styles.pic} aria-hidden="true">
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
              </span>
              <h2 className={styles.ptitle}>Save photo as</h2>
              <span className={styles.ptag}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <g
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3.5 7.5A2 2 0 015.5 5.5h4l2 2.5h7a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />
                  </g>
                </svg>
                Client file
              </span>
            </div>
            <div className={styles.pchoices}>
              {PHOTO_CHOICES.map((choice, index) => (
                <button
                  key={choice.type}
                  className={styles.pchoice}
                  type="button"
                  onClick={() => {
                    closeSheets();
                    onPhotoType(choice.type);
                  }}
                >
                  <span className={styles.pchoicen} aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className={styles.pchoicet}>
                    <b>{choice.title}</b>
                    <small>{choice.hint}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section
            className={`${styles.psheet} ${styles.pics} ${photosOpen ? styles.psheetopen : ""}`}
            role="dialog"
            aria-label="Photos"
            aria-hidden={photosOpen ? "false" : "true"}
          >
            <div className={styles.pgrab} aria-hidden="true" />
            <div className={styles.phead}>
              <span className={styles.pic} aria-hidden="true">
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
              </span>
              <h2 className={styles.ptitle}>Photos</h2>
              <span className={styles.ptag}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <g
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3.5 7.5A2 2 0 015.5 5.5h4l2 2.5h7a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />
                  </g>
                </svg>
                Client file
              </span>
              <button
                className={`${styles.abtn} ${styles.ppicsclose}`}
                type="button"
                aria-label="Close photos"
                onClick={closeSheets}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M6.5 6.5l11 11" />
                    <path d="M17.5 6.5l-11 11" />
                  </g>
                </svg>
              </button>
            </div>
            <div className={styles.pphotos}>
              <figure className={styles.pphoto}>
                <div className={styles.pimg} data-photo-slot="before">
                  Before
                </div>
                <figcaption>Before</figcaption>
              </figure>
              <span className={styles.pplus} aria-hidden="true">
                +
              </span>
              <figure className={styles.pphoto}>
                <div className={styles.pimg} data-photo-slot="reference">
                  Reference
                </div>
                <figcaption>Client reference</figcaption>
              </figure>
            </div>
            <figure className={`${styles.pphoto} ${styles.pwide}`}>
              <div className={styles.pimg} data-photo-slot="expected">
                Expected result
              </div>
              <figcaption className={styles.pcap}>
                <span>Expected result</span>
                <span className={styles.pmuse}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z"
                      fill="currentColor"
                    />
                    <path
                      d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"
                      fill="currentColor"
                    />
                  </svg>
                  Preview by Muse Image
                </span>
              </figcaption>
            </figure>
          </section>
        </>
      }
    />
  );
}
