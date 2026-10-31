/* App icon: midnight rounded square, the five bars in light tints. */

export function AppIcon({ size = 96 }: { size?: number }) {
  const bars = [
    { x: 0, y: 0, h: 100 },
    { x: 34, y: 16, h: 88 },
    { x: 68, y: 34, h: 76 },
    { x: 102, y: 16, h: 88 },
    { x: 136, y: 0, h: 100 },
  ];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label="Vale app icon"
      style={{ display: "block", borderRadius: size * 0.24 }}
    >
      <rect width="120" height="120" fill="var(--vale-icon-bg)" />
      <g transform="translate(17.1 29.75) scale(0.55)">
        {bars.map((bar, i) => (
          <rect
            key={i}
            x={bar.x}
            y={bar.y}
            width="20"
            height={bar.h}
            rx="10"
            fill={`var(--vale-icon-bar-${i + 1})`}
          />
        ))}
      </g>
    </svg>
  );
}
