import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_LANGUAGE,
  storedLanguage,
  storeLanguage,
  type ValeLanguage,
} from "@/lib/vale-language";

/** Single language source for the screens: storage, synced live. */
export function useValeLanguage(): [
  ValeLanguage,
  (next: ValeLanguage) => void,
] {
  const [language, setLanguageState] = useState<ValeLanguage>(() =>
    typeof window === "undefined" ? DEFAULT_LANGUAGE : storedLanguage(),
  );
  useEffect(() => {
    const onLanguage = (event: Event) => {
      const next = (event as CustomEvent<ValeLanguage>).detail;
      if (next === "en" || next === "es") setLanguageState(next);
    };
    window.addEventListener("vale-language", onLanguage);
    return () => window.removeEventListener("vale-language", onLanguage);
  }, []);
  const setLanguage = useCallback(
    (next: ValeLanguage) => {
      setLanguageState(next);
      storeLanguage(next);
    },
    [],
  );
  return [language, setLanguage];
}
