// @vitest-environment node
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  emitTurnLog,
  eventLogFile,
  formatTurnLog,
  formatVlog,
  modelElapsedMs,
  persistTurnLog,
  turnsLogFile,
  vlog,
} from "./turn-log";

describe("unified server log", () => {
  it("formats one aligned line per process type", () => {
    const processes = [
      "ASR",
      "AGENT",
      "TOOL",
      "VOICE",
      "IMAGE",
      "SAM",
      "GLIMMER",
      "DB",
      "ERROR",
    ] as const;
    for (const process of processes) {
      const parts = formatVlog({
        turn: "t042",
        process,
        model: "muse-spark-1.3",
        durationMs: 842,
        status: "ok",
        detail: { tool: "agenda_show" },
        content: "hello",
      }).split(" | ");
      expect(parts).toHaveLength(8);
      expect(parts[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
      expect(parts[1].trim()).toBe("t042");
      expect(parts[2].trim()).toBe(process);
      expect(parts[3].trim()).toBe("muse-spark-1.3");
      expect(parts[4].trim()).toBe("842ms");
      expect(parts[5].trim()).toBe("ok");
      expect(parts[6]).toBe("tool=agenda_show");
      expect(parts[7]).toBe("hello");
    }
  });

  it("clips console content to 64 chars and flattens newlines", () => {
    const content = formatVlog({
      turn: "-",
      process: "AGENT",
      status: "ok",
      content: `one\ntwo\r\n${"x".repeat(200)}`,
    }).split(" | ")[7];
    expect(content).toHaveLength(65);
    expect(content.endsWith("…")).toBe(true);
    expect(content).not.toMatch(/[\r\n]/);
  });

  it("keeps the model column narrow and typical rows short", () => {
    const short = formatVlog({ turn: "-", process: "DB", status: "ok" });
    expect(short.split(" | ")[3]).toHaveLength(14);
    const typical = formatVlog({
      turn: "t007",
      process: "VOICE",
      durationMs: 6566,
      status: "ok",
      detail: { gate: "ventana", tool: "session_open" },
      content: `Ballet, open a session with Emma. ${"y".repeat(200)}`,
    });
    expect(typical.length).toBeLessThanOrEqual(170);
  });

  it("sends errors and timeouts to stderr", () => {
    const errors: string[] = [];
    const saved = console.error;
    console.error = (line: string) => void errors.push(line);
    try {
      vlog({ turn: "-", process: "ASR", status: "error" });
      vlog({ turn: "-", process: "VOICE", status: "timeout" });
      expect(errors).toHaveLength(2);
    } finally {
      console.error = saved;
    }
  });

  it("keeps the recording full and the secrets out of every line", () => {
    const saved = process.env.VALE_EVENTLOG_PATH;
    const file = join(tmpdir(), `events-test-${Date.now()}.jsonl`);
    const seen: string[] = [];
    const savedLog = console.log;
    console.log = (line: string) => void seen.push(line);
    try {
      process.env.VALE_EVENTLOG_PATH = file;
      const widget = { kind: "agenda", title: "Today", size: "half", data: {} };
      const secret = 'Bearer abcDEF123 and {"api_key":"sk-live-1"}';
      vlog({
        turn: "t042",
        process: "VOICE",
        status: "ok",
        detail: { widget: "agenda" },
        content: `${secret} ${"y".repeat(200)}`,
        extra: { widget },
      });
      // Console: one aligned row, clipped content, no secrets.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("t042");
      expect(seen[0]).not.toContain("abcDEF123");
      expect(seen[0]).not.toContain("sk-live-1");
      expect(seen[0]).toContain("[redacted]");
      // Recording: full content, widget payload intact, secrets scrubbed.
      const row = JSON.parse(readFileSync(file, "utf8").trim());
      expect(row.turn).toBe("t042");
      expect(row.process).toBe("VOICE");
      expect(row.content).toContain("y".repeat(200));
      expect(row.content).not.toContain("sk-live-1");
      expect(row.content).not.toContain("abcDEF123");
      expect(row.widget).toEqual(widget);
      expect(row.detail).toEqual({ widget: "agenda" });
    } finally {
      console.log = savedLog;
      if (saved === undefined) delete process.env.VALE_EVENTLOG_PATH;
      else process.env.VALE_EVENTLOG_PATH = saved;
      rmSync(file, { force: true });
    }
  });

  it("routes the recording to data/logs live and beside eval turns files", () => {
    const savedTurns = process.env.VALE_TURNS_PATH;
    const savedEvents = process.env.VALE_EVENTLOG_PATH;
    try {
      delete process.env.VALE_EVENTLOG_PATH;
      delete process.env.VALE_TURNS_PATH;
      expect(eventLogFile(new Date("2026-11-03T00:00:00.000Z"))).toBe(
        join(process.cwd(), "data", "logs", "2026-11-03.jsonl"),
      );
      process.env.VALE_EVENTLOG_PATH = "/tmp/eval-events.jsonl";
      expect(eventLogFile()).toBe("/tmp/eval-events.jsonl");
      delete process.env.VALE_EVENTLOG_PATH;
      process.env.VALE_TURNS_PATH = "/tmp/eval-turns.jsonl";
      expect(eventLogFile(new Date("2026-11-03T00:00:00.000Z"))).toBe(
        join("/tmp", "events-2026-11-03.jsonl"),
      );
    } finally {
      if (savedTurns === undefined) delete process.env.VALE_TURNS_PATH;
      else process.env.VALE_TURNS_PATH = savedTurns;
      if (savedEvents === undefined) delete process.env.VALE_EVENTLOG_PATH;
      else process.env.VALE_EVENTLOG_PATH = savedEvents;
    }
  });

  it("still reports the model elapsed time", () => {
    expect(modelElapsedMs(800, 1000)).toBe(800);
    expect(modelElapsedMs(null, Date.now() - 50)).toBeGreaterThanOrEqual(0);
  });
});

describe("turn log persistence", () => {
  it("formats one [voice-turn] JSON line per turn", () => {
    const line = formatTurnLog({
      ts: "2026-10-31T00:00:00.000Z",
      turn: "t042",
      language: "es",
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
      turn: "t042",
      transcript: "hola",
      ignored: true,
      gate: "ignorado",
    });
  });

  it("reports the real missing fraction, not blocks over blocks", () => {
    const pctOf = (lostBlocks: number, srcBlocks: number): unknown => {
      const line = formatTurnLog({
        ts: "2026-10-31T00:00:00.000Z",
        language: "en",
        transcript: "Vale",
        ttftMs: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        audioSeconds: 0,
        tool: null,
        modelSkipped: true,
        error: null,
        ignored: false,
        lostBlocks,
        srcBlocks,
      });
      return JSON.parse(line.slice("[voice-turn] ".length)).lostPct;
    };
    expect(pctOf(0, 451)).toBe(0);
    expect(pctOf(87, 421)).toBeCloseTo(0.608, 3);
    expect(pctOf(110, 736)).toBeCloseTo(0.529, 3);
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

  it("shows the vlog row on console and keeps the JSON in the files", () => {
    const saved = process.env.VALE_TURNS_PATH;
    const savedEvents = process.env.VALE_EVENTLOG_PATH;
    const file = join(tmpdir(), `turns-test-${Date.now()}.jsonl`);
    const eventsFile = join(tmpdir(), `events-test-${Date.now()}.jsonl`);
    const savedLog = console.log;
    const seen: string[] = [];
    console.log = (line: string) => void seen.push(line);
    try {
      process.env.VALE_TURNS_PATH = file;
      process.env.VALE_EVENTLOG_PATH = eventsFile;
      const fields = {
        ts: "2026-10-31T00:00:00.000Z",
        turn: "t042",
        language: "es" as const,
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
      expect(lines[0]).toContain('"turn":"t042"');
      expect(lines[1]).toBe("[voice-turn] custom");
      // Console shows the aligned row, not the JSON.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("| VOICE ");
      expect(seen[0]).toContain("vale?");
      expect(seen[0]).not.toContain("[voice-turn]");
      // The recording keeps the full turn for replay.
      const row = JSON.parse(readFileSync(eventsFile, "utf8").trim());
      expect(row.turn).toBe("t042");
      expect(row.turnFields).toMatchObject({ turn: "t042", transcript: "vale?" });
      expect(row.extra).toBeUndefined();
    } finally {
      console.log = savedLog;
      if (saved === undefined) delete process.env.VALE_TURNS_PATH;
      else process.env.VALE_TURNS_PATH = saved;
      if (savedEvents === undefined) delete process.env.VALE_EVENTLOG_PATH;
      else process.env.VALE_EVENTLOG_PATH = savedEvents;
      rmSync(file, { force: true });
      rmSync(eventsFile, { force: true });
    }
  });
});
