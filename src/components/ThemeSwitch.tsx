"use client";

import { SegmentedControl } from "./SegmentedControl";
import { applyTheme, useScreenMode } from "./useScreenMode";
import { uiStrings } from "@/lib/vale-ui";
import type { ValeLanguage } from "@/lib/vale-language";

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19" />
      </g>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Light/dark appearance switch: sun and moon segments in the shared
 * control. One tap repaints the page and moves every mounted switch.
 */
export function ThemeSwitch({ language }: { language: ValeLanguage }) {
  const mode = useScreenMode();
  const ui = uiStrings(language);
  return (
    <SegmentedControl<"light" | "dark">
      label={ui.theme}
      value={mode === "day" ? "light" : "dark"}
      onChange={applyTheme}
      options={[
        { value: "light", label: <SunIcon />, ariaLabel: ui.lightMode },
        { value: "dark", label: <MoonIcon />, ariaLabel: ui.darkMode },
      ]}
    />
  );
}
