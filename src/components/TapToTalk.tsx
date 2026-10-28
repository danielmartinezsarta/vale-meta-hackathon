"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startCapture } from "@/lib/capture";
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

function makePcmPipe(): {
  readable: ReadableStream<Uint8Array>;
  push: (frame: Int16Array) => void;
  close: () => void;
} {
  const queue: Uint8Array[] = [];
  let waiting: ((chunk: Uint8Array | null) => void) | null = null;
  let closed = false;
  const push = (frame: Int16Array) => {
    const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(bytes);
    } else {
      queue.push(bytes);
    }
  };
  const close = () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  };
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next) {
        controller.enqueue(next);
        return;
      }
      if (closed) {
        controller.close();
        return;
      }
      return new Promise<void>((resolve) => {
        waiting = (chunk) => {
          if (chunk) controller.enqueue(chunk);
          else controller.close();
          resolve();
        };
      });
    },
    cancel() {
      close();
    },
  });
  return { readable, push, close };
}

export function TapToTalk() {
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef(false);
  const turnIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const captureRef = useRef<{ stop: () => void } | null>(null);
  const repliesRef = useRef(new Map<number, string>());
  const lastInterruptMsRef = useRef(0);
  const finalReceivedRef = useRef(new Set<number>());

  const stopSession = useCallback(() => {
    sessionRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    try {
      captureRef.current?.stop();
    } catch {
      /* already stopped */
    }
    captureRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
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
    (message: string) => {
      sessionRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      try {
        captureRef.current?.stop();
      } catch {
        /* already stopped */
      }
      captureRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      finalReceivedRef.current.clear();
      repliesRef.current.clear();
      setAlert(message);
      setStatus("idle");
    },
    [],
  );

  const runOneTurn = useCallback(
    async (stream: MediaStream): Promise<void> => {
      const id = turnIdRef.current++;
      setTurns((prev) => [...prev, { id, interim: "", final: null, reply: null }]);

      return new Promise<void>((resolve) => {
        let pipe: ReturnType<typeof makePcmPipe> | null = null;
        let posted = false;
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(quietTimer);
          try {
            capture.stop();
          } catch {
            /* already stopped */
          }
          if (captureRef.current === capture) captureRef.current = null;
          fn();
        };
        // A failed turn ends the session so the user can tap to retry.
        // A turn that already showed its final keeps its bubble (test 25).
        const failTurn = (message: string) => {
          settle(() => {
            if (!finalReceivedRef.current.has(id)) removeTurn(id);
            endSessionWithAlert(message);
            resolve();
          });
        };
        const quietTimer = window.setTimeout(() => {
          settle(() => {
            removeTurn(id);
            setNotice("I didn't hear anything. Just speak and I'll listen.");
            resolve();
          });
        }, NO_SPEECH_TIMEOUT_MS);

        const postTurn = (firstFrames: Int16Array[]) => {
          pipe = makePcmPipe();
          for (const frame of firstFrames) pipe.push(frame);
          const controller = new AbortController();
          abortRef.current = controller;
          setNotice(null);
          void fetch("/api/voice", {
            method: "POST",
            headers: { "content-type": "audio/l16" },
            body: pipe.readable,
            // @ts-expect-error streaming upload flag (supported in browsers)
            duplex: "half",
            signal: controller.signal,
          })
            .then(async (response) => {
              if (!response.ok) {
                let message = "Connection lost. Tap to try again.";
                try {
                  const problem = (await response.json()) as {
                    error?: unknown;
                  };
                  if (typeof problem.error === "string") message = problem.error;
                } catch {
                  /* keep the default */
                }
                failTurn(message);
                return;
              }
              if (!response.body) {
                failTurn("Connection lost. Tap to try again.");
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
                onErrorEvent: (message) => failTurn(message),
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
                onNotice: (message) => setNotice(message),
                onDone: () => settle(() => resolve()),
              });
            })
            .catch(() => {
              if (controller.signal.aborted) {
                settle(() => resolve());
                return;
              }
              failTurn("Connection lost. Tap to try again.");
            });
        };

        const pending: Int16Array[] = [];
        const capture = startCapture(
          stream,
          {
            onFrame: (frame) => {
              if (!posted) pending.push(frame.slice());
              else pipe?.push(frame);
            },
            onSpeechStart: () => {
              if (!sessionRef.current) return;
              // Interruption (test 18): new speech dismisses any shown
              // reply immediately, then starts the next turn.
              const started = performance.now();
              setTurns((prev) =>
                prev.some((turn) => turn.reply)
                  ? prev.map((turn) => ({ ...turn, reply: null }))
                  : prev,
              );
              repliesRef.current.clear();
              lastInterruptMsRef.current = performance.now() - started;
              if (posted) return;
              posted = true;
              postTurn(pending.splice(0));
            },
            onSpeechEnd: () => {
              pipe?.close();
              try {
                capture.stop();
              } catch {
                /* already stopped */
              }
            },
          },
          { endSilenceMs: 1200 },
        );

        // Stash the capture handle so session stop can tear it down.
        captureRef.current = capture;
      });
    },
    [patchTurn, removeTurn, endSessionWithAlert],
  );

  const runSession = useCallback(
    async (stream: MediaStream) => {
      sessionRef.current = true;
      try {
        while (sessionRef.current) {
          await runOneTurn(stream);
        }
      } catch {
        // Backstop: turn failures already end the session themselves.
        endSessionWithAlert("Connection lost. Tap to try again.");
      }
    },
    [runOneTurn, endSessionWithAlert],
  );

  const handleTap = useCallback(async () => {
    if (status === "requesting") return;
    if (status === "live" || status === "error") {
      stopSession();
      setAlert(null);
      setNotice(null);
      return;
    }
    setAlert(null);
    setNotice(null);
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

      {notice && <p role="status">{notice}</p>}

      {alert && <div role="alert">{alert}</div>}

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
