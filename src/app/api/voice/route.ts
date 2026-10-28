import { openAsrConnection } from "@/lib/asr";

export const runtime = "nodejs";

const TURN_TIMEOUT_MS = 120000;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * POST /api/voice — one push-to-talk turn.
 * Body: raw PCM_24KHZ mono 16-bit audio bytes (streamed while the user speaks)
 * or JSON { "transcript": "..." } to skip ASR (agent-only turn).
 * Returns a text/event-stream of `interim`, `final`, `reply`, `done`,
 * `error` events. One Meta WS connection per turn, closed when done or when
 * the page disconnects. The Meta key never leaves the server.
 */
export async function POST(request: Request): Promise<Response> {
  const key = process.env.META_API_KEY;
  if (!key) {
    return Response.json(
      { error: "Voice service is not configured. Try again later." },
      { status: 503 },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  const jsonTurn = contentType.includes("application/json");
  let cannedTranscript: string | null = null;
  if (jsonTurn) {
    try {
      const body = (await request.json()) as { transcript?: unknown };
      if (typeof body.transcript !== "string" || body.transcript.trim() === "") {
        return Response.json({ error: "Empty transcript." }, { status: 400 });
      }
      cannedTranscript = body.transcript;
    } catch {
      return Response.json({ error: "Bad request." }, { status: 400 });
    }
  } else if (!request.body) {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          closed = true;
        }
      };
      const closeStream = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const finishError = (message: string) => {
        if (closed) return;
        send("error", { message });
        send("done", {});
        closeStream();
      };
      let asr: Awaited<ReturnType<typeof openAsrConnection>> | null = null;
      let settled = false;
      const timeout = setTimeout(() => {
        asr?.close();
        finishError("The voice turn timed out. Tap to try again.");
      }, TURN_TIMEOUT_MS);

      const abort = () => {
        clearTimeout(timeout);
        try {
          asr?.close();
        } catch {
          /* already closed */
        }
        closeStream();
      };
      request.signal.addEventListener("abort", abort);

      try {
        if (cannedTranscript !== null) {
          send("final", { transcript: cannedTranscript });
          send("done", {});
          clearTimeout(timeout);
          closeStream();
          return;
        }

        let opened = false;
        const reader = (request.body as ReadableStream<Uint8Array>).getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!opened) {
              opened = true;
              try {
                asr = await openAsrConnection({
                  key,
                  url: process.env.META_ASR_URL || undefined,
                  onEvent: (event) => {
                    if (event.kind === "interim") {
                      send("interim", { transcript: event.transcript });
                    } else if (event.kind === "final") {
                      settled = true;
                      send("final", {
                        transcript: event.transcript,
                        audioProcessedMs: event.audioProcessedMs ?? null,
                      });
                    }
                  },
                  onError: (message) => {
                    if (!settled) {
                      settled = true;
                      clearTimeout(timeout);
                      finishError(
                        `Voice transcription had a problem (${message}). Tap to try again.`,
                      );
                    }
                  },
                });
              } catch {
                settled = true;
                clearTimeout(timeout);
                finishError("Connection lost. Tap to try again.");
                return;
              }
            }
            asr?.sendPcm(value);
          }
        } finally {
          reader.releaseLock();
        }

        if (!opened) {
          clearTimeout(timeout);
          finishError("I didn't hear anything. Tap and speak.");
          return;
        }
        asr?.endTurn();
        // Wait for the final on this same stream: poll the settled flag via
        // a promise that resolves on final/error/close.
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (settled) {
              clearInterval(check);
              resolve();
            }
          }, 25);
          setTimeout(() => {
            clearInterval(check);
            resolve();
          }, TURN_TIMEOUT_MS);
        });
        if (!settled) {
          finishError("Connection lost. Tap to try again.");
          return;
        }
        send("done", {});
        clearTimeout(timeout);
        closeStream();
      } catch {
        if (!settled) finishError("Connection lost. Tap to try again.");
      } finally {
        clearTimeout(timeout);
        try {
          asr?.close();
        } catch {
          /* already closed */
        }
        request.signal.removeEventListener("abort", abort);
      }
    },
    cancel() {
      // Client went away mid-turn; the abort listener closes the Meta socket.
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
