// Server-side only. Tells the screen whether voice can run: a key, replay,
// the open-model voice, or neither. Booleans only; nothing secret leaves here.
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    key: (process.env.META_API_KEY ?? "").trim() !== "",
    replay: process.env.VALE_REPLAY === "1",
    seamless: (process.env.SEAMLESS_URL ?? "").trim() !== "",
  });
}
