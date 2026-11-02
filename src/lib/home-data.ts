// Server-side only: home screen snapshot. Never import from client code.
import { userName, type ValeDb } from "./db";
import { goalProgress, listToday, readStock } from "./vale-tools";

export interface HomeAppointment {
  time: string;
  client: string;
  service: string;
}

export interface HomeGoal {
  earned: number;
  goal: number;
  pct: number;
  month: string;
}

export interface HomeSupply {
  name: string;
  qty: number;
}

export interface HomeData {
  userName: string;
  today: HomeAppointment[];
  goal: HomeGoal | null;
  supplies: HomeSupply[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dataOf(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

/** Today, month goal, low supplies and the user name for the home screen. */
export function getHomeData(db: ValeDb): HomeData {
  const appointments = dataOf(listToday(db).data).appointments;
  const today: HomeAppointment[] = Array.isArray(appointments)
    ? (appointments as Record<string, unknown>[]).flatMap((row) => {
        const time = text(row.time);
        const client = text(row.client);
        const service = text(row.service);
        return time !== "" && client !== "" ? [{ time, client, service }] : [];
      })
    : [];

  const goalData = dataOf(goalProgress(db).data);
  const earned = num(goalData.earned_usd);
  const goal = num(goalData.goal_usd);
  const month = text(goalData.month);

  const low = dataOf(readStock(db).data).low;
  const supplies: HomeSupply[] = Array.isArray(low)
    ? (low as Record<string, unknown>[]).flatMap((row) => {
        const name = text(row.name);
        const qty = num(row.stock_qty);
        return name !== "" && qty !== null ? [{ name, qty }] : [];
      })
    : [];

  return {
    userName: userName(db),
    today,
    goal:
      earned !== null && goal !== null && goal > 0
        ? { earned, goal, pct: Math.round((earned / goal) * 100), month }
        : null,
    supplies,
  };
}
