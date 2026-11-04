"use client";

import type { CSSProperties, ReactNode } from "react";
import { useScreenMode } from "@/components/useScreenMode";
import styles from "./ManageScreens.module.css";

/**
 * HACK-030 shared shell for the management screens: back button top-left,
 * title, scrolling list/detail body, and one primary action bottom-wide.
 * Same overlay look and --vs-* tokens as the HomeScreen menu.
 */
export function ManageShell({
  title,
  onBack,
  actionLabel,
  onAction,
  actionDisabled,
  notice,
  children,
}: {
  title: string;
  onBack: () => void;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  notice?: string | null;
  children: ReactNode;
}) {
  const mode = useScreenMode();
  return (
    <div
      className={styles.mg}
      style={{ colorScheme: mode === "night" ? "dark" : "light" } as CSSProperties}
    >
      <div className={styles.top}>
        <button className={styles.back} type="button" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M15 5l-7 7 7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h1 className={styles.title}>{title}</h1>
      </div>
      <div className={styles.body}>{children}</div>
      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}
      {actionLabel && onAction ? (
        <button
          className={styles.action}
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/** Label above the control, 48px minimum touch target. */
export function ManageField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}
