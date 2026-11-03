// HACK-005: warm the private brief cache after db:reset. Chained in the
// db:reset npm script for the clients with appointments today. Exits 0 at
// once without GLIMMER_URL/GLIMMER_TOKEN; a failed model call keeps the
// reset green and the voice falls back to the card.
import { getDb } from "../src/lib/db";
import {
  glimmerConfigured,
  precomputeBriefsForClients,
  todayClientIds,
} from "../src/lib/client-briefs";

async function main(): Promise<void> {
  if (!glimmerConfigured()) {
    console.log("[briefs] no private model configured; skipping");
    return;
  }
  const db = getDb();
  try {
    const ids = todayClientIds(db);
    const { refreshed, total } = await precomputeBriefsForClients(db, ids);
    console.log(`[briefs] precomputed ${refreshed}/${total}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`[briefs] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
