// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildReplayRun, parseReplayRun } from "./replay";

const WIDGET = {
  kind: "client_card",
  title: "David",
  size: "full",
  data: { name: "David", visits: [] },
};
const BOARD = { session: null, card: { name: "David", notes: [] }, list: ["Acetone"] };

function row(fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: "2026-11-03T12:00:00.000Z", model: "-", ...fields });
}

const LINES = [
  row({
    turn: "replay-1",
    process: "VOICE",
    status: "ok",
    content: "Vale, show me David",
    turnFields: {
      language: "en",
      transcript: "Vale, show me David",
      tool: "find_client",
      costUsd: 0.004,
      wav: "data/audio/x.wav",
      peakLevel: 0.9,
    },
  }),
  row({
    turn: "replay-1",
    process: "TOOL",
    status: "ok",
    detail: { tool: "find_client" },
    content: "Found David.",
    args: { client_name: "David" },
  }),
  row({
    turn: "replay-1",
    process: "AGENT",
    model: "muse-spark-1.3",
    status: "ok",
    detail: { tool: "find_client" },
    content: "Here is David. Bearer abc123 should never land in the file.",
  }),
  row({
    turn: "replay-1",
    process: "DB",
    status: "ok",
    detail: { board: true },
    board: BOARD,
  }),
  row({
    turn: "replay-1",
    process: "VOICE",
    status: "ok",
    detail: { widget: "client_card" },
    content: "David",
    widget: WIDGET,
  }),
  "not json at all",
  row({ turn: "-", process: "VOICE", status: "ok", content: "off-turn noise" }),
];

describe("buildReplayRun", () => {
  it("folds one turn's transcript, tool, reply, widget and board", () => {
    const run = buildReplayRun(LINES);
    expect(run.version).toBe(1);
    expect(run.turns).toHaveLength(1);
    const turn = run.turns[0];
    expect(turn.turn).toBe("replay-1");
    expect(turn.transcript).toBe("Vale, show me David");
    expect(turn.tool).toBe("find_client");
    expect(turn.toolArgs).toEqual({ client_name: "David" });
    expect(turn.reply).toContain("Here is David.");
    expect(turn.widget).toEqual(WIDGET);
    expect(turn.board).toEqual(BOARD);
    expect(turn.costUsd).toBeCloseTo(0.004);
    expect(turn.language).toBe("en");
  });

  it("keeps no audio and scrubs secret-looking strings", () => {
    const run = buildReplayRun(LINES);
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain("abc123");
    expect(serialized).toContain("Bearer [redacted]");
    expect(serialized).not.toContain("wav");
    expect(serialized).not.toContain("peakLevel");
    expect(serialized).not.toContain(".wav");
  });

  it("skips junk lines and turns without a transcript", () => {
    expect(buildReplayRun(["junk", row({ turn: "t9", process: "DB", status: "ok" })]).turns).toEqual(
      [],
    );
  });

  it("reads the tool off IMAGE and SAM rows that carry detail.tool", () => {
    const run = buildReplayRun([
      row({
        turn: "replay-2",
        process: "VOICE",
        status: "ok",
        turnFields: { language: "en", transcript: "show me how it will look" },
      }),
      row({
        turn: "replay-2",
        process: "SAM",
        status: "ok",
        detail: { tool: "photo_preview_design" },
        content: "-",
      }),
      row({
        turn: "replay-2",
        process: "IMAGE",
        status: "ok",
        detail: { tool: "photo_preview_design" },
        content: "Here is how it would look. The preview is on screen.",
        args: {},
      }),
      row({
        turn: "replay-2",
        process: "AGENT",
        status: "ok",
        content: "Here is how it would look.",
      }),
    ]);
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0].tool).toBe("photo_preview_design");
  });

  it("ignores SAM upload rows without a tool", () => {
    const run = buildReplayRun([
      row({
        turn: "replay-3",
        process: "VOICE",
        status: "ok",
        turnFields: { language: "en", transcript: "take the before photo" },
      }),
      row({
        turn: "replay-3",
        process: "SAM",
        status: "ok",
        detail: { slot: "pre", session: 8 },
        content: "-",
      }),
    ]);
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0].tool).toBeNull();
  });
});

describe("parseReplayRun", () => {
  it("round-trips the built run and rejects anything else", () => {
    const run = buildReplayRun(LINES);
    expect(parseReplayRun(JSON.stringify(run))).toEqual({ ...run, recordedAt: run.recordedAt });
    expect(() => parseReplayRun("{}")).toThrow();
    expect(() => parseReplayRun(JSON.stringify({ version: 1, turns: [{ turn: 7 }] }))).toThrow();
  });
});
