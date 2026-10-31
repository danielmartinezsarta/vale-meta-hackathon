// @vitest-environment node
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emitTurnLog,
  formatTurnLog,
  persistTurnLog,
  turnsLogFile,
} from "./turn-log";

describe("turn log persistence", () => {
  it("formats one [voice-turn] JSON line per turn", () => {
    const line = formatTurnLog({
      ts: "2026-10-31T00:00:00.000Z",
      transcript: "hola",
      ttftMs: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      audioSeconds: 0,
      tool: null,
      modelSkipped: true,
      error: null,
      ignored: true,
      gate: "ignorado",
    });
    expect(line.startsWith("[voice-turn] ")).toBe(true);
    expect(JSON.parse(line.slice("[voice-turn] ".length))).toMatchObject({
      transcript: "hola",
      ignored: true,
      gate: "ignorado",
    });
  });

  it("defaults to data/turns.jsonl and honors VALE_TURNS_PATH", () => {
    const saved = process.env.VALE_TURNS_PATH;
    try {
      delete process.env.VALE_TURNS_PATH;
      expect(turnsLogFile()).toBe(join(process.cwd(), "data", "turns.jsonl"));
      process.env.VALE_TURNS_PATH = "/tmp/ear-test.jsonl";
      expect(turnsLogFile()).toBe("/tmp/ear-test.jsonl");
    } finally {
      if (saved === undefined) delete process.env.VALE_TURNS_PATH;
      else process.env.VALE_TURNS_PATH = saved;
    }
  });

  it("appends every emitted line to the override file", () => {
    const saved = process.env.VALE_TURNS_PATH;
    const file = join(tmpdir(), `turns-test-${Date.now()}.jsonl`);
    const savedLog = console.log;
    const seen: string[] = [];
    console.log = (line: string) => void seen.push(line);
    try {
      process.env.VALE_TURNS_PATH = file;
      const fields = {
        ts: "2026-10-31T00:00:00.000Z",
        transcript: "vale?",
        ttftMs: null as number | null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        audioSeconds: 0,
        tool: null as string | null,
        modelSkipped: true,
        error: null as string | null,
        ignored: true as boolean,
      };
      emitTurnLog(fields);
      persistTurnLog("[voice-turn] custom");
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(seen[0]);
      expect(lines[1]).toBe("[voice-turn] custom");
    } finally {
      console.log = savedLog;
      if (saved === undefined) delete process.env.VALE_TURNS_PATH;
      else process.env.VALE_TURNS_PATH = saved;
      rmSync(file, { force: true });
    }
  });
});
