"use client";

import type { Widget } from "@/lib/widget";

/** Touch fallback for proposals with no widget of their own. */
export function WidgetCard({
  widget,
  language,
  onVote,
}: {
  widget: Extract<Widget, { kind: "confirm" }>;
  language: "en" | "es";
  onVote: (vote: "yes" | "no") => void;
}) {
  return (
    <div role="group" aria-label={widget.title}>
      <p>{widget.title}</p>
      <button type="button" onClick={() => onVote("yes")}>
        {language === "es" ? "Sí" : "Yes"}
      </button>{" "}
      <button type="button" onClick={() => onVote("no")}>
        {language === "es" ? "No" : "No"}
      </button>
    </div>
  );
}
