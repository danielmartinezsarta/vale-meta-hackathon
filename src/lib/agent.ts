import { TOY_TOOL, runToyTool } from "./tools";

export const AGENT_MODEL = "muse-spark-1.3";
export const RESPONSES_URL = "https://api.meta.ai/v1/responses";

/**
 * Hardened spoken-style system prompt: plain text only, 1-2 short sentences,
 * no invented capabilities. The no-markdown rule is enforced by wording and
 * verified by the style test (5 canned prompts, no lists/URLs/emoji).
 */
export const SPOKEN_SYSTEM_PROMPT = [
  "You are Vale, a hands-free voice helper for nail technicians.",
  "The user hears your reply read aloud, so reply in exactly one or two short spoken sentences.",
  "Use plain text only. No markdown. No bold or italics. No lists. No links. No URLs. No emoji.",
  "You can check invented demo booking slots with the get_invented_slots tool when asked about availability.",
  "Anything else you cannot do yet. Say so in one short sentence and offer what you can do.",
  "Never invent prices, names, or addresses. Use only the tool result, or say you do not have it.",
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
}

interface ResponsesOutputItem {
  type?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  text?: string;
}

function extractDeltaText(eventType: string, data: Record<string, unknown>): string {
  if (!eventType.includes("delta")) return "";
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
          onDelta(text);
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

export interface AgentTurnOptions {
  key: string;
  transcript: string;
  previousResponseId?: string;
  url?: string;
  onDelta?: (text: string) => void;
  startedAt?: number;
}

/**
 * One agent turn: transcript -> (tool call?) -> spoken-style reply text.
 * Key stays server-side; the caller streams deltas to the user.
 */
export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentResult> {
  const url = options.url ?? RESPONSES_URL;
  const startedAt = options.startedAt ?? Date.now();
  const onDelta = options.onDelta ?? (() => {});
  const instructions = SPOKEN_SYSTEM_PROMPT;

  const first = await postResponses(
    options.key,
    url,
    {
      instructions,
      input: options.transcript,
      tools: [TOY_TOOL],
      // Cheapest reasoning mode: latency budget depends on it (probe B).
      reasoning: { effort: "minimal" },
      ...(options.previousResponseId
        ? { previous_response_id: options.previousResponseId }
        : {}),
      stream: true,
    },
    onDelta,
    startedAt,
  );

  if (first.calls.length === 0) {
    return {
      text: first.text,
      usage: first.usage,
      toolUsed: null,
      firstTokenMs: first.firstTokenMs,
    };
  }

  const call = first.calls[0];
  const toolResult = runToyTool(call.name, JSON.parse(call.args || "{}"));
  const second = await postResponses(
    options.key,
    url,
    {
      instructions,
      previous_response_id: first.id,
      input: [
        {
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify(toolResult),
        },
      ],
      tools: [TOY_TOOL],
      reasoning: { effort: "minimal" },
      stream: true,
    },
    onDelta,
    startedAt,
  );

  return {
    text: second.text,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
    },
    toolUsed: call.name,
    firstTokenMs: first.firstTokenMs ?? second.firstTokenMs,
  };
}
