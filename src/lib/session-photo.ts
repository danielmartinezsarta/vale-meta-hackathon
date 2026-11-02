// HACK-023 photo slots: pre/post/ref session photos.
// Thin storage wrapper over the HACK-004 core in ./nails (no duplication:
// parsing and model calls stay there and are re-exported here for the
// photo flow). This module never calls a model and knows nothing about
// vale-tools or the widget layer.
// Invented demo data only; no real client data.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ValeDb } from "./db";

// Core stays in ./nails; the slot module is the single photo-flow surface.
export {
  NAIL_CONCEPT,
  NAIL_DESCRIBE_INSTRUCTIONS,
  buildNailDescribePrompt,
  parseNailBoxes,
} from "./nails";

export type PhotoSlot = "pre" | "post" | "ref";

export interface SessionPhotoRef {
  slot: PhotoSlot;
  path: string;
}

export function sessionPhotoPath(
  sessionId: number,
  slot: PhotoSlot,
  baseDir?: string,
): string {
  return join(
    baseDir ?? join(process.cwd(), "data", "session-photos"),
    `${slot}_${sessionId}.jpg`,
  );
}

function isPhotoSlot(slot: string): slot is PhotoSlot {
  return slot === "pre" || slot === "post" || slot === "ref";
}

/**
 * Store one slot photo on disk and point the session at it.
 * Returns the path, or null when the slot or photo is invalid or the
 * photo cannot be stored; the session is kept in every failure case.
 */
export function session_photo_save(
  db: ValeDb,
  sessionId: number,
  slot: PhotoSlot,
  imageDataUrl: string,
  baseDir?: string,
): string | null {
  if (!isPhotoSlot(slot)) return null;
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(imageDataUrl);
  if (!match) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const path = sessionPhotoPath(sessionId, slot, baseDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  } catch {
    return null;
  }
  try {
    db.prepare("UPDATE sessions SET photo_path = ? WHERE id = ?").run(path, sessionId);
  } catch {
    return null;
  }
  return path;
}

/** Latest stored photo path for a session, tagged with the asked slot. */
export function session_photo_show(
  db: ValeDb,
  sessionId: number,
  slot: PhotoSlot,
): SessionPhotoRef | null {
  if (!isPhotoSlot(slot)) return null;
  let row: { photo_path: string | null } | undefined;
  try {
    row = db
      .prepare("SELECT photo_path FROM sessions WHERE id = ?")
      .get(sessionId) as { photo_path: string | null } | undefined;
  } catch {
    return null;
  }
  if (!row?.photo_path) return null;
  return { slot, path: row.photo_path };
}
