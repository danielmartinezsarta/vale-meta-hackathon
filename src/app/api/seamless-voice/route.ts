export const runtime = "nodejs";

const SEAMLESS_URL =
  "https://danielmartinezsarta--vale-seamless-tts-web-speak.us-east.modal.run";
const DEFAULT_SPEAKER = 10;
const MAX_SPEAKER = 199;
const MAX_CHARS = 500;
const LIMIT_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

// Best-effort per-instance bucket (HACK-013 pattern): each serverless
// instance tracks its own callers, so a flood spread across instances
// may pass. Every call burns Modal GPU, hence the cap.
const hits = new Map<string, number[]>();

function clientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first === undefined || first === "" ? "unknown" : first;
}

function overLimit(ip: string, now: number = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT_PER_MINUTE) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

function pickSpeaker(param: string | null): number {
  if (param === null || param.trim() === "") return DEFAULT_SPEAKER;
  const parsed = Number(param);
  if (!Number.isInteger(parsed)) return DEFAULT_SPEAKER;
  return Math.min(MAX_SPEAKER, Math.max(0, parsed));
}

// Same-origin proxy for the Seamless voice demo (speaker 10 by default):
// the demo has no CORS open for the preview domain, and the key (if ever
// needed) stays server-side.
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const text = (searchParams.get("text") ?? "").slice(0, MAX_CHARS);
  if (text.trim() === "") {
    return Response.json({ error: "Missing text." }, { status: 400 });
  }
  const speaker = pickSpeaker(searchParams.get("speaker"));
  if (overLimit(clientIp(request))) {
    return Response.json(
      {
        error: "Too many requests. Wait a minute and try again.",
        code: "E-LIMIT",
      },
      { status: 429 },
    );
  }
  let upstream: Response;
  try {
    upstream = await fetch(
      `${SEAMLESS_URL}?speaker=${speaker}&text=${encodeURIComponent(text)}`,
    );
  } catch {
    return Response.json(
      { error: "Voice service is not reachable. Try again later.", code: "E-NET" },
      { status: 502 },
    );
  }
  if (!upstream.ok) {
    return Response.json(
      { error: "Voice service failed. Try again later.", code: "E-NET" },
      { status: 502 },
    );
  }
  const audio = await upstream.arrayBuffer();
  const headers = new Headers({
    "Content-Type": "audio/wav",
    "X-Speaker-Requested": String(speaker),
  });
  const synthesis = upstream.headers.get("X-Synthesis-Seconds");
  if (synthesis) headers.set("X-Synthesis-Seconds", synthesis);
  return new Response(audio, { headers });
}
