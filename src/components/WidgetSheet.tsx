"use client";

import { useEffect, useRef, useState } from "react";
import type { WidgetSize } from "@/lib/widget";
import styles from "./WidgetSheet.module.css";

/**
 * Generic bottom sheet: any widget renders inside it. "half" rises to
 * mid-screen with Vale visible behind; "full" covers the screen. Closes
 * with the X button or by dragging down from the handle.
 */
export function WidgetSheet({
  size,
  open,
  onClose,
  label,
  children,
}: {
  size: WidgetSize;
  open: boolean;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ startY: number; dy: number; active: boolean }>({
    startY: 0,
    dy: 0,
    active: false,
  });
  const [dragDy, setDragDy] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const beginDrag = (clientY: number) => {
    dragRef.current = { startY: clientY, dy: 0, active: true };
  };
  const moveDrag = (clientY: number) => {
    if (!dragRef.current.active) return;
    const dy = Math.max(0, clientY - dragRef.current.startY);
    dragRef.current.dy = dy;
    setDragDy(dy);
  };
  const endDrag = () => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    const dy = dragRef.current.dy;
    setDragDy(0);
    if (dy > 64) onClose();
  };

  return (
    <section
      ref={sheetRef}
      role="dialog"
      aria-label={label}
      aria-hidden={open ? "false" : "true"}
      data-size={size}
      className={`${styles.sheet} ${open ? styles.open : ""}`}
      style={dragDy > 0 ? { transform: `translateY(${dragDy}px)` } : undefined}
    >
      <div
        className={styles.grab}
        role="button"
        tabIndex={0}
        aria-label={`Drag down to close ${label}`}
        onPointerDown={(event) => {
          try {
            (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
          } catch {
            /* jsdom and some browsers lack pointer capture: drag still works */
          }
          beginDrag(event.clientY);
        }}
        onPointerMove={(event) => moveDrag(event.clientY)}
        onPointerUp={() => endDrag()}
        onPointerCancel={() => endDrag()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onClose();
        }}
      >
        <span aria-hidden="true" />
      </div>
      <div className={styles.head}>
        <h2 className={styles.title}>{label}</h2>
        <button
          type="button"
          className={styles.close}
          aria-label={`Close ${label}`}
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <g
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M6.5 6.5l11 11" />
              <path d="M17.5 6.5l-11 11" />
            </g>
          </svg>
        </button>
      </div>
      {children}
    </section>
  );
}
