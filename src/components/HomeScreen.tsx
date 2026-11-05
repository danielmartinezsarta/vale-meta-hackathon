"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { BRAND } from "@/lib/brand-tokens";
import { uiStrings } from "@/lib/vale-ui";
import { homeVars } from "@/lib/vale-theme";
import { PhoneFrame } from "@/components/PhoneFrame";
import { ManageScreensHost } from "@/components/screens/ManageScreensHost";
import { useScreenMode } from "@/components/useScreenMode";
import type { ValeLanguage } from "@/lib/vale-language";
import type { HomeData } from "@/lib/home-data";
import styles from "./HomeScreen.module.css";

/**
 * App home = Vale asleep. Today, month goal, supplies to buy, side menu
 * and the round "Wake Vale" sleeper button. Modes follow the device.
 */

const c = BRAND.color;

function Wordmark() {
  return (
    <span className={styles.logo} aria-label="vale" role="img">
      <svg viewBox="26 34 148 136" aria-hidden="true">
        <line x1="36" y1="44" x2="36" y2="124" stroke={c.blue} strokeWidth="20" strokeLinecap="round" />
        <line x1="68" y1="68" x2="68" y2="140" stroke={c.blue} strokeWidth="20" strokeLinecap="round" />
        <line x1="100" y1="92" x2="100" y2="160" stroke={c.cyan} strokeWidth="20" strokeLinecap="round" />
        <line x1="132" y1="68" x2="132" y2="140" stroke={c.blue} strokeWidth="20" strokeLinecap="round" />
        <line x1="164" y1="44" x2="164" y2="124" stroke={c.magenta} strokeWidth="20" strokeLinecap="round" />
      </svg>
      vale
    </span>
  );
}

function SleepingHead() {
  return (
    <svg className={styles.head} viewBox="40 -4 160 170" aria-hidden="true">
      <defs>
        <linearGradient id="vale-sleep-g" x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor={c.bodyLight} />
          <stop offset="0.55" stopColor={c.blue} />
          <stop offset="1" stopColor={c.bodyDark} />
        </linearGradient>
      </defs>
      <line x1="120" y1="40" x2="120" y2="12" stroke={c.blue} strokeWidth="5" strokeLinecap="round" />
      <circle cx="120" cy="10" r="9" fill={c.antennaError} />
      <rect x="98" y="34" width="44" height="12" rx="6" fill={c.bodyDark} />
      <path
        d="M50 112 C50 64 82 40 120 40 C158 40 190 64 190 112 C190 146 178 160 150 160 H90 C62 160 50 146 50 112 Z"
        fill="url(#vale-sleep-g)"
      />
      <ellipse cx="82" cy="74" rx="20" ry="9" transform="rotate(-32 82 74)" fill="#fff" opacity=".22" />
      <rect x="64" y="82" width="112" height="60" rx="30" fill={c.night} />
      <g fill="none" stroke={c.eye} strokeWidth="5" strokeLinecap="round">
        <path d="M86 112 Q100 124 114 112" />
        <path d="M126 112 Q140 124 154 112" />
      </g>
    </svg>
  );
}

export const MENU_ITEMS = [
  {
    name: "Agenda",
    icon: (
      <>
        <rect x="4" y="5.5" width="16" height="14" rx="3" />
        <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
      </>
    ),
  },
  {
    name: "Client files",
    icon: (
      <>
        <circle cx="12" cy="9" r="3.4" />
        <path d="M5.5 19.5c.8-3.6 3.4-5.3 6.5-5.3s5.7 1.7 6.5 5.3" />
      </>
    ),
  },
  {
    name: "Services",
    icon: (
      <>
        <path d="M9 7h11M9 12h11M9 17h11" />
        <path d="M3.5 7l1.2 1.2L6.8 6M3.5 12l1.2 1.2L6.8 11M3.5 17l1.2 1.2L6.8 16" />
      </>
    ),
  },
  {
    name: "Supplies & stock",
    icon: (
      <>
        <path d="M4 8l8-4 8 4v8l-8 4-8-4z" />
        <path d="M4 8l8 4 8-4M12 12v8" />
      </>
    ),
  },
  {
    name: "Shopping list",
    icon: (
      <>
        <path d="M4 6h2l2.4 11h10.4l2-8H7" />
        <circle cx="9.5" cy="19" r="1.5" />
        <circle cx="16.5" cy="19" r="1.5" />
      </>
    ),
  },
  {
    name: "Payments",
    icon: (
      <>
        <rect x="3" y="6" width="18" height="13" rx="3" />
        <path d="M3 10h18M7 15h4" />
      </>
    ),
  },
  {
    name: "Goals",
    icon: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="12" cy="12" r=".8" fill="currentColor" />
      </>
    ),
  },
  {
    name: "Preferences",
    icon: (
      <>
        <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
        <circle cx="16" cy="8" r="2.2" />
        <circle cx="10" cy="16" r="2.2" />
      </>
    ),
  },
];

function monthLabel(month: string, language: ValeLanguage): string {
  const date = new Date(`${month}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(language === "es" ? "es" : "en-US", { month: "long" });
}

const MENU_LABELS: Record<string, "menuAgenda" | "menuClientFiles" | "menuServices" | "menuSuppliesStock" | "shoppingList" | "menuPayments" | "menuGoals" | "menuPreferences"> = {
  Agenda: "menuAgenda",
  "Client files": "menuClientFiles",
  Services: "menuServices",
  "Supplies & stock": "menuSuppliesStock",
  "Shopping list": "shoppingList",
  Payments: "menuPayments",
  Goals: "menuGoals",
  Preferences: "menuPreferences",
};

export function HomeScreen({
  data,
  language,
  onLanguageChange,
  onWake,
  onNavigate,
}: {
  data: HomeData | null;
  language: ValeLanguage;
  onLanguageChange: (next: ValeLanguage) => void;
  onWake: () => void;
  onNavigate?: (name: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  const mode = useScreenMode();

  const openScreen = (name: string) => {
    if (onNavigate) {
      onNavigate(name);
      return;
    }
    setScreen(name);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const ui = uiStrings(language);
  const menuLabel = (name: string): string => ui[MENU_LABELS[name] ?? "menuAgenda"] ?? name;
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 12 ? ui.greetingMorning : hour < 19 ? ui.greetingAfternoon : ui.greetingEvening;
  const dateLine = now.toLocaleDateString(language === "es" ? "es" : "en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const pct = data?.goal ? Math.min(100, Math.max(0, data.goal.pct)) : 0;

  const vars = homeVars(mode);
  return (
    <PhoneFrame background={vars["--vs-bg"]}>
      <div
        className={`${styles.vs} ${menuOpen ? styles.open : ""}`}
        style={vars as CSSProperties}
      >
        <div className={styles.bg} aria-hidden="true" />
      <header className={styles.top}>
        <Wordmark />
      </header>
      <div className={styles.greet}>
        <h1 className={styles.hi}>
          {greeting}, {data?.userName ?? "…"}
        </h1>
        <button className={styles.menu} type="button" aria-label="Menu" onClick={() => setMenuOpen(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M5 8h14" />
              <path d="M5 12h14" />
              <path d="M5 16h14" />
            </g>
          </svg>
        </button>
      </div>

      <section className={styles.card} aria-label={ui.homeToday}>
        <h2 className={styles.h}>
          <b>{ui.homeToday}</b>, {dateLine}
        </h2>
        {data === null ? (
          <div className={styles.row}>
            <span>{ui.homeLoading}</span>
          </div>
        ) : data.today.length === 0 ? (
          <div className={styles.row}>
            <span>{ui.homeEmptyToday}</span>
          </div>
        ) : (
          data.today.map((appt) => (
            <div className={styles.row} key={`${appt.time}-${appt.client}`}>
              <span>
                {appt.time} · {appt.client}
              </span>
              <span>{appt.service}</span>
            </div>
          ))
        )}
      </section>

      <section className={styles.card} aria-label={ui.homeSupplies}>
        <h2 className={styles.h}>{ui.homeSupplies}</h2>
        {data === null ? (
          <div className={styles.row}>
            <span>{ui.homeLoading}</span>
          </div>
        ) : data.supplies.length === 0 ? (
          <div className={styles.row}>
            <span>{ui.emptyList}</span>
          </div>
        ) : (
          data.supplies.map((item) => (
            <div className={styles.row} key={item.name}>
              <span>{item.name}</span>
              <span>{item.qty}</span>
            </div>
          ))
        )}
      </section>

      <section className={styles.goal} aria-label={ui.homeMonthlyGoal}>
        <div className={styles.goaltop}>
          <div>
            <h2>{ui.homeMonthlyGoal}</h2>
            <p>{data?.goal ? monthLabel(data.goal.month, language) : ""}</p>
          </div>
          <div className={styles.pct}>
            {pct}
            <small>%</small>
          </div>
        </div>
        <div
          className={styles.track}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Salary goal progress"
        >
          <div className={styles.fill} style={{ width: `${pct}%` }} />
          <span className={styles.tick} style={{ left: "25%" }} />
          <span className={styles.tick} style={{ left: "50%" }} />
          <span className={styles.tick} style={{ left: "75%" }} />
        </div>
      </section>

      <button className={styles.fab} type="button" aria-label="Wake Vale" onClick={onWake}>
        <span className={styles.z} aria-hidden="true">
          z
        </span>
        <span className={styles.z} aria-hidden="true">
          z
        </span>
        <span className={styles.z} aria-hidden="true">
          z
        </span>
        <SleepingHead />
      </button>

      <div className={styles.ov} role="dialog" aria-label="Menu" aria-hidden={menuOpen ? "false" : "true"}>
        {/* Backdrop is mouse-only; keyboard closes with Escape or the X. */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className={styles.scrim}
          onClick={() => setMenuOpen(false)}
        />
        <nav className={styles.panel}>
          <div className={styles.ovtop}>
            <h2>{screen ?? "Menu"}</h2>
            <button
              className={styles.menu}
              type="button"
              aria-label={screen ? "Back to menu" : "Close menu"}
              onClick={() => (screen ? setScreen(null) : setMenuOpen(false))}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6.5 6.5l11 11" />
                  <path d="M17.5 6.5l-11 11" />
                </g>
              </svg>
            </button>
          </div>
          {screen ? (
            <ManageScreensHost
              name={screen}
              onBack={() => setScreen(null)}
              language={language}
              onLanguageChange={onLanguageChange}
            />
          ) : (
          <ul className={styles.items}>
            {MENU_ITEMS.map((item, index) => (
              <li key={item.name}>
                <button
                  className={`${styles.item} ${styles[`i${(index % 3) + 1}`]}`}
                  type="button"
                  onClick={() => openScreen(item.name)}
                >
                  <span className={styles.ic}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <g
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        {item.icon}
                      </g>
                    </svg>
                  </span>
                  <span className={styles.lb}>{menuLabel(item.name)}</span>
                  <svg className={styles.chev} viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M9 6l6 6-6 6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
          )}
          </nav>
        </div>
      </div>
    </PhoneFrame>
  );
}
