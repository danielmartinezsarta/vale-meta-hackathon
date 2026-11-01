"use client";

import type { Widget } from "@/lib/widget";

/** Screen card for one tool result: plain text until the 018 design lands. */
export function WidgetCard({
  widget,
  language,
  onVote,
}: {
  widget: Widget;
  language: "en" | "es";
  onVote: (vote: "yes" | "no") => void;
}) {
  if (widget.kind === "confirm") {
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
  return (
    <div>
      <p>{widget.title}</p>
      {widget.lines.length > 0 && (
        <ul>
          {widget.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
