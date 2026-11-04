import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServicesScreen } from "./ServicesScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? "GET" });
      if (href.includes("/api/manage/services")) {
        return Response.json([
          { id: 4, name: "Gel", es: "", priceUsd: 40, durationMin: 60, supplies: [] },
        ]);
      }
      if (href.includes("/api/manage/supplies")) return Response.json([]);
      if (href.includes("/api/manage/service")) return Response.json({ ok: true, message: "Gel saved.", data: { service_id: 4 } });
      return Response.json({ ok: true, message: "Done." });
    }),
  );
  return calls;
}

describe("ServicesScreen", () => {
  it("renders services with price and duration", async () => {
    stubFetch();
    render(<ServicesScreen onBack={() => {}} />);
    expect(await screen.findByText("Gel")).toBeTruthy();
    expect(screen.getByText("$40 · 60 min")).toBeTruthy();
  });

  it("saves a new service", async () => {
    const calls = stubFetch();
    render(<ServicesScreen onBack={() => {}} />);
    await screen.findByText("Gel");
    fireEvent.click(screen.getByText("+ Service"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pedicure" } });
    fireEvent.change(screen.getByLabelText("Price USD"), { target: { value: "35" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/service") && call.method === "POST")).toBe(true);
    });
  });

  it("deletes a service after confirming", async () => {
    const calls = stubFetch();
    render(<ServicesScreen onBack={() => {}} />);
    await screen.findByText("Gel");
    fireEvent.click(screen.getByText("Gel"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm delete"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/service") && call.method === "DELETE")).toBe(true);
    });
  });
});
