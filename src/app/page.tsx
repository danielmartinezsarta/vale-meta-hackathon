"use client";

import { useCallback, useEffect, useState } from "react";
import { SplashScreen } from "@/components/SplashScreen";
import { HomeScreen } from "@/components/HomeScreen";
import { TapToTalk } from "@/components/TapToTalk";
import { storedLanguage, type ValeLanguage } from "@/lib/vale-language";
import type { HomeData } from "@/lib/home-data";

type Screen = "home" | "voice";

export default function Home() {
  const [showSplash, setShowSplash] = useState(true);
  const [screen, setScreen] = useState<Screen>("home");
  const [language, setLanguage] = useState<ValeLanguage>(() =>
    typeof window === "undefined" ? "en" : storedLanguage(),
  );
  const [homeData, setHomeData] = useState<HomeData | null>(null);

  useEffect(() => {
    if (showSplash) return;
    let cancelled = false;
    fetch("/api/home")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) setHomeData(data as HomeData);
      })
      .catch(() => {
        /* the home screen renders its empty states instead */
      });
    return () => {
      cancelled = true;
    };
  }, [showSplash]);

  const wake = useCallback(() => setScreen("voice"), []);

  if (showSplash) return <SplashScreen onDone={() => setShowSplash(false)} />;

  if (screen === "voice")
    return <TapToTalk autoStart onSleep={() => setScreen("home")} />;

  return (
    <main>
      <HomeScreen
        data={homeData}
        language={language}
        onLanguageChange={setLanguage}
        onWake={wake}
      />
    </main>
  );
}
