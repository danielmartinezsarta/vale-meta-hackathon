"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startCapture } from "@/lib/capture";
import { LevelMeter } from "@/components/LevelMeter";
import { parseSseStream } from "@/lib/sse";
import { speak, stopSpeaking } from "@/lib/speak";

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

function hasVisibleContent(turn: {
  interim: string;
  final: string | null;
  reply: string | null;
}): boolean {
  return (
    (turn.final ?? turn.interim).trim() !== "" ||
    (turn.reply?.trim() ?? "") !== ""
  );
}

// Mirrors the VAD threshold in capture.ts.
const VOICE_ENERGY_THRESHOLD = 200;

function countVoiced(frame: Int16Array): boolean {
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += Math.abs(frame[i]);
  return frame.length > 0 && energy / frame.length > VOICE_ENERGY_THRESHOLD;
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
  const socketsRef = useRef(new Set<WebSocket>());
  const quietTimerRef = useRef(0);
  const sessionEndRef = useRef<(() => void) | null>(null);
  const captureRef = useRef<{ stop: () => void } | null>(null);
  const repliesRef = useRef(new Map<number, string>());
  const finalReceivedRef = useRef(new Set<number>());
  // Only a still-open turn's reply can be interrupted.
  const settledTurnsRef = useRef(new Set<number>());
  // Silent streak: the banner shows only on repeated silence.
  const silentStreakRef = useRef(0);

  const stopSession = useCallback(() => {
    sessionRef.current = false;
    stopSpeaking();
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
    socketsRef.current.forEach((socket) => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    });
    socketsRef.current.clear();
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

  const pruneIfEmpty = useCallback((id: number) => {
    setTurns((prev) =>
      prev.filter((turn) => turn.id !== id || hasVisibleContent(turn)),
    );
  }, []);

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
      socketsRef.current.forEach((socket) => {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      });
      socketsRef.current.clear();
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
      // One capture for the whole session; VAD events delimit turns.
      let resolveSession: (() => void) | null = null;
      const ended = new Promise<void>((resolve) => {
        resolveSession = resolve;
      });
      sessionEndRef.current = () => resolveSession?.();

      const pending: Int16Array[] = [];
      let currentId = -1;
      let posted = false;
      // One WebSocket per turn; frames stay buffered for replay or POST fallback.
      interface TurnTransport {
        socket: WebSocket | null;
        frames: Int16Array[];
        opened: boolean;
        reconnected: boolean;
        endQueued: boolean;
        /** Speech already ended: every (re)open must close the turn. */
        ended: boolean;
        settled: boolean;
        failed: boolean;
        /** The single buffered-POST retry already ran for this turn. */
        postRetried: boolean;
        /** Audio as it stood when speech ended (no inter-turn tail). */
        endFrames: Int16Array[] | null;
        /** Frames with real voice (energy above the VAD threshold). */
        voiced: number;
      }
      const transports = new Map<number, TurnTransport>();

      const showNotice = (message: string, code: string | null = null) => {
        setNotice(message);
        setNoticeCode(code);
      };

      const handleVadCandidate = (id: number) => {
        const voiced = transports.get(id)?.voiced ?? 0;
        if (voiced > 0) {
          silentStreakRef.current = 0;
          return;
        }
        silentStreakRef.current += 1;
        if (silentStreakRef.current >= 2) {
          showNotice(
            "I didn't hear anything. Just speak and I'll listen.",
            "E-VAD",
          );
        }
      };

      const armQuiet = () => {
        window.clearTimeout(quietTimerRef.current);
        quietTimerRef.current = window.setTimeout(() => {
          if (!sessionRef.current) return;
          handleVadCandidate(currentId);
          removeTurn(currentId);
          openTurn();
        }, NO_SPEECH_TIMEOUT_MS);
      };

      const openTurn = (arm = true) => {
        const id = turnIdRef.current++;
        currentId = id;
        posted = false;
        pending.length = 0;
        transports.set(id, {
          socket: null,
          frames: [],
          opened: false,
          reconnected: false,
          endQueued: false,
          ended: false,
          settled: false,
          failed: false,
          postRetried: false,
          endFrames: null,
          voiced: 0,
        });
        setTurns((prev) => [
          ...prev,
          { id, interim: "", final: null, reply: null },
        ]);
        if (arm) armQuiet();
      };

      // A failed turn ends the session so the user can tap to retry.
      const failTurn = (id: number, message: string, code: string | null = null) => {
        if (!finalReceivedRef.current.has(id)) removeTurn(id);
        endSessionWithAlert(message, code);
      };

      const sendFrameBytes = (socket: WebSocket, frame: Int16Array) => {
        socket.send(
          frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
        );
      };

      const handleBridgeMessage = (id: number, raw: unknown) => {
        const transport = transports.get(id);
        // Late socket frames after the POST retry are stale; ignore them.
        if (
          !transport ||
          transport.settled ||
          transport.failed ||
          !sessionRef.current
        )
          return;
        let message: {
          type?: string;
          transcript?: unknown;
          text?: unknown;
          message?: unknown;
          code?: unknown;
        };
        try {
          const text =
            typeof raw === "string"
              ? raw
              : new TextDecoder().decode(raw as ArrayBuffer);
          message = JSON.parse(text) as typeof message;
        } catch {
          return;
        }
        switch (message.type) {
          case "transcript":
            if (typeof message.transcript !== "string") return;
            if ((message as { final?: unknown }).final === true) {
              finalReceivedRef.current.add(id);
              if (message.transcript.trim() !== "") silentStreakRef.current = 0;
              patchTurn(id, { final: message.transcript, interim: "" });
            } else {
              patchTurn(id, { interim: message.transcript });
            }
            break;
          case "reply-delta":
            if (typeof message.text !== "string") return;
            // Append fragments; the final "reply" paints the complete text.
            {
              const next = `${repliesRef.current.get(id) ?? ""}${message.text}`;
              repliesRef.current.set(id, next);
              patchTurn(id, { reply: next });
            }
            break;
          case "reply":
            if (typeof message.text !== "string") return;
            repliesRef.current.set(id, message.text);
            patchTurn(id, { reply: message.text });
            speak(message.text);
            break;
          case "notice":
            if (typeof message.message !== "string") return;
            if (typeof message.code === "string" && message.code === "E-VAD") {
              handleVadCandidate(id);
              break;
            }
            showNotice(
              message.message,
              typeof message.code === "string" ? message.code : null,
            );
            break;
          case "error": {
            if (typeof message.message !== "string") return;
            transport.settled = true;
            const socket = transport.socket;
            transport.socket = null;
            if (socket) {
              socketsRef.current.delete(socket);
              try {
                socket.close();
              } catch {
                /* already closed */
              }
            }
            failTurn(
              id,
              message.message,
              typeof message.code === "string" ? message.code : "E-NET",
            );
            break;
          }
          case "done":
            transport.settled = true;
            {
              const socket = transport.socket;
              transport.socket = null;
              if (socket) {
                socketsRef.current.delete(socket);
                try {
                  socket.close();
                } catch {
                  /* already closed */
                }
              }
            }
            settledTurnsRef.current.add(id);
            pruneIfEmpty(id);
            // Fresh silence window, unless a newer turn is already collecting.
            if (id === currentId) armQuiet();
            break;
          default:
            break;
        }
      };

      // One bridge socket per turn; replays buffered frames on (re)open.
      const openTurnSocket = (id: number) => {
        const transport = transports.get(id);
        if (!transport || transport.socket || typeof WebSocket === "undefined") {
          return;
        }
        let socket: WebSocket;
        try {
          socket = new WebSocket(
            `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/voice`,
          );
        } catch {
          return; // The speech-end fallback posts the buffered audio instead.
        }
        transport.socket = socket;
        socketsRef.current.add(socket);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          if (transport.failed) {
            try {
              socket.close();
            } catch {
              /* already closed */
            }
            return;
          }
          transport.opened = true;
          for (const frame of transport.frames) sendFrameBytes(socket, frame);
          // The turn already ended: close it on the fresh socket.
          if (transport.ended || transport.endQueued) {
            transport.endQueued = false;
            try {
              socket.send(JSON.stringify({ type: "endStream" }));
            } catch {
              /* the close handler decides: reconnect or fail */
            }
          }
        };
        socket.onmessage = (event: MessageEvent) => {
          handleBridgeMessage(id, event.data);
        };
        socket.onerror = () => {
          // The close event follows with the decision (fallback/reconnect).
        };
        socket.onclose = () => {
          socketsRef.current.delete(socket);
          if (transport.socket === socket) transport.socket = null;
          if (
            transport.settled ||
            transport.failed ||
            !sessionRef.current
          ) {
            return;
          }
          if (finalReceivedRef.current.has(id)) {
            // The transcript bubble stays; only the reply is lost.
            failTurn(id, "Connection lost. Tap to try again.", "E-NET");
            return;
          }
          if (!transport.opened) {
            // Never connected: fall back to the buffered POST.
            transport.failed = true;
            transport.postRetried = true;
            try {
              socket.close();
            } catch {
              /* already closed */
            }
            postTurn(id, pending.splice(0));
            return;
          }
          if (!transport.reconnected) {
            // Mid-turn drop: reopen once and replay; Meta has no resume.
            transport.reconnected = true;
            window.setTimeout(() => {
              if (
                sessionRef.current &&
                !transport.settled &&
                !transport.failed
              ) {
                openTurnSocket(id);
              }
            }, 1000);
            return;
          }
          if (!transport.postRetried && !finalReceivedRef.current.has(id)) {
            // No final after reopen: one POST retry; the bridge never ran the agent, so no duplicate call.
            transport.postRetried = true;
            transport.failed = true;
            try {
              socket.close();
            } catch {
              /* already closed */
            }
            const retryFrames =
              transport.endFrames && transport.endFrames.length > 0
                ? transport.endFrames.slice()
                : transport.frames.slice();
            if (id === currentId) pending.splice(0);
            postTurn(id, retryFrames.length > 0 ? retryFrames : pending.splice(0));
            return;
          }
          failTurn(id, "Connection lost. Tap to try again.", "E-NET");
        };
      };

      // Speech end: live endStream when the socket is up, else the POST.
      const endTurnTransport = (id: number) => {
        const transport = transports.get(id);
        const socket = transport?.socket ?? null;
        // The turn is over: any (re)open must send endStream after replay.
        if (transport) {
          transport.ended = true;
          // Freeze the retry audio here; gap frames belong to the next turn.
          transport.endFrames = transport.frames.slice();
        }
        if (
          socket &&
          transport &&
          !transport.failed &&
          socket.readyState === WebSocket.OPEN
        ) {
          try {
            socket.send(JSON.stringify({ type: "endStream" }));
          } catch {
            transport.failed = true;
            postTurn(id, pending.splice(0));
          }
          return;
        }
        if (
          socket &&
          transport &&
          !transport.failed &&
          socket.readyState === WebSocket.CONNECTING
        ) {
          // Still dialing: queue the end, POST only if it never connects.
          transport.endQueued = true;
          window.setTimeout(() => {
            const current = transports.get(id);
            if (
              current &&
              !current.settled &&
              !current.failed &&
              socket.readyState !== WebSocket.OPEN
            ) {
              current.failed = true;
              try {
                socket.close();
              } catch {
                /* already closed */
              }
              postTurn(id, pending.splice(0));
            }
          }, 5000);
          return;
        }
        postTurn(id, pending.splice(0));
      };

      const postTurn = (id: number, frames: Int16Array[]) => {
        // One buffered body per turn: Safari iOS rejects streaming request bodies.
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
                // The turn ends at `done`; reply/notice/error follow on this stream.
                finalReceivedRef.current.add(id);
                if (transcript.trim() !== "") silentStreakRef.current = 0;
                patchTurn(id, { final: transcript, interim: "" });
              },
              onErrorEvent: (message, code) => {
                controllersRef.current.delete(controller);
                failTurn(id, message, code ?? "E-NET");
              },
              onReplyDelta: (text) => {
                // Append fragments, same as the bridge path.
                const next = `${repliesRef.current.get(id) ?? ""}${text}`;
                repliesRef.current.set(id, next);
                patchTurn(id, { reply: next });
              },
              onReply: (text) => {
                repliesRef.current.set(id, text);
                patchTurn(id, { reply: text });
                speak(text);
              },
              onNotice: (message, code) => {
                // E-VAD notices pass the silence gate; anything else shows directly.
                if (code === "E-VAD") handleVadCandidate(id);
                else showNotice(message, code ?? null);
              },
              onDone: () => {
                controllersRef.current.delete(controller);
                if (!sessionRef.current) return;
                settledTurnsRef.current.add(id);
                pruneIfEmpty(id);
                // Fresh silence window, unless a newer turn is already collecting.
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
            // Stream each frame live and keep it buffered for replay or POST fallback.
            const transport = transports.get(currentId);
            if (transport && !transport.failed) {
              if (countVoiced(frame)) transport.voiced += 1;
              transport.frames.push(frame.slice());
              const socket = transport.socket;
              if (socket && socket.readyState === WebSocket.OPEN) {
                try {
                  sendFrameBytes(socket, frame);
                } catch {
                  /* the close handler decides: reconnect or fail */
                }
              }
            }
          },
          onSpeechStart: () => {
            if (!sessionRef.current) return;
            stopSpeaking();
            window.clearTimeout(quietTimerRef.current);
            // New speech dismisses only the still-open turn's reply.
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
            // A new utterance after a posted turn opens the next turn on the same capture.
            if (posted) openTurn(false);
            // Open the socket at speech start so the ~0.9 s handshake hides inside the utterance.
            openTurnSocket(currentId);
          },
          onSpeechEnd: () => {
            if (!sessionRef.current || posted) return;
            posted = true;
            endTurnTransport(currentId);
          },
          // Same samples as the VAD, throttled to ~10 Hz.
          onLevel: (value) => {
            const now = Date.now();
            if (now - lastLevelRef.current < 100) return;
            lastLevelRef.current = now;
            setLevel(value);
          },
        },
        // Threshold 200 with 1 s pre-roll; 800 ms end silence posts ~1.2 s sooner.
        { threshold: 200, endSilenceMs: 800 },
      );

      captureRef.current = capture;
      openTurn();
      await ended;
    },
    [patchTurn, removeTurn, pruneIfEmpty, endSessionWithAlert],
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
        turns.every((turn) => !hasVisibleContent(turn)) &&
        !notice && <p>Your microphone is on. Go ahead, I&apos;m listening.</p>}

      <ol aria-label="Conversation turns">
        {turns.filter(hasVisibleContent).map((turn) => (
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
