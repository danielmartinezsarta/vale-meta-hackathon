import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalsScreen } from "./GoalsScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SETTINGS = {
  monthlyGoalUsd: 2500,
  marginPct: 30,
  schedule: "lun-vie",
  workHoursPerDay: 8,
  fixedCosts: [{ id: 41, label: "studio rent", amountUsd: 800 }],
};

function stubFetch() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? "GET" });
      if (href.includes("/api/manage/goal")) {
        return Response.json({ ok: true, message: "Progress.", data: { earned_usd: 40, goal_usd: 2500, month: "2026-11" } });
      }
      if (href.includes("/api/manage/settings")) return Response.json(SETTINGS);
      if (href.includes("/api/manage/fixed-cost")) return Response.json({ ok: true, message: "Fixed cost added.", data: { fixed_cost_id: 41 } });
      return Response.json({ ok: true, message: "Done." });
    }),
  );
  return calls;
}

describe("GoalsScreen", () => {
  it("renders month progress with the same goal figure", async () => {
    stubFetch();
    render(<GoalsScreen onBack={() => {}} />);
    expect(await screen.findByText("$40 of $2500", { exact: false })).toBeTruthy();
    expect(screen.getByText("studio rent", { exact: false })).toBeTruthy();
  });

  it("saves the edited goal", async () => {
    const calls = stubFetch();
    render(<GoalsScreen onBack={() => {}} />);
    await screen.findByText("Edit goal");
    fireEvent.click(screen.getByText("Edit goal"));
    fireEvent.change(screen.getByLabelText("Monthly goal USD"), { target: { value: "3000" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/settings") && call.method === "POST")).toBe(true);
    });
  });

  it("deletes a fixed cost after confirming", async () => {
    const calls = stubFetch();
    render(<GoalsScreen onBack={() => {}} />);
    await screen.findByText("studio rent", { exact: false });
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/fixed-cost") && call.method === "DELETE")).toBe(true);
    });
  });
});
