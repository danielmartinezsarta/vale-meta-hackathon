// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const saved = process.env.VALE_REPLAY;

afterEach(() => {
  if (saved === undefined) delete process.env.VALE_REPLAY;
  else process.env.VALE_REPLAY = saved;
});

describe("GET /api/replay", () => {
  it("stays off without VALE_REPLAY=1", async () => {
    delete process.env.VALE_REPLAY;
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("serves the committed run with transcripts, replies, widgets and boards", async () => {
    process.env.VALE_REPLAY = "1";
    const res = await GET();
    expect(res.status).toBe(200);
    const run = (await res.json()) as {
      version: number;
      turns: {
        transcript: string;
        reply: string;
        widget: { kind: string } | null;
        board: unknown;
      }[];
    };
    expect(run.version).toBe(1);
    expect(run.turns.length).toBeGreaterThan(0);
    for (const turn of run.turns) {
      expect(turn.transcript).not.toBe("");
      expect(turn.reply).not.toBe("");
    }
    expect(run.turns.some((turn) => turn.widget !== null)).toBe(true);
    expect(run.turns.some((turn) => turn.board !== null && turn.board !== undefined)).toBe(true);
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain(".wav");
    expect(serialized).not.toContain("data/audio");
  });

  it("makes no model call: no key is read and nothing is fetched", async () => {
    const savedKey = process.env.META_API_KEY;
    delete process.env.META_API_KEY;
    process.env.VALE_REPLAY = "1";
    try {
      const res = await GET();
      expect(res.status).toBe(200);
    } finally {
      if (savedKey === undefined) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = savedKey;
    }
  });
});
