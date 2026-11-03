// Server-side only. Serves the committed demo run when VALE_REPLAY=1,
// so judges without a Meta key can watch the recorded run end to end.
// No key is read here and no model is ever called from this route.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReplayRun } from "@/lib/replay";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  if (process.env.VALE_REPLAY !== "1") {
    return Response.json({ error: "Replay is off.", code: "E-NO-REPLAY" }, { status: 404 });
  }
  try {
    const raw = readFileSync(join(process.cwd(), "replay", "demo-run.json"), "utf8");
    return new Response(JSON.stringify(parseReplayRun(raw)), {
      headers: { "content-type": "application/json" },
    });
  } catch {
    return Response.json({ error: "No recorded run.", code: "E-NO-REPLAY" }, { status: 404 });
  }
}
