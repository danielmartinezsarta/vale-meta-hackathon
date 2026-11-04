export const runtime = "nodejs";

/** The open-model voice lives only in the server env: zero URLs in code. */
const DEFAULT_SPEAKER = 17;
/** Seconds of synthesis above which the container is assumed cold-started. */
const COLD_START_SECONDS = 10;
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

// Same-origin proxy for the Seamless voice demo (speaker 17 by default):
// the demo has no CORS open for the preview domain, and the key (if ever
// needed) stays server-side.
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const text = (searchParams.get("text") ?? "").slice(0, MAX_CHARS);
  if (text.trim() === "") {
    return Response.json({ error: "Missing text." }, { status: 400 });
  }
  const speaker = pickSpeaker(searchParams.get("speaker"));
  const seamlessUrl = (process.env.SEAMLESS_URL ?? "").trim();
  // Same auth as Glimmer: the token comes from the local .env (gitignored)
  // or the shell env, never committed, and rides to Modal in the authorization header.
  const seamlessToken = (process.env.SEAMLESS_TOKEN ?? "").trim();
  if (seamlessUrl === "" || seamlessToken === "") {
    return Response.json(
      { error: "Seamless voice is not configured.", code: "E-NET" },
      { status: 503 },
    );
  }
  if (overLimit(clientIp(request))) {
    return Response.json(
      {
        error: "Too many requests. Wait a minute and try again.",
        code: "E-LIMIT",
      },
      { status: 429 },
    );
  }
  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(
      `${seamlessUrl}?speaker=${speaker}&text=${encodeURIComponent(text)}`,
      { headers: { authorization: `Bearer ${seamlessToken}` } },
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
  const synthesisSecs = synthesis === null ? NaN : Number(synthesis);
  const warmth = !Number.isFinite(synthesisSecs)
    ? "unknown"
    : synthesisSecs > COLD_START_SECONDS
      ? "cold"
      : "warm";
  console.log(
    `[seamless-voice] engine=seamless speaker=${speaker} synthesisS=${synthesis ?? "?"} ${warmth} totalMs=${Date.now() - startedAt}`,
  );
  return new Response(audio, { headers });
}
