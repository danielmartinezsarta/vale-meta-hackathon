export const runtime = "nodejs";

const MMS_URL =
  "https://danielmartinezsarta--vale-mms-tts-web-speak.us-east.modal.run";
const MAX_CHARS = 500;

// Same-origin proxy for the public MMS voice demo: the demo has no CORS
// open for the preview domain, and the key (if ever needed) stays server-side.
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const text = (searchParams.get("text") ?? "").slice(0, MAX_CHARS);
  if (text.trim() === "") {
    return Response.json({ error: "Missing text." }, { status: 400 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${MMS_URL}?text=${encodeURIComponent(text)}`);
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
  const headers = new Headers({ "Content-Type": "audio/wav" });
  const synthesis = upstream.headers.get("X-Synthesis-Seconds");
  if (synthesis) headers.set("X-Synthesis-Seconds", synthesis);
  return new Response(audio, { headers });
}
