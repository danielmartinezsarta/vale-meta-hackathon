import type { ValeLanguage } from "./vale-language";

/**
 * Screen card derived from a tool call, never from reply text. The voice
 * says one short line pointing at it; amounts and details stay on screen.
 * Plain text only: visual design lands in a later ticket.
 */

export type WidgetKind =
  | "meta"
  | "agenda"
  | "note"
  | "appointment"
  | "breakdown"
  | "confirm";

export interface Widget {
  kind: WidgetKind;
  title: string;
  lines: string[];
}

function moneyUsd(value: unknown): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `${n.toFixed(2)} USD`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dataOf(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

/**
 * Build the screen card for a successful tool call. Returns null for tools
 * with nothing to show. Pure formatting of tool arguments and data.
 */
export function buildWidget(
  tool: string,
  args: Record<string, unknown>,
  data: unknown,
  language: ValeLanguage = "en",
): Widget | null {
  const en = language !== "es";
  const info = dataOf(data);
  switch (tool) {
    case "goal_progress": {
      const earned =
        typeof info.earned_usd === "number" ? info.earned_usd : null;
      const goal = typeof info.goal_usd === "number" ? info.goal_usd : null;
      if (earned === null || goal === null) return null;
      const pct = Math.round((earned / goal) * 100);
      return {
        kind: "meta",
        title: en ? "Month goal" : "Meta del mes",
        lines: [
          en
            ? `${moneyUsd(earned)} of ${moneyUsd(goal)} (${pct}%)`
            : `${moneyUsd(earned)} de ${moneyUsd(goal)} (${pct}%)`,
        ],
      };
    }
    case "list_today":
    case "next_appointment": {
      const rows = Array.isArray(info.appointments)
        ? info.appointments
        : info.appointment !== null &&
            typeof info.appointment === "object" &&
            !Array.isArray(info.appointment)
          ? [info.appointment]
          : [];
      const lines = (rows as Record<string, unknown>[]).map((row) => {
        const when = text(row.time) || text(row.day);
        const what = text(row.client) || text(row.service);
        return when !== "" && what !== "" ? `${when} — ${what}` : what || when;
      });
      return {
        kind: "agenda",
        title: tool === "list_today" ? (en ? "Today" : "Hoy") : en ? "Next" : "Sigue",
        lines:
          lines.length > 0
            ? lines
            : [en ? "Nothing on the books." : "No tienes nada."],
      };
    }
    case "add_note": {
      if (info.private === true) {
        return {
          kind: "note",
          title: en ? "Private note saved." : "Nota privada guardada.",
          lines: [],
        };
      }
      const client = text(args.client_name);
      return {
        kind: "note",
        title:
          client !== ""
            ? en
              ? `Note on ${client}'s card`
              : `Nota en la ficha de ${client}`
            : en
              ? "Note saved"
              : "Nota guardada",
        lines: [],
      };
    }
    case "create_appointment":
    case "move_appointment": {
      const client = text(args.client_name);
      const day = text(args.day);
      const time = text(args.time);
      const line =
        client !== "" && day !== "" && time !== ""
          ? `${client} ${day} ${time}`
          : [client, day, time].filter((part) => part !== "").join(" ");
      if (line === "") return null;
      return {
        kind: "appointment",
        title: en ? "Appointment" : "Cita",
        lines: [line],
      };
    }
    case "quote_price": {
      const service = text(info.service) || text(args.service_name);
      if (service === "") return null;
      return {
        kind: "breakdown",
        title: service,
        lines: [
          en
            ? `Supplies ${moneyUsd(info.supplies_cost)}`
            : `Insumos ${moneyUsd(info.supplies_cost)}`,
          en
            ? `Time ${moneyUsd(info.time_cost)}`
            : `Tiempo ${moneyUsd(info.time_cost)}`,
          en
            ? `Fixed ${moneyUsd(info.fixed_share)}`
            : `Fijos ${moneyUsd(info.fixed_share)}`,
          en
            ? `Total ${moneyUsd(info.final_price_usd)}`
            : `Total ${moneyUsd(info.final_price_usd)}`,
        ],
      };
    }
    default:
      return null;
  }
}
