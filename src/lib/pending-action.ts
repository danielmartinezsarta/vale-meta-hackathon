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
export function buildPendingActions(
  db: ValeDb,
  toolName: string,
  args: Record<string, unknown>,
  toolResult: { ok: boolean; pendingCreate?: unknown },
): PendingAction[] | undefined {
  if (!toolResult.ok) {
    if (toolName === "log_supply_use") {
      const name = clean(toolResult.pendingCreate);
      if (name !== undefined && getOpenSession(db) !== null) {
        return [{ tool: "log_supply_use", args: { name, confirm_create: true } }];
      }
      return undefined;
    }
    if (toolName === "open_session") {
      const client = clean(args.client_name);
      const service = clean(args.service_name);
      if (
        client !== undefined &&
        service !== undefined &&
        matchOne(allClients(db), client).kind === "none" &&
        matchOne(allServices(db), service).kind === "match"
      ) {
        return [
          { tool: "create_client", args: { name: client } },
          {
            tool: "open_session",
            args: { client_name: client, service_name: service },
          },
        ];
      }
      return undefined;
    }
    if (toolName === "add_note") {
      const client = clean(args.client_name);
      if (
        client !== undefined &&
        clean(args.text) !== undefined &&
        matchOne(allClients(db), client).kind === "none"
      ) {
        return [
          { tool: "create_client", args: { name: client } },
          {
            tool: "add_note",
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
