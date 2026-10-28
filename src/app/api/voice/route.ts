import { connection } from "next/server";
import { upgradeWebSocket } from "@vercel/functions";
import { runAgentTurn } from "@/lib/agent";
import { openAsrConnection } from "@/lib/asr";
import { estimateCost, formatTurnLog } from "@/lib/turn-log";
import { attachVoiceBridge } from "@/lib/voice-bridge";

export const runtime = "nodejs";

/**
 * GET /api/voice — live bridge: browser <--WS--> Vercel <--WS--> Meta.
 * One browser socket = one Meta socket = one PUSH_TO_TALK turn. CUMULATIVE
 * partials stream while the person speaks; the final freezes the bubble and
 * triggers the Spark reply. POST below stays as the fallback transport
 * (and the agent-only path for canned transcripts).
 */
export async function GET(): Promise<Response> {
  const key = process.env.META_API_KEY;
  if (!key) {
    console.error("[voice] META_API_KEY is not configured; rejecting turn.");
    return Response.json(
      {
        error: "Voice service is not configured. Try again later.",
        code: "E-NET",
      },
      { status: 503 },
    );
  }
  await connection();
  return upgradeWebSocket((browser) => {
    attachVoiceBridge({
      browser,
      key,
      metaUrl: process.env.META_ASR_URL || undefined,
    });
  });
}

const TURN_TIMEOUT_MS = 120000;

async function waitFor(
  isDone: () => boolean,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (isDone()) {
        clearInterval(check);
        resolve();
      }
    }, 25);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, timeoutMs);
  });
}

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
    // M3: clear server-side log line (the key itself is never logged).
    console.error("[voice] META_API_KEY is not configured; rejecting turn.");
    return Response.json(
      {
        error: "Voice service is not configured. Try again later.",
        code: "E-NET",
      },
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
      // Short on-screen error code next to the plain message, so a phone
      // test can report the failing layer: E-VAD (silence), E-NET
      // (service/connection), E-ASR (transcription), E-MODEL (reply).
      const finishError = (message: string, code: string) => {
        if (closed) return;
        send("error", { message, code });
        send("done", {});
        closeStream();
      };
      let asr: Awaited<ReturnType<typeof openAsrConnection>> | null = null;
      let settled = false;
      let gotFinal = false;
      let finalText = "";
      let lastInterim = "";
      let finalAtMs = 0;
      let audioSeconds = 0;
      let agentRan = false;
      // b3: overridable in tests so the timeout path is exercisable.
      const turnTimeoutMs = Math.max(
        1,
        Number(process.env.VOICE_TURN_TIMEOUT_MS) || TURN_TIMEOUT_MS,
      );
      const timeout = setTimeout(() => {
        asr?.close();
        // b3: a timed-out turn leaves a log line too.
        if (!settled) {
          settled = true;
          logTurn({
            ts: new Date(finalAtMs || Date.now()).toISOString(),
            transcript: finalText || lastInterim,
            ttftMs: null,
            inputTokens: 0,
            outputTokens: 0,
            audioSeconds,
            tool: null,
            modelSkipped: !agentRan,
            error: "timeout",
          });
        }
        finishError("The voice turn timed out. Tap to try again.", "E-NET");
      }, turnTimeoutMs);

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

      const logTurn = (fields: {
        // b1: ts is the real end-of-speech moment, supplied by the caller.
        ts: string;
        transcript: string;
        ttftMs: number | null;
        inputTokens: number;
        outputTokens: number;
        audioSeconds: number;
        tool: string | null;
        modelSkipped: boolean;
        error: string | null;
      }) => {
        console.log(
          formatTurnLog({
            ...fields,
            costUsd: estimateCost(
              { inputTokens: fields.inputTokens, outputTokens: fields.outputTokens },
              fields.audioSeconds,
            ),
          }),
        );
      };

      /** Run the agent for a final transcript, then log the turn. */
      const answerTranscript = async (
        transcript: string,
        audioSeconds: number,
        speechEndAt: number,
      ): Promise<void> => {
        agentRan = true;
        const ts = new Date(speechEndAt || Date.now()).toISOString();
        try {
          const result = await runAgentTurn({
            key,
            transcript,
            url: process.env.META_RESPONSES_URL || undefined,
            startedAt: speechEndAt,
            onDelta: (text) => send("reply-delta", { text }),
          });
          send("reply", { text: result.text });
          logTurn({
            ts,
            transcript,
            ttftMs: result.firstTokenMs,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            audioSeconds,
            tool: result.toolUsed,
            modelSkipped: false,
            error: null,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "failed";
          logTurn({
            ts,
            transcript,
            ttftMs: null,
            inputTokens: 0,
            outputTokens: 0,
            audioSeconds,
            tool: null,
            modelSkipped: false,
            error: message,
          });
          send("error", {
            message: "Sorry, I had trouble answering. Tap to try again.",
            code: "E-MODEL",
          });
        }
      };

      try {
        if (cannedTranscript !== null) {
          send("final", { transcript: cannedTranscript });
          await answerTranscript(cannedTranscript, 0, Date.now());
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
                      lastInterim = event.transcript;
                      send("interim", { transcript: event.transcript });
                    } else if (event.kind === "final") {
                      gotFinal = true;
                      // b1: the final arrives right at end of speech.
                      finalAtMs = Date.now();
                      finalText = event.transcript;
                      audioSeconds = (event.audioProcessedMs ?? 0) / 1000;
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
                      // M2: fixed plain text to the user; raw provider text
                      // stays in the server log only.
                      console.error(`[voice-asr] transcription error: ${message}`);
                      finishError("Connection lost. Tap to try again.", "E-ASR");
                    }
                  },
                });
              } catch {
                settled = true;
                clearTimeout(timeout);
                finishError("Connection lost. Tap to try again.", "E-NET");
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
          finishError("I didn't hear anything. Tap and speak.", "E-VAD");
          return;
        }
        asr?.endTurn();
        // Wait for the final on this same stream.
        await waitFor(() => gotFinal || settled, TURN_TIMEOUT_MS);
        if (!gotFinal) {
          if (!settled) finishError("Connection lost. Tap to try again.", "E-NET");
          return;
        }
        if (finalText.trim() === "") {
          // Heard nothing intelligible: no model call (test 24).
          send("notice", { message: "I didn't hear anything. Just speak and I'll listen.", code: "E-VAD" });
          logTurn({
            ts: new Date(finalAtMs || Date.now()).toISOString(),
            transcript: "",
            ttftMs: null,
            inputTokens: 0,
            outputTokens: 0,
            audioSeconds,
            tool: null,
            modelSkipped: true,
            error: null,
          });
        } else {
          await answerTranscript(finalText, audioSeconds, finalAtMs);
        }
        settled = true;
        send("done", {});
        clearTimeout(timeout);
        closeStream();
      } catch {
        if (!settled) finishError("Connection lost. Tap to try again.", "E-NET");
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
