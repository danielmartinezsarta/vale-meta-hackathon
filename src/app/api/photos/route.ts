// Server-side only. Serves stored JPG/PNG bytes from the two photo
// dirs. Anything else is a 404; paths never escape those directories.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { previewsDir, sessionPhotosDir } from "@/lib/session-photo";

export const runtime = "nodejs";

const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png)$/i;

export async function GET(request: Request): Promise<Response> {
  const file = new URL(request.url).searchParams.get("file") ?? "";
  if (!FILE_PATTERN.test(file) || file.includes("..")) {
    return Response.json({ error: "Not found.", code: "E-NO-PHOTO" }, { status: 404 });
  }
  const contentType = file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
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
