"use client";

import { useEffect, useState } from "react";
import type { HomeMode } from "@/lib/vale-theme";

/** Day/night follows the device; the reference keeps the switch out of the UI. */
export function useScreenMode(): HomeMode {
  const [mode, setMode] = useState<HomeMode>("day");
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const apply = () => setMode(query.matches ? "night" : "day");
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return mode;
}
