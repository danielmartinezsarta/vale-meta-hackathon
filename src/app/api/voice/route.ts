import { AGENT_MODEL, runAgentTurn, toolWaitPhrase } from "@/lib/agent";
import { getDb, recentTurns, recordTurn } from "@/lib/db";
import { getBoard } from "@/lib/board";
import { getSlots } from "@/lib/slot-memory";
import {
  clearPendingAction,
  isConfirmYes,
  isRefusalNo,
  peekPendingAction,
  quoteAcceptSessionId,
  runPendingActions,
  takePendingAction,
} from "@/lib/pending-action";
import { rejectQuote } from "@/lib/vale-tools";
import { buildWidget, type Widget } from "@/lib/widget";
import {
  canonicalizeWakeWord,
  checkWake,
  noteAttention,
  requestClientId,
  type WakeVerdict,
} from "@/lib/wake";
import { getOpenSession } from "@/lib/vale-tools";
import { ASR_MODEL, openAsrConnection } from "@/lib/asr";
import { emitTurnLog, estimateCost, modelElapsedMs, vlog } from "@/lib/turn-log";
import { saveTurnWav } from "@/lib/turn-audio";
import { attachVoiceBridge, parseTurnTag } from "@/lib/voice-bridge";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReplayRun, type ReplayRun } from "@/lib/replay";
import {
  DEFAULT_LANGUAGE,
  declineText,
  parseLanguage,
  turnErrorText,
  type ValeLanguage,
} from "@/lib/vale-language";

export const runtime = "nodejs";

// Replay state per client: with VALE_REPLAY=1 each typed turn is
// answered from the committed run in order, no model involved. The pill
// and the demo share it through GET /api/voice?replay=...&client=....
interface ReplayState {
  cursor: number;
  paused: boolean;
}
const replayStates = new Map<string, ReplayState>();
function replayState(clientKey: string): ReplayState {
  const existing = replayStates.get(clientKey);
  if (existing) return existing;
  const fresh: ReplayState = { cursor: 0, paused: false };
  replayStates.set(clientKey, fresh);
  return fresh;
}

interface ReplayScene {
  name: string;
  start: number;
  count: number;
}

function replaySceneList(run: ReplayRun): ReplayScene[] {
  const scenes: ReplayScene[] = [];
  for (let i = 0; i < run.turns.length; i += 1) {
    const last = scenes[scenes.length - 1];
    if (last && last.name === run.turns[i].scene) last.count += 1;
    else scenes.push({ name: run.turns[i].scene, start: i, count: 1 });
  }
  return scenes;
}

// Replay controls for the pill and the demo (VALE_REPLAY=1 only):
// GET /api/voice?replay=state&client=... reads; replay=pause|resume|stop|
// prev|next writes. Stop parks at turn 0 paused; next from the last scene
// finishes the run. Nothing here touches the live turn path.
export async function GET(request: Request): Promise<Response> {
  if (process.env.VALE_REPLAY !== "1") {
    return Response.json({ replay: false }, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const state = replayState(requestClientId(request));
  let run: ReplayRun;
  try {
    run = parseReplayRun(readFileSync(join(process.cwd(), "replay", "demo-run.json"), "utf8"));
  } catch {
    return Response.json({ replay: true, error: "no run" }, { status: 500 });
  }
  const scenes = replaySceneList(run);
  const atScene = (): number => {
    if (state.cursor >= run.turns.length) return scenes.length - 1;
    const found = scenes.findIndex(
      (s) => state.cursor >= s.start && state.cursor < s.start + s.count,
    );
    return found < 0 ? 0 : found;
  };
  const action = params.get("replay");
  if (action === "pause") state.paused = true;
  else if (action === "resume") state.paused = false;
  else if (action === "stop") {
    state.cursor = 0;
    state.paused = true;
  } else if (action === "prev") {
    state.cursor = atScene() <= 0 ? 0 : scenes[atScene() - 1].start;
  } else if (action === "next") {
    state.cursor =
      atScene() >= scenes.length - 1 ? run.turns.length : scenes[atScene() + 1].start;
  }
  const done = state.cursor >= run.turns.length;
  const scene = done ? null : scenes[atScene()];
  return Response.json({
    replay: true,
    cursor: state.cursor,
    total: run.turns.length,
    paused: state.paused,
    done,
    scenes,
    current: scene
      ? {
          scene: scene.name,
          indexInScene: state.cursor - scene.start + 1,
          sceneCount: scene.count,
        }
      : null,
  });
}

// One voice socket: the browser dials /voice, served by server.ts
// (plain ws upgrade, no platform helpers). This route keeps the POST
// turns only: typed turns and the replay/POST fallback.

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
  // Keyless replay (npm run demo): recorded turns need no key, typed or
  // audio; every other turn still goes through the key gate below.
  const replayContent = (request.headers.get("content-type") ?? "").includes(
    "application/json",
  );
  const replayTyped = process.env.VALE_REPLAY === "1" && replayContent;
  const replayAudio = process.env.VALE_REPLAY === "1" && !replayContent;
  // Closed language from the screen selector; JSON and PCM turns agree.
  const language = parseLanguage(
    new URL(request.url).searchParams.get("language") ?? DEFAULT_LANGUAGE,
  );
  // Shared turn id from the client (t042); the WS bridge parses its own.
  const turnTag = parseTurnTag(new URL(request.url).searchParams.get("turn"));
  // Slots and pending proposals live per client, like the wake window.
  const clientKey = requestClientId(request);
  // The live path below is always keyed; replay typed turns carry no key
  // by design and only ever take the recorded answer path, so the empty
  // fallback below can never reach the model.
  const modelKey = key ?? "";
  if (!key && !replayTyped && !replayAudio) {
    // Server-side log only; the key itself is never logged.
    vlog({
      turn: turnTag ?? "-",
      process: "ERROR",
      status: "error",
      content: "META_API_KEY is not configured; rejecting turn",
    });
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
  let typedTurn = false;
  if (jsonTurn) {
    try {
      const body = (await request.json()) as { transcript?: unknown; typed?: unknown };
      if (typeof body.transcript !== "string" || body.transcript.trim() === "") {
        return Response.json({ error: "Empty transcript." }, { status: 400 });
      }
      cannedTranscript = body.transcript;
      typedTurn = body.typed === true;
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
      // Every screen payload also lands in the JSONL recording with its
      // turn, so replay sees exactly what the screen showed.
      const sendBoard = () => {
        const board = getBoard(getDb());
        send("board", { board });
        vlog({
          turn: turnTag ?? "-",
          process: "DB",
          status: "ok",
          detail: { board: true },
          extra: { board },
        });
      };
      const sendWidget = (widget: Widget | null) => {
        send("widget", { widget });
        vlog({
          turn: turnTag ?? "-",
          process: "VOICE",
          status: "ok",
          detail: { widget: widget === null ? "none" : widget.kind },
          content: widget === null ? null : widget.title,
          extra: { widget },
        });
      };
      // Error codes name the failing layer: E-VAD silence, E-NET service, E-ASR transcription, E-MODEL reply.
      const finishError = (message: string, code: string) => {
        if (closed) return;
        send("error", { message, code });
        send("done", {});
        closeStream();
      };
      let asr: Awaited<ReturnType<typeof openAsrConnection>> | null = null;
      let asrStartMs = 0;
      let settled = false;
      let gotFinal = false;
      let finalText = "";
      let lastInterim = "";
      let finalAtMs = 0;
      let audioSeconds = 0;
      let agentRan = false;
      /** This turn's mic PCM for the WAV evidence file; freed at turn end. */
      const audioChunks: Uint8Array[] = [];
      let turnWav: string | null = null;
      let wavSaved = false;
      const turnTimeoutMs = Math.max(
        1,
        Number(process.env.VOICE_TURN_TIMEOUT_MS) || TURN_TIMEOUT_MS,
      );
      let aborted = false;
      const timeout = setTimeout(() => {
        asr?.close();
        if (!settled) {
          settled = true;
          logTurn({
            language,
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
            asrMs:
              asrStartMs > 0 && finalAtMs > 0 ? finalAtMs - asrStartMs : null,
            chain: "none",
            key: clientKey,
            slots: null,
            gate: null,
            sinceReplyS: null,
            totalMs: null,
          });
        }
        finishError(turnErrorText("timeout", language), "E-NET");
      }, turnTimeoutMs);

      const abort = () => {
        aborted = true;
        clearTimeout(timeout);
        try {
          asr?.close();
        } catch {
          /* already closed */
        }
        closeStream();
      };
      request.signal.addEventListener("abort", abort);

      // Replay mode (VALE_REPLAY=1): the normal typed pipeline answers each
      // turn from the committed run in order — transcript, reply, card —
      // with no ASR and no model. The client runs its real turn path:
      // wake, listening, thinking, speaking, sheets, back to idle.
      // byIndex answers the Nth utterance with the Nth recorded turn and
      // ignores the audio content entirely: no ASR, no wake gate, no model.
      // The transcript shown on screen is the recorded one.
      const answerRecordedTurn = async (transcript: string, byIndex = false): Promise<boolean> => {
        if (process.env.VALE_REPLAY !== "1") return false;
        let run: ReplayRun | null = null;
        try {
          const raw = readFileSync(join(process.cwd(), "replay", "demo-run.json"), "utf8");
          run = parseReplayRun(raw);
        } catch {
          return false;
        }
        const state = replayState(clientKey);
        // Pause holds the turn until resume; the demo waits on the reply.
        while (state.paused && !aborted) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (aborted) return false;
        // Normal path: the next turn in order. A jump or stop can land the
        // cursor elsewhere while a turn is in flight; then answer the
        // matching turn anywhere in the run without moving the cursor.
        let idx = state.cursor;
        let advance = true;
        if (byIndex) {
          if (idx >= run.turns.length) return false;
        } else if (idx >= run.turns.length || run.turns[idx].transcript !== transcript) {
          advance = false;
          idx = -1;
          for (let k = 0; k < run.turns.length; k += 1) {
            const j = (state.cursor + k) % run.turns.length;
            if (run.turns[j].transcript === transcript) {
              idx = j;
              break;
            }
          }
          if (idx < 0) return false;
        }
        const turn = run.turns[idx];
        if (advance) state.cursor = idx + 1;
        if (byIndex) {
          send("final", { transcript: turn.transcript });
          // eslint-disable-next-line no-param-reassign
          transcript = turn.transcript;
        }
        recordTurn(getDb(), clientKey, "user", transcript);
        const half = Math.ceil(turn.reply.length / 2);
        if (turn.reply !== "") {
          send("reply-delta", { text: turn.reply.slice(0, half) });
          send("reply-delta", { text: turn.reply.slice(half) });
        }
        send("reply", { text: turn.reply });
        recordTurn(getDb(), clientKey, "vale", turn.reply, turn.tool);
        noteAttention(clientKey);
        if (turn.board) send("board", { board: turn.board });
        else sendBoard();
        if (turn.widget) sendWidget(turn.widget);
        const stored = getSlots(clientKey);
        logTurn({
          language,
          ts: new Date().toISOString(),
          transcript,
          ttftMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: 0,
          tool: turn.tool,
          modelSkipped: true,
          error: null,
          ignored: false,
          chain: "none",
          key: clientKey,
          slots: stored.client !== undefined || stored.service !== undefined ? stored : null,
          gate: byIndex ? "audio" : "typed",
          sinceReplyS: null,
          totalMs: 0,
        });
        vlog({
          turn: turn.turn,
          process: "AGENT",
          status: "ok",
          detail: { tool: turn.tool, scene: turn.scene, replayed: true },
          content: turn.reply.slice(0, 120),
        });
        return true;
      };

      const logTurn = (fields: {
        // ts is the caller-supplied end-of-speech moment.
        ts: string;
        turn?: string | null;
        language: ValeLanguage;
        transcript: string;
        ttftMs: number | null;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number | null;
        audioSeconds: number;
        tool: string | null;
        modelSkipped: boolean;
        error: string | null;
        ignored: boolean;
        asrMs?: number | null;
        chain?: "hit" | "miss" | "none";
        key?: string;
        slots?: { client?: string; service?: string } | null;
        gate?: WakeVerdict["gate"] | null;
        sinceReplyS?: number | null;
        totalMs?: number | null;
      }) => {
        // One WAV per turn from whatever the mic sent; canned transcripts
        // carry no audio, so they log wav null. POST turns have no client
        // stats frame, unlike the WS bridge (stats stay null there).
        if (!wavSaved && audioChunks.length > 0) {
          wavSaved = true;
          turnWav = saveTurnWav(clientKey, audioChunks);
          audioChunks.length = 0;
        }
        emitTurnLog({
          ...fields,
          turn: fields.turn ?? turnTag,
          wav: turnWav,
          costUsd: estimateCost(
            {
              inputTokens: fields.inputTokens,
              outputTokens: fields.outputTokens,
              cachedInputTokens: fields.cachedInputTokens ?? 0,
            },
            fields.audioSeconds,
          ),
        });
      };

      const answerTranscript = async (
        transcript: string,
        audioSeconds: number,
        speechEndAt: number,
        verdict: WakeVerdict,
      ): Promise<void> => {
        agentRan = true;
        const ts = new Date(speechEndAt || Date.now()).toISOString();
        // Explicit memory: history first, then record this user turn.
        const history = recentTurns(getDb(), clientKey);
        recordTurn(getDb(), clientKey, "user", transcript);
        const slotSnapshot = (): {
          client?: string;
          service?: string;
        } | null => {
          const slots = getSlots(clientKey);
          return slots.client !== undefined || slots.service !== undefined
            ? slots
            : null;
        };
        const measuredAsrMs =
          audioSeconds > 0 && speechEndAt > 0 && asrStartMs > 0
            ? speechEndAt - asrStartMs
            : null;
        try {
          // A yes to Vale's pending proposal runs the stored writes at once:
          // no model, no questions, no chain needed.
          if (isConfirmYes(transcript)) {
            const actions = takePendingAction(clientKey);
            if (actions) {
              const executed = runPendingActions(getDb(), clientKey, actions, language);
              recordTurn(getDb(), clientKey, "vale", executed.text, executed.toolUsed);
              send("reply", { text: executed.text });
              // Her reply restarts the window: the next turn counts from here.
              noteAttention(clientKey);
              sendBoard();
              logTurn({
                language,
                ts,
                transcript,
                ttftMs: Date.now() - speechEndAt,
                inputTokens: 0,
                outputTokens: 0,
                audioSeconds,
                tool: executed.toolUsed,
                modelSkipped: true,
                error: null,
                ignored: false,
                asrMs: measuredAsrMs,
                chain: "none",
                key: clientKey,
                slots: slotSnapshot(),
                gate: verdict.gate,
                sinceReplyS: verdict.sinceReplyS,
                totalMs: Date.now() - speechEndAt,
              });
              return;
            }
          }
          // A no to Vale's pending proposal discards it at once: the card
          // goes away with a short decline, no model, no second question.
          // A no on the quote sheet rejects it instead and waits for the
          // spoken amount, with the sheet still open.
          if (isRefusalNo(transcript) && peekPendingAction(clientKey)) {
            const stored = takePendingAction(clientKey);
            const quoteSession = quoteAcceptSessionId(stored ?? []);
            if (quoteSession !== null) {
              const rejected = rejectQuote(getDb(), quoteSession, language);
              recordTurn(getDb(), clientKey, "user", transcript);
              recordTurn(getDb(), clientKey, "vale", rejected.message, "session_quote");
              send("reply", { text: rejected.message });
              noteAttention(clientKey);
              sendBoard();
              sendWidget(
                buildWidget(
                  "quote_price",
                  {},
                  (rejected as { data?: unknown }).data ?? null,
                ),
              );
              logTurn({
                language,
                ts,
                transcript,
                ttftMs: Date.now() - speechEndAt,
                inputTokens: 0,
                outputTokens: 0,
                audioSeconds,
                tool: "session_quote",
                modelSkipped: true,
                error: null,
                ignored: false,
                asrMs: measuredAsrMs,
                chain: "none",
                key: clientKey,
                slots: slotSnapshot(),
                gate: verdict.gate,
                sinceReplyS: verdict.sinceReplyS,
                totalMs: Date.now() - speechEndAt,
              });
              send("done", {});
              return;
            }
            const declined = declineText(language);
            recordTurn(getDb(), clientKey, "vale", declined, null);
            send("reply", { text: declined });
            noteAttention(clientKey);
            sendBoard();
            sendWidget(null);
            logTurn({
              language,
              ts,
              transcript,
              ttftMs: Date.now() - speechEndAt,
              inputTokens: 0,
              outputTokens: 0,
              audioSeconds,
              tool: null,
              modelSkipped: true,
              error: null,
              ignored: false,
              asrMs: measuredAsrMs,
              chain: "none",
              key: clientKey,
              slots: slotSnapshot(),
              gate: verdict.gate,
              sinceReplyS: verdict.sinceReplyS,
              totalMs: Date.now() - speechEndAt,
            });
            send("done", {});
            return;
          }
          const result = await runAgentTurn({
            key: modelKey,
            transcript,
            history,
            url: process.env.META_RESPONSES_URL || undefined,
            startedAt: speechEndAt,
            onDelta: (text) => send("reply-delta", { text }),
            onToolStart: (tool) => {
              const wait = toolWaitPhrase(tool, language);
              if (wait) send("reply-delta", { text: wait });
            },
            language,
            slotKey: clientKey,
            turn: turnTag ?? undefined,
          });
          if (!aborted) recordTurn(getDb(), clientKey, "vale", result.text, result.toolUsed);
          vlog({
            turn: turnTag ?? "-",
            process: "AGENT",
            model: AGENT_MODEL,
            durationMs: modelElapsedMs(result.firstTokenMs, speechEndAt),
            status: "ok",
            detail: { tool: result.toolUsed },
            content: result.text,
          });
          send("reply", { text: result.text });
          // Her reply restarts the window: the next turn counts from here.
          noteAttention(clientKey);
          sendBoard();
          if (result.widget) {
            sendWidget(result.widget);
          }
          logTurn({
            language,
            ts,
            transcript,
            ttftMs: result.firstTokenMs,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedInputTokens: result.usage.cachedInputTokens,
            audioSeconds,
            tool: result.toolUsed,
            modelSkipped: false,
            error: null,
            ignored: false,
            asrMs: measuredAsrMs,
            chain: "none",
            key: clientKey,
            slots: slotSnapshot(),
            gate: verdict.gate,
            sinceReplyS: verdict.sinceReplyS,
            totalMs: Date.now() - speechEndAt,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "failed";
          logTurn({
            language,
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
            asrMs: measuredAsrMs,
            chain: "none",
            key: clientKey,
            slots: slotSnapshot(),
            gate: verdict.gate,
            sinceReplyS: verdict.sinceReplyS,
            totalMs: Date.now() - speechEndAt,
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
          if (typedTurn && (await answerRecordedTurn(cannedTranscript))) {
            send("done", {});
            clearTimeout(timeout);
            closeStream();
            return;
          }
          if (typedTurn) {
            // Typed turns are always addressed to Vale: no ASR ran and the
            // wake gate is skipped, then the identical answer path runs.
            // They log gate "typed" so logs and replay tell them apart.
            const typedVerdict: WakeVerdict = {
              execute: true,
              namedVale: true,
              gate: "typed",
              sinceReplyS: null,
            };
            await answerTranscript(cannedTranscript, 0, Date.now(), typedVerdict);
            send("done", {});
            clearTimeout(timeout);
            closeStream();
            return;
          }
          cannedTranscript = canonicalizeWakeWord(cannedTranscript);
          // Sliding gate first: background chatter never reaches the model,
          // the board or the memory.
          const sessionOpen = getOpenSession(getDb()) !== null;
          const verdict = checkWake(cannedTranscript, clientKey, Date.now(), sessionOpen, language);
          if (!verdict.execute) {
            const cannedSlots = getSlots(clientKey);
            logTurn({
              language,
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
              asrMs: null,
              chain: "none",
              key: clientKey,
              slots:
                cannedSlots.client !== undefined ||
                cannedSlots.service !== undefined
                  ? cannedSlots
                  : null,
              gate: verdict.gate,
              sinceReplyS: verdict.sinceReplyS,
              totalMs: 0,
            });
            send("ignored", {});
            send("done", {});
            clearTimeout(timeout);
            closeStream();
            return;
          }
          await answerTranscript(cannedTranscript, 0, Date.now(), verdict);
          send("done", {});
          clearTimeout(timeout);
          closeStream();
          return;
        }

        // Replay audio (npm run demo): drain the utterance — the VAD already
        // showed listening — then answer the next recorded turn by index.
        // Overruns past the run stay silent; nothing here reaches the model.
        if (process.env.VALE_REPLAY === "1" && !jsonTurn) {
          const drain = (request.body as ReadableStream<Uint8Array>).getReader();
          try {
            for (;;) {
              const part = await drain.read();
              if (part.done) break;
            }
          } finally {
            drain.releaseLock();
          }
          await answerRecordedTurn("", true);
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
              asrStartMs = Date.now();
              try {
                asr = await openAsrConnection({
                  key: modelKey,
                  url: process.env.META_ASR_URL || undefined,
                  language,
                  onEvent: (event) => {
                    if (event.kind === "interim") {
                      lastInterim = event.transcript;
                      send("interim", { transcript: event.transcript });
                    } else if (event.kind === "final") {
                      gotFinal = true;
                      finalAtMs = Date.now();
                      finalText = event.transcript;
                      vlog({
                        turn: turnTag ?? "-",
                        process: "ASR",
                        model: ASR_MODEL,
                        durationMs:
                          asrStartMs > 0 ? finalAtMs - asrStartMs : null,
                        status: "ok",
                        content: finalText,
                      });
                      // Canonical wake word past here; the ASR row keeps raw.
                      finalText = canonicalizeWakeWord(finalText);
                      audioSeconds = (event.audioProcessedMs ?? 0) / 1000;
                      send("final", {
                        transcript: finalText,
                        audioProcessedMs: event.audioProcessedMs ?? null,
                      });
                    }
                  },
                  onError: (message) => {
                    if (!settled) {
                      settled = true;
                      clearTimeout(timeout);
                      // Plain text to the user; raw provider text stays in the server log only.
                      vlog({
                        turn: turnTag ?? "-",
                        process: "ASR",
                        model: ASR_MODEL,
                        status: "error",
                        detail: { code: "E-ASR" },
                        content: message,
                      });
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
            audioChunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }

        if (!opened) {
          // No audio arrived: log the empty turn, stay silent, no banner.
          logTurn({
            language,
            ts: new Date().toISOString(),
            transcript: "",
            ttftMs: null,
            inputTokens: 0,
            outputTokens: 0,
            audioSeconds: 0,
            tool: null,
            modelSkipped: true,
            error: null,
            ignored: false,
            asrMs: null,
            chain: "none",
            key: clientKey,
            slots: null,
            gate: null,
            sinceReplyS: null,
            totalMs: 0,
          });
          settled = true;
          send("done", {});
          clearTimeout(timeout);
          closeStream();
          return;
        }
        asr?.endTurn();
        await waitFor(() => gotFinal || settled, TURN_TIMEOUT_MS);
        if (!gotFinal) {
          if (!settled) finishError(turnErrorText("lost", language), "E-NET");
          return;
        }
        if (finalText.trim() === "") {
          // Empty final: no model call, no banner; the log keeps the evidence.
          logTurn({
            language,
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
            asrMs: asrStartMs > 0 ? finalAtMs - asrStartMs : null,
            chain: "none",
            key: clientKey,
            slots: null,
            gate: null,
            sinceReplyS: null,
            totalMs: 0,
          });
          settled = true;
          send("done", {});
          clearTimeout(timeout);
          closeStream();
          return;
        }
        const sessionOpen = getOpenSession(getDb()) !== null;
        const verdict = checkWake(finalText, clientKey, Date.now(), sessionOpen, language);
        if (!verdict.execute) {
          // Background chatter without the name: silent discard.
          const ignoredSlots = getSlots(clientKey);
          logTurn({
            language,
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
            asrMs: asrStartMs > 0 ? finalAtMs - asrStartMs : null,
            chain: "none",
            key: clientKey,
            slots:
              ignoredSlots.client !== undefined ||
              ignoredSlots.service !== undefined
                ? ignoredSlots
                : null,
            gate: verdict.gate,
            sinceReplyS: verdict.sinceReplyS,
            totalMs: Date.now() - finalAtMs,
          });
          send("ignored", {});
        } else {
          await answerTranscript(finalText, audioSeconds, finalAtMs, verdict);
        }
        settled = true;
        send("done", {});
        clearTimeout(timeout);
        closeStream();
      } catch (error) {
        // The client only sees E-NET; the cause stays in the server log.
        vlog({
          turn: turnTag ?? "-",
          process: "ERROR",
          status: "error",
          detail: { code: "E-NET" },
          content:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        });
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
