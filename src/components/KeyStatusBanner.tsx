"use client";

import { useEffect, useState } from "react";
import { turnErrorText, type ValeLanguage } from "@/lib/vale-language";

/**
 * Upfront banner when voice cannot run: no key and no replay. The per-turn
 * 503 already says this after a tap; this says it before the first one, so
 * a clean start never looks broken.
 */
export function KeyStatusBanner({ language = "en" }: { language?: ValeLanguage }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/status")
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const status = (await response.json()) as { key?: unknown; replay?: unknown };
        if (!cancelled) setVisible(status.key !== true && status.replay !== true);
      })
      .catch(() => {
        /* the per-turn error still speaks; the banner stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;
  return (
    <p role="status">
      {turnErrorText("setup", language)}{" "}
      {language === "es"
        ? "Configura META_API_KEY, o arranca con VALE_REPLAY=1 para ver la demo grabada."
        : "Set META_API_KEY, or start with VALE_REPLAY=1 to watch the recorded demo."}
    </p>
  );
}
