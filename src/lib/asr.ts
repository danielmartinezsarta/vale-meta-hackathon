import WebSocket from "ws";

import type { ValeLanguage } from "./vale-language";

export const ASR_URL = "wss://api.meta.ai/v1/asr/realtime";
export const ASR_MODEL = "muse-voice-transcribe-1.0";
export const ASR_ENCODING = "PCM_24KHZ";
export const ASR_SAMPLE_RATE = 24000; // 24 kHz mono 16-bit = 48 000 bytes/s.
const HANDSHAKE_TIMEOUT_MS = 10000;

export type AsrEvent =
  | { kind: "interim"; transcript: string; audioProcessedMs?: number }
  | { kind: "final"; transcript: string; audioProcessedMs?: number }
  | { kind: "progress"; audioProcessedMs: number };

export interface AsrConnection {
  sendPcm(chunk: Uint8Array): void;
  /** Delimit the turn (PUSH_TO_TALK): the server answers with the final. */
  endTurn(): void;
  close(): void;
  readonly open: boolean;
}

export interface OpenAsrOptions {
  key: string;
  url?: string;
  onEvent: (event: AsrEvent) => void;
  onError?: (message: string) => void;
  /** Screen language: pinned as the transcription bias (names, not tags). */
  language?: ValeLanguage;
}

// Server-side only: holds the Meta key, never import from client code.
export function openAsrConnection(
  options: OpenAsrOptions,
): Promise<AsrConnection> {
  const url = options.url ?? ASR_URL;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    let open = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        reject(new Error("asr handshake timeout"));
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          authorization: { accessToken: `Bearer ${options.key}` },
          audioEncoding: ASR_ENCODING,
          model: ASR_MODEL,
          mode: "PUSH_TO_TALK",
          // Pin listening to the screen language (names, not tags).
          languageBias: [options.language === "es" ? "Spanish" : "English"],
        }),
      );
    });

    let gotFinal = false;
    ws.on("message", (data) => {
      let message: {
        type?: string;
        sessionId?: string;
        transcript?: string;
        final?: boolean;
        audioProcessedMs?: number;
        message?: string;
      };
      try {
        message = JSON.parse(data.toString()) as typeof message;
      } catch {
        return;
      }
      if (!settled && message.sessionId && !message.type) {
        settled = true;
        clearTimeout(timer);
        open = true;
        resolve(connection);
        return;
      }
      if (message.type === "transcript" && typeof message.transcript === "string") {
        if (message.final) gotFinal = true;
        options.onEvent(
          message.final
            ? {
                kind: "final",
                transcript: message.transcript,
                audioProcessedMs: message.audioProcessedMs,
              }
            : {
                kind: "interim",
                transcript: message.transcript,
                audioProcessedMs: message.audioProcessedMs,
              },
        );
      } else if (
        message.type === "audioProgress" &&
        typeof message.audioProcessedMs === "number"
      ) {
        options.onEvent({
          kind: "progress",
          audioProcessedMs: message.audioProcessedMs,
        });
      } else if (message.type === "error") {
        options.onError?.(message.message ?? "transcription error");
      }
    });

    const fail = (error: Error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        options.onError?.(error.message);
      }
    };
    ws.on("error", fail);
    ws.on("unexpected-response", (_req, res) => {
      fail(new Error(`asr unexpected response: ${res.statusCode}`));
    });

    const connection: AsrConnection = {
      sendPcm(chunk: Uint8Array) {
        if (open && ws.readyState === WebSocket.OPEN) ws.send(chunk);
      },
      endTurn() {
        if (open && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "endStream" }));
        }
      },
      close() {
        open = false;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
      get open() {
        return open && ws.readyState === WebSocket.OPEN;
      },
    };

    ws.on("close", () => {
      open = false;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("asr connection closed before handshake"));
      } else if (!gotFinal) {
        // Only a pre-final close is a failure; after the final Meta closes the socket normally.
        options.onError?.("connection lost");
      }
    });
  });
}
