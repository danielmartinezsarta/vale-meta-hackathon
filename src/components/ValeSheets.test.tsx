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
        visits: [
          { date: "2026-10-12", service: "Gel manicure", photo: "/api/photos?file=post_3.jpg" },
        ],
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
    // The camera affordance returns once a visit carries real photos.
    expect(
      screen
        .getByRole("button", { name: /open the photos of this visit/ })
        .querySelector("svg"),
    ).not.toBeNull();
    expect(screen.getByText("Always on time")).toBeTruthy();
  });

  it("shows no camera affordance when the visit carries no photo", () => {
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
        visits: [{ date: "2026-10-12", service: "Gel manicure", photo: null }],
        visitsMore: 0,
        healthNotes: [],
        noteTags: [],
      },
    });
    expect(
      screen
        .getByRole("button", { name: /open the photos of this visit/ })
        .querySelector("svg"),
    ).toBeNull();
  });

  it("contains stored photos to their slot width", () => {
    renderSheet({
      kind: "photos",
      title: "Photos",
      size: "full",
      data: { before: "/api/photos?file=pre_7.jpg", reference: null, expected: null, final: null },
    });
    const img = document.querySelector(".aw-pics img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("/api/photos?file=pre_7.jpg");
    expect(img?.style.width).toBe("100%");
  });

  it("renders only slots with real images, one image full width", () => {
    renderSheet({
      kind: "photos",
      title: "Photos",
      size: "full",
      data: { before: null, reference: "r-url", expected: null, final: null },
    });
    const tiles = document.querySelectorAll(".aw-pics > .aw-pic");
    expect(tiles).toHaveLength(1);
    expect(tiles[0].className).toContain("aw-pic--solo");
    expect(tiles[0].getAttribute("data-slot")).toBe("reference");
    expect(document.querySelector('[data-slot="before"]')).toBeNull();
    expect(document.querySelector('[data-slot="expected"]')).toBeNull();
    expect(document.querySelector(".aw-pics__note")).toBeNull();
  });

  it("lets the final photo replace the expected tile without the credit", () => {
    renderSheet({
      kind: "photos",
      title: "Photos",
      size: "full",
      data: { before: "b-url", reference: "r-url", expected: "e-url", final: "f-url" },
    });
    expect(document.querySelectorAll(".aw-pics > .aw-pic")).toHaveLength(3);
    expect(document.querySelector('[data-slot="expected"]')).toBeNull();
    const final = document.querySelector('[data-slot="final"]');
    expect(final?.className).toContain("aw-pic--wide");
    expect(final?.textContent).toMatch(/Final/);
    expect(document.querySelector(".aw-pics__note")).toBeNull();
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
    render(<CareOverlay />);
    expect(screen.getByText("Water")).toBeTruthy();
    expect(screen.getByText("Food")).toBeTruthy();
    expect(screen.getByText("Stretch")).toBeTruthy();
  });

  it("marks the mounted sheet open so Ali's CSS shows it", async () => {
    renderSheet({
      kind: "goal",
      title: "Monthly goal",
      size: "half",
      data: { name: null, goal: 600, earned: 120 },
    });
    const sheet = screen.getByRole("dialog", { name: "Monthly goal" });
    await vi.waitFor(() => {
      expect(sheet.className).toContain("is-open");
    });
  });

  it("marks every Ali sheet open so each kind can show", async () => {
    const sheets: Widget[] = [
      { kind: "client_card", title: "Client card", size: "full", data: { name: "David", birthday: null, sex: null, phone: null, email: null, visits: [], visitsMore: 0, healthNotes: [], noteTags: [] } },
      { kind: "goal", title: "Monthly goal", size: "half", data: { name: null, goal: 600, earned: 120 } },
      { kind: "camera_save_as", title: "Save photo as", size: "half", data: {} },
      { kind: "photos", title: "Photos", size: "full", data: { before: null, reference: null, expected: null, final: null } },
      { kind: "health_note", title: "Health note", size: "half", data: { text: "Allergic to monomer", client: "David" } },
      { kind: "note", title: "Note saved", size: "half", data: { text: "Likes neon colors", client: "David" } },
      { kind: "price", title: "Price", size: "half", data: { service: "Manicure", extras: null, suggested: 35 } },
      { kind: "final_photo_confirm", title: "Save final photo", size: "full", data: { photo: null } },
      { kind: "final_result", title: "Final result", size: "full", data: { photo: null, description: null } },
      { kind: "booked", title: "Appointment booked", size: "half", data: { client: "David", service: "Manicure", day: "2026-11-27", time: "15:00" } },
      { kind: "session_summary", title: "Session summary", size: "full", data: { client: "David", date: "Nov 2, 2026", service: { name: "Gel removal", price: 24 }, extras: [], suggested: 24, charged: 24, timeTotal: "11m", timeParts: [], costs: [], fixedDetail: null } },
    ];
    for (const widget of sheets) {
      const { container, unmount } = renderSheet(widget);
      const section = container.querySelector("section.aw-sheet");
      expect(section).not.toBeNull();
      await vi.waitFor(() => {
        expect(section?.className).toContain("is-open");
      });
      unmount();
    }
  });

  it("renders nothing for a kind outside the contract", () => {
    const { container } = renderSheet({
      kind: "agenda",
      title: "Agenda",
      size: "half",
      data: {},
    } as unknown as Widget);
    expect(container.firstChild).toBeNull();
  });

  it("attributes the photos preview to Muse Image with the expected slot wide", () => {
    renderSheet({
      kind: "photos",
      title: "Photos",
      size: "full",
      data: { before: "b-url", reference: "r-url", expected: "e-url", final: null },
    });
    expect(screen.getByText("Preview generated by Muse Image")).toBeTruthy();
    expect(screen.queryByText(/Muse Spark/)).toBeNull();
    const expected = document.querySelector('[data-slot="expected"]');
    expect(expected?.className).toContain("aw-pic--wide");
    const note = document.querySelector(".aw-pics__note");
    expect(note?.closest('[data-slot="expected"]')).not.toBeNull();
    expect(document.querySelectorAll(".aw-pics > .aw-pic")).toHaveLength(3);
  });
});
