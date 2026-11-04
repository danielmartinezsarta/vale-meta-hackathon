"use client";

import { useEffect, useState } from "react";
import type { HomeMode } from "@/lib/vale-theme";

/** Stored appearance: "light" only when the user picked it, else dark. */
export type ThemeChoice = "light" | "dark";

const KEY = "vale-theme";
const EVENT = "vale-theme-change";

export function themeChoice(): ThemeChoice {
  try {
    return window.localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Persist the pick, repaint <html> at once, and tell every mounted
 * useScreenMode hook so all three switches move together with no reload.
 */
export function applyTheme(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {
    /* private mode: the page still repaints */
  }
  document.documentElement.dataset.theme = choice;
  window.dispatchEvent(new CustomEvent<ThemeChoice>(EVENT, { detail: choice }));
}

/** Day/night follows the stored choice; with nothing saved it starts dark. */
export function useScreenMode(): HomeMode {
  const [mode, setMode] = useState<HomeMode>(() =>
    typeof window === "undefined" || themeChoice() === "dark" ? "night" : "day",
  );
  useEffect(() => {
    const onChange = (event: Event) => {
      const choice = (event as CustomEvent<ThemeChoice>).detail;
      setMode(choice === "light" ? "day" : "night");
    };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return mode;
}
