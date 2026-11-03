"use client";

import { useEffect, useRef, useState } from "react";
import { parseReplayRun, type ReplayRun } from "@/lib/replay";
import { speak, stopSpeaking } from "@/lib/speak";
import { ValeBoard } from "@/components/ValeBoard";
import { ValeSheets } from "@/components/ValeSheets";

/**
 * Recorded run playback (VALE_REPLAY=1): the committed run plays end to
 * end with a visible label. Vale's replies are spoken with the browser
 * voice. No mic, no model, no network beyond the run file itself.
 */
export function ReplayScreen({ stepMs = 6000 }: { stepMs?: number }) {
  const [run, setRun] = useState<ReplayRun | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(true);
  const spokenRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/replay")
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const parsed = parseReplayRun(await res.text());
        if (!cancelled) setRun(parsed);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!run || !playing || shown >= run.turns.length) return;
    const id = window.setTimeout(
      () => setShown((count) => Math.min(run.turns.length, count + 1)),
      stepMs,
    );
    return () => window.clearTimeout(id);
  }, [run, playing, shown, stepMs]);

  // The agent-to-voice path: every shown reply reaches speak once.
  useEffect(() => {
    if (!run) return;
    while (spokenRef.current < shown) {
      const turn = run.turns[spokenRef.current];
      spokenRef.current += 1;
      if (turn.reply !== "") speak(turn.reply, turn.language);
    }
  }, [run, shown]);

  useEffect(() => () => stopSpeaking("replay screen unmounted"), []);

  if (failed) return null;
  if (!run) return null;
  const visible = run.turns.slice(0, shown);
  const widget = [...visible].reverse().find((turn) => turn.widget !== null)?.widget ?? null;
  const board = [...visible].reverse().find((turn) => turn.board !== null)?.board ?? null;
  const language = visible.length > 0 ? visible[visible.length - 1].language : "en";
  const done = shown >= run.turns.length;

  return (
    <main aria-label="Replay">
      <p>Replay: recorded run</p>
      <p>
        Turn {Math.min(shown + (done ? 0 : 1), run.turns.length)} of {run.turns.length}
      </p>
      <button type="button" onClick={() => setPlaying((value) => !value)}>
        {playing ? "Pause" : "Play"}
      </button>{" "}
      <button
        type="button"
        onClick={() => {
          spokenRef.current = 0;
          stopSpeaking("replay restarted");
          setShown(0);
          setPlaying(true);
        }}
      >
        Replay
      </button>
      {visible.map((turn) => (
        <section key={turn.turn} aria-label={`Recorded turn ${turn.turn}`}>
          <p>{turn.transcript}</p>
          <p>{turn.reply}</p>
        </section>
      ))}
      {board && <ValeBoard board={board} language={language} />}
      {widget && <ValeSheets widget={widget} />}
    </main>
  );
}
