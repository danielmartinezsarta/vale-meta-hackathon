// Server-side only. Stores one session slot photo from multipart upload.
// Request slots before|after|reference map to lib slots pre|post|ref.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { buildNailMosaic, describeMosaic, segmentNails } from "@/lib/nails";
import {
  previewsDir,
  sessionPhotosDir,
  session_photo_save,
  type PhotoSlot,
} from "@/lib/session-photo";

export const runtime = "nodejs";

const REQUEST_SLOTS: Record<string, PhotoSlot> = {
  before: "pre",
  after: "post",
  reference: "ref",
};

function fail(code: string, message: string, status: number): Response {
  return Response.json({ error: message, code }, { status });
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("E-NO-PHOTO", "Missing photo.", 400);
  }
  const sessionIdRaw = form.get("sessionId");
  const sessionId = typeof sessionIdRaw === "string" ? Number(sessionIdRaw) : NaN;
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return fail("E-NO-SESSION", "Missing or invalid sessionId.", 400);
  }
  const slotRaw = form.get("slot");
  const slot = typeof slotRaw === "string" ? REQUEST_SLOTS[slotRaw.trim()] : undefined;
  if (!slot) {
    return fail("E-BAD-SLOT", "Slot must be before, after, or reference.", 400);
  }
  const db = getDb();
  const session = db
    .prepare("SELECT id FROM sessions WHERE id = ?")
    .get(sessionId) as { id: number } | undefined;
  if (!session) {
    return fail("E-NO-SESSION", "Unknown session.", 404);
  }
  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return fail("E-NO-PHOTO", "Missing photo.", 400);
  }
  const mime = photo.type.toLowerCase();
  if (mime !== "image/png" && mime !== "image/jpeg") {
    return fail("E-NO-PHOTO", "Photo must be PNG or JPEG.", 400);
  }
  const bytes = Buffer.from(await photo.arrayBuffer());
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  const photoPath = session_photo_save(db, sessionId, slot, dataUrl, sessionPhotosDir());
  if (!photoPath) {
    return fail("E-STORE", "Photo could not be stored.", 500);
  }
  const name = photoPath.split("/").pop() ?? "";
  const photoUrl = `/api/photos?file=${encodeURIComponent(name)}`;
  const key = process.env.META_API_KEY?.trim() ?? "";
  if (!key) {
    return fail("E-NO-KEY", "Missing META_API_KEY.", 500);
  }
  let sam: { nailCount: number; boxes: Awaited<ReturnType<typeof segmentNails>> };
  try {
    const boxes = await segmentNails(key, dataUrl);
    sam = { nailCount: boxes.length, boxes };
  } catch {
    return fail("E-SAM", "Nail analysis failed.", 500);
  }
  const nailsFound = sam.nailCount === 5;
  if (slot !== "post") {
    return Response.json({
      ok: true,
      sessionId,
      slot,
      photoUrl,
      sam,
      checks: { nailsFound, nailsExpected: 5, mosaic: false },
    });
  }
  try {
    const mosaic = await buildNailMosaic(bytes, sam.boxes);
    const description = await describeMosaic(key, mosaic);
    const mosaicName = `mosaic_${sessionId}.png`;
    const dir = previewsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, mosaicName), mosaic);
    return Response.json({
      ok: true,
      sessionId,
      slot,
      photoUrl,
      sam,
      mosaicUrl: `/api/photos?file=${encodeURIComponent(mosaicName)}`,
      description,
      checks: { nailsFound, nailsExpected: 5, mosaic: true },
    });
  } catch {
    return fail("E-SAM", "Nail analysis failed.", 500);
  }
}
