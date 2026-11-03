"use client";

import { useCallback, useEffect, useState } from "react";
import { SplashScreen } from "@/components/SplashScreen";
import { HomeScreen } from "@/components/HomeScreen";
import { ReplayScreen } from "@/components/ReplayScreen";
import { TapToTalk } from "@/components/TapToTalk";
import { useValeLanguage } from "@/components/useValeLanguage";
import type { HomeData } from "@/lib/home-data";

type Screen = "home" | "voice";

export default function Home() {
  const [showSplash, setShowSplash] = useState(true);
  const [screen, setScreen] = useState<Screen>("home");
  const [language, setLanguage] = useValeLanguage();
  const [homeData, setHomeData] = useState<HomeData | null>(null);
  const [replayMode, setReplayMode] = useState(false);

  // A served run file means VALE_REPLAY=1: play the recording, no mic.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/replay")
      .then((response) => {
        if (!cancelled && response.ok) setReplayMode(true);
      })
      .catch(() => {
        /* live mode: the home screen renders its empty states instead */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  if (replayMode) return <ReplayScreen />;

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
