import type { ValeDb } from "./db";
import type { ValeLanguage } from "./vale-language";
import { updateSlotsFromTool } from "./slot-memory";
import {
  allClients,
  allServices,
  getOpenSession,
  matchOne,
  runValeTool,
} from "./vale-tools";
import { normalizeWakeText, windowMs } from "./wake";

/**
 * Pending action: when Vale asks "should I do it?", the concrete writes
 * are stored per connection. A later yes executes them directly, with no
 * model in the middle and no questions. Combined (create + open) and
 * simple (one write) proposals share the same path.
 */

export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
}

interface PendingEntry {
  actions: PendingAction[];
  at: number;
}

const pendingByKey = new Map<string, PendingEntry>();

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed === "" ? undefined : trimmed;
}

export function setPendingAction(
  key: string,
  actions: PendingAction[],
  at: number = Date.now(),
): void {
  if (actions.length === 0) return;
  pendingByKey.set(key, { actions, at });
}

/**
 * Confirm title for the screen card, derived from the stored writes, never
 * from reply text. The voice asks its own question; the card shows this.
 */
export function pendingConfirmTitle(
  actions: PendingAction[],
  language: ValeLanguage = "en",
): string {
  const en = language !== "es";
  const find = (tool: string): Record<string, unknown> | null => {
    const action = actions.find((entry) => entry.tool === tool);
    return action ? action.args : null;
  };
  const open = find("session_open");
  if (open) {
    const client = clean(open.client_name);
    const service = clean(open.service_name);
    const closes = actions.some((entry) => entry.tool === "session_close");
    if (client !== undefined && service !== undefined) {
      if (closes) {
        return en
          ? `Close the open session and open ${client} for ${service}?`
          : `¿Cierro la sesión abierta y abro ${client} de ${service}?`;
      }
      return en
        ? `Open session with ${client} for ${service}?`
        : `¿Abro sesión con ${client} de ${service}?`;
    }
    if (client !== undefined) {
      return en ? `Open session with ${client}?` : `¿Abro sesión con ${client}?`;
    }
  }
  const note = find("client_note_add");
  if (note) {
    const client = clean(note.client_name);
    if (client !== undefined) {
      return en ? `Save note for ${client}?` : `¿Guardo nota para ${client}?`;
    }
  }
  const supply = find("session_log_supply");
  if (supply) {
    const name = clean(supply.name);
    if (name !== undefined) {
      return en ? `Log ${name}?` : `¿Registro ${name}?`;
    }
  }
  const accept = find("session_quote_accept");
  if (accept) {
    return en ? "Register the payment?" : "¿Registro el pago?";
  }
  const move = find("agenda_move_appointment");
  if (move) {
    const client = clean(move.client_name);
    if (client !== undefined) {
      return en ? `Move ${client}'s appointment?` : `¿Muevo la cita de ${client}?`;
    }
  }
  const cancel = find("agenda_cancel_appointment");
  if (cancel) {
    return en ? "Cancel the appointment?" : "¿Cancelo la cita?";
  }
  return en ? "Should I save it?" : "¿Lo guardo?";
}

/** Peek without consuming: true while a stored proposal waits for its yes. */
export function peekPendingAction(
  key: string,
  now: number = Date.now(),
): boolean {
  const entry = pendingByKey.get(key);
  if (!entry) return false;
  if (now - entry.at >= windowMs()) {
    pendingByKey.delete(key);
    return false;
  }
  return true;
}

/** Take deletes: a yes consumes its proposal exactly once. */
export function takePendingAction(
  key: string,
  now: number = Date.now(),
): PendingAction[] | undefined {
  const entry = pendingByKey.get(key);
  if (!entry) return undefined;
  pendingByKey.delete(key);
  if (now - entry.at >= windowMs()) return undefined;
  return entry.actions;
}

export function clearPendingAction(key: string): void {
  pendingByKey.delete(key);
}

/**
 * Derive the concrete writes from a doubt turn. Only complete proposals
 * are stored: the yes that follows must run without asking anything else.
 * Anything else clears the slot instead of leaving a stale proposal.
 */
/**
 * The session behind a stored Accept proposal, if any. Touch and voice
 * Reject both consult this: the sheet stays open and waits for the amount.
 */
export function quoteAcceptSessionId(actions: PendingAction[]): number | null {
  const accept = actions.find((entry) => entry.tool === "session_quote_accept");
  if (!accept) return null;
  const sessionId = accept.args.session_id;
  return typeof sessionId === "number" ? sessionId : null;
}

export function buildPendingActions(
  db: ValeDb,
  toolName: string,
  args: Record<string, unknown>,
  toolResult: {
    ok: boolean;
    pendingCreate?: unknown;
    pendingSessionSwitch?: unknown;
    pendingAccept?: unknown;
    pendingMove?: unknown;
    pendingCancel?: unknown;
  },
): PendingAction[] | undefined {
  // A quoted total waits for Accept: the yes registers it, a no waits for
  // the spoken amount. Stored on success, like every other proposal.
  if (toolResult.ok && toolName === "session_quote") {
    const pending = toolResult.pendingAccept as
      | { amount?: unknown; session_id?: unknown }
      | undefined;
    if (typeof pending?.amount === "number" && typeof pending?.session_id === "number") {
      return [
        {
          tool: "session_quote_accept",
          args: { amount: pending.amount, session_id: pending.session_id },
        },
      ];
    }
    return undefined;
  }
  if (!toolResult.ok) {
    // A live session blocks the requested open: a yes closes it first.
    // Unknown clients join the same yes; the open re-validates the service.
    if (toolName === "session_open") {
      const target = toolResult.pendingSessionSwitch as
        | { client_name?: unknown; service_name?: unknown }
        | undefined;
      const client = clean(target?.client_name);
      const service = clean(target?.service_name);
      if (
        client !== undefined &&
        service !== undefined &&
        matchOne(allServices(db), service).kind === "match"
      ) {
        const steps: PendingAction[] = [{ tool: "session_close", args: {} }];
        if (matchOne(allClients(db), client).kind === "none") {
          steps.push({ tool: "client_create", args: { name: client } });
        }
        steps.push({
          tool: "session_open",
          args: { client_name: client, service_name: service },
        });
        return steps;
      }
    }
    if (toolName === "session_log_supply") {
      const name = clean(toolResult.pendingCreate);
      if (name !== undefined && getOpenSession(db) !== null) {
        return [{ tool: "session_log_supply", args: { name, confirm_create: true } }];
      }
      return undefined;
    }
    if (toolName === "agenda_move_appointment") {
      const pending = toolResult.pendingMove as
        | { client_name?: unknown; new_day?: unknown; new_time?: unknown }
        | undefined;
      const client = clean(pending?.client_name);
      const day = clean(pending?.new_day);
      const time = clean(pending?.new_time);
      if (client !== undefined && day !== undefined && time !== undefined) {
        return [
          {
            tool: "agenda_move_appointment",
            args: { client_name: client, new_day: day, new_time: time, confirm_move: true },
          },
        ];
      }
      return undefined;
    }
    if (toolName === "agenda_cancel_appointment") {
      const pending = toolResult.pendingCancel as { appointment_id?: unknown } | undefined;
      if (typeof pending?.appointment_id === "number") {
        return [
          {
            tool: "agenda_cancel_appointment",
            args: { appointment_id: pending.appointment_id, confirm_cancel: true },
          },
        ];
      }
      return undefined;
    }
    if (toolName === "session_open") {
      const client = clean(args.client_name);
      const service = clean(args.service_name);
      if (
        client !== undefined &&
        service !== undefined &&
        matchOne(allClients(db), client).kind === "none" &&
        matchOne(allServices(db), service).kind === "match"
      ) {
        return [
          { tool: "client_create", args: { name: client } },
          {
            tool: "session_open",
            args: { client_name: client, service_name: service },
          },
        ];
      }
      return undefined;
    }
    if (toolName === "client_note_add") {
      const client = clean(args.client_name);
      if (
        client !== undefined &&
        clean(args.text) !== undefined &&
        matchOne(allClients(db), client).kind === "none"
      ) {
        return [
          { tool: "client_create", args: { name: client } },
          {
            tool: "client_note_add",
            args: { client_name: client, text: args.text, kind: args.kind ?? "general" },
          },
        ];
      }
      return undefined;
    }
  }
  return undefined;
}

/** A yes addressed to Vale's proposal: bare or with please/do-it words. */
export function isConfirmYes(transcript: string): boolean {
  const words = normalizeWakeText(transcript)
    .split(" ")
    .filter((word) => word !== "" && word !== "vale");
  if (words.length === 0) return false;
  const rest = words.join(" ");
  return (
    /^(si|sí|yes)$/.test(rest) ||
    /^(si|sí|yes),? por favor$/.test(rest) ||
    /^por favor,? (si|sí|yes)$/.test(rest) ||
    /^(si|sí|yes),? (hazlo|hagalo|dale|registrala|anotalo|save it|do it)$/.test(rest) ||
    /^(hazlo|do it)(,? por favor)?$/.test(rest) ||
    /^(claro|dale|yes please)$/.test(rest) ||
    /^claro que si$/.test(rest)
  );
}

/** A no addressed to Vale's proposal: bare, in either language. */
export function isRefusalNo(transcript: string): boolean {
  const words = normalizeWakeText(transcript)
    .split(" ")
    .filter((word) => word !== "" && word !== "vale");
  if (words.length === 0) return false;
  return /^(no|nope)$/.test(words.join(" "));
}

export interface PendingExecution {
  text: string;
  toolUsed: string | null;
}

/**
 * Run the stored writes in order, stopping at the first failure. Every
 * step updates the slot memory like a model-driven turn would.
 */
export function runPendingActions(
  db: ValeDb,
  slotKey: string,
  actions: PendingAction[],
  language: ValeLanguage = "es",
): PendingExecution {
  const said: string[] = [];
  let toolUsed: string | null = null;
  for (const action of actions) {
    const result = runValeTool(db, action.tool, action.args, language);
    toolUsed = action.tool;
    updateSlotsFromTool(slotKey, action.tool, action.args, result.ok, (result as { data?: unknown }).data);
    said.push(result.message);
    if (!result.ok) break;
  }
  return { text: said.join(" "), toolUsed };
}
