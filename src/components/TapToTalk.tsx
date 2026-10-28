"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startCapture } from "@/lib/capture";
import { LevelMeter } from "@/components/LevelMeter";
import { parseSseStream } from "@/lib/sse";

type Status = "idle" | "requesting" | "live" | "blocked" | "error";

interface Turn {
  id: number;
  interim: string;
  final: string | null;
  reply: string | null;
}

const NO_SPEECH_TIMEOUT_MS = 8000;

function isPermissionDenied(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  );
}

export function TapToTalk() {
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeCode, setNoticeCode] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [alertCode, setAlertCode] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const lastLevelRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef(false);
  const turnIdRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  const quietTimerRef = useRef(0);
  const sessionEndRef = useRef<(() => void) | null>(null);
  const captureRef = useRef<{ stop: () => void } | null>(null);
  const repliesRef = useRef(new Map<number, string>());
  const finalReceivedRef = useRef(new Set<number>());
  // Turns whose stream already ended (done/error/timeout): their replies
  // are history. Only a still-open turn's reply can be interrupted.
  const settledTurnsRef = useRef(new Set<number>());

  const stopSession = useCallback(() => {
    sessionRef.current = false;
    window.clearTimeout(quietTimerRef.current);
    controllersRef.current.forEach((controller) => {
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    });
    controllersRef.current.clear();
    try {
      captureRef.current?.stop();
    } catch {
      /* already stopped */
    }
    captureRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    sessionEndRef.current?.();
    sessionEndRef.current = null;
    setStatus("idle");
  }, []);

  useEffect(() => stopSession, [stopSession]);

  const patchTurn = useCallback((id: number, patch: Partial<Turn>) => {
    setTurns((prev) => prev.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)));
  }, []);

  const removeTurn = useCallback((id: number) => {
    setTurns((prev) => prev.filter((turn) => turn.id !== id));
  }, []);

  /** End the whole session with a plain-language banner (tap to retry). */
  const endSessionWithAlert = useCallback(
    (message: string, code: string | null = null) => {
      sessionRef.current = false;
      window.clearTimeout(quietTimerRef.current);
      controllersRef.current.forEach((controller) => {
        try {
          controller.abort();
        } catch {
          /* already aborted */
        }
      });
      controllersRef.current.clear();
      try {
        captureRef.current?.stop();
      } catch {
        /* already stopped */
      }
      captureRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      finalReceivedRef.current.clear();
      settledTurnsRef.current.clear();
      repliesRef.current.clear();
      setAlert(message);
      setAlertCode(code);
      setStatus("idle");
      sessionEndRef.current?.();
      sessionEndRef.current = null;
    },
    [],
  );

  const runSession = useCallback(
    async (stream: MediaStream): Promise<void> => {
      sessionRef.current = true;
      // One capture for the whole session (bug 2): stopping the mic after
      // every turn left a gap silent while the POST/SSE round-trip ran, and
      // anything said in that gap was lost. Turns are delimited by VAD
      // events only; the capture stops when the session stops.
      let resolveSession: (() => void) | null = null;
      const ended = new Promise<void>((resolve) => {
        resolveSession = resolve;
      });
      sessionEndRef.current = () => resolveSession?.();

      const pending: Int16Array[] = [];
      let currentId = -1;
      let posted = false;

      const showNotice = (message: string, code: string | null = null) => {
        setNotice(message);
        setNoticeCode(code);
      };

      const armQuiet = () => {
        window.clearTimeout(quietTimerRef.current);
        quietTimerRef.current = window.setTimeout(() => {
          if (!sessionRef.current) return;
          removeTurn(currentId);
          showNotice("I didn't hear anything. Just speak and I'll listen.", "E-VAD");
          openTurn();
        }, NO_SPEECH_TIMEOUT_MS);
      };

      const openTurn = (arm = true) => {
        const id = turnIdRef.current++;
        currentId = id;
        posted = false;
        pending.length = 0;
        setTurns((prev) => [
          ...prev,
          { id, interim: "", final: null, reply: null },
        ]);
        if (arm) armQuiet();
      };

      // A failed turn ends the session so the user can tap to retry.
      // A turn that already showed its final keeps its bubble (test 25).
      const failTurn = (id: number, message: string, code: string | null = null) => {
        if (!finalReceivedRef.current.has(id)) removeTurn(id);
        endSessionWithAlert(message, code);
      };

      const postTurn = (id: number, frames: Int16Array[]) => {
        // One buffered body per turn: Safari on iOS rejects streaming
        // request bodies (`duplex: "half"`), so the audio never left the
        // phone. The route reads the full body the same way.
        const total = frames.reduce((n, frame) => n + frame.length, 0);
        const pcm = new Int16Array(total);
        let offset = 0;
        for (const frame of frames) {
          pcm.set(frame, offset);
          offset += frame.length;
        }
        const body = new Blob([pcm.buffer as ArrayBuffer], {
          type: "audio/l16",
        });
        const controller = new AbortController();
        controllersRef.current.add(controller);
        setNotice(null);
        setNoticeCode(null);
        void fetch("/api/voice", {
          method: "POST",
          headers: { "content-type": "audio/l16" },
          body,
          signal: controller.signal,
        })
          .then(async (response) => {
            if (!response.ok) {
              let message = "Connection lost. Tap to try again.";
              let code: string | null = "E-NET";
              try {
                const problem = (await response.json()) as {
                  error?: unknown;
                  code?: unknown;
                };
                if (typeof problem.error === "string") message = problem.error;
                if (typeof problem.code === "string") code = problem.code;
              } catch {
                /* keep the default */
              }
              controllersRef.current.delete(controller);
              failTurn(id, message, code);
              return;
            }
            if (!response.body) {
              controllersRef.current.delete(controller);
              failTurn(id, "Connection lost. Tap to try again.", "E-NET");
              return;
            }
            await parseSseStream(response.body, {
              onInterim: (transcript) => patchTurn(id, { interim: transcript }),
              onFinal: (transcript) => {
                // Do not settle here: reply/notice/error follow on the
                // same stream; the turn ends at `done`.
                finalReceivedRef.current.add(id);
                patchTurn(id, { final: transcript, interim: "" });
              },
              onErrorEvent: (message, code) => {
                controllersRef.current.delete(controller);
                failTurn(id, message, code ?? "E-NET");
              },
              onReplyDelta: (text) =>
                patchTurn(id, {
                  reply: `${
                    repliesRef.current.get(id) ?? ""
                  }${text}`,
                }),
              onReply: (text) => {
                repliesRef.current.set(id, text);
                patchTurn(id, { reply: text });
              },
              onNotice: (message, code) => showNotice(message, code ?? null),
              onDone: () => {
                controllersRef.current.delete(controller);
                if (!sessionRef.current) return;
                settledTurnsRef.current.add(id);
                // Fresh silence window for the gap before the next turn;
                // skipped when a newer turn is already collecting so a
                // slow reply cannot cut it off.
                if (id === currentId) armQuiet();
              },
            });
          })
          .catch(() => {
            controllersRef.current.delete(controller);
            if (controller.signal.aborted) {
              settledTurnsRef.current.add(id);
              return;
            }
            failTurn(id, "Connection lost. Tap to try again.", "E-NET");
          });
      };

      const capture = startCapture(
        stream,
        {
          onFrame: (frame) => {
            if (!sessionRef.current) return;
            pending.push(frame.slice());
          },
          onSpeechStart: () => {
            if (!sessionRef.current) return;
            window.clearTimeout(quietTimerRef.current);
            // Interruption (test 18): new speech dismisses only the
            // still-open turn's reply. Finished turns keep theirs, so a
            // multi-turn conversation accumulates (tests 11, B2).
            // No POST here: frames buffer until speech ends (single body).
            const dismissed: number[] = [];
            setTurns((prev) =>
              prev.map((turn) =>
                turn.reply && !settledTurnsRef.current.has(turn.id)
                  ? (dismissed.push(turn.id), { ...turn, reply: null })
                  : turn,
              ),
            );
            for (const turnId of dismissed) {
              repliesRef.current.delete(turnId);
            }
            // A new utterance after a posted turn opens the next turn on
            // the same capture: the mic never stops between turns (bug 2).
            // Stray frames buffered before this event carry over.
            if (posted) openTurn(false);
          },
          onSpeechEnd: () => {
            if (!sessionRef.current || posted) return;
            posted = true;
            postTurn(currentId, pending.splice(0));
          },
          // The meter reads the same samples as the VAD: no extra audio
          // API, throttled to ~10 Hz so the bar moves without re-render
          // churn. Works wherever capture works (iPhone Safari/Chrome).
          onLevel: (value) => {
            const now = Date.now();
            if (now - lastLevelRef.current < 100) return;
            lastLevelRef.current = now;
            setLevel(value);
          },
        },
        // Calibrated against the speech fixture (bug 2 onsets stay at
        // ~200 with 1 s of pre-roll); the end-of-turn silence is 800 ms so
        // the first text arrives ~1.2 s sooner (feedback ticket).
        { threshold: 200, endSilenceMs: 800 },
      );

      // Stash the capture handle so session stop can tear it down.
      captureRef.current = capture;
      openTurn();
      await ended;
    },
    [patchTurn, removeTurn, endSessionWithAlert],
  );

  const handleTap = useCallback(async () => {
    if (status === "requesting") return;
    if (status === "live" || status === "error") {
      stopSession();
      setAlert(null);
      setAlertCode(null);
      setNotice(null);
      setNoticeCode(null);
      setLevel(0);
      return;
    }
    setAlert(null);
    setAlertCode(null);
    setNotice(null);
    setNoticeCode(null);
    setLevel(0);
    setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setStatus("live");
      void runSession(stream);
    } catch (error) {
      setStatus(isPermissionDenied(error) ? "blocked" : "error");
    }
  }, [status, stopSession, runSession]);

  return (
    <section>
      <button
        type="button"
        onClick={handleTap}
        disabled={status === "requesting"}
      >
        {status === "live"
          ? "Stop"
          : status === "requesting"
            ? "Waiting for permission…"
            : "Tap to talk"}
      </button>

      {status === "live" && <LevelMeter level={level} />}

      {status === "live" &&
        turns.every((turn) => !turn.final && !turn.interim && !turn.reply) &&
        !notice && <p>Your microphone is on. Go ahead, I&apos;m listening.</p>}

      <ol aria-label="Conversation turns">
        {turns.map((turn) => (
          <li key={turn.id}>
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
          </li>
        ))}
      </ol>

      {notice && (
        <p role="status">
          {notice}
          {noticeCode ? ` (${noticeCode})` : ""}
        </p>
      )}

      {alert && (
        <div role="alert">
          {alert}
          {alertCode ? ` (${alertCode})` : ""}
        </div>
      )}

      {status === "blocked" && (
        <div role="alert">
          <p>
            Your microphone is blocked, so I can&apos;t hear you. To turn it
            back on:
          </p>
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
          <p>
            Something went wrong with the microphone. Check that one is
            connected and tap again.
          </p>
        </div>
      )}
    </section>
  );
}
