// Delete the local database and rebuild it from schema.sql plus the demo
// seed. Idempotent: two runs leave the same rows (seed timestamps excluded).
// Usage:
//   npm run db:reset                        -> rebuilds data/vale.db
//   VALE_DB_PATH=/tmp/x.db npm run db:reset -> rebuilds that file (tests)
// Never touches any other file.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const override = (process.env.VALE_DB_PATH ?? "").trim();
const file = override
  ? isAbsolute(override)
    ? override
    : join(root, override)
  : join(root, "data", "vale.db");

// Replacing the file under a running server breaks its writes, so the flow
// stays db:reset first, then npm start: refuse while the port answers.
const port = Number(process.env.PORT ?? process.env.VOICE_PORT ?? 3000);
const serverUp = await new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.on("error", () => resolve(false));
  socket.setTimeout(2000, () => {
    socket.destroy();
    resolve(false);
  });
});
if (serverUp) {
  console.log("Stop the server first (Ctrl-C), then run db:reset.");
  process.exit(1);
}

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
