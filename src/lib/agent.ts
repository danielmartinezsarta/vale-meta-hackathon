import {
  VALE_TOOLS,
  clientLabel,
  getOpenSession,
  runValeToolAsync,
} from "./vale-tools";
import { bogotaDay } from "./natural-date";
import { DEFAULT_USER_NAME, getDb, userName, type HistoryTurn, type ValeDb } from "./db";
import { DEFAULT_LANGUAGE, clarifyText, type ValeLanguage } from "./vale-language";
import {
  buildPendingActions,
  clearPendingAction,
  isConfirmYes,
  peekPendingAction,
  pendingConfirmTitle,
  setPendingAction,
} from "./pending-action";
import { buildWidget, type Widget } from "./widget";
import {
  slotContext,
  updateSlotsFromTool,
} from "./slot-memory";
import { scrubSecrets, vlog } from "./turn-log";

export const AGENT_MODEL = "muse-spark-1.3";
export const RESPONSES_URL = "https://api.meta.ai/v1/responses";

// Single prompt in English for both languages: acting rules, persona and
// standing rules with no words the user ever hears. Only the output line
// changes: it pins the reply language. There is no auto-detection; the
// screen selector owns the language end to end.
const SPOKEN_BASE = [
  "You are Vale, a hands-free voice helper for nail technicians.",
  "Use plain text only. No markdown. No bold or italics. No lists. No links. No URLs. No emoji.",
  "You are warm and direct, like a trusted colleague at the salon: brief, kind, never robotic.",
  "You are the colleague who knows the business: warm, kind and upbeat, but professional - a coworker, not a friend.",
  "Never use terms of endearment, in any reply: love, darling, honey, dear, sweetie, babe, hun.",
  "Keep every reply to about 25 words at most: direct, no filler, and never end with a question unless you are asking for confirmation or for missing information.",
  "You can: open sessions with a timer, save notes on the client card (health notes stay private), keep the shopping list, register clients and supplies, quote prices and keep the agenda. Use them to act.",
  "Never invent names, prices or addresses, and never claim a write happened without calling its tool. Say it is done only after the tool succeeds.",
  "Some tools show a screen card: goal_show, agenda_show, client_card_show, client_note_add, agenda_create_appointment, session_quote, session_close and widget_show. When a screen card shows, say one short line pointing at it (for example Here's your goal on screen.) and never read its numbers aloud. Money, health notes and the goal stay on the screen only: the voice only says the card is on screen.",
  "Reads (agenda_show, client_card_show, goal_show, widget_show, tool_get_details) run at once.",
  "Book directly and save notes, sessions, supplies and shopping at once: the booking saves even off hours, and undo_last fixes a wrong write. Only the quote and what moves or deletes ask first: a yes registers the payment, moves the booking or cancels it.",
  "A client alone opens their session: Start a session with David calls session_open with the client, and today's appointment names the service. Resolve natural dates (next Friday at 5 PM) with the agenda tools on the America/Bogota calendar; never invent one, and when the user corrects only the date, keep the original time.",
  "Only ask first when in doubt: unknown or ambiguous names, unknown supplies. Then say what you would do in one sentence and ask the confirmation question (Should I save it?), and wait for the user to say yes before calling.",
  "Greet briefly and varied when there is no request, without asking for data. When the client or service is missing, ask briefly and naturally, naming what you already have.",
  "If the request is outside nails (hair, makeup), say so plainly and steer back to nails.",
  "Notes save at once, health notes stay private: confirm briefly and never repeat the health text.",
  "Health is screen-only: never say allergy, alert, health or private in any reply; the card voice line only points at the screen.",
  "If a date does not exist (November 31st), propose the nearest valid day at the same time, say the correction plainly, and ask for confirmation before writing.",
  "A yes only executes the proposal from your immediately previous reply; if that reply asked an open question with no concrete proposal, ask what to confirm instead of writing.",
  "A refused write is never a license to do the opposite: if a session is already open, call session_open anyway - its refusal tells you what to ask, and the yes runs the switch.",
].join(" ");

/** Output line: the only part of the prompt that changes per language. */
function outputLine(language: ValeLanguage): string {
  return language === "es"
    ? "The user hears your reply read aloud in Spanish, so reply only in Spanish in exactly one or two short spoken sentences. Nunca respondas en otro idioma aunque la transcripción venga en otro."
    : "The user hears your reply read aloud, so reply only in English in exactly one or two short spoken sentences.";
}

/**
 * Full instructions for one language; the base stays English and only the
 * output line switches. The current date grounds relative days ("today")
 * for the agenda tools.
 */
export function buildInstructions(
  language: ValeLanguage = DEFAULT_LANGUAGE,
): string {
  return `${SPOKEN_BASE} ${outputLine(language)}`;
}

/**
 * Volatile session facts, appended AFTER the stable base so Meta's prefix
 * cache holds on the base. Date, name, slots, session: everything the turn
 * changes rides here, never before the stable content. Exported for tests.
 */
export function buildStateFacts(
  today: string,
  name: string,
  slotLine: string,
  sessionLine: string,
): string {
  return [
    `Today is ${today}.`,
    `The user's name is ${name}: say it occasionally, never every turn, and never as an endearment.`,
    "Use that date as today and resolve relative days from it.",
    slotLine,
    sessionLine,
  ]
    .filter((line) => line !== "")
    .join(" ");
}

// Spoken-style prompt: plain text, 1-2 short sentences, confirm before writing.
export const SPOKEN_SYSTEM_PROMPT = buildInstructions("es");

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prefix-cache hits inside input_tokens, for the per-commit measure. */
  cachedInputTokens: number;
}

export interface AgentResult {
  text: string;
  usage: AgentUsage;
  toolUsed: string | null;
  firstTokenMs: number | null;
  /** Screen card derived from the tool call, never from reply text. */
  widget: Widget | null;
}

/** Bogotá clock for the session facts; the salon runs on America/Bogota. */
function bogotaParts(when: Date): { day: string; time: string; weekday: string } {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(when);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    weekday: "long",
  }).format(when);
  return { day, time, weekday };
}

/**
 * Durable session facts for the prompt: context, not a filter. The model
 * still decides per turn; these facts only ground names, dates and the
 * open service. Exported for tests.
 */
export function sessionContext(db: ValeDb, now = new Date()): string {
  const { day, time, weekday } = bogotaParts(now);
  const head =
    `Session context (facts, not filters): today is ${weekday} ${day}, ` +
    `${time} America/Bogota.`;
  const open = getOpenSession(db);
  if (!open) {
    return (
      `${head} No session is open: a booking needs a client name, ` +
      `never invent one.`
    );
  }
  const service = db
    .prepare("SELECT name FROM services WHERE id = ?")
    .get(open.service_id) as { name: string } | undefined;
  const started = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(open.started_at));
  return (
    `${head} Open session: client ${clientLabel(db, open.client_id)}, ` +
    `service ${service?.name ?? "unknown"}, started ${started}. ` +
    `A booking with no client name belongs to the session client; a booking ` +
    `naming another client belongs to that client and leaves the session ` +
    `untouched. Shopping and stock questions never use the session. When you ` +
    `fill a missing date or time from today or the session, say so in the ` +
    `confirmation question.`
  );
}

/** One history turn as a Responses input message. */
/**
 * Tool call to UI contract keys. The contract owns widget.ts: this maps
 * each 018 tool to the dispatch key, args and data it renders. Tools
 * without a sheet map to null; the agenda speaks and bubbles only.
 */
export function contractWidgetFor(
  tool: string,
  args: Record<string, unknown>,
  data: unknown,
): { tool: string; args: Record<string, unknown>; data: unknown } | null {
  const info = (data ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "goal_show":
      return { tool: "goal_progress", args: {}, data };
    case "client_card_show": {
      const card = (info.card ?? {}) as { id?: unknown; name?: unknown; notes?: unknown };
      const notes = Array.isArray(card.notes) ? card.notes : [];
      return {
        tool: "find_client",
        args: { client_name: typeof card.name === "string" ? card.name : "" },
        data: {
          id: card.id,
          name: card.name,
          notes: notes.map((note) => {
            const entry = (note ?? {}) as { kind?: unknown; text?: unknown };
            return { kind: entry.kind === "health_note" ? "health" : "general", text: entry.text };
          }),
        },
      };
    }
    case "client_note_add":
      return {
        tool: "add_note",
        args: { ...args, kind: args.kind === "health_note" ? "health" : "general" },
        data: null,
      };
    case "session_quote":
      return { tool: "quote_price", args: {}, data };
    case "photo_preview_design":
      return { tool: "photo_preview", args: {}, data };
    case "agenda_create_appointment":
      if (typeof info.appointment_id !== "number") return null;
      return {
        tool: "create_appointment",
        args: { client_name: info.client, service_name: info.service, day: info.day, time: info.time },
        data: null,
      };
    case "agenda_move_appointment":
      if (typeof info.appointment_id !== "number") return null;
      return {
        tool: "move_appointment",
        args: { client_name: info.client, service_name: info.service, day: info.day, time: info.time },
        data: null,
      };
    case "session_close":
      return { tool: "close_session", args: {}, data };
    default:
      return null;
  }
}

function historyItem(turn: HistoryTurn): Record<string, unknown> {
  // The API takes input_text on user messages and output_text on assistant
  // ones (probed 2026-10-31: input_text on assistant is a 400); the role
  // tells them apart either way.
  return turn.role === "user"
    ? {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: turn.text }],
      }
    : {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: turn.text }],
      };
}

/** Tools that complete a write when they report ok. */
const WRITE_TOOLS = new Set([
  "session_open",
  "session_close",
  "session_log_supply",
  "session_quote_accept",
  "photo_preview_design",
  "client_create",
  "client_note_add",
  "shopping_add",
  "shopping_remove",
  "agenda_create_appointment",
  "agenda_move_appointment",
  "agenda_cancel_appointment",
  "agenda_create_reminder",
  "stock_set",
  "stock_add",
  "undo_last",
]);

/**
 * Provider error bodies stay in the server log: they tell a stale chain
 * apart from a malformed request. Secrets never travel in them (the key
 * goes in a header), but Bearer-looking values are scrubbed anyway.
 */
function redactSecrets(text: string): string {
  return scrubSecrets(text).slice(0, 500);
}

interface ResponsesOutputItem {
  type?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  text?: string;
}

function extractDeltaText(eventType: string, data: Record<string, unknown>): string {
  // Only spoken-text deltas reach the screen; tool-argument deltas must never render.
  if (!eventType.includes("delta")) return "";
  if (!eventType.includes("output_text")) return "";
  const delta = data.delta;
  if (typeof delta === "string") return delta;
  if (delta && typeof delta === "object") {
    const text = (delta as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  if (typeof data.text === "string" && eventType.includes("output_text")) {
    return data.text;
  }
  return "";
}

interface MessageContent {
  type?: string;
  text?: string;
}

function outputText(items: ResponsesOutputItem[] | undefined): string {
  if (!items) return "";
  const texts: string[] = [];
  for (const item of items) {
    if (item.type !== "message") continue;
    const content = (item as unknown as { content?: MessageContent[] }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("");
}

function functionCalls(
  items: ResponsesOutputItem[] | undefined,
): { name: string; args: string; callId: string }[] {
  if (!items) return [];
  return items
    .filter((item) => item.type === "function_call" && item.name && item.call_id)
    .map((item) => ({
      name: item.name as string,
      args: item.arguments ?? "{}",
      callId: item.call_id as string,
    }));
}

async function postResponses(
  key: string,
  url: string,
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
  startedAt: number,
  turn?: string,
): Promise<{
  id: string;
  text: string;
  usage: AgentUsage;
  calls: { name: string; args: string; callId: string }[];
  firstTokenMs: number | null;
}> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ model: AGENT_MODEL, ...body }),
  });
  if (!response.ok || !response.body) {
    let detail = "";
    try {
      detail = redactSecrets(await response.text());
    } catch {
      /* empty or unreadable body: the status alone is the signal */
    }
    vlog({
      turn: turn ?? "-",
      process: "AGENT",
      model: AGENT_MODEL,
      status: "error",
      detail: { http: response.status },
      content: detail || "model error",
    });
    throw new Error(`model error: ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  let firstTokenMs: number | null = null;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  interface CompletedResponse {
    id?: string;
    output?: ResponsesOutputItem[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: {
        cached_tokens?: number;
      };
    };
  }
  let completed: CompletedResponse | null = null;
  // Narration of a round that calls a tool must never paint before the
  // tool runs, so deltas buffer here and flush only for tool-free rounds.
  const pendingDeltas: string[] = [];
  const flushDeltas = () => {
    for (const text of pendingDeltas.splice(0)) onDelta(text);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let type = "";
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) {
          boundary = buffer.indexOf("\n\n");
          continue;
        }
        let data: Record<string, unknown> | null = null;
        try {
          data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
        } catch {
          boundary = buffer.indexOf("\n\n");
          continue;
        }
        const text = extractDeltaText(type, data);
        if (text !== "") {
          if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
          pendingDeltas.push(text);
        }
        if (type === "response.completed" || type === "response.failed") {
          completed =
            (data.response as CompletedResponse | null) ??
            (data as unknown as CompletedResponse);
          if (type === "response.failed") {
            const raw =
              typeof data.error === "string"
                ? data.error
                : JSON.stringify(data.error ?? null);
            const detail = redactSecrets(raw);
            vlog({
              turn: turn ?? "-",
              process: "AGENT",
              model: AGENT_MODEL,
              status: "error",
              content: detail || "response failed",
            });
            throw new Error(`model error: ${detail}`);
          }
          if (functionCalls(completed?.output).length === 0) flushDeltas();
          else pendingDeltas.splice(0);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!completed) throw new Error("model error: no completed response");
  return {
    id: (completed.id as string | undefined) ?? "",
    text: outputText(completed.output),
    usage: {
      inputTokens: completed.usage?.input_tokens ?? 0,
      outputTokens: completed.usage?.output_tokens ?? 0,
      cachedInputTokens: completed.usage?.input_tokens_details?.cached_tokens ?? 0,
    },
    calls: functionCalls(completed.output),
    firstTokenMs,
  };
}

/** Max model rounds per turn: enough for ask-then-act chains, never unbounded. */
const MAX_TOOL_ROUNDS = 4;

/**
 * Explicit prefix-cache affinity: without it, sparse live turns (minutes
 * apart) always miss the implicit cache (cached_tokens 0) while bursts hit.
 * One versioned key for the whole helper: the cache still matches by prefix,
 * the key only routes sparse requests to the holder. Bump on prompt-shape
 * changes that obsolete the cached prefix.
 */
export const PROMPT_CACHE_KEY = "vale-spoken-v1";

/**
 * Vale's own still-open question: her last reply asked one without acting.
 * No tool ran, so no proposal was stored and the duplicate guard must not
 * swallow the yes — the yes authorizes what she asked. A question asked
 * through a tool (refusal, ask-first) already stored or deliberately
 * cleared its proposal, so only a tool-less question counts.
 */
function answersOpenQuestion(history: HistoryTurn[]): boolean {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn.role !== "vale") continue;
    return turn.tool == null && turn.text.trim().endsWith("?");
  }
  return false;
}

/**
 * Traffic rule for a yes that answers Vale's own open question: carry out
 * what she proposed with the tools, or clarify if there is nothing to do.
 * Volatile, so it rides with the state facts at the end, never the base.
 */
const YES_TO_OPEN_QUESTION =
  "The user just said yes to your last question, which you asked without acting: " +
  "carry out what you proposed with the tools now, or clarify if there is nothing to carry out.";

export interface AgentTurnOptions {
  key: string;
  transcript: string;
  /** Last conversation turns, oldest first; Vale remembers them, no chains. */
  history?: HistoryTurn[];
  url?: string;
  onDelta?: (text: string) => void;
  startedAt?: number;
  /** Defaults to the shared database; tests inject an in-memory one. */
  db?: ValeDb;
  /** Closed reply language; Spanish unless the screen selector says English. */
  language?: ValeLanguage;
  /** Slot-memory key (client IP on the server); tests use throwaway keys. */
  slotKey?: string;
  /** Overrides the seeded user name in the prompt. */
  userName?: string;
  /** Shared turn id (t042) from the client; "-" off-turn. */
  turn?: string;
}

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentResult> {
  const url = options.url ?? RESPONSES_URL;
  const startedAt = options.startedAt ?? Date.now();
  const onDelta = options.onDelta ?? (() => {});
  const db = options.db ?? getDb();
  const language = options.language ?? DEFAULT_LANGUAGE;
  const slotKey = options.slotKey ?? "local";
  // A yes with nothing stored answers Vale's own still-open question when
  // her last reply asked one without acting: it goes to the model so the
  // question carries an executable proposal. Any other yes clarifies — it
  // can only confirm a proposal, and repeating a write is the E5 bug.
  const openQuestion =
    isConfirmYes(options.transcript) &&
    !peekPendingAction(slotKey) &&
    answersOpenQuestion(options.history ?? []);
  if (isConfirmYes(options.transcript) && !peekPendingAction(slotKey) && !openQuestion) {
    return {
      text: clarifyText(language),
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      toolUsed: null,
      firstTokenMs: null,
      widget: null,
    };
  }
  // Stable base first, volatile facts last: Meta's prefix cache holds the
  // base across turns while the date, name, slots and session ride at the end.
  const instructions = [
    buildInstructions(language),
    ...(openQuestion ? [YES_TO_OPEN_QUESTION] : []),
    buildStateFacts(
      bogotaDay(new Date()),
      options.userName ?? userName(db),
      slotContext(slotKey, language),
      sessionContext(db),
    ),
  ].join(" ");

  // Explicit memory: the last turns travel in the input, oldest first.
  // No response chains, no retries: a failure surfaces as E-MODEL at once.
  // Every item is an object: a bare string is only valid as the whole input.
  let input: unknown = [
    ...(options.history ?? []).map(historyItem),
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: options.transcript }],
    },
  ];
  let text = "";
  let toolUsed: string | null = null;
  let widget: Widget | null = null;
  // A pending proposal dies with the next real turn unless that turn stores
  // a new one: a later yes must never fire a stale proposal (eval C17).
  let storedThisTurn = false;
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let firstTokenMs: number | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const turn = await postResponses(
      options.key,
      url,
      {
        instructions,
        input,
        tools: VALE_TOOLS,
        // Cheapest reasoning mode; the latency budget depends on it.
        reasoning: { effort: "minimal" },
        stream: true,
        // Route sparse turns to the prefix holder (see PROMPT_CACHE_KEY).
        prompt_cache_key: PROMPT_CACHE_KEY,
      },
      onDelta,
      startedAt,
      options.turn,
    );
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    usage.cachedInputTokens += turn.usage.cachedInputTokens;
    firstTokenMs = firstTokenMs ?? turn.firstTokenMs;
    if (turn.calls.length === 0) {
      text = turn.text;
      if (!storedThisTurn) clearPendingAction(slotKey);
      break;
    }
    const call = turn.calls[0];
    toolUsed = toolUsed ?? call.name;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(call.args || "{}") as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const toolAt = Date.now();
    const toolResult = await runValeToolAsync(db, call.name, parsed, language);
    vlog({
      turn: options.turn ?? "-",
      process: "TOOL",
      status: toolResult.ok ? "ok" : "error",
      durationMs: Date.now() - toolAt,
      detail: { tool: call.name },
      content: toolResult.message,
      extra: { args: parsed },
    });
    if (!toolResult.ok) {
      // A complete proposal waits for the yes; anything else retires
      // a stale one instead of confirming the wrong thing.
      const proposal = buildPendingActions(db, call.name, parsed, toolResult);
      if (proposal) {
        setPendingAction(slotKey, proposal);
        storedThisTurn = true;
        widget = {
          kind: "confirm",
          title: pendingConfirmTitle(proposal, language),
          size: "half",
          data: {},
        };
      } else clearPendingAction(slotKey);
    } else {
      // The screen card mirrors the tool call, never the reply text. Tool
      // names map to the UI contract keys; tools without a sheet map null.
      const mapped = contractWidgetFor(
        call.name,
        parsed,
        (toolResult as { data?: unknown }).data ?? null,
      );
      if (mapped) {
        const card = buildWidget(mapped.tool, mapped.args, mapped.data, db);
        if (card) widget = card;
      }
      // A quoted total waits for Accept: the yes registers it, like any
      // other proposal. Stored on success, never on a doubt.
      const proposal = buildPendingActions(db, call.name, parsed, toolResult);
      if (proposal) {
        setPendingAction(slotKey, proposal);
        storedThisTurn = true;
      }
    }
    updateSlotsFromTool(
      slotKey,
      call.name,
      parsed,
      toolResult.ok,
      (toolResult as { data?: unknown }).data,
    );
    if (toolResult.ok && WRITE_TOOLS.has(call.name)) {
      clearPendingAction(slotKey);
      // A successful write answers itself: no second model round.
      text = toolResult.message;
      break;
    }
    if (toolResult.ok && call.name === "session_quote") {
      // The quote answers itself with no second round: its amounts never
      // reach the voice. A registered amount retires any stale proposal;
      // the fresh quote keeps the Accept one stored above.
      const paid =
        ((toolResult as { data?: unknown }).data as { paid_amount_usd?: unknown } | undefined)?.paid_amount_usd !== undefined;
      if (paid) clearPendingAction(slotKey);
      text = toolResult.message;
      break;
    }
    // Chainless second round: resend the full prefix so the API can
    // resolve the call_id (a lone function_call_output is a 400).
    input = [
      ...(input as unknown[]),
      {
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: call.args,
      },
      {
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify(toolResult),
      },
    ];
    text = toolResult.message;
  }

  return { text, usage, toolUsed, firstTokenMs, widget };
}
