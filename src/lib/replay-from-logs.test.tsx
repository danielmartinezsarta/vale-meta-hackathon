import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayScreen } from "@/components/ReplayScreen";
import { speak } from "@/lib/speak";

vi.mock("@/lib/speak", () => ({
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
}));

const mockSpeak = vi.mocked(speak);
const root = process.cwd();

const WIDGET = {
  kind: "goal",
  title: "Monthly goal",
  size: "half",
  data: { name: null, goal: 2500, earned: 1360 },
};
const BOARD = { session: null, card: null, list: ["Acetone"] };

function row(fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: "2026-11-03T20:00:00.000Z", model: "-", ...fields });
}

/** One voice turn (with audio stats) plus one typed turn, and one older turn. */
const LOG = [
  row({ turn: "t099", ts: "2026-11-03T19:00:00.000Z", process: "VOICE", status: "ok", content: "older turn", turnFields: { transcript: "older turn", language: "en", costUsd: 0.001 } }),
  "not json",
  row({
    turn: "t101",
    ts: "2026-11-03T20:00:10.000Z",
    process: "VOICE",
    status: "ok",
    content: "Vale, what do I have today?",
    turnFields: {
      language: "en",
      transcript: "Vale, what do I have today?",
      tool: "agenda_show",
      costUsd: 0.004,
      wav: "data/audio/x.wav",
      peakLevel: 0.9,
      totalMs: 1200,
    },
  }),
  row({
    turn: "t101",
    ts: "2026-11-03T20:00:11.000Z",
    process: "AGENT",
    model: "muse-spark-1.3",
    status: "ok",
    content: "Today: David at 3 PM.",
  }),
  row({
    turn: "t101",
    ts: "2026-11-03T20:00:11.000Z",
    process: "DB",
    status: "ok",
    detail: { board: true },
    board: BOARD,
  }),
  row({
    turn: "t102",
    ts: "2026-11-03T20:01:10.000Z",
    process: "VOICE",
    status: "ok",
    content: "Vale, how is my goal?",
    turnFields: {
      language: "en",
      transcript: "Vale, how is my goal?",
      tool: "goal_show",
      costUsd: 0.005,
      gate: "typed",
      totalMs: 900,
    },
  }),
  row({
    turn: "t102",
    ts: "2026-11-03T20:01:11.000Z",
    process: "TOOL",
    status: "ok",
    detail: { tool: "goal_show" },
    content: "Goal on screen.",
    args: {},
  }),
  row({
    turn: "t102",
    ts: "2026-11-03T20:01:12.000Z",
    process: "AGENT",
    model: "muse-spark-1.3",
    status: "ok",
    content: "Here is your goal.",
  }),
  row({
    turn: "t102",
    ts: "2026-11-03T20:01:12.000Z",
    process: "VOICE",
    status: "ok",
    detail: { widget: "goal" },
    content: "Monthly goal",
    widget: WIDGET,
  }),
].join("\n");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("npm run replay:from-logs", () => {
  it("folds one voice turn and one typed turn into a replay that plays both", () => {
    const dir = mkdtempSync(join(tmpdir(), "vale-replay-from-logs-"));
    writeFileSync(join(dir, "2026-11-03.jsonl"), `${LOG}\n`);
    const out = join(dir, "demo-run.json");
    const output = execFileSync(
      "npx",
      ["tsx", join(root, "scripts", "replay-from-logs.ts"), "--logs", dir, "--since", "2026-11-03T19:59:00Z", "--out", out],
      { timeout: 120000, encoding: "utf8" },
    );
    expect(output).toContain("2 turns");
    const serialized = readFileSync(out, "utf8");
    expect(serialized).not.toContain(".wav");
    expect(serialized).not.toContain("data/audio");

    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = typeof input === "string" ? input : String(input);
        fetched.push(url);
        if (url === "/api/replay") return { ok: true, text: async () => serialized };
        throw new Error(`unexpected network in replay: ${url}`);
      }),
    );
    render(<ReplayScreen stepMs={20} />);
    return waitFor(() => {
      expect(screen.getByText("Today: David at 3 PM.")).toBeTruthy();
      expect(screen.getByText("Here is your goal.")).toBeTruthy();
    }).then(() => {
      expect(mockSpeak).toHaveBeenCalledWith("Today: David at 3 PM.", "en");
      expect(mockSpeak).toHaveBeenCalledWith("Here is your goal.", "en");
      expect(screen.getByRole("dialog", { name: "Monthly goal" })).toBeTruthy();
      expect(fetched).toEqual(["/api/replay"]);
    });
  });
});
