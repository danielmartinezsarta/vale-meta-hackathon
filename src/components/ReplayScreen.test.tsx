import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayScreen } from "./ReplayScreen";
import { speak } from "@/lib/speak";

vi.mock("@/lib/speak", () => ({
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
}));

const mockSpeak = vi.mocked(speak);

const RUN = {
  version: 1,
  recordedAt: "2026-11-03T19:50:00.000Z",
  turns: [
    {
      turn: "t901",
      transcript: "Vale, what do I have today?",
      language: "en",
      tool: "agenda_show",
      toolArgs: {},
      reply: "Today: David at 3 PM.",
      widget: null,
      board: { session: null, card: null, list: ["Acetone"] },
      costUsd: 0.004,
    },
    {
      turn: "t902",
      transcript: "Vale, how is my goal?",
      language: "en",
      tool: "goal_show",
      toolArgs: {},
      reply: "Here is your goal.",
      widget: { kind: "goal", title: "Monthly goal", size: "half", data: { name: null, goal: 2500, earned: 1360 } },
      board: { session: null, card: null, list: ["Acetone"] },
      costUsd: 0.005,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReplayScreen (VALE_REPLAY=1)", () => {
  it("labels the run, plays it end to end and voices every reply", async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = typeof input === "string" ? input : String(input);
        fetched.push(url);
        if (url === "/api/replay") {
          return { ok: true, text: async () => JSON.stringify(RUN) };
        }
        throw new Error(`unexpected network in replay mode: ${url}`);
      }),
    );
    render(<ReplayScreen stepMs={20} />);
    await waitFor(() => {
      expect(screen.getByText("Replay: recorded run")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("Today: David at 3 PM.")).toBeTruthy();
      expect(screen.getByText("Here is your goal.")).toBeTruthy();
    });
    // The agent-to-voice path: each recorded reply reaches speak once.
    expect(mockSpeak).toHaveBeenCalledWith("Today: David at 3 PM.", "en");
    expect(mockSpeak).toHaveBeenCalledWith("Here is your goal.", "en");
    expect(mockSpeak).toHaveBeenCalledTimes(2);
    // The recorded sheet and board render from the run payloads.
    expect(screen.getByRole("dialog", { name: "Monthly goal" })).toBeTruthy();
    expect(screen.getByText("Acetone")).toBeTruthy();
    // Zero network calls to Meta (or anywhere else) in replay mode.
    expect(fetched).toEqual(["/api/replay"]);
    expect(fetched.some((url) => url.includes("meta"))).toBe(false);
  });
});
