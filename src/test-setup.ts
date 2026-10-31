// Every test runs against the seeded in-memory database (or an explicit
// tmp file). Touching the real data/vale.db from a test fails loudly in
// getDb instead of polluting Daniel's live turns.
if (process.env.VALE_DB_MEMORY === undefined) {
  process.env.VALE_DB_MEMORY = "1";
}
