import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentsScreen } from "./PaymentsScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PAYMENTS = [
  { id: 21, amountUsd: 55, createdAt: "2026-11-03T10:00:00", client: "Ana", service: "Gel", sessionId: 31, durationS: 3600 },
];
const SESSIONS = [
  { sessionId: 31, client: "Ana", service: "Gel", startedAt: "2026-11-03T09:00:00", durationS: 3600, supplies: [], paid: true },
];

function stubFetch() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? "GET" });
      if (href.includes("/api/manage/payments")) return Response.json(PAYMENTS);
      if (href.includes("/api/manage/sessions")) return Response.json(SESSIONS);
      if (href.includes("/api/manage/payment")) return Response.json({ ok: true, message: "Payment saved.", data: { payment_id: 21 } });
      return Response.json({ ok: true, message: "Done." });
    }),
  );
  return calls;
}

describe("PaymentsScreen", () => {
  it("renders charges with client and amount", async () => {
    stubFetch();
    render(<PaymentsScreen onBack={() => {}} />);
    expect(await screen.findByText("Ana", { exact: false })).toBeTruthy();
    expect(screen.getByText("Gel · $55", { exact: false })).toBeTruthy();
  });

  it("saves a charge on a session", async () => {
    const calls = stubFetch();
    render(<PaymentsScreen onBack={() => {}} />);
    await screen.findByText("Ana", { exact: false });
    fireEvent.click(screen.getByText("+ Charge"));
    fireEvent.change(screen.getByLabelText("Session"), { target: { value: "31" } });
    fireEvent.change(screen.getByLabelText("Amount USD"), { target: { value: "55" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/payment") && call.method === "POST")).toBe(true);
    });
  });

  it("deletes a charge after confirming", async () => {
    const calls = stubFetch();
    render(<PaymentsScreen onBack={() => {}} />);
    await screen.findByText("Ana", { exact: false });
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/payment") && call.method === "DELETE")).toBe(true);
    });
  });
});
