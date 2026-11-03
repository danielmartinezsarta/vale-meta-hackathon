// @vitest-environment node
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
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

/** A port with nothing listening: bind it, read it, close it. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

function resetTo(file: string, port: number): { elapsedMs: number } {
  const started = Date.now();
  const output = execFileSync("node", [join(root, "scripts", "db-reset.mjs")], {
    env: { ...process.env, VALE_DB_PATH: file, PORT: String(port) },
    timeout: 30000,
    encoding: "utf8",
  });
  const match = /in (\d+)ms/.exec(output);
  return { elapsedMs: match ? Number(match[1]) : Date.now() - started };
}

describe("npm run db:reset", () => {
  it("leaves the same database after two runs and finishes under 5 s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vale-db-reset-"));
    const file = join(dir, "vale.db");
    const port = await closedPort();
    const first = resetTo(file, port);
    expect(first.elapsedMs).toBeLessThan(5000);
    const before = dump(file);
    expect(before.clients.length).toBeGreaterThan(0);
    expect(before.appointments.length).toBeGreaterThan(0);
    const second = resetTo(file, port);
    expect(second.elapsedMs).toBeLessThan(5000);
    expect(dump(file)).toEqual(before);
  });

  it("does nothing but say so when the server is up on the Vale port", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", () => resolve());
    });
    const port = String((listener.address() as { port: number }).port);
    const file = join(mkdtempSync(join(tmpdir(), "vale-db-reset-busy-")), "vale.db");
    let output = "";
    try {
      execFileSync("node", [join(root, "scripts", "db-reset.mjs")], {
        env: { ...process.env, VALE_DB_PATH: file, PORT: port },
        timeout: 30000,
        encoding: "utf8",
      });
      expect.unreachable("db:reset must refuse while the server listens");
    } catch (error) {
      output = String((error as { stdout?: unknown }).stdout ?? error);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    expect(output.trim()).toBe("Stop the server first (Ctrl-C), then run db:reset.");
    expect(existsSync(file)).toBe(false);
  });
});
