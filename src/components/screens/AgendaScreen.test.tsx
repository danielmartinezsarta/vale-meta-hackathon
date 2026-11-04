import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgendaScreen } from "./AgendaScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const AGENDA = {
  appointments: [
    { id: 7, day: "2026-11-04", time: "10:00", client: "Ana", service: "Gel", clientId: 1, serviceId: 2, referencePhoto: "" },
  ],
  reminders: [{ id: 9, text: "Call Ana", kind: "call", day: "2026-11-04" }],
  undated: [],
};

function stubFetch() {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? "GET", body: typeof options?.body === "string" ? options.body : undefined });
      if (href.includes("/api/manage/agenda")) return Response.json(AGENDA);
      if (href.includes("/api/manage/clients")) return Response.json([{ id: 1, name: "Ana" }]);
      if (href.includes("/api/manage/services")) return Response.json([{ id: 2, name: "Gel" }]);
      if (href.includes("/api/manage/appointment")) return Response.json({ ok: true, message: "Saved.", data: { appointment_id: 7 } });
      if (href.includes("/api/manage/reminder")) return Response.json({ ok: true, message: "Reminder saved." });
      return Response.json({ ok: true, message: "Done." });
    }),
  );
  return calls;
}

describe("AgendaScreen", () => {
  it("renders the day bookings and reminders", async () => {
    stubFetch();
    render(<AgendaScreen onBack={() => {}} />);
    expect(await screen.findByRole("button", { name: /Ana/ })).toBeTruthy();
    expect(screen.getByText("Call Ana")).toBeTruthy();
  });

  it("saves a new appointment", async () => {
    const calls = stubFetch();
    render(<AgendaScreen onBack={() => {}} />);
    await screen.findByRole("button", { name: /Ana/ });
    fireEvent.click(screen.getByText("+ Appointment"));
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "Gel" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "11:00" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/appointment") && call.method === "POST")).toBe(true);
    });
  });

  it("cancels an appointment after confirming", async () => {
    const calls = stubFetch();
    render(<AgendaScreen onBack={() => {}} />);
    await screen.findByRole("button", { name: /Ana/ });
    fireEvent.click(screen.getByRole("button", { name: /Ana/ }));
    fireEvent.click(screen.getByText("Cancel appointment"));
    fireEvent.click(screen.getByText("Confirm cancel"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/appointment") && call.method === "DELETE")).toBe(true);
    });
  });
});
