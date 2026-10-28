"use client";

const BAR_WIDTH = 120;

// Listening level bar driven by the same samples as the voice detector.
export function LevelMeter({ level }: { level: number }) {
  const clamped = Math.max(0, Math.min(1, level));
  const pct = Math.round(clamped * 100);
  return (
    <div
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div
        aria-hidden="true"
        style={{
          width: BAR_WIDTH,
          height: 8,
          backgroundColor: "#e5e5e5",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: `${pct}%`,
            height: 8,
            backgroundColor: "#2f9e44",
            borderRadius: 4,
          }}
        />
      </div>
    </div>
  );
}
