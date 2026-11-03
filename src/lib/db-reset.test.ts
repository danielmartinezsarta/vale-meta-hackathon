// @vitest-environment node
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Full content dump minus wall-clock columns, for run-to-run equality. */
function dump(file: string): Record<string, unknown[]> {
  const db = new DatabaseSync(file);
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const out: Record<string, unknown[]> = {};
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<
        string,
        unknown
      >[];
      out[table] = rows.map((row) => {
        const { created_at: _created, added_at: _added, ...rest } = row;
        return rest;
      });
    }
    return out;
  } finally {
    db.close();
  }
}

function resetTo(file: string): { elapsedMs: number } {
  const started = Date.now();
  const output = execFileSync("node", [join(root, "scripts", "db-reset.mjs")], {
    env: { ...process.env, VALE_DB_PATH: file },
    timeout: 30000,
    encoding: "utf8",
  });
  const match = /in (\d+)ms/.exec(output);
  return { elapsedMs: match ? Number(match[1]) : Date.now() - started };
}

describe("npm run db:reset", () => {
  it("leaves the same database after two runs and finishes under 5 s", () => {
    const dir = mkdtempSync(join(tmpdir(), "vale-db-reset-"));
    const file = join(dir, "vale.db");
    const first = resetTo(file);
    expect(first.elapsedMs).toBeLessThan(5000);
    const before = dump(file);
    expect(before.clients.length).toBeGreaterThan(0);
    expect(before.appointments.length).toBeGreaterThan(0);
    const second = resetTo(file);
    expect(second.elapsedMs).toBeLessThan(5000);
    expect(dump(file)).toEqual(before);
  });
});
