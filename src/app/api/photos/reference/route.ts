// Server-side only. Reference photo for the photos sheet, resolved from
// the real appointment row behind the session: no client constant.
import { getDb } from "@/lib/db";
import { referencePhotoForSession } from "@/lib/session-reference";

export const runtime = "nodejs";

function fail(code: string, message: string, status: number): Response {
  return Response.json({ error: message, code }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const sessionId = Number(new URL(request.url).searchParams.get("sessionId"));
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return fail("E-NO-SESSION", "Missing or invalid sessionId.", 400);
  }
  const db = getDb();
  const session = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId) as
    | { id: number }
    | undefined;
  if (!session) {
    return fail("E-NO-SESSION", "Unknown session.", 404);
  }
  const photoUrl = referencePhotoForSession(db, sessionId);
  if (!photoUrl) {
    return fail("E-NO-PHOTO", "No appointment reference photo.", 404);
  }
  return Response.json({ photoUrl });
}
