// Warm the private brief cache when the server boots.
// Fire-and-forget: without a configured private model this is an instant
// no-op, replay runs skip it, and a failure never surfaces or blocks boot.
// The brief store needs node:sqlite, so this hook pins the Node runtime:
// the edge runtime cannot load it.
export const runtime = "nodejs";

export async function register(): Promise<void> {
  if (process.env.VALE_REPLAY === "1") return;
  const { getDb } = await import("./lib/db");
  const { glimmerConfigured, precomputeBriefsForClients, todayClientIds } =
    await import("./lib/client-briefs");
  if (!glimmerConfigured()) return;
  try {
    const db = getDb();
    void precomputeBriefsForClients(db, todayClientIds(db))
      .then(({ refreshed, total }) => {
        console.log(`[briefs] precomputed ${refreshed}/${total}`);
      })
      .catch(() => {});
  } catch {
    /* boot never waits on the brief cache */
  }
}
