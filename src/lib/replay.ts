// Committed demo replay: the recorded run the app plays back
// with VALE_REPLAY=1. Client-safe: no node imports, so the player and the
// recording script share this module. Only text and payloads are kept;
// user audio never lands here (the unified log carries WAV paths, and the
// transform below never reads them).
import type { Board } from "./board";
import type { ValeLanguage } from "./vale-language";
import type { Widget } from "./widget";

/** One recorded turn: everything the screen showed, no audio. */
export interface ReplayTurn {
  turn: string;
  transcript: string;
  language: ValeLanguage;
  tool: string | null;
  toolArgs: unknown;
  reply: string;
  widget: Widget | null;
  board: Board | null;
  costUsd: number;
}

export interface ReplayRun {
  version: 1;
  recordedAt: string;
  turns: ReplayTurn[];
}

/** Secret scrub for recorded strings (mirror of turn-log scrubSecrets). */
function scrubRecorded(text: string): string {
  return text
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /"(api_?key|token|secret)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"',
    );
}

interface LogRow {
  turn?: unknown;
  process?: unknown;
  status?: unknown;
  content?: unknown;
  detail?: unknown;
  [key: string]: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? scrubRecorded(value) : "";
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Fold unified-log JSONL rows into the committed run. Rows group by turn
 * tag; a turn keeps the transcript (VOICE turnFields), the tool call plus
 * args (TOOL), the reply (AGENT), and the last board and widget the screen
 * showed. Audio, stats and secret-looking strings never make it in.
 */
export function buildReplayRun(lines: string[]): ReplayRun {
  const turns = new Map<string, ReplayTurn>();
  const take = (tag: string): ReplayTurn => {
    const existing = turns.get(tag);
    if (existing) return existing;
    const fresh: ReplayTurn = {
      turn: tag,
      transcript: "",
      language: "en",
      tool: null,
      toolArgs: null,
      reply: "",
      widget: null,
      board: null,
      costUsd: 0,
    };
    turns.set(tag, fresh);
    return fresh;
  };
  for (const line of lines) {
    let row: LogRow;
    try {
      row = JSON.parse(line) as LogRow;
    } catch {
      continue;
    }
    const tag = typeof row.turn === "string" ? row.turn : "";
    if (tag === "" || tag === "-") continue;
    const current = take(tag);
    // The photo preview logs no TOOL row: its IMAGE and SAM rows carry
    // the tool name (and the args on the IMAGE row), so replay reads the
    // tool off those too. SAM upload rows carry no tool and stay out.
    if (row.process === "TOOL" || ((row.process === "IMAGE" || row.process === "SAM") && typeof recordOf(row.detail).tool === "string")) {
      // The recording spreads tool args at the top level of the row.
      const detail = recordOf(row.detail);
      if (typeof detail.tool === "string") current.tool = detail.tool;
      const args = recordOf(row.args);
      if (Object.keys(args).length > 0) current.toolArgs = args;
    }
    if (row.process === "AGENT" && row.status === "ok") {
      const reply = text(row.content);
      if (reply !== "") current.reply = reply;
    }
    // Screen snapshots ride top-level on their rows: the recording
    // spreads the extra payloads (turnFields, args, widget, board).
    const fields = recordOf(row.turnFields);
    if (Object.keys(fields).length > 0) {
      if (fields.language === "es" || fields.language === "en") {
        current.language = fields.language;
      }
      const transcript = text(fields.transcript);
      if (transcript !== "") current.transcript = transcript;
      if (typeof fields.tool === "string") current.tool = fields.tool;
      if (typeof fields.costUsd === "number" && Number.isFinite(fields.costUsd)) {
        current.costUsd = fields.costUsd;
      }
    }
    const widget = row.widget;
    if (widget !== null && widget !== undefined && typeof widget === "object") {
      current.widget = widget as Widget;
    }
    const board = row.board;
    if (board !== null && board !== undefined && typeof board === "object") {
      current.board = board as Board;
    }
  }
  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    turns: [...turns.values()].filter((turn) => turn.transcript !== ""),
  };
}

/** Parse and validate the committed run file; throws on anything else. */
export function parseReplayRun(json: string): ReplayRun {
  const parsed = JSON.parse(json) as Partial<ReplayRun>;
  if (parsed.version !== 1 || !Array.isArray(parsed.turns)) {
    throw new Error("[replay] not a recorded demo run");
  }
  for (const turn of parsed.turns) {
    if (typeof turn.turn !== "string" || typeof turn.transcript !== "string") {
      throw new Error("[replay] turn without transcript");
    }
  }
  return parsed as ReplayRun;
}
