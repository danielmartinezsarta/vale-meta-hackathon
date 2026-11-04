"use client";

import { useEffect, useId, useRef } from "react";
import { BRAND } from "@/lib/brand-tokens";
import type { ValeState } from "@/lib/vale-state";

/**
 * Vale's friendly robot. Pure SVG, no dependencies, animated with one
 * requestAnimationFrame loop that writes transforms directly to the DOM
 * (no React re-render per frame), so it is cheap on an iPhone.
 *
 * Usage:
 *   <VoiceRobot state="listening" level={micLevel} />
 *
 * - `state` picks the animation.
 * - `level` (0..1) is optional. Pass the existing microphone/volume meter value
 *   and the eyes (listening) and mouth (speaking) follow the real voice.
 *   Without it, a synthetic motion is used.
 * - Honors `prefers-reduced-motion`: draws a still pose per state.
 */
/** Robot states are the single ValeState union. */
export type RobotState = ValeState;

type Props = {
  state?: RobotState;
  /** 0..1, current voice level. Optional. */
  level?: number;
  className?: string;
  /** Accessible name. Defaults to "Vale assistant". */
  title?: string;
};

const SMILE = "M112 124 A8 8 0 0 0 128 124 Z";
const FROWN = "M112 130 A8 8 0 0 1 128 130 Z";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function VoiceRobot({
  state = "idle",
  level,
  className,
  title = "Vale assistant",
}: Props) {
  const uid = useId().replace(/:/g, "");
  const allRef = useRef<SVGGElement>(null);
  const headRef = useRef<SVGGElement>(null);
  const armLRef = useRef<SVGPathElement>(null);
  const armRRef = useRef<SVGPathElement>(null);
  const antRef = useRef<SVGGElement>(null);
  const ballRef = useRef<SVGCircleElement>(null);
  const haloRef = useRef<SVGCircleElement>(null);
  const eyeLRef = useRef<SVGGElement>(null);
  const eyeRRef = useRef<SVGGElement>(null);
  const smileGRef = useRef<SVGGElement>(null);
  const smileRef = useRef<SVGPathElement>(null);

  const stateRef = useRef({ state, since: 0 });
  const levelRef = useRef<number | undefined>(level);
  const drawRef = useRef<(t: number) => void>(() => {});
  const reducedRef = useRef(false);

  // Latest-value pattern, assigned in an effect to satisfy react-hooks/refs.
  useEffect(() => {
    levelRef.current = level;
  });

  useEffect(() => {
    stateRef.current = { state, since: performance.now() };
    if (reducedRef.current) drawRef.current(0.5);
  }, [state]);

  useEffect(() => {
    reducedRef.current =
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const draw = (t: number) => {
      const { state: s, since } = stateRef.current;
      const local = (performance.now() - since) / 1000;
      const lv = levelRef.current;
      let dx = 0;
      let dy = Math.sin(t * 1.4) * 1.5;
      let rot = 0;
      let eyeS = 1;
      let eyeRot = 0;
      let eyeX = 0;
      let smX = 1;
      let smY = 1;
      let frown = false;
      let armR = Math.sin(t * 2.2) * 8;
      let armL = Math.sin(t * 1.3) * 3;
      let antRot = 0;
      let glow = 0;
      let ballR = 9;
      let ballColor: string = BRAND.color.antenna;

      if (s === "idle") {
        const b = t % 4.2;
        if (b > 4.0) eyeS = 1 - 0.88 * Math.sin(((b - 4.0) / 0.2) * Math.PI);
        rot = Math.sin(t * 0.7) * 1.5;
      } else if (s === "listening") {
        eyeS = lv != null ? 1 + 0.35 * lv : 1.18;
        rot = -6;
        dy = Math.sin(t * 2) * 1;
        armR = 22 + Math.sin(t * 1.8) * 2;
        antRot = Math.sin(t * 3) * 5;
        glow = lv != null ? 0.3 + 0.7 * lv : 0.5 + 0.5 * Math.sin(t * 5);
        ballR = 9 + 2 * glow;
        smX = 0.9;
        smY = 0.8;
      } else if (s === "thinking") {
        eyeS = 0.85;
        eyeX = Math.sin(t * 2) * 5;
        rot = 4;
        armR = 34;
        smY = 0.5;
        smX = 0.8;
        antRot = Math.sin(t * 2) * 8;
        glow = Math.sin(t * 6) > 0 ? 0.8 : 0.1;
      } else if (s === "speaking") {
        const e =
          lv != null
            ? clamp(lv, 0, 1)
            : Math.abs(Math.sin(t * 11) * Math.sin(t * 4.3 + 0.6));
        smY = 0.7 + 1.7 * e;
        smX = 1 + 0.15 * e;
        eyeS = 0.92;
        dy = -Math.abs(Math.sin(t * 5.5)) * 2;
        rot = 1.5 * Math.sin(t * 3);
        armR = Math.sin(t * 4.5) * 16;
      } else if (s === "done") {
        smX = 1.25;
        smY = 1.6;
        eyeS = 1.05;
        dy =
          local < 0.6
            ? -9 * Math.sin(clamp(local / 0.6, 0, 1) * Math.PI)
            : Math.sin(t * 1.4) * 1.2;
        armR = local < 1.4 ? Math.sin(local * 14) * 18 : Math.sin(t * 2.2) * 8;
        glow = local < 0.8 ? 1 - local / 0.8 : 0;
        ballR = 9 + 3 * glow;
      } else if (s === "error") {
        eyeS = 0.35;
        eyeRot = 14;
        frown = true;
        smY = 0.9;
        ballColor = BRAND.color.antennaError;
        armR = 40;
        armL = -4;
        rot = -2;
        dx = local < 0.6 ? Math.sin(local * 50) * 3 * (1 - local / 0.6) : 0;
      }

      if (reducedRef.current) {
        dx = 0;
        dy = 0;
        eyeX = 0;
        armR = s === "listening" ? 22 : s === "thinking" || s === "error" ? 34 : 0;
        glow = s === "listening" ? 0.8 : 0;
      }

      allRef.current?.setAttribute("transform", `translate(${dx.toFixed(2)} ${(20 + dy).toFixed(2)})`);
      headRef.current?.setAttribute("transform", `rotate(${rot.toFixed(2)} 120 160)`);
      eyeLRef.current?.setAttribute(
        "transform",
        `translate(${eyeX.toFixed(2)} 0) translate(100 112) rotate(${-eyeRot}) scale(1 ${eyeS.toFixed(3)}) translate(-100 -112)`,
      );
      eyeRRef.current?.setAttribute(
        "transform",
        `translate(${eyeX.toFixed(2)} 0) translate(140 112) rotate(${eyeRot}) scale(1 ${eyeS.toFixed(3)}) translate(-140 -112)`,
      );
      smileRef.current?.setAttribute("d", frown ? FROWN : SMILE);
      const oy = frown ? 130 : 124;
      smileGRef.current?.setAttribute(
        "transform",
        `translate(120 ${oy}) scale(${smX.toFixed(3)} ${smY.toFixed(3)}) translate(-120 -${oy})`,
      );
      armRRef.current?.setAttribute("transform", `rotate(${armR.toFixed(2)} 152 188)`);
      armLRef.current?.setAttribute("transform", `rotate(${armL.toFixed(2)} 88 182)`);
      antRef.current?.setAttribute("transform", `rotate(${antRot.toFixed(2)} 120 40)`);
      ballRef.current?.setAttribute("fill", ballColor);
      ballRef.current?.setAttribute("r", ballR.toFixed(1));
      haloRef.current?.setAttribute("r", (9 + 14 * glow).toFixed(1));
      haloRef.current?.setAttribute("opacity", (glow > 0 ? 0.45 * (1 - glow * 0.5) : 0).toFixed(2));
    };
    drawRef.current = draw;

    stateRef.current.since = performance.now();
    draw(0.5);
    if (reducedRef.current) return;

    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      draw((now - t0) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const c = BRAND.color;
  return (
    <svg viewBox="0 0 240 290" role="img" aria-label={title} className={className}>
      <title>{title}</title>
      <defs>
        <linearGradient id={`${uid}-g`} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor={c.bodyLight} />
          <stop offset="0.55" stopColor={c.blue} />
          <stop offset="1" stopColor={c.bodyDark} />
        </linearGradient>
        <filter id={`${uid}-glow`} x="-40%" y="-80%" width="180%" height="260%">
          <feGaussianBlur stdDeviation="3.5" />
        </filter>
        <g id={`${uid}-face`}>
          <g ref={eyeLRef}>
            <path d="M86 112 A14 14 0 0 1 114 112 Z" />
          </g>
          <g ref={eyeRRef}>
            <path d="M126 112 A14 14 0 0 1 154 112 Z" />
          </g>
          <g ref={smileGRef}>
            <path ref={smileRef} d={SMILE} />
          </g>
        </g>
      </defs>
      <ellipse cx="120" cy="280" rx="48" ry="6" fill={c.night} opacity=".12" />
      <g ref={allRef} transform="translate(0 20)">
        <path ref={armLRef} d="M88 180 C70 178 60 202 66 232 C82 224 92 204 88 180 Z" fill={`url(#${uid}-g)`} />
        <path ref={armRRef} d="M152 190 C168 194 186 184 196 164 C178 162 158 172 152 190 Z" fill={`url(#${uid}-g)`} />
        <path
          d="M84 172 C84 166 92 164 102 164 H138 C148 164 156 166 156 172 C160 208 150 240 120 246 C90 240 80 208 84 172 Z"
          fill={`url(#${uid}-g)`}
        />
        <ellipse cx="120" cy="166" rx="36" ry="6" fill={c.night} opacity=".28" />
        <g ref={headRef}>
          <g ref={antRef}>
            <line x1="120" y1="40" x2="120" y2="12" stroke={c.blue} strokeWidth="5" strokeLinecap="round" />
            <circle ref={haloRef} cx="120" cy="10" r="9" fill={c.antenna} opacity="0" />
            <circle ref={ballRef} cx="120" cy="10" r="9" fill={c.antenna} />
            <circle cx="117" cy="7" r="2.6" fill="#fff" opacity=".6" />
          </g>
          <rect x="98" y="34" width="44" height="12" rx="6" fill={c.bodyDark} />
          <path
            d="M50 112 C50 64 82 40 120 40 C158 40 190 64 190 112 C190 146 178 160 150 160 H90 C62 160 50 146 50 112 Z"
            fill={`url(#${uid}-g)`}
          />
          <ellipse cx="82" cy="74" rx="20" ry="9" transform="rotate(-32 82 74)" fill="#fff" opacity=".22" />
          <rect x="64" y="82" width="112" height="60" rx="30" fill={c.night} />
          <use href={`#${uid}-face`} fill={c.eyeGlow} filter={`url(#${uid}-glow)`} />
          <use href={`#${uid}-face`} fill={c.eye} />
        </g>
      </g>
    </svg>
  );
}

export default VoiceRobot;