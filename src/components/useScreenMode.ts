"use client";

import { useEffect, useState } from "react";
import type { HomeMode } from "@/lib/vale-theme";

/** Stored override from the app shell, if the user ever set one. */
function storedMode(): HomeMode | null {
  try {
    const saved = window.localStorage.getItem("vale-theme");
    if (saved === "light") return "day";
    if (saved === "dark") return "night";
    return null;
  } catch {
    return null;
  }
}

/** Day/night follows the stored choice, else the device. */
export function useScreenMode(): HomeMode {
  const [mode, setMode] = useState<HomeMode>("day");
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => setMode(storedMode() ?? (query?.matches ? "night" : "day"));
    apply();
    query?.addEventListener("change", apply);
    return () => query?.removeEventListener("change", apply);
  }, []);
  return mode;
}
