// Delete the local database and rebuild it from schema.sql plus the demo
// seed. Idempotent: two runs leave the same rows (seed timestamps excluded).
// Usage:
//   npm run db:reset                        -> rebuilds data/vale.db
//   VALE_DB_PATH=/tmp/x.db npm run db:reset -> rebuilds that file (tests)
// Never touches any other file.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const override = (process.env.VALE_DB_PATH ?? "").trim();
const file = override
  ? isAbsolute(override)
    ? override
    : join(root, override)
  : join(root, "data", "vale.db");

const started = Date.now();
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const path = `${file}${suffix}`;
  if (existsSync(path)) rmSync(path);
}
// The seed script does schema plus seed; with the file just deleted it
// inserts every demo row from scratch (VALE_DB_PATH keeps tests isolated).
// The --live flag unlocks the live file, which is exactly our target when
// VALE_DB_PATH is unset; on a scratch file it is redundant but harmless.
execFileSync("node", [join(root, "scripts", "seed.mjs"), "--live"], {
  env: { ...process.env, VALE_DB_PATH: file },
  stdio: "inherit",
});
console.log(`[db:reset] ${file} in ${Date.now() - started}ms`);
