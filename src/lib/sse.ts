import type { Board } from "./board";

export interface SseHandlers {
  onInterim?: (transcript: string) => void;
  onFinal?: (transcript: string, audioProcessedMs: number | null) => void;
  onReplyDelta?: (text: string) => void;
  onReply?: (text: string) => void;
  onBoard?: (board: Board) => void;
  onNotice?: (message: string, code?: string) => void;
  onErrorEvent?: (message: string, code?: string) => void;
  onDone?: () => void;
}

export async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  handlers: SseHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatch(raw, handlers);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") dispatch(buffer, handlers);
  } finally {
    reader.releaseLock();
  }
}

function dispatch(raw: string, handlers: SseHandlers): void {
  let event = "";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  let data: unknown = null;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  const payload = data as Record<string, unknown>;
  switch (event) {
    case "interim":
      if (typeof payload.transcript === "string") {
        handlers.onInterim?.(payload.transcript);
      }
      break;
    case "final":
      if (typeof payload.transcript === "string") {
        const ms =
          typeof payload.audioProcessedMs === "number"
            ? payload.audioProcessedMs
            : null;
        handlers.onFinal?.(payload.transcript, ms);
      }
      break;
    case "reply-delta":
      if (typeof payload.text === "string") handlers.onReplyDelta?.(payload.text);
      break;
    case "reply":
      if (typeof payload.text === "string") handlers.onReply?.(payload.text);
      break;
    case "board":
      if (payload.board && typeof payload.board === "object") {
        handlers.onBoard?.(payload.board as Board);
      }
      break;
    case "notice":
      if (typeof payload.message === "string") {
        handlers.onNotice?.(
          payload.message,
          typeof payload.code === "string" ? payload.code : undefined,
        );
      }
      break;
    case "error":
      if (typeof payload.message === "string") {
        handlers.onErrorEvent?.(
          payload.message,
          typeof payload.code === "string" ? payload.code : undefined,
        );
      }
      break;
    case "done":
      handlers.onDone?.();
      break;
    default:
      break;
  }
}
