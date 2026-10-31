import { VALE_TOOLS, getOpenSession, localDay, runValeTool } from "./vale-tools";
import { getDb, type HistoryTurn, type ValeDb } from "./db";
import { DEFAULT_LANGUAGE, type ValeLanguage } from "./vale-language";
import {
  buildPendingActions,
  clearPendingAction,
  setPendingAction,
} from "./pending-action";
import {
  slotContext,
  updateSlotsFromTool,
} from "./slot-memory";

export const AGENT_MODEL = "muse-spark-1.3";
export const RESPONSES_URL = "https://api.meta.ai/v1/responses";

/** Said once per session when a health note is saved. Appended server-side. */
export const PRIVACY_LINE =
  "Las notas de salud las procesa un modelo abierto en infraestructura dedicada y nunca van a la API general.";

/** English twin of PRIVACY_LINE for the closed EN setting. */
export const PRIVACY_LINE_EN =
  "Health notes are processed by an open model on dedicated infrastructure and never reach the general API.";

// Language-neutral base: acting rules with no words the user ever hears.
const SPOKEN_BASE = [
  "You are Vale, a hands-free voice helper for nail technicians.",
  "Use plain text only. No markdown. No bold or italics. No lists. No links. No URLs. No emoji.",
  "You have tools for sessions, client cards, notes, the shopping list, supplies, price quotes, the agenda and stock. Use them to act.",
  "Never invent names, prices or addresses, and never claim a write happened without calling its tool. For a price always call quote_price and say every part of its breakdown. For the goal always call goal_progress and say its numbers.",
  "Reads (find_client, read_shopping_list, quote_price, goal_progress, list_today, next_appointment, read_stock) run at once.",
  "Act right away when the request is direct and complete: if the user names a client and a service, call open_session right away; if they dictate a note or name an item, call that write right away. Say it is done only after the tool succeeds.",
  "Only ask first when in doubt: unknown or ambiguous names, unknown supplies. Then say what you would do in one sentence and ask the confirmation question, and wait for the user to say yes before calling.",
  "When the tool asks whether to create a supply, ask the user and call log_supply_use again with confirm_create true only after a yes. When a booking warns about off hours, ask the user and call create_appointment again with confirm_off_hours true only after a yes.",
].join(" ");

// Per-language suffix: warm persona, capabilities, few-shots and the
// standing rules. Closed set: es or en.
const LANGUAGE_SUFFIX: Record<ValeLanguage, string> = {
  es: [
    "The user hears your reply read aloud, so reply in Spanish in exactly one or two short spoken sentences. Nunca respondas en otro idioma aunque la transcripción venga en otro.",
    "Eres Vale, manicurista de voz cálida y directa: habla siempre de tú, nunca de usted.",
    "Hoy puedes: abrir sesiones con cronómetro, guardar notas en la ficha (las de salud van en privado), llevar la lista de insumos, crear clientas e insumos. Precio y agenda aún no; dilo plainly si los piden.",
    "Saluda variado y breve cuando no hay pedido, sin preguntar datos. Si falta clienta o servicio, pregunta natural y breve nombrando lo que sí tienes.",
    "Ejemplos de tono (no guion): clienta «hola» -> «Hola, ¿cómo vas?»; clienta «buenas» -> «Buenas, te escucho.»; clienta «¿qué puedes hacer?» -> «Abro sesiones con cronómetro, guardo notas en tu ficha, llevo tu lista de insumos y registro clientas e insumos. Precio y agenda todavía no.»; clienta «abre sesión con Ana» -> «¿Qué servicio le hago a Ana?»; clienta «sí» con duda pendiente -> ejecuta y confirma «Listo, ya quedó.»",
    "Si piden algo fuera de uñas (pelo, maquillaje), dilo plainly y redirige a uñas: «Eso es de pelo y yo solo atiendo uñas; ¿te abro sesión de esmaltado?»",
    "Ante la duda pregunta con una frase y la cuestión de confirmación es ¿lo guardo?.",
    "When the user says deshazlo, call undo_last_write at once.",
    "Health topics (allergies, onicolisis and similar) always use add_note with kind health; confirm with Nota privada guardada. and never repeat the health text.",
  ].join(" "),
  en: [
    "The user hears your reply read aloud, so reply only in English in exactly one or two short spoken sentences.",
    "You are warm and direct, like a trusted colleague at the salon: brief, kind, never robotic.",
    "Act right away on direct requests; only ask first when in doubt, saying what you would do in one sentence with the confirmation question Should I save it?, and wait for yes before calling.",
    "When the user says undo it, call undo_last_write at once.",
    "Health topics always use add_note with kind health; confirm with Private note saved. and never repeat the health text.",
  ].join(" "),
};

/**
 * Full instructions for one language; Spanish keeps the historic export.
 * The current date grounds relative days ("today") for the agenda tools.
 */
export function buildInstructions(
  language: ValeLanguage = DEFAULT_LANGUAGE,
  today: string = localDay(),
): string {
  return `${SPOKEN_BASE} Today is ${today}. Use that date for hoy and resolve relative days from it. ${LANGUAGE_SUFFIX[language]}`;
}

// Spoken-style prompt: plain text, 1-2 short sentences, confirm before writing.
export const SPOKEN_SYSTEM_PROMPT = buildInstructions("es");

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentResult {
  text: string;
  usage: AgentUsage;
  toolUsed: string | null;
  firstTokenMs: number | null;
}

/** One history turn as a Responses input message. */
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
  "open_session",
  "close_session",
  "add_note",
  "create_client",
  "add_to_shopping_list",
  "log_supply_use",
  "undo_last_write",
  "create_appointment",
  "move_appointment",
  "set_stock",
  "add_stock",
]);

/**
 * Provider error bodies stay in the server log: they tell a stale chain
 * apart from a malformed request. Secrets never travel in them (the key
 * goes in a header), but Bearer-looking values are scrubbed anyway.
 */
function redactSecrets(text: string): string {
  return text
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /"(api_?key|token|secret)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"',
    )
    .slice(0, 500);
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
    console.error(`[agent] model error ${response.status}: ${detail}`);
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
            console.error(`[agent] response failed: ${detail}`);
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
    },
    calls: functionCalls(completed.output),
    firstTokenMs,
  };
}

/** Max model rounds per turn: enough for ask-then-act chains, never unbounded. */
const MAX_TOOL_ROUNDS = 4;

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
}

function privacyNoticeNeeded(db: ValeDb): boolean {
  const open = getOpenSession(db);
  if (!open) return true;
  const row = db.prepare("SELECT privacy_notice_sent FROM sessions WHERE id = ?").get(open.id) as {
    privacy_notice_sent: number;
  };
  return row.privacy_notice_sent !== 1;
}

function markPrivacyNoticeSent(db: ValeDb): void {
  const open = getOpenSession(db);
  if (!open) return;
  db.prepare("UPDATE sessions SET privacy_notice_sent = 1 WHERE id = ?").run(open.id);
}

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentResult> {
  const url = options.url ?? RESPONSES_URL;
  const startedAt = options.startedAt ?? Date.now();
  const onDelta = options.onDelta ?? (() => {});
  const db = options.db ?? getDb();
  const language = options.language ?? DEFAULT_LANGUAGE;
  const slotKey = options.slotKey ?? "local";
  const staticInstructions = buildInstructions(language);
  const slotLine = slotContext(slotKey, language);
  const instructions = slotLine
    ? `${staticInstructions} ${slotLine}`
    : staticInstructions;
  const privacyLine = language === "en" ? PRIVACY_LINE_EN : PRIVACY_LINE;

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
  let healthSaved = false;
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0 };
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
      },
      onDelta,
      startedAt,
    );
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    firstTokenMs = firstTokenMs ?? turn.firstTokenMs;
    if (turn.calls.length === 0) {
      text = turn.text;
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
    const toolResult = runValeTool(db, call.name, parsed, language);
    if (!toolResult.ok) {
      // A complete proposal waits for the yes; anything else retires
      // a stale one instead of confirming the wrong thing.
      const proposal = buildPendingActions(db, call.name, parsed, toolResult);
      if (proposal) setPendingAction(slotKey, proposal);
      else clearPendingAction(slotKey);
    }
    updateSlotsFromTool(
      slotKey,
      call.name,
      parsed,
      toolResult.ok,
      (toolResult as { data?: unknown }).data,
    );
    if (call.name === "add_note" && (toolResult.data as { private?: boolean } | undefined)?.private === true) {
      healthSaved = true;
    }
    if (toolResult.ok && WRITE_TOOLS.has(call.name)) {
      clearPendingAction(slotKey);
      // A successful write answers itself: no second model round.
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

  if (healthSaved && privacyNoticeNeeded(db)) {
    markPrivacyNoticeSent(db);
    text = text === "" ? privacyLine : `${text} ${privacyLine}`;
  }

  return { text, usage, toolUsed, firstTokenMs };
}
