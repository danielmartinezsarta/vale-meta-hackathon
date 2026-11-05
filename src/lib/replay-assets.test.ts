import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The keyless replay runs on a judge machine with no data/ dir: every
 * photo it shows must be a repo file under seed-assets/. */
describe("demo-run photo assets", () => {
  it("points every photo URL at an existing seed-assets file", () => {
    const run = JSON.parse(
      readFileSync(join(process.cwd(), "replay", "demo-run.json"), "utf8"),
    ) as { turns: Array<{ turn: string; widget?: unknown }> };
    const urls: Array<{ turn: string; url: string }> = [];
    for (const turn of run.turns) {
      const text = JSON.stringify(turn.widget ?? {});
      for (const match of text.matchAll(/\/api\/photos\?file=([^"\\]+)/g)) {
        urls.push({ turn: turn.turn, url: match[1] });
      }
    }
    expect(urls.length).toBeGreaterThan(0);
    for (const { turn, url } of urls) {
      expect(`${turn}: ${url}`).toMatch(/seed-assets\//);
      expect(url).not.toMatch(/\.\./);
      expect(existsSync(join(process.cwd(), url))).toBe(true);
    }
  });
});
