"use client";

import { useCallback, useEffect, useState } from "react";
import { getValeClientId } from "@/lib/client-id";
import styles from "./ReplayPill.module.css";

interface ReplayCurrent {
  scene: string;
  indexInScene: number;
  sceneCount: number;
}

interface ReplayStatus {
  cursor: number;
  total: number;
  paused: boolean;
  done: boolean;
  current: ReplayCurrent | null;
}

async function readState(client: string): Promise<ReplayStatus | null> {
  try {
    const response = await fetch(
      `/api/voice?replay=state&client=${encodeURIComponent(client)}`,
    );
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<ReplayStatus>;
    return typeof data.cursor === "number" && typeof data.total === "number"
      ? (data as ReplayStatus)
      : null;
  } catch {
    return null;
  }
}

function Icon({ d, rect }: { d?: string; rect?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {rect ? (
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
        ) : (
          <path d={d} />
        )}
      </g>
    </svg>
  );
}

// Floating replay controls, replay mode only: the scene name, the turn
// inside the scene (2/4) with a run progress line, plus scene controls.
// Always dark like the island it borrows from, readable on both themes.
export function ReplayPill() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<ReplayStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const client = getValeClientId();
    fetch("/api/status")
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const data = (await response.json()) as { replay?: unknown };
        if (!cancelled && data.replay === true) setEnabled(true);
      })
      .catch(() => {
        /* live mode: the pill stays hidden */
      });
    const tick = async () => {
      const next = await readState(client);
      if (!cancelled && next) setStatus(next);
    };
    const timer = setInterval(() => {
      void tick();
    }, 1000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const act = useCallback(async (action: string) => {
    const client = getValeClientId();
    try {
      const response = await fetch(
        `/api/voice?replay=${action}&client=${encodeURIComponent(client)}`,
      );
      if (!response.ok) return;
      const data = (await response.json()) as Partial<ReplayStatus>;
      if (typeof data.cursor === "number" && typeof data.total === "number") {
        setStatus(data as ReplayStatus);
      }
    } catch {
      /* the next poll repairs it */
    }
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        void act(status?.paused ? "resume" : "pause");
      } else if (event.key === "ArrowRight") {
        void act("next");
      } else if (event.key === "ArrowLeft") {
        void act("prev");
      }
    },
    [act, status?.paused],
  );

  if (!enabled || !status) return null;

  const expanded = !status.paused && !status.done;
  const label = status.done
    ? "Replay complete"
    : status.current
      ? `${status.current.scene} ${status.current.indexInScene}/${status.current.sceneCount}`
      : "Replay";
  const pct =
    status.total > 0 ? Math.min(100, Math.round((status.cursor / status.total) * 100)) : 0;

  return (
    <div
      className={`${styles.pill} ${expanded ? styles.open : styles.shut}`}
      role="region"
      aria-label="Replay controls"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.text}>{label}</span>
      <span className={styles.bar} aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className={styles.buttons}>
        <button
          type="button"
          className={styles.optional}
          aria-label="Previous scene"
          onClick={() => act("prev")}
        >
          <Icon d="M19 20 9 12l10-8v16zM5 19V5" />
        </button>
        <button
          type="button"
          aria-label={status.paused ? "Play replay" : "Pause replay"}
          onClick={() => act(status.paused ? "resume" : "pause")}
        >
          {status.paused ? <Icon d="M8 5v14l11-7z" /> : <Icon d="M9 5v14M15 5v14" />}
        </button>
        <button
          type="button"
          className={styles.optional}
          aria-label="Stop replay"
          onClick={() => act("stop")}
        >
          <Icon rect />
        </button>
        <button
          type="button"
          className={styles.optional}
          aria-label="Next scene"
          onClick={() => act("next")}
        >
          <Icon d="M5 4l10 8-10 8V4zM19 5v14" />
        </button>
      </span>
    </div>
  );
}
