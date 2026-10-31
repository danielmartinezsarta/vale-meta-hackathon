// Every test runs against the seeded in-memory database (or an explicit
// tmp file). Touching the real data/vale.db from a test fails loudly in
// getDb instead of polluting Daniel's live turns.
import { tmpdir } from "node:os";
import { join } from "node:path";
if (process.env.VALE_DB_MEMORY === undefined) {
  process.env.VALE_DB_MEMORY = "1";
}

// Turn lines emitted by bridge/route flows under test go to a tmp file,
// never to Daniel's data/turns.jsonl ear log.
if (process.env.VALE_TURNS_PATH === undefined) {
  process.env.VALE_TURNS_PATH = join(tmpdir(), `test-turns-${process.pid}.jsonl`);
}
