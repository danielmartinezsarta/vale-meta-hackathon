"use client";

import { LevelMeter } from "@/components/LevelMeter";
import { ValeBoard } from "@/components/ValeBoard";
import { CareOverlay, ValeSheets, type SheetCallbacks } from "@/components/ValeSheets";
import { VoiceControls } from "@/components/VoiceControls";
import { WidgetCard } from "@/components/WidgetCard";
import type { Board } from "@/lib/board";
import type { ValeLanguage } from "@/lib/vale-language";
import type { UiStrings } from "@/lib/vale-ui";
import type { ValeState } from "@/lib/vale-state";
import { hasVisibleContent, type Turn } from "@/lib/turn-view";
import type { Widget } from "@/lib/widget";
import type { VoiceEngine } from "@/lib/speak";

/** Debug render of the voice session: every control and list. Lives at /debug. */

export type DebugStatus = "idle" | "requesting" | "live" | "blocked" | "error";

export type DebugTurn = Turn;

function SpeakerIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M2 6v4h3l4 3V3L5 6H2z" fill="currentColor" stroke="none" />
      <path d="M11 5.5a3.5 3.5 0 010 5" />
    </svg>
  );
}

export function VoiceDebugView({
  status,
  ui,
  language,
  engine,
  level,
  valeUiState,
  turns,
  board,
  widget,
  notice,
  alert,
  onTap,
  onToggleEngine,
  onSwitchLanguage,
  onVote,
  onCloseWidget,
  sheetCallbacks,
}: {
  status: DebugStatus;
  ui: UiStrings;
  language: ValeLanguage;
  engine: VoiceEngine;
  level: number;
  valeUiState: ValeState;
  turns: DebugTurn[];
  board: Board | null;
  widget: Widget | null;
  notice: string | null;
  alert: string | null;
  onTap: () => void;
  onToggleEngine: () => void;
  onSwitchLanguage: (next: ValeLanguage) => void;
  onVote: (vote: "yes" | "no") => void;
  onCloseWidget: () => void;
  sheetCallbacks?: SheetCallbacks;
}) {
  return (
    <section>
      <button type="button" onClick={onTap} disabled={status === "requesting"}>
        {status === "live"
          ? ui.stop
          : status === "requesting"
            ? ui.waiting
            : ui.tapToTalk}
      </button>{" "}
      <button
        type="button"
        onClick={onToggleEngine}
        aria-pressed={engine === "seamless"}
        aria-label={
          engine === "seamless"
            ? "Use browser voice"
            : "Use Seamless voice"
        }
        title={
          engine === "seamless"
            ? "Use browser voice"
            : "Use Seamless voice"
        }
      >
        <SpeakerIcon /> Voice: {engine === "seamless" ? "Seamless" : "browser"}
      </button>{" "}
      <fieldset>
        <legend>{ui.language}</legend>{" "}
        <label>
          <input
            type="radio"
            aria-label="English"
            name="vale-language"
            value="en"
            checked={language === "en"}
            onChange={() => onSwitchLanguage("en")}
          />{" "}
          EN
        </label>{" "}
        <label>
          <input
            type="radio"
            aria-label="Español"
            name="vale-language"
            value="es"
            checked={language === "es"}
            onChange={() => onSwitchLanguage("es")}
          />{" "}
          ES
        </label>
      </fieldset>{" "}
      <VoiceControls language={language} />

      {status === "live" && <LevelMeter level={level} />}

      {status === "live" && <p role="status">{ui.valeState(valeUiState)}</p>}

      {status === "live" &&
        turns.every((turn) => !hasVisibleContent(turn)) &&
        !notice && (
          <p>{ui.listenHint}</p>
        )}

      <ol aria-label="Conversation turns">
        {turns.filter(hasVisibleContent).map((turn) => (
          <li
            key={turn.id}
            style={turn.ignored ? { opacity: 0.6 } : undefined}
          >
            {turn.ignored ? (
              <p>
                {turn.final ?? turn.interim}{" "}
                <small>
                  {ui.ignoredTag}
                </small>
              </p>
            ) : (
              <>
                {(turn.final ?? turn.interim) !== "" && (
                  <p>
                    <strong>You:</strong> {turn.final ?? turn.interim}
                  </p>
                )}
                {turn.reply && (
                  <p>
                    <strong>Vale:</strong> {turn.reply}
                  </p>
                )}
              </>
            )}
          </li>
        ))}
      </ol>

      <ValeBoard board={board} language={language} />

      {widget?.kind === "confirm" ? (
        <WidgetCard widget={widget} language={language} onVote={onVote} />
      ) : widget?.kind === "good_job" ? (
        <>
          <p>Good job!</p>
          <CareOverlay />
        </>
      ) : (
        widget && <ValeSheets widget={widget} onClose={onCloseWidget} {...sheetCallbacks} />
      )}

      {notice && <p role="status">{notice}</p>}

      {alert && <div role="alert">{alert}</div>}

      {status === "blocked" && (
        <div role="alert">
          <p>{ui.micBlockedLead}</p>
          <ul>
            <li>
              iPhone (Safari): open Settings &gt; Safari &gt; Microphone and
              choose Allow, then come back and tap again.
            </li>
            <li>
              Chrome: tap the lock (or tune) icon left of the address bar,
              choose Microphone &gt; Allow, then tap again.
            </li>
          </ul>
        </div>
      )}

      {status === "error" && !alert && (
        <div role="alert">
          <p>{ui.micError}</p>
        </div>
      )}
    </section>
  );
}
