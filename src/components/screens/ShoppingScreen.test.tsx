import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShoppingScreen } from "./ShoppingScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SHOPPING = {
  items: [{ id: 11, supplyId: 6, name: "Acetone", stockQty: 1 }],
  suggestions: [{ supplyId: 12, name: "Cotton pads", stockQty: 0 }],
};

function stubFetch() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? "GET" });
      if (href.includes("/api/manage/shopping") && (options?.method ?? "GET") === "GET") return Response.json(SHOPPING);
      if (href.includes("/api/manage/supplies")) return Response.json([{ id: 6, name: "Acetone" }, { id: 12, name: "Cotton pads" }]);
      return Response.json({ ok: true, message: "Done." });
    }),
  );
  return calls;
}

describe("ShoppingScreen", () => {
  it("renders items and low-stock suggestions", async () => {
    stubFetch();
    render(<ShoppingScreen onBack={() => {}} />);
    expect(await screen.findByText("Acetone")).toBeTruthy();
    // Suggestion row plus the add-item picker option.
    expect(screen.getAllByText("Cotton pads")).toHaveLength(2);
  });

  it("adds a suggested supply to the list", async () => {
    const calls = stubFetch();
    render(<ShoppingScreen onBack={() => {}} />);
    await screen.findAllByText("Cotton pads");
    fireEvent.click(screen.getByRole("button", { name: "Add Cotton pads" }));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/shopping-add") && call.method === "POST")).toBe(true);
    });
  });

  it("removes an item from the list", async () => {
    const calls = stubFetch();
    render(<ShoppingScreen onBack={() => {}} />);
    await screen.findByText("Acetone");
    fireEvent.click(screen.getByRole("button", { name: "Remove Acetone" }));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/shopping") && call.method === "DELETE")).toBe(true);
    });
  });
});
