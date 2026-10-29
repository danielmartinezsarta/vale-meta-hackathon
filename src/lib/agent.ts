import { VALE_TOOLS, getOpenSession, runValeTool } from "./vale-tools";
import { getDb, type ValeDb } from "./db";

export const AGENT_MODEL = "muse-spark-1.3";
export const RESPONSES_URL = "https://api.meta.ai/v1/responses";

/** Said once per session when a health note is saved. Appended server-side. */
export const PRIVACY_LINE =
  "Las notas de salud las procesa un modelo abierto en infraestructura dedicada y nunca van a la API general.";

// Spoken-style prompt: plain text, 1-2 short sentences, confirm before writing.
export const SPOKEN_SYSTEM_PROMPT = [
  "You are Vale, a hands-free voice helper for nail technicians.",
  "The user hears your reply read aloud, so reply in the user's language (default Spanish) in exactly one or two short spoken sentences.",
  "Use plain text only. No markdown. No bold or italics. No lists. No links. No URLs. No emoji.",
  "You have tools for sessions, client cards, notes, the shopping list and supplies. Use them to act.",
  "Never invent names, prices or addresses, and never claim a write happened without calling its tool.",
  "Reads (find_client, read_shopping_list) run at once.",
  "Act right away when the request is direct and complete: if the user names a client and a service, call open_session right away; if they dictate a note or name an item, call that write right away. Say it is done only after the tool succeeds.",
  "Only ask first when in doubt: unknown or ambiguous names, unknown supplies. Then say what you would do in one sentence and ask ¿lo guardo?, and wait for the user to say yes before calling.",
  "When the user says deshazlo, call undo_last_write at once.",
  "When the tool asks whether to create a supply, ask the user and call log_supply_use again with confirm_create true only after a yes.",
  "Health topics (allergies, onicolisis and similar) always use add_note with kind health; confirm with Nota privada guardada. and never repeat the health text.",
].join(" ");

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentResult {
  text: string;
  usage: AgentUsage;
  toolUsed: string | null;
  firstTokenMs: number | null;
  /** Last completed response id: chain it as previous_response_id next turn. */
  responseId: string;
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
    throw new Error(`model error: ${response.status}`);
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
            throw new Error(
              `model error: ${typeof data.error === "string" ? data.error : "failed"}`,
            );
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
  previousResponseId?: string;
  url?: string;
  onDelta?: (text: string) => void;
  startedAt?: number;
  /** Defaults to the shared database; tests inject an in-memory one. */
  db?: ValeDb;
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
  const instructions = SPOKEN_SYSTEM_PROMPT;

  let previousResponseId = options.previousResponseId;
  let input: unknown = options.transcript;
  let text = "";
  let responseId = "";
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
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
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
    previousResponseId = turn.id;
    responseId = turn.id;
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
    const toolResult = runValeTool(db, call.name, parsed);
    if (call.name === "add_note" && (toolResult.data as { private?: boolean } | undefined)?.private === true) {
      healthSaved = true;
    }
    input = [
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
    text = text === "" ? PRIVACY_LINE : `${text} ${PRIVACY_LINE}`;
  }

  return { text, usage, toolUsed, firstTokenMs, responseId };
}
