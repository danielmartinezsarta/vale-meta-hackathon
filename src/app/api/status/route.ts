// Server-side only. Tells the screen whether voice can run: a key, replay,
// or neither. The values are booleans; nothing secret ever leaves here.
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    key: (process.env.META_API_KEY ?? "").trim() !== "",
    replay: process.env.VALE_REPLAY === "1",
  });
}
