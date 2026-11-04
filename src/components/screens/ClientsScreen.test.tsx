import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientsScreen } from "./ClientsScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DETAIL = {
  id: 3,
  name: "Maya",
  sex: "female",
  phone: "+1-555-0103",
  email: "maya@example.com",
  birthday: "1991-02-02",
  notes: [{ id: 5, kind: "note", text: "Prefers morning slots", masked: false }],
  healthAlert: false,
  visits: [{ id: 8, visitedAt: "2026-10-01T12:00:00", service: "Gel", photo: "", note: "" }],
  brief: null,
};

function stubFetch() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? "GET" });
      if (href.includes("/api/manage/client?id=")) return Response.json(DETAIL);
      if (href.includes("/api/manage/clients")) return Response.json([{ id: 3, name: "Maya", phone: "+1-555-0103", next: null }]);
      if (href.includes("/api/manage/client")) return Response.json({ ok: true, message: "Maya saved.", data: { client_id: 3 } });
      if (href.includes("/api/manage/note")) return Response.json({ ok: true, message: "Note saved.", data: { note_id: 5 } });
      return Response.json({ ok: true, message: "Done." });
    }),
  );
  return calls;
}

describe("ClientsScreen", () => {
  it("renders the client list with the next visit", async () => {
    stubFetch();
    render(<ClientsScreen onBack={() => {}} />);
    expect(await screen.findByText("Maya")).toBeTruthy();
    expect(screen.getByText("No upcoming visit")).toBeTruthy();
  });

  it("saves a new client", async () => {
    const calls = stubFetch();
    render(<ClientsScreen onBack={() => {}} />);
    await screen.findByText("Maya");
    fireEvent.click(screen.getByText("+ Client"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Lena" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/client") && call.method === "POST")).toBe(true);
    });
  });

  it("deletes a client after confirming", async () => {
    const calls = stubFetch();
    render(<ClientsScreen onBack={() => {}} />);
    await screen.findByText("Maya");
    fireEvent.click(screen.getByText("Maya"));
    await screen.findByText("Delete client");
    fireEvent.click(screen.getByText("Delete client"));
    fireEvent.click(screen.getByText("Confirm delete"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/client") && call.method === "DELETE")).toBe(true);
    });
  });
});
