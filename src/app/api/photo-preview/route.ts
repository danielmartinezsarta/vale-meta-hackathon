// Server-side only. Generates one AI preview from the session before
// photo plus the appointment reference photo. Exactly one runPhotoPreview
// call per request; the module enforces the USD 2.0 budget / 1.5 warning.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import {
  previewCostLogPath,
  previewsDir,
  sessionPhotoPath,
  sessionPhotosDir,
} from "@/lib/session-photo";
import { runPhotoPreview, samBoxesMatch, type DesignSpec } from "@/lib/photo-preview";
import { segmentNails, type NailBox } from "@/lib/nails";

export const runtime = "nodejs";

/** Hard cap: at most two Image calls per request, no matter what. */
const MAX_IMAGE_CALLS = 2;

// The reference image carries the design; the text spec stays neutral.
const PREVIEW_DESIGN: DesignSpec = {
  shape: "natural",
  color: "reference",
  finish: "reference",
  detail: "reference",
};

function fail(code: string, message: string, status: number): Response {
  return Response.json({ error: message, code }, { status });
}

function sniffMime(bytes: Buffer): "image/png" | "image/jpeg" {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    ? "image/png"
    : "image/jpeg";
}

function readPhotoFile(path: string): Buffer | null {
  try {
    const bytes = readFileSync(path);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: { sessionId?: unknown };
  try {
    body = (await request.json()) as { sessionId?: unknown };
  } catch {
    return fail("E-NO-SESSION", "Missing or invalid sessionId.", 400);
  }
  const sessionId = typeof body.sessionId === "number" ? body.sessionId : NaN;
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return fail("E-NO-SESSION", "Missing or invalid sessionId.", 400);
  }
  const db = getDb();
  const session = db
    .prepare("SELECT id, client_id, service_id FROM sessions WHERE id = ?")
    .get(sessionId) as { id: number; client_id: number; service_id: number } | undefined;
  if (!session) {
    return fail("E-NO-SESSION", "Unknown session.", 404);
  }
  const before = readPhotoFile(sessionPhotoPath(sessionId, "pre", sessionPhotosDir()));
  if (!before) {
    return fail("E-NO-PHOTO", "No before photo for this session.", 404);
  }
  const appointment = db
    .prepare(
      "SELECT id, reference_photo_ref FROM appointments WHERE client_id = ? AND service_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(session.client_id, session.service_id) as
    | { id: number; reference_photo_ref: string | null }
    | undefined;
  if (!appointment?.reference_photo_ref) {
    return fail("E-NO-PHOTO", "No appointment reference photo.", 404);
  }
  const refValue = appointment.reference_photo_ref;
  let reference: Buffer | null = null;
  const dataMatch = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(refValue);
  if (dataMatch) {
    try {
      reference = Buffer.from(dataMatch[2], "base64");
    } catch {
      reference = null;
    }
  } else {
    reference = readPhotoFile(refValue);
  }
  if (!reference) {
    return fail("E-NO-PHOTO", "No appointment reference photo.", 404);
  }
  const key = process.env.META_API_KEY?.trim();
  if (!key) {
    return fail("E-NO-KEY", "Missing META_API_KEY for photo preview.", 503);
  }
  const beforeMime = sniffMime(before);
  const referenceMime = sniffMime(reference);
  // Step 1: SAM pre-check on the before photo; no Image call unless all
  // five nails are visible.
  let beforeBoxes: NailBox[];
  try {
    beforeBoxes = await segmentNails(
      key,
      `data:${beforeMime};base64,${before.toString("base64")}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Photo preview failed.";
    return fail("E-MODEL", message, 502);
  }
  if (beforeBoxes.length !== 5) {
    return Response.json(
      {
        error: "I need a photo with all five nails visible.",
        code: "E-NO-NAILS",
        sam: { nailCount: beforeBoxes.length, boxes: beforeBoxes },
      },
      { status: 422 },
    );
  }
  const previewInput = {
    beforePhoto: before,
    mime: beforeMime,
    referencePhoto: reference,
    referenceMime,
    design: PREVIEW_DESIGN,
    appointmentRef: `APT-${appointment.id}`,
  };
  const runImage = () => runPhotoPreview(previewInput, { costLogPath: previewCostLogPath() });
  const checkResult = async (image: Buffer): Promise<NailBox[]> =>
    segmentNails(key, `data:image/png;base64,${image.toString("base64")}`);
  const imageError = (error: unknown): Response => {
    const code = (error as NodeJS.ErrnoException)?.code ?? "E-MODEL";
    const message = error instanceof Error ? error.message : "Photo preview failed.";
    if (code === "E-BUDGET") return fail(code, message, 429);
    if (code === "E-NO-KEY") return fail(code, message, 503);
    return fail(code, message, 502);
  };
  // Step 2: the single Image call.
  let imageCalls = 0;
  let result: Awaited<ReturnType<typeof runPhotoPreview>>;
  try {
    result = await runImage();
    imageCalls += 1;
  } catch (error) {
    return imageError(error);
  }
  // Step 3: SAM post-check on the result.
  let afterBoxes: NailBox[];
  try {
    afterBoxes = await checkResult(result.image);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Photo preview failed.";
    return fail("E-MODEL", message, 502);
  }
  let matched = samBoxesMatch(beforeBoxes, afterBoxes);
  let secondCall = false;
  if (!matched && imageCalls < MAX_IMAGE_CALLS) {
    try {
      result = await runImage();
      imageCalls += 1;
      secondCall = true;
    } catch (error) {
      return imageError(error);
    }
    try {
      afterBoxes = await checkResult(result.image);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Photo preview failed.";
      return fail("E-MODEL", message, 502);
    }
    matched = samBoxesMatch(beforeBoxes, afterBoxes);
  }
  mkdirSync(previewsDir(), { recursive: true });
  writeFileSync(join(previewsDir(), `preview_${sessionId}.png`), result.image);
  return Response.json({
    ok: true,
    previewUrl: `/api/photos?file=preview_${sessionId}.png`,
    elapsedMs: result.elapsedMs,
    estimatedCostUsd: result.estimatedCostUsd,
    aiPreview: true,
    disclaimer: result.disclaimer,
    preCheck: { nailCount: beforeBoxes.length, boxes: beforeBoxes },
    postCheck: { nailCount: afterBoxes.length, matched },
    secondCall,
  });
}
