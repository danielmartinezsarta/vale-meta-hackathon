import type { ValeLanguage } from "./vale-language";

/**
 * Slot memory: the client and service in progress, resolved by tools.
 * Keyed like the wake attention window (one nail tech, one phone); the
 * server injects the known slots into every turn so Vale asks only for
 * what is missing and never re-asks what was given.
 */

export interface ValeSlots {
  client?: string;
  service?: string;
}

const slotsByKey = new Map<string, ValeSlots>();

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed === "" ? undefined : trimmed;
}

/** Known slots for this client; empty when nothing is in progress. */
export function getSlots(key: string): ValeSlots {
  return { ...slotsByKey.get(key) };
}

/** Forget everything in progress (a closed session ends the course). */
export function clearSlots(key: string): void {
  slotsByKey.delete(key);
}

function merge(key: string, patch: ValeSlots): void {
  const current = slotsByKey.get(key) ?? {};
  const next: ValeSlots = { ...current };
  if (patch.client !== undefined) next.client = patch.client;
  if (patch.service !== undefined) next.service = patch.service;
  if (next.client === undefined && next.service === undefined) {
    slotsByKey.delete(key);
    return;
  }
  slotsByKey.set(key, next);
}

/**
 * Record what a tool resolved. Only successful runs count: doubt leaves
 * the slots untouched so the next turn still asks for what is missing.
 */
export function updateSlotsFromTool(
  key: string,
  toolName: string,
  args: Record<string, unknown>,
  ok: boolean,
  data?: unknown,
): void {
  if (!ok) return;
  switch (toolName) {
    case "open_session": {
      const client = clean(args.client_name);
      const service = clean(args.service_name);
      if (client !== undefined || service !== undefined) {
        merge(key, { client, service });
      }
      return;
    }
    case "create_client": {
      const client = clean(args.name);
      if (client !== undefined) merge(key, { client });
      return;
    }
    case "find_client": {
      const named =
        clean((data as { name?: unknown } | undefined)?.name) ??
        clean(args.name);
      if (named !== undefined) merge(key, { client: named });
      return;
    }
    case "add_note": {
      const client = clean(args.client_name);
      if (client !== undefined) merge(key, { client });
      return;
    }
    case "close_session":
      clearSlots(key);
      return;
    default:
      return;
  }
}

/** Injected context line; empty when nothing is in progress. */
export function slotContext(key: string, language: ValeLanguage): string {
  const slots = slotsByKey.get(key);
  if (!slots || (slots.client === undefined && slots.service === undefined)) {
    return "";
  }
  const parts: string[] = [];
  if (slots.client !== undefined) {
    parts.push(
      language === "en" ? `client ${slots.client}` : `clienta ${slots.client}`,
    );
  }
  if (slots.service !== undefined) {
    parts.push(
      language === "en"
        ? `service ${slots.service}`
        : `servicio ${slots.service}`,
    );
  }
  return language === "en"
    ? `Ongoing: ${parts.join("; ")}. Don't ask again for what's known.`
    : `En curso: ${parts.join("; ")}. No repreguntes lo dado.`;
}
