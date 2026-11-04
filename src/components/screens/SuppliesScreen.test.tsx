import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuppliesScreen } from "./SuppliesScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SUPPLIES = [
  { id: 6, name: "Acetone", es: "", unit: "ml", contentPerProduct: 100, stockQty: 1, minQty: 2, pricePerProductUsd: 4, low: true },
];

function stubFetch() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? "GET" });
      if (href.includes("/api/manage/supplies")) return Response.json(SUPPLIES);
      if (href.includes("/api/manage/supply")) return Response.json({ ok: true, message: "Acetone saved.", data: { supply_id: 6 } });
      return Response.json({ ok: true, message: "Done." });
    }),
  );
  return calls;
}

describe("SuppliesScreen", () => {
  it("renders stock with the Low badge", async () => {
    stubFetch();
    render(<SuppliesScreen onBack={() => {}} />);
    expect(await screen.findByText("Acetone")).toBeTruthy();
    expect(screen.getByText("Low")).toBeTruthy();
  });

  it("saves a new supply", async () => {
    const calls = stubFetch();
    render(<SuppliesScreen onBack={() => {}} />);
    await screen.findByText("Acetone");
    fireEvent.click(screen.getByText("+ Supply"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Buffer" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/supply") && call.method === "POST")).toBe(true);
    });
  });

  it("deletes a supply after confirming", async () => {
    const calls = stubFetch();
    render(<SuppliesScreen onBack={() => {}} />);
    await screen.findByText("Acetone");
    fireEvent.click(screen.getByText("Acetone"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm delete"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/supply") && call.method === "DELETE")).toBe(true);
    });
  });
});
