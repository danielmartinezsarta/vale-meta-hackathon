"use client";

import type { CSSProperties, ReactNode } from "react";
import styles from "./PhoneFrame.module.css";

/**
 * The demo phone column: screens keep their own layout inside a centered
 * 390-430 px column, and the gutters reuse the screen background so wide
 * viewports show no bands or cut-off controls.
 */
export function PhoneFrame({
  background,
  children,
}: {
  background: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.frame} style={{ background } as CSSProperties}>
      <div className={styles.col}>{children}</div>
    </div>
  );
}
