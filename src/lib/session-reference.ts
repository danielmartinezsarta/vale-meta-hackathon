// Server-side only: the appointment reference photo for a session.
// Never import from client code.
import type { ValeDb } from "./db";

/**
 * Servable URL for the session's appointment reference photo, or null.
 * The photo comes from the real appointment row (client plus service),
 * never from a client-side constant. Only seed-assets files map to the
 * /api/photos endpoint and data URLs ride along; anything else stays
 * server-side and the sheet shows an empty slot.
 */
export function referencePhotoForSession(db: ValeDb, sessionId: number): string | null {
  const session = db
    .prepare("SELECT client_id, service_id FROM sessions WHERE id = ?")
    .get(sessionId) as { client_id: number; service_id: number } | undefined;
  if (!session) return null;
  const appointment = db
    .prepare(
      "SELECT reference_photo FROM appointments WHERE client_id = ? AND service_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(session.client_id, session.service_id) as { reference_photo: string | null } | undefined;
  const refValue = appointment?.reference_photo?.trim() ?? "";
  if (refValue === "") return null;
  if (refValue.startsWith("seed-assets/") && !refValue.includes("..")) {
    return `/api/photos?file=${encodeURIComponent(refValue)}`;
  }
  if (/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(refValue)) return refValue;
  return null;
}
