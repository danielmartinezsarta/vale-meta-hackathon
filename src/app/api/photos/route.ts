// Server-side only. Serves stored JPG/PNG bytes from the two photo
// dirs. Anything else is a 404; paths never escape those directories.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { previewsDir, sessionPhotosDir } from "@/lib/session-photo";

export const runtime = "nodejs";

const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png)$/i;
// Repo-committed seed assets only: no traversal, no absolute paths, no other dirs.
const SEED_ASSETS_PATTERN = /^seed-assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png)$/i;

export async function GET(request: Request): Promise<Response> {
  const file = new URL(request.url).searchParams.get("file") ?? "";
  const seedAsset = SEED_ASSETS_PATTERN.test(file) && !file.includes("..");
  if (!seedAsset && (!FILE_PATTERN.test(file) || file.includes(".."))) {
    return Response.json({ error: "Not found.", code: "E-NO-PHOTO" }, { status: 404 });
  }
  const contentType = file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  if (seedAsset) {
    try {
      const bytes = readFileSync(join(process.cwd(), file));
      return new Response(bytes, {
        status: 200,
        headers: { "Content-Type": contentType },
      });
    } catch {
      return Response.json({ error: "Not found.", code: "E-NO-PHOTO" }, { status: 404 });
    }
  }
  for (const dir of [sessionPhotosDir(), previewsDir()]) {
    try {
      const bytes = readFileSync(join(dir, file));
      return new Response(bytes, {
        status: 200,
        headers: { "Content-Type": contentType },
      });
    } catch {
      /* try the next directory */
    }
  }
  return Response.json({ error: "Not found.", code: "E-NO-PHOTO" }, { status: 404 });
}
