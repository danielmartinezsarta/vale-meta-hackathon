// @vitest-environment node
// Precompute wiring: server-start hook and db:reset chain.
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getStoredBrief } from "./client-briefs";
import { getDb } from "./db";

const root = fileURLToPath(new URL("../../", import.meta.url));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("precompute wiring", () => {
  it("register() is an instant no-op without a private model", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [] }) }));
    vi.stubGlobal("fetch", fetchImpl);
    const { register } = await import("../instrumentation");
    await expect(register()).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("register() skips the network on replay runs", async () => {
    vi.stubEnv("VALE_REPLAY", "1");
    vi.stubEnv("GLIMMER_URL", "https://glimmer.test");
    vi.stubEnv("GLIMMER_TOKEN", "secret");
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [] }) }));
    vi.stubGlobal("fetch", fetchImpl);
    const { register } = await import("../instrumentation");
    await expect(register()).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("register() warms today's briefs when the model answers", async () => {
    vi.stubEnv("VALE_DB_MEMORY", "1");
    vi.stubEnv("GLIMMER_URL", "https://glimmer.test");
    vi.stubEnv("GLIMMER_TOKEN", "secret");
    const brief = {
      spoken: "David comes every 3 weeks.",
      summary: ["Prefers dark matte designs"],
      has_health_note: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(brief) } }] }),
      })),
    );
    const { register } = await import("../instrumentation");
    await register();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const db = getDb();
    const david = db.prepare("SELECT id FROM clients WHERE name = ?").get("David") as { id: number };
    expect(getStoredBrief(db, david.id)?.brief).toEqual(brief);
  });

  it("precompute script skips without env and survives a dead endpoint", () => {
    const file = join(mkdtempSync(join(tmpdir(), "vale-h005-pre-")), "vale.db");
    const script = join(root, "scripts", "precompute-briefs.ts");
    const skip = execFileSync("npx", ["tsx", script], {
      env: { ...process.env, VALE_DB_PATH: file },
      timeout: 120000,
      encoding: "utf8",
    });
    expect(skip).toContain("skipping");
    const dead = execFileSync("npx", ["tsx", script], {
      env: {
        ...process.env,
        VALE_DB_PATH: file,
        GLIMMER_URL: "http://127.0.0.1:1",
        GLIMMER_TOKEN: "test",
      },
      timeout: 120000,
      encoding: "utf8",
    });
    expect(dead).toContain("precomputed 0/3");
  });

});
