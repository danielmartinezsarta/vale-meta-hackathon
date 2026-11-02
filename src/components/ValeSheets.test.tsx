import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ValeSheets, CareOverlay } from "./ValeSheets";
import type { Widget } from "@/lib/widget";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSheet(widget: Widget) {
  return render(<ValeSheets widget={widget} onClose={vi.fn()} />);
}

describe("ValeSheets (Ali's sheet per kind)", () => {
  it("renders the client card with health first, then visits and notes", () => {
    renderSheet({
      kind: "client_card",
      title: "Client card",
      size: "full",
      data: {
        name: "David",
        birthday: "March 14",
        sex: "Male",
        phone: "+1 (555) 014-2200",
        email: "david@example.com",
        visits: [{ date: "Oct 12, 2026", service: "Gel manicure" }],
        visitsMore: 2,
        healthNotes: ["Allergic to monomer"],
        noteTags: ["Always on time"],
      },
    });
    expect(screen.getByText("David")).toBeTruthy();
    expect(screen.getByText("On screen only")).toBeTruthy();
    expect(screen.getByText("Allergic to monomer")).toBeTruthy();
    expect(screen.getByText("Oct 12, 2026")).toBeTruthy();
    expect(screen.getByText("+ 2 earlier visits")).toBeTruthy();
    expect(screen.getByText("Always on time")).toBeTruthy();
  });

  it("hides the card health block when there are no health notes", () => {
    renderSheet({
      kind: "client_card",
      title: "Client card",
      size: "full",
      data: {
        name: "David",
        birthday: null,
        sex: null,
        phone: null,
        email: null,
        visits: [],
        visitsMore: 0,
        healthNotes: [],
        noteTags: [],
      },
    });
    expect(screen.queryByText("On screen only")).toBeNull();
  });

  it("renders the goal bar with amounts, never as voice text", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    renderSheet({
      kind: "goal",
      title: "Monthly goal",
      size: "half",
      data: { name: null, goal: 2500, earned: 1360 },
    });
    expect(screen.getByText("Monthly goal")).toBeTruthy();
    expect(screen.getByText("$2,500")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Monthly goal progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("54");
  });

  it("renders the price with lock and Reject/Accept", () => {
    const onReject = vi.fn();
    render(
      <ValeSheets
        widget={{
          kind: "price",
          title: "Price",
          size: "half",
          data: { service: "Manicure", extras: 7, suggested: 35 },
        }}
        onReject={onReject}
      />,
    );
    expect(screen.getByText("Manicure")).toBeTruthy();
    expect(screen.getByText("$35")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
  });

  it("renders the booked sheet with the longhand date", () => {
    renderSheet({
      kind: "booked",
      title: "Appointment booked",
      size: "half",
      data: { client: "David", service: "Gel manicure", day: "2026-11-27", time: "15:00" },
    });
    expect(screen.getByText("Friday, November 27")).toBeTruthy();
    expect(screen.getByText("David")).toBeTruthy();
  });

  it("renders the summary with service, time, and cost blocks", () => {
    renderSheet({
      kind: "session_summary",
      title: "Session summary",
      size: "full",
      data: {
        client: "David",
        date: "Nov 2, 2026",
        service: { name: "Gel manicure", price: 28 },
        extras: [{ label: "Gold foil", amount: 7 }],
        suggested: 35,
        charged: 35,
        timeTotal: "1h 12m",
        timeParts: [{ label: "Apply", time: "20m" }],
        costs: [{ label: "Supplies", amount: 4 }],
        fixedDetail: "$0.60 of this service",
      },
    });
    expect(screen.getByText("David")).toBeTruthy();
    expect(screen.getAllByText("$35")).toHaveLength(2);
    expect(screen.getByText("1h 12m")).toBeTruthy();
  });

  it("renders the health and regular note sheets", () => {
    renderSheet({
      kind: "health_note",
      title: "Health note",
      size: "half",
      data: { text: "Allergic to monomer", client: "David" },
    });
    expect(screen.getByText("Allergic to monomer")).toBeTruthy();
    expect(screen.getByText("On screen only")).toBeTruthy();
  });

  it("renders the camera choices and photo placeholders", () => {
    const onChoose = vi.fn();
    render(
      <ValeSheets
        widget={{ kind: "camera_save_as", title: "Save photo as", size: "half", data: {} }}
        onChoose={onChoose}
      />,
    );
    expect(screen.getByRole("button", { name: /Before/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Final photo/ })).toBeTruthy();
  });

  it("renders the good-job overlay with care icons", () => {
    render(<CareOverlay caption="Good job!" />);
    expect(screen.getByText("Good job!")).toBeTruthy();
    expect(screen.getByText("Water")).toBeTruthy();
    expect(screen.getByText("Stretch")).toBeTruthy();
  });
});
