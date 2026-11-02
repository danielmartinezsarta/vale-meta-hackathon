import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every Ali class the renderer references must have a rule in the port. */
describe("ValeSheets CSS coverage", () => {
  it("defines every aw- class used by the sheet markup", () => {
    const dir = join(__dirname);
    const markup = readFileSync(join(dir, "ValeSheets.tsx"), "utf8");
    const css = readFileSync(join(dir, "vale-sheets.css"), "utf8");
    const used = new Set<string>();
    for (const match of markup.matchAll(/["`]([^"`]*\baw-[a-zA-Z0-9_-]+[^"`]*)["`]/g)) {
      for (const cls of match[1].matchAll(/\baw-[a-zA-Z0-9_-]+/g)) {
        used.add(cls[0]);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    // Ali styles some elements through the block selector, so a __part
    // is covered when its block carries rules. Four sheet markers carry
    // no rule in Ali either: the base half sheet sizes them.
    const ruleless = new Set([
      "aw-goal-sheet",
      "aw-cam-sheet",
      "aw-sens-sheet",
      "aw-final-sheet",
    ]);
    const covered = (cls: string): boolean => {
      if (css.includes(`.${cls}`)) return true;
      if (ruleless.has(cls)) return true;
      const block = cls.split("__")[0];
      return block !== cls && css.includes(`.${block}`);
    };
    const missing = [...used].filter((cls) => !covered(cls));
    expect(missing).toEqual([]);
  });
});
