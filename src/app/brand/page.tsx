"use client";

import { useState } from "react";
import { AppIcon } from "@/components/brand/AppIcon";
import { Logo } from "@/components/brand/Logo";
import "./brand.css";

type PageTheme = "system" | "light" | "dark";

interface TokenSwatch {
  name: string;
  /** Documented value, shown as a label. Never used for painting. */
  hex: string;
  /** Token that paints the chip, so styling stays token-driven. */
  token: string;
  theme?: "light" | "dark";
}

const TOKEN_SWATCHES: TokenSwatch[] = [
  { name: "Midnight", hex: "#14224F", token: "--vale-midnight" },
  { name: "Blue", hex: "#2F5BFF", token: "--vale-blue" },
  { name: "Cyan", hex: "#18B8E0", token: "--vale-cyan" },
  { name: "Magenta", hex: "#E6329B", token: "--vale-magenta" },
  { name: "Mist", hex: "#F5F8FF", token: "--vale-mist" },
  { name: "Light tint blue", hex: "#8FA9FF", token: "--vale-tint-blue" },
  { name: "Light tint cyan", hex: "#7FDDEB", token: "--vale-tint-cyan" },
  { name: "Light tint magenta", hex: "#FF6BBE", token: "--vale-tint-magenta" },
  { name: "Pastel blue", hex: "#BFD0FF", token: "--vale-pastel-blue" },
  { name: "Pastel magenta", hex: "#FAC0E0", token: "--vale-pastel-magenta" },
  { name: "Dark app background", hex: "#0E1634", token: "--vale-bg", theme: "dark" },
  { name: "Dark card", hex: "#162047", token: "--vale-card", theme: "dark" },
  { name: "Dark border", hex: "#2B3866", token: "--vale-border", theme: "dark" },
  { name: "Light border", hex: "#D8DEEF", token: "--vale-border", theme: "light" },
  { name: "Secondary text, light", hex: "#505B7E", token: "--vale-text-secondary", theme: "light" },
  { name: "Secondary text, dark", hex: "#A8B2D6", token: "--vale-text-secondary", theme: "dark" },
];

function chipTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "var(--vale-midnight)" : "var(--vale-mist)";
}

function ThemeCard({
  theme,
  label,
}: {
  theme: "light" | "dark";
  label: string;
}) {
  return (
    <div className="theme-card" data-theme={theme}>
      <div>
        <p className="caption">
          {label} — full lockup, English slogan
        </p>
        <div className="logo-row">
          <Logo size={24} theme={theme} />
          <Logo size={48} theme={theme} />
          <Logo size={96} theme={theme} />
        </div>
      </div>
      <div>
        <p className="caption">Spanish slogan, 48 px</p>
        <Logo size={48} theme={theme} sloganLanguage="es" />
      </div>
      <div>
        <p className="caption">Bars only, 24 / 48 / 96 px</p>
        <div className="logo-row">
          <Logo size={24} theme={theme} showWord={false} showSlogan={false} />
          <Logo size={48} theme={theme} showWord={false} showSlogan={false} />
          <Logo size={96} theme={theme} showWord={false} showSlogan={false} />
        </div>
      </div>
    </div>
  );
}

export default function BrandPage() {
  const [pageTheme, setPageTheme] = useState<PageTheme>("system");

  const choose = (value: PageTheme) => {
    setPageTheme(value);
    try {
      const root = document.documentElement;
      const storage = window.localStorage;
      if (value === "system") {
        root.removeAttribute("data-theme");
        storage.removeItem("vale-theme");
      } else {
        root.setAttribute("data-theme", value);
        storage.setItem("vale-theme", value);
      }
    } catch {
      /* Preview still updates through React state. */
    }
  };

  return (
    <main className="brand-page">
      <header className="brand-header">
        <h1>Vale brand preview</h1>
        <p>
          The logo, the app icon, and every color token, on light and dark.
        </p>
        <div
          className="theme-switch"
          role="group"
          aria-label="Page color theme"
        >
          {(["system", "light", "dark"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={pageTheme === value}
              onClick={() => choose(value)}
            >
              {value === "system" ? "System" : value === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </header>

      <section className="brand-section" aria-label="Logo">
        <h2>Logo</h2>
        <p>Five voice bars in a V, lowercase wordmark, measured slogan.</p>
        <ThemeCard theme="light" label="Light" />
        <ThemeCard theme="dark" label="Dark" />
      </section>

      <section className="brand-section" aria-label="App icon">
        <h2>App icon</h2>
        <p>Midnight rounded square, bars in light tints, no text.</p>
        <div className="theme-card">
          <div className="icon-row">
            <AppIcon size={96} />
            <AppIcon size={48} />
          </div>
        </div>
      </section>

      <section className="brand-section" aria-label="Color tokens">
        <h2>Color tokens</h2>
        <p>Every token, exactly as defined.</p>
        <div className="swatch-grid">
          {TOKEN_SWATCHES.map((token) => (
            <div className="swatch" key={token.name}>
              <div
                className="swatch-chip"
                data-theme={token.theme}
                style={{
                  background: `var(${token.token})`,
                  color: chipTextColor(token.hex),
                }}
              >
                {token.hex}
              </div>
              <div className="swatch-label">
                <strong>{token.name}</strong>
                <span>{token.hex}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
