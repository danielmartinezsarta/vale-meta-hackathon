// Server-side only: builds the minimal screen snapshot. Never import from client code.
import { getPublicNotes, type PublicNote, type ValeDb } from "./db";
import { getOpenSession } from "./vale-tools";

export interface BoardSession {
  clientName: string;
  serviceName: string;
  startedAt: string;
}

export interface BoardCard {
  name: string;
  notes: PublicNote[];
}

export interface Board {
  session: BoardSession | null;
  card: BoardCard | null;
  list: string[];
}

function nameOf(db: ValeDb, table: string, id: number): string {
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as { name: string };
  return row.name;
}

/** Session in progress, card (masked) and shopping list for the screen. */
export function getBoard(db: ValeDb): Board {
  const open = getOpenSession(db);
  const session: BoardSession | null = open
    ? {
        clientName: nameOf(db, "clients", open.client_id),
        serviceName: nameOf(db, "services", open.service_id),
        startedAt: open.started_at,
      }
    : null;
  const cardClientId =
    open?.client_id ??
    (db.prepare("SELECT client_id FROM notes ORDER BY id DESC LIMIT 1").get() as
      | { client_id: number }
      | undefined)?.client_id ??
    null;
  const card: BoardCard | null =
    cardClientId === null
      ? null
      : {
          name: nameOf(db, "clients", cardClientId),
          notes: getPublicNotes(db, cardClientId),
        };
  const list = (
    db.prepare("SELECT s.name FROM shopping_list l JOIN supplies s ON s.id = l.supply_id ORDER BY l.id").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  return { session, card, list };
}
