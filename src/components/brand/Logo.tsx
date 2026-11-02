"use client";

import { useEffect, useRef } from "react";
import { BRAND } from "@/lib/brand-tokens";
import { leftBearing } from "@/lib/text-metrics";

export type LogoTheme = "light" | "dark" | "system";
export type SloganLanguage = "en" | "es";

/** The brand slogan, single-sourced from BRAND. */

/* Five equal bars, equal gaps, fully rounded. Tops step down toward the
   center and bottoms step down further, so both edges dip like a V. */
const BARS = [
  { x: 0, y: 0, h: 100 },
  { x: 34, y: 16, h: 88 },
  { x: 68, y: 34, h: 76 },
  { x: 102, y: 16, h: 88 },
  { x: 136, y: 0, h: 100 },
];
const BAR_WIDTH = 20;

export function VoiceBars({ label }: { label?: string }) {
  return (
    <svg
      viewBox="0 0 156 110"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ height: "1.25em", width: "auto", display: "block" }}
    >
      {BARS.map((bar, i) => (
        <rect
          key={i}
          x={bar.x}
          y={bar.y}
          width={BAR_WIDTH}
          height={bar.h}
          rx={BAR_WIDTH / 2}
          fill={`var(--vale-bar-${i + 1})`}
        />
      ))}
    </svg>
  );
}

export interface LogoProps {
  /** Wordmark font size in px. Every dimension scales from this value. */
  size?: number;
  showWord?: boolean;
  showSlogan?: boolean;
  sloganLanguage?: SloganLanguage;
  theme?: LogoTheme;
}

export function Logo({
  size = 48,
  showWord = true,
  showSlogan = true,
  sloganLanguage = "en",
  theme = "system",
}: LogoProps) {
  const slogan = BRAND.slogan[sloganLanguage];
  const sloganRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = sloganRef.current;
    if (!node || !showWord || !showSlogan) {
      if (node) node.style.marginLeft = "0px";
      return;
    }
    const compute = () => {
      const target = sloganRef.current;
      if (!target) return;
      const shift =
        leftBearing("vale", `300 ${size}px "Josefin Sans", sans-serif`) -
        leftBearing(slogan, `italic 300 ${size * 0.32}px "Cormorant Garamond", serif`);
      if (Number.isFinite(shift) && shift !== 0)
        target.style.marginLeft = `${shift}px`;
    };
    compute();
    if (document.fonts) {
      document.fonts.ready.then(compute).catch(() => {});
    }
  }, [size, slogan, showWord, showSlogan]);

  return (
    <span
      role="img"
      aria-label={`Vale, ${slogan}`}
      data-theme={theme === "system" ? undefined : theme}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.22em",
        fontSize: size,
        lineHeight: 1,
      }}
    >
      <VoiceBars />
      {showWord && (
        <span style={{ display: "block", lineHeight: 1 }}>
          <span
            style={{
              display: "block",
              fontFamily: 'var(--font-word), "Josefin Sans", sans-serif',
              fontWeight: 300,
              fontSize: "1em",
              letterSpacing: "0.01em",
              lineHeight: 1,
              color: "var(--vale-wordmark)",
            }}
          >
            vale
          </span>
          {showSlogan && (
            <span
              ref={sloganRef}
              style={{
                display: "block",
                fontFamily:
                  'var(--font-slogan), "Cormorant Garamond", serif',
                fontStyle: "italic",
                fontWeight: 300,
                fontSize: "0.32em",
                lineHeight: 1.3,
                color: "var(--vale-text-secondary)",
                marginLeft: 0,
                whiteSpace: "nowrap",
              }}
            >
              {slogan}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
