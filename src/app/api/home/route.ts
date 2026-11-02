import { getDb } from "@/lib/db";
import { getHomeData } from "@/lib/home-data";

export const runtime = "nodejs";

/** Home screen snapshot: today, month goal, low supplies, user name. */
export async function GET(): Promise<Response> {
  return Response.json(getHomeData(getDb()));
}
