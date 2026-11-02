"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { BRAND } from "@/lib/brand-tokens";
import { leftBearing } from "@/lib/text-metrics";
import styles from "./SplashScreen.module.css";

/**
 * Vale splash screen: the logo (five voice bars + the word "vale") with the
 * slogan right under the word. Pure CSS animation, no dependencies.
 *
 * Usage:
 *   <SplashScreen onDone={() => setShowSplash(false)} />
 *
 * - `onDone` fires once, when the animation is over (~2.4 s + `holdMs`).
 * - `lang` picks the slogan. The app is in English, so the default is "en".
 * - Honors `prefers-reduced-motion`: shows the final logo and calls `onDone`
 *   after a short hold.
 *
 * Needs two fonts loaded in the app (see the README): Josefin Sans 300 for the
 * word and Cormorant Garamond italic 300 for the slogan.
 */
type Props = {
  onDone?: () => void;
  lang?: "en" | "es";
  /** Extra time to keep the finished logo on screen, in ms. */
  holdMs?: number;
  className?: string;
};

/** The brand slogan, single-sourced. */
const SLOGAN = BRAND.slogan;
const ANIMATION_MS = 2400;

// Bar geometry (viewBox units). Colors come from BRAND, the single source.
const BARS = [
  { x: 36, y1: 44, y2: 124, color: BRAND.color.blueLight },
  { x: 68, y1: 68, y2: 140, color: BRAND.color.blueLight },
  { x: 100, y1: 92, y2: 160, color: BRAND.color.cyanLight },
  { x: 132, y1: 68, y2: 140, color: BRAND.color.blueLight },
  { x: 164, y1: 44, y2: 124, color: BRAND.color.magentaLight },
] as const;

export function SplashScreen({ onDone, lang = "en", holdMs = 400, className }: Props) {
  const valeRef = useRef<HTMLDivElement>(null);
  const sloganRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  // Latest-ref pattern, assigned in an effect to satisfy react-hooks/refs.
  useEffect(() => {
    doneRef.current = onDone;
  });

  // Align the first letter of the slogan exactly under the "v" of "vale".
  useEffect(() => {
    let cancelled = false;
    const align = () => {
      const v = valeRef.current;
      const s = sloganRef.current;
      if (!v || !s || cancelled) return;
      const cv = getComputedStyle(v);
      const cs = getComputedStyle(s);
      const vFont = `${cv.fontStyle} ${cv.fontWeight} ${cv.fontSize} ${cv.fontFamily}`;
      const sFont = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const shift =
        leftBearing(SLOGAN[lang].charAt(0), sFont) - leftBearing("v", vFont);
      s.style.marginLeft = `${shift.toFixed(2)}px`;
    };
    const fonts = document.fonts;
    if (fonts?.ready) fonts.ready.then(align, align);
    else align();
    window.addEventListener("resize", align);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", align);
    };
  }, [lang]);

  // Tell the app when the splash is finished.
  useEffect(() => {
    const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const ms = reduce ? 800 : ANIMATION_MS + holdMs;
    const id = window.setTimeout(() => doneRef.current?.(), ms);
    return () => window.clearTimeout(id);
  }, [holdMs]);

  return (
    <div
      className={`${styles.splash} ${className ?? ""}`}
      role="img"
      aria-label={`Vale. ${SLOGAN[lang]}`}
      style={{ "--splash-night": BRAND.color.night, "--splash-mist": BRAND.color.mist } as CSSProperties}
    >
      <div className={styles.logo}>
        <svg viewBox="26 34 148 136" aria-hidden="true">
          {BARS.map((b, i) => (
            <g key={b.x} className={styles.bar} style={{ ["--i" as string]: i }}>
              <line x1={b.x} y1={b.y1} x2={b.x} y2={b.y2} stroke={b.color} strokeWidth="20" strokeLinecap="round" />
            </g>
          ))}
        </svg>
        <div className={styles.word}>
          <div ref={valeRef} className={styles.vale}>vale</div>
          <div ref={sloganRef} className={styles.slogan}>{SLOGAN[lang]}</div>
        </div>
      </div>
    </div>
  );
}

export default SplashScreen;
