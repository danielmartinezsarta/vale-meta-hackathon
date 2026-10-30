import { connection } from "next/server";
import { upgradeWebSocket } from "@vercel/functions";
import { runAgentTurn } from "@/lib/agent";
import { getDb } from "@/lib/db";
import { getBoard } from "@/lib/board";
import {
  chainFailed,
  chainSucceeded,
  nextPreviousResponseId,
} from "@/lib/response-chain";
import { checkWake, requestClientIp } from "@/lib/wake";
import { openAsrConnection } from "@/lib/asr";
import { estimateCost, formatTurnLog } from "@/lib/turn-log";
import { attachVoiceBridge } from "@/lib/voice-bridge";
import {
  DEFAULT_LANGUAGE,
  parseLanguage,
  turnErrorText,
} from "@/lib/vale-language";

export const runtime = "nodejs";

// Live bridge: one browser socket = one Meta socket = one PUSH_TO_TALK turn.
export async function GET(): Promise<Response> {
  const key = process.env.META_API_KEY;
  if (!key) {
    console.error("[voice] META_API_KEY is not configured; rejecting turn.");
    return Response.json(
      {
        error: turnErrorText("setup"),
        code: "E-NET",
      },
      { status: 503 },
    );
  }
  await connection();
  // The upgrade handler receives no request, so the WS turn language
  // arrives as a {type:"language"} control frame from the browser instead.
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

// One push-to-talk turn: raw PCM_24KHZ body or JSON transcript; answers an SSE stream.
export async function POST(request: Request): Promise<Response> {
  const key = process.env.META_API_KEY;
  // Closed language from the screen selector; JSON and PCM turns agree.
  const language = parseLanguage(
    new URL(request.url).searchParams.get("language") ?? DEFAULT_LANGUAGE,
  );
  if (!key) {
    // Server-side log only; the key itself is never logged.
    console.error("[voice] META_API_KEY is not configured; rejecting turn.");
    return Response.json(
      {
        error: turnErrorText("setup", language),
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
      // Error codes name the failing layer: E-VAD silence, E-NET service, E-ASR transcription, E-MODEL reply.
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
      const turnTimeoutMs = Math.max(
        1,
        Number(process.env.VOICE_TURN_TIMEOUT_MS) || TURN_TIMEOUT_MS,
      );
      let aborted = false;
      const timeout = setTimeout(() => {
        asr?.close();
        if (!settled) {
          settled = true;
          chainFailed();
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
            ignored: false,
          });
        }
        finishError(turnErrorText("timeout", language), "E-NET");
      }, turnTimeoutMs);

      const abort = () => {
        aborted = true;
        chainFailed();
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
        // ts is the caller-supplied end-of-speech moment.
        ts: string;
        transcript: string;
        ttftMs: number | null;
        inputTokens: number;
        outputTokens: number;
        audioSeconds: number;
        tool: string | null;
        modelSkipped: boolean;
        error: string | null;
        ignored: boolean;
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
            previousResponseId: nextPreviousResponseId(),
            url: process.env.META_RESPONSES_URL || undefined,
            startedAt: speechEndAt,
            onDelta: (text) => send("reply-delta", { text }),
            language,
          });
          if (!aborted) chainSucceeded(result.responseId, result.chainNext);
          send("reply", { text: result.text });
          send("board", { board: getBoard(getDb()) });
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
            ignored: false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "failed";
          chainFailed();
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
            ignored: false,
          });
          send("error", {
            message: turnErrorText("model", language),
            code: "E-MODEL",
          });
        }
      };

      try {
        if (cannedTranscript !== null) {
          send("final", { transcript: cannedTranscript });
          // Name gate first: background chatter never reaches the model, the
          // board or the response chain.
          if (!checkWake(cannedTranscript, requestClientIp(request)).execute) {
            logTurn({
              ts: new Date().toISOString(),
              transcript: cannedTranscript,
              ttftMs: null,
              inputTokens: 0,
              outputTokens: 0,
              audioSeconds: 0,
              tool: null,
              modelSkipped: true,
              error: null,
              ignored: true,
            });
            send("ignored", {});
            send("done", {});
            clearTimeout(timeout);
            closeStream();
            return;
          }
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
                      // Plain text to the user; raw provider text stays in the server log only.
                      console.error(`[voice-asr] transcription error: ${message}`);
                      finishError(turnErrorText("lost", language), "E-ASR");
                    }
                  },
                });
              } catch {
                settled = true;
                clearTimeout(timeout);
                finishError(turnErrorText("lost", language), "E-NET");
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
          finishError(turnErrorText("vad-tap", language), "E-VAD");
          return;
        }
        asr?.endTurn();
        await waitFor(() => gotFinal || settled, TURN_TIMEOUT_MS);
        if (!gotFinal) {
          if (!settled) finishError(turnErrorText("lost", language), "E-NET");
          return;
        }
        if (finalText.trim() === "") {
          // Empty final: no model call, just the notice.
          send("notice", { message: turnErrorText("vad-continue", language), code: "E-VAD" });
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
            ignored: false,
          });
        } else if (!checkWake(finalText, requestClientIp(request)).execute) {
          // Background chatter without the name: silent discard.
          logTurn({
            ts: new Date(finalAtMs || Date.now()).toISOString(),
            transcript: finalText,
            ttftMs: null,
            inputTokens: 0,
            outputTokens: 0,
            audioSeconds,
            tool: null,
            modelSkipped: true,
            error: null,
            ignored: true,
          });
          send("ignored", {});
        } else {
          await answerTranscript(finalText, audioSeconds, finalAtMs);
        }
        settled = true;
        send("done", {});
        clearTimeout(timeout);
        closeStream();
      } catch {
        if (!settled) finishError(turnErrorText("lost", language), "E-NET");
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
