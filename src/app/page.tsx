"use client";

import { useState } from "react";
import { SplashScreen } from "@/components/SplashScreen";
import { TapToTalk } from "@/components/TapToTalk";

export default function Home() {
  const [showSplash, setShowSplash] = useState(true);

  if (showSplash) return <SplashScreen onDone={() => setShowSplash(false)} />;

  return (
    <main>
      <h1>Vale</h1>
      <p>
        Your hands-free helper. Tap the button, allow the microphone, and just
        talk.
      </p>
      <TapToTalk />
    </main>
  );
}
