"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startCapture, unlockAudioContext } from "@/lib/capture";
import type {
  CaptureCallbacks,
  CaptureHandle,
  UtteranceStats,
} from "@/lib/capture";
import { LevelMeter } from "@/components/LevelMeter";
import { ValeBoard } from "@/components/ValeBoard";
import type { Board } from "@/lib/board";
import { parseSseStream } from "@/lib/sse";
import { namesVale } from "@/lib/wake";
import {
  isSpeaking,
  setVoiceEngine,
  speak,
  speechSettled,
  stopSpeaking,
  voiceEngine,
  type VoiceEngine,
  finishStream,
  speakStream,
} from "@/lib/speak";
import { createValeState, type ValeState } from "@/lib/vale-state";
import { turnErrorText, type ValeLanguage } from "@/lib/vale-language";
import { uiStrings } from "@/lib/vale-ui";
import type { Widget } from "@/lib/widget";
import { VoiceControls } from "@/components/VoiceControls";
import { WidgetCard } from "@/components/WidgetCard";

type Status = "idle" | "requesting" | "live" | "blocked" | "error";

interface Turn {
  id: number;
  interim: string;
  final: string | null;
  reply: string | null;
  /** Discarded by the wake gate: shown dimmed, never as dialogue. */
  ignored?: boolean;
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
/** Below this much voiced audio the utterance is noise, never a turn. */
const MIN_VOICED_MS = 300;
/** Strict turns: wait after her voice ends before re-listening. */
const SPEECH_RESUME_DELAY_MS = 300;
/** Absolute backstop: a voice stuck past this releases the mic anyway. */
const SPEECH_HARD_CAP_MS = 60000;
/** 960 samples at the 24 kHz capture rate (capture.ts). */
const FRAME_MS = 40;

/** Persisted screen language: the selector survives reloads, EN default. */
const LANGUAGE_KEY = "vale-language";

function storedLanguage(): ValeLanguage {
  try {
    return window.localStorage.getItem(LANGUAGE_KEY) === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

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

function countVoiced(frame: Int16Array): boolean {
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += Math.abs(frame[i]);
  return frame.length > 0 && energy / frame.length > VOICE_ENERGY_THRESHOLD;
}

export function TapToTalk() {
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Codes drive routing (E-VAD banner vs alert) but never render: the user
  // only reads the friendly message, never a raw code.
  const [, setNoticeCode] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [, setAlertCode] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [board, setBoard] = useState<Board | null>(null);
  const [widget, setWidget] = useState<Widget | null>(null);
  const castVoteRef = useRef<(vote: "yes" | "no") => void>(() => {});
  const [engine, setEngine] = useState<VoiceEngine>(() => voiceEngine());
  // Screen selector: persisted choice, EN default. It drives listening
  // (ASR language), prompt output, voice and UI; there is no auto-detection.
  const [language, setLanguage] = useState<ValeLanguage>(() =>
    typeof window === "undefined" ? "en" : storedLanguage(),
  );
  // Turn handlers close over the session; the ref keeps the live language.
  const languageRef = useRef<ValeLanguage>(language);
  const switchLanguage = useCallback((next: ValeLanguage) => {
    setLanguage(next);
    // The ref is the wire truth, not the session listener: switching while
    // idle (no live socket, no listener yet) must still stick for the next
    // connection's first frame.
    languageRef.current = next;
    try {
      window.localStorage.setItem(LANGUAGE_KEY, next);
    } catch {
      /* private mode: the session still switches for this visit */
    }
    stopSpeaking("language-switch");
    // The session listener forwards this on the live socket at once (the
    // next Meta dial pins ASR to it and the next reply speaks it, with no
    // manual reconnect); an idle session adopts it from the ref instead.
    try {
      window.dispatchEvent(
        new CustomEvent<ValeLanguage>("vale-language", { detail: next }),
      );
    } catch {
      /* the next turn carries the language frame instead */
    }
  }, []);
  const ui = uiStrings(language);
  // Stable per-browser id so slots, pending actions and chain lanes survive
  // retaps even behind one shared IP; generated once, then reused.
  const convSocketRef = useRef<WebSocket | null>(null);
  const [clientId] = useState<string>(() => {
    if (typeof window === "undefined") return "unknown";
    try {
      const stored = window.localStorage.getItem("vale-client");
      if (stored !== null && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(stored)) {
        return stored;
      }
      const fresh =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
      window.localStorage.setItem("vale-client", fresh);
      return fresh;
    } catch {
      return "unknown";
    }
  });
  const lastLevelRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef(false);
  const turnIdRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  const socketsRef = useRef(new Set<WebSocket>());
  const quietTimerRef = useRef(0);
  const watchdogRef = useRef(0);
  const visibilityHandlerRef = useRef<(() => void) | null>(null);
  const languageHandlerRef = useRef<((event: Event) => void) | null>(null);
  const sessionEndRef = useRef<(() => void) | null>(null);
  const captureRef = useRef<CaptureHandle | null>(null);
  const repliesRef = useRef(new Map<number, string>());
  const finalReceivedRef = useRef(new Set<number>());
  const settledTurnsRef = useRef(new Set<number>());
  // Silent streak: the banner shows only on repeated silence.
  const silentStreakRef = useRef(0);
  // Strict turns: capture muted while she speaks, resumed ~300 ms after.
  const mutedRef = useRef(false);
  const resumeTimerRef = useRef(0);
  const speechWatchRef = useRef(0);
  const muteStartRef = useRef(0);
  // Per-turn ear evidence, frozen at endStream and sent with it.
  const turnPeakRef = useRef(0);
  const turnMutedMsRef = useRef(0);
  const turnLostRef = useRef(0);
  const turnSrcRef = useRef(0);
  // Single source of truth for what Vale is doing; the indicator mirrors it.
  const valeStoreRef = useRef(createValeState());
  const [valeUiState, setValeUiState] = useState<ValeState>("idle");
  useEffect(() => {
    const stop = valeStoreRef.current.subscribe(setValeUiState);
    return stop;
  }, []);

  const clearSpeechWatch = useCallback(() => {
    window.clearInterval(speechWatchRef.current);
    window.clearTimeout(resumeTimerRef.current);
    mutedRef.current = false;
  }, []);

  const clearCaptureWatch = useCallback(() => {
    window.clearTimeout(quietTimerRef.current);
    window.clearInterval(watchdogRef.current);
    if (visibilityHandlerRef.current) {
      document.removeEventListener(
        "visibilitychange",
        visibilityHandlerRef.current,
      );
      visibilityHandlerRef.current = null;
    }
    if (languageHandlerRef.current) {
      window.removeEventListener("vale-language", languageHandlerRef.current);
      languageHandlerRef.current = null;
    }
  }, []);

  const stopSession = useCallback(() => {
    sessionRef.current = false;
    stopSpeaking("tap");
    clearCaptureWatch();
    controllersRef.current.forEach((controller) => {
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    });
    controllersRef.current.clear();
    clearSpeechWatch();
    valeStoreRef.current.set("idle");
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
    convSocketRef.current = null;
    sessionEndRef.current?.();
    sessionEndRef.current = null;
    setStatus("idle");
  }, [clearCaptureWatch, clearSpeechWatch]);

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
      clearCaptureWatch();
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
      convSocketRef.current = null;
      setAlert(message);
      setAlertCode(code);
      setStatus("idle");
      valeStoreRef.current.set("error");
      sessionEndRef.current?.();
      sessionEndRef.current = null;
      clearSpeechWatch();
    },
    [clearCaptureWatch, clearSpeechWatch],
  );

  const runSession = useCallback(
    async (stream: MediaStream): Promise<void> => {
      sessionRef.current = true;
      valeStoreRef.current.set("attentive");
      // One capture for the whole session; VAD events delimit turns.
      let resolveSession: (() => void) | null = null;
      const ended = new Promise<void>((resolve) => {
        resolveSession = resolve;
      });
      sessionEndRef.current = () => resolveSession?.();

      const pending: Int16Array[] = [];
      let currentId = -1;
      let posted = false;
      // Move the open mute interval into the turn total without double
      // counting: each snap restarts the clock, the unmute adds the tail.
      const snapMutedMs = () => {
        if (mutedRef.current) {
          turnMutedMsRef.current += Date.now() - muteStartRef.current;
          muteStartRef.current = Date.now();
        }
        return turnMutedMsRef.current;
      };
      // Strict turns: follow her voice, not the VAD. While anything is
      // owed (audible speech or the estimate window), capture stays muted;
      // when she settles, flush stale frames, wait ~300 ms, re-listen.
      // The window stays open throughout: a yes still lands on the session.
      window.clearInterval(speechWatchRef.current);
      speechWatchRef.current = window.setInterval(() => {
        if (!sessionRef.current) return;
        if (!speechSettled()) {
          // She owns the air: the store says so even when the frame guard
          // muted first (set is idempotent, no extra render past the first).
          valeStoreRef.current.set("speaking");
          if (!mutedRef.current) {
            mutedRef.current = true;
            muteStartRef.current = Date.now();
            captureRef.current?.setPaused?.(true);
            window.clearTimeout(resumeTimerRef.current);
          } else if (
            Date.now() - muteStartRef.current >
            SPEECH_HARD_CAP_MS
          ) {
            // Wedged voice: release the mic instead of staying deaf.
            stopSpeaking("speech-cap");
          }
          return;
        }
        if (mutedRef.current) {
          mutedRef.current = false;
          turnMutedMsRef.current += Date.now() - muteStartRef.current;
          // Fresh stamp for the next mute: the cap measures this voice.
          muteStartRef.current = 0;
          pending.length = 0;
          window.clearTimeout(resumeTimerRef.current);
          resumeTimerRef.current = window.setTimeout(() => {
            if (!sessionRef.current) return;
            captureRef.current?.setPaused?.(false);
            // A turn posted while she settled already claimed the state.
            if (valeStoreRef.current.get() === "speaking") {
              valeStoreRef.current.set("attentive");
            }
          }, SPEECH_RESUME_DELAY_MS);
        }
      }, 250);
      // One conversation socket when /voice is up, else one bridge socket
      // per turn; frames stay buffered for replay or POST fallback.
      let convSocket: WebSocket | null = null;
      let convOpen = false;
      let pendingConvTurn: number | null = null;
      interface TurnTransport {
        socket: WebSocket | null;
        /** This turn's audio rode the shared conversation socket. */
        conv: boolean;
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
        /** Frozen endStream payload: the same stats on every (re)send. */
        endPayload: string | null;
      }
      const transports = new Map<number, TurnTransport>();

      const openConvSocket = () => {
        if (
          convSocket ||
          typeof WebSocket === "undefined" ||
          typeof window === "undefined"
        ) {
          return;
        }
        let socket: WebSocket;
        try {
          socket = new WebSocket(
            `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/voice`,
          );
        } catch {
          return; // Per-turn sockets and POST stay as the fallback.
        }
        convSocket = socket;
        convSocketRef.current = socket;
        socketsRef.current.add(socket);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          convOpen = true;
          try {
            socket.send(
              JSON.stringify({
                type: "language",
                language: languageRef.current,
              }),
            );
            socket.send(JSON.stringify({ type: "client", client: clientId }));
            socket.send(JSON.stringify({ type: "wake" }));
          } catch {
            /* the close handler falls back to per-turn sockets */
          }
        };
        socket.onmessage = (event: MessageEvent) => {
          const id = pendingConvTurn ?? currentId;
          if (!transports.has(id)) return;
          handleBridgeMessage(id, event.data);
          try {
            const raw =
              typeof event.data === "string"
                ? event.data
                : new TextDecoder().decode(event.data as ArrayBuffer);
            if ((JSON.parse(raw) as { type?: unknown }).type === "done") {
              if (pendingConvTurn === id) pendingConvTurn = null;
            }
          } catch {
            /* not a JSON control frame */
          }
        };
        const dropConv = () => {
          convOpen = false;
          if (convSocket === socket) convSocket = null;
          if (convSocketRef.current === socket) convSocketRef.current = null;
          socketsRef.current.delete(socket);
        };
        socket.onerror = () => {
          // The close event follows; in-flight turns fall back below.
        };
        socket.onclose = () => {
          dropConv();
        };
      };

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
            turnErrorText("vad-continue", languageRef.current),
            "E-VAD",
          );
        }
      };

      const armQuiet = () => {
        window.clearTimeout(quietTimerRef.current);
        quietTimerRef.current = window.setTimeout(() => {
          if (!sessionRef.current) return;
          // Muted while she speaks, the VAD is frozen: churning the turn
          // here would drop an in-flight reply bubble, so wait her out.
          if (mutedRef.current) {
            armQuiet();
            return;
          }
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
        turnPeakRef.current = 0;
        turnMutedMsRef.current = 0;
        transports.set(id, {
          socket: null,
          conv: false,
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
          endPayload: null,
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
            // Append fragments and voice complete sentences at once.
            {
              const next = `${repliesRef.current.get(id) ?? ""}${message.text}`;
              repliesRef.current.set(id, next);
              patchTurn(id, { reply: next });
              valeStoreRef.current.set("speaking");
              speakStream(message.text, languageRef.current);
            }
            break;
          case "reply":
            if (typeof message.text !== "string") return;
            // Deltas already voiced this turn: only flush the tail.
            if ((repliesRef.current.get(id) ?? "") !== "") finishStream();
            else speak(message.text, languageRef.current);
            repliesRef.current.set(id, message.text);
            patchTurn(id, { reply: message.text });
            valeStoreRef.current.set("speaking");
            break;
          case "board": {
            const board = (message as { board?: unknown }).board;
            if (board && typeof board === "object") {
              setBoard(board as Board);
            }
            break;
          }
          case "widget": {
            const incoming = (message as { widget?: unknown }).widget;
            if (
              incoming === null ||
              (incoming && typeof incoming === "object")
            ) {
              setWidget((incoming ?? null) as Widget | null);
            }
            break;
          }
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
          case "ignored":
            patchTurn(id, { ignored: true });
            break;
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
          // The upgrade carries no query string, so the selector and the
          // stable browser id ride as frames.
          try {
            socket.send(
              JSON.stringify({
                type: "language",
                language: languageRef.current,
              }),
            );
            socket.send(JSON.stringify({ type: "client", client: clientId }));
          } catch {
            /* the close handler decides: reconnect or fail */
          }
          for (const frame of transport.frames) sendFrameBytes(socket, frame);
          // The turn already ended: close it on the fresh socket.
          if (transport.ended || transport.endQueued) {
            transport.endQueued = false;
            try {
              socket.send(
                transport.endPayload ?? JSON.stringify({ type: "endStream" }),
              );
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
            failTurn(id, turnErrorText("lost", languageRef.current), "E-NET");
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
          failTurn(id, turnErrorText("lost", languageRef.current), "E-NET");
        };
      };

      // Speech end: conversation socket first, then the turn socket, then POST.
      const endTurnTransport = (id: number) => {
        valeStoreRef.current.set("thinking");
        const transport = transports.get(id);
        // Freeze what the client saw: the same evidence on every (re)send.
        const endPayload = JSON.stringify({
          type: "endStream",
          peakLevel: turnPeakRef.current,
          voicedMs: (transport?.voiced ?? 0) * FRAME_MS,
          mutedMs: snapMutedMs(),
          valeState: valeStoreRef.current.get(),
          lostBlocks: turnLostRef.current,
          srcBlocks: turnSrcRef.current,
        });
        if (transport) transport.endPayload = endPayload;
        if (
          transport?.conv &&
          convSocket &&
          convSocket.readyState === WebSocket.OPEN
        ) {
          try {
            convSocket.send(endPayload);
            pendingConvTurn = id;
            return;
          } catch {
            /* fall through to the turn socket or POST */
          }
        }
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
            socket.send(
              transport.endPayload ?? JSON.stringify({ type: "endStream" }),
            );
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

      const subscribePostTurn = (
        id: number,
        request: Promise<Response>,
        controller: AbortController,
      ) => {
        request
          .then(async (response) => {
            if (!response.ok) {
              let message = turnErrorText("lost", languageRef.current);
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
              failTurn(id, turnErrorText("lost", languageRef.current), "E-NET");
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
                // Append fragments and voice complete sentences at once.
                const next = `${repliesRef.current.get(id) ?? ""}${text}`;
                repliesRef.current.set(id, next);
                patchTurn(id, { reply: next });
                speakStream(text, languageRef.current);
              },
              onReply: (text) => {
                // Deltas already voiced this turn: only flush the tail.
                if ((repliesRef.current.get(id) ?? "") !== "") finishStream();
                else speak(text, languageRef.current);
                repliesRef.current.set(id, text);
                patchTurn(id, { reply: text });
              },
              onBoard: (next) => setBoard(next),
              onWidget: (next) => setWidget(next),
              onIgnored: () => patchTurn(id, { ignored: true }),
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
            failTurn(id, turnErrorText("lost", languageRef.current), "E-NET");
          });
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
        subscribePostTurn(
          id,
          fetch(
            `/api/voice?language=${languageRef.current}&client=${encodeURIComponent(clientId)}`,
            {
              method: "POST",
              headers: { "content-type": "audio/l16" },
              body,
              signal: controller.signal,
            },
          ),
          controller,
        );
      };

      // Touch on a confirm card: rides the open socket like any control, or
      // a JSON turn when no socket is open. Either way it equals a spoken vote.
      const castVote = (vote: "yes" | "no") => {
        if (!sessionRef.current) return;
        const payload = JSON.stringify({ type: "vote", vote });
        try {
          if (
            convOpen &&
            convSocket &&
            typeof WebSocket !== "undefined" &&
            convSocket.readyState === WebSocket.OPEN
          ) {
            convSocket.send(payload);
            return;
          }
          const socket = transports.get(currentId)?.socket;
          if (
            socket &&
            typeof WebSocket !== "undefined" &&
            socket.readyState === WebSocket.OPEN
          ) {
            socket.send(payload);
            return;
          }
        } catch {
          /* fall through to the JSON turn */
        }
        openTurn();
        const id = currentId;
        const controller = new AbortController();
        controllersRef.current.add(controller);
        setNotice(null);
        setNoticeCode(null);
        subscribePostTurn(
          id,
          fetch(
            `/api/voice?language=${languageRef.current}&client=${encodeURIComponent(clientId)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ transcript: vote }),
              signal: controller.signal,
            },
          ),
          controller,
        );
      };

      // End-of-turn pause, tunable without redeploying the default: slow
      // phrases keep pauses under this; longer silence splits the turn.
      const endSilenceMs = Math.max(
        1,
        Number(process.env.NEXT_PUBLIC_VAD_END_SILENCE_MS) || 800,
      );
      // Stall watchdog: the processor feeds a heartbeat on every audio
      // block, speech or silence, so a quiet mic still proves it is alive.
      // No blocks for STALL_MS means capture died (suspended context,
      // throttled tab, killed processor) and restarts on the same stream.
      // Silence never trips it: only the heartbeat counts, never frames.
      const STALL_MS = 5000;
      let lastBeatAt = Date.now();
      let framesOut = 0;
      const snapshotState = (capture: string): Record<string, unknown> => ({
        capture,
        audio: captureRef.current?.state() ?? "unknown",
        visible:
          typeof document !== "undefined" ? document.visibilityState : "?",
        speaking: isSpeaking(),
        framesOut,
        idleMs: Date.now() - lastBeatAt,
      });
      const sendClientState = (capture: string) => {
        let payload = "";
        try {
          payload = JSON.stringify({
            type: "client-state",
            state: snapshotState(capture),
          });
        } catch {
          return;
        }
        // Diagnostics ride the open socket; they never open one themselves.
        try {
          if (
            convOpen &&
            convSocket &&
            typeof WebSocket !== "undefined" &&
            convSocket.readyState === WebSocket.OPEN
          ) {
            convSocket.send(payload);
            return;
          }
          const socket = transports.get(currentId)?.socket;
          if (
            socket &&
            typeof WebSocket !== "undefined" &&
            socket.readyState === WebSocket.OPEN
          ) {
            socket.send(payload);
          }
        } catch {
          /* diagnostics never break the turn */
        }
      };
      const logClientState = (event: string) => {
        const snapshot = snapshotState(event);
        try {
          console.log(
            `[capture] ${event} visible=${String(snapshot.visible)} audio=${String(snapshot.audio)} speaking=${String(snapshot.speaking)} frames=${String(snapshot.framesOut)} idleMs=${String(snapshot.idleMs)}`,
          );
        } catch {
          /* logging never breaks the turn */
        }
        sendClientState(event);
      };
      const beginCapture = () => {
        try {
          captureRef.current?.stop();
        } catch {
          /* already stopped */
        }
        captureRef.current = startCapture(stream, captureCallbacks, {
          threshold: 200,
          endSilenceMs,
        });
        lastBeatAt = Date.now();
      };
      const captureCallbacks: CaptureCallbacks = {
          onHeartbeat: () => {
            lastBeatAt = Date.now();
          },
          onFrame: (frame) => {
            if (!sessionRef.current) return;
            // Strict turns: while she speaks, nothing is captured. The
            // capture pause usually drops these first; this guards the gap
            // before the next watch tick lands.
            if (!speechSettled()) {
              captureRef.current?.setPaused?.(true);
              mutedRef.current = true;
              // The watch reads this for the 60 s backstop: stamp it on
              // every mute path, or the first tick would cut her at once.
              if (muteStartRef.current === 0) {
                muteStartRef.current = Date.now();
              }
              return;
            }
            framesOut += 1;
            pending.push(frame.slice());
            // Stream each frame live and keep it buffered for replay or POST fallback.
            const transport = transports.get(currentId);
            if (transport && !transport.failed) {
              if (countVoiced(frame)) transport.voiced += 1;
              transport.frames.push(frame.slice());
              if (
                convOpen &&
                convSocket &&
                convSocket.readyState === WebSocket.OPEN
              ) {
                try {
                  sendFrameBytes(convSocket, frame);
                  transport.conv = true;
                } catch {
                  /* endTurnTransport falls back to POST */
                }
                return;
              }
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
            // Strict turns: speech only starts while she is silent (capture
            // runs muted otherwise), so there is nothing to interrupt and
            // her text stays put.
            valeStoreRef.current.set("hearing");
            window.clearTimeout(quietTimerRef.current);
            // A new utterance after a posted turn opens the next turn on the same capture.
            if (posted) openTurn(false);
            // Without a conversation socket, open one per turn so the
            // ~0.9 s handshake hides inside the utterance.
            if (!convOpen) openTurnSocket(currentId);
          },
          onSpeechEnd: (utterance?: UtteranceStats) => {
            if (!sessionRef.current || posted) return;
            posted = true;
            // Delivery accounting for this utterance (blocks lost under
            // load, source blocks spanned): frozen into the endStream below.
            turnLostRef.current = utterance?.lostBlocks ?? 0;
            turnSrcRef.current = utterance?.srcBlocks ?? 0;
            // Below ~300 ms of voiced audio the mic heard noise, not Daniel:
            // drop the turn before it reaches the wire. An empty never cuts
            // her voice (audible starts never cut) and never moves the window
            // (the server only stamps attention on executed turns and replies).
            const transport = transports.get(currentId);
            if ((transport?.voiced ?? 0) * FRAME_MS < MIN_VOICED_MS) {
              if (transport) {
                transport.failed = true;
                const socket = transport.socket;
                if (socket) {
                  try {
                    socket.close();
                  } catch {
                    /* already closed */
                  }
                }
              }
              removeTurn(currentId);
              openTurn(false);
              return;
            }
            // Strict turns: speech only starts while she is silent, so
            // every utterance here is Daniel, never her echo.
            endTurnTransport(currentId);
          },
          // Same samples as the VAD, throttled to ~10 Hz.
          onLevel: (value) => {
            const now = Date.now();
            if (now - lastLevelRef.current < 100) return;
            lastLevelRef.current = now;
            if (value > turnPeakRef.current) turnPeakRef.current = value;
            setLevel(value);
          },
          // iOS kept the context suspended past the gesture: zeros flow.
          onBlocked: () => {
            if (!sessionRef.current) return;
            endSessionWithAlert(
              turnErrorText("suspended", languageRef.current),
              null,
            );
          },
        // Threshold 200 with 1 s pre-roll; the end silence comes from
        // NEXT_PUBLIC_VAD_END_SILENCE_MS (default 800 ms).
        };
        castVoteRef.current = castVote;
      beginCapture();
      // A stall resumes alone: no audio blocks for STALL_MS restarts
      // capture on the same stream instead of ending the session. The mic
      // stream itself dead is the only honest alert left.
      watchdogRef.current = window.setInterval(() => {
        if (!sessionRef.current) return;
        if (Date.now() - lastBeatAt < STALL_MS) return;
        const tracks =
          typeof stream.getTracks === "function" ? stream.getTracks() : [];
        const micLive =
          tracks.length === 0 ||
          tracks.some((track) => track.readyState === "live");
        if (!micLive) {
          endSessionWithAlert(
            turnErrorText("suspended", languageRef.current),
            null,
          );
          return;
        }
        logClientState("stall-restart");
        try {
          beginCapture();
        } catch {
          endSessionWithAlert(
            turnErrorText("suspended", languageRef.current),
            null,
          );
        }
      }, 2000);
      // Hidden tabs stop the processor on some platforms: log the state on
      // every change and re-check on return; the watchdog restarts a stall.
      const onVisibility = () => {
        if (!sessionRef.current) return;
        logClientState("visibility");
      };
      visibilityHandlerRef.current = onVisibility;
      document.addEventListener("visibilitychange", onVisibility);
      // Mid-session language switch: the ref, the open conversation
      // socket and the next dial adopt it at once.
      const onLanguage = (event: Event) => {
        const next = (event as CustomEvent<ValeLanguage>).detail;
        if (next !== "es" && next !== "en") return;
        languageRef.current = next;
        try {
          if (
            convOpen &&
            convSocket &&
            typeof WebSocket !== "undefined" &&
            convSocket.readyState === WebSocket.OPEN
          ) {
            convSocket.send(JSON.stringify({ type: "language", language: next }));
          }
        } catch {
          /* the next turn carries the language frame instead */
        }
      };
      languageHandlerRef.current = onLanguage;
      window.addEventListener("vale-language", onLanguage);
      openConvSocket();
      openTurn();
      await ended;
      clearCaptureWatch();
    },
    [
      patchTurn,
      removeTurn,
      pruneIfEmpty,
      endSessionWithAlert,
      clearCaptureWatch,
      clientId,
    ],
  );

  const handleTap = useCallback(async () => {
    if (status === "requesting") return;
    // In-gesture audio unlock: resume() after the getUserMedia await below
    // no longer counts as a gesture on iOS and the mic delivers zeros.
    try {
      unlockAudioContext();
    } catch {
      /* startCapture throws the clear error when unsupported */
    }
    if (status === "live" || status === "error") {
      stopSession();
      setAlert(null);
      setAlertCode(null);
      setNotice(null);
      setNoticeCode(null);
      setLevel(0);
      setBoard(null);
      return;
    }
    setAlert(null);
    setAlertCode(null);
    setNotice(null);
    setNoticeCode(null);
    setLevel(0);
    setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;
      setStatus("live");
      void runSession(stream);
    } catch (error) {
      setStatus(isPermissionDenied(error) ? "blocked" : "error");
    }
  }, [status, stopSession, runSession]);

  const toggleEngine = useCallback(() => {
    const next: VoiceEngine = engine === "seamless" ? "browser" : "seamless";
    setVoiceEngine(next);
    stopSpeaking("engine-switch");
    setEngine(next);
  }, [engine]);

  return (
    <section>
      <button
        type="button"
        onClick={handleTap}
        disabled={status === "requesting"}
      >
        {status === "live"
          ? ui.stop
          : status === "requesting"
            ? ui.waiting
            : ui.tapToTalk}
      </button>{" "}
      <button
        type="button"
        onClick={toggleEngine}
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
            onChange={() => switchLanguage("en")}
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
            onChange={() => switchLanguage("es")}
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

      {widget && (
        <WidgetCard
          widget={widget}
          language={language}
          onVote={(vote) => castVoteRef.current(vote)}
        />
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
