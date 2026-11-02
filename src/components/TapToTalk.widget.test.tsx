import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);

class FakeWs {
  static instances: FakeWs[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.instances.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  serverMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  sentStrings(): string[] {
    return this.sent.filter((item) => typeof item === "string") as string[];
  }
}

function stubSessionOnce() {
  mockStartCapture.mockImplementation(() => ({
    stop: () => {},
    state: () => "running",
      engine: () => "script" as const,
  }));
}

afterEach(() => {
  cleanup();
  FakeWs.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openConversation() {
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  vi.stubGlobal("WebSocket", FakeWs);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("no post", { status: 500 })));
  stubSessionOnce();

  render(<TapToTalk debug />);
  fireEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
  await waitFor(() => {
    expect(FakeWs.instances).toHaveLength(1);
  });
  const ws = FakeWs.instances[0];
  expect(ws.url).toContain("/voice");
  ws.open();
  return ws;
}

describe("confirm card (touch equals voice)", () => {
  it("shows the pending proposal with big Yes/No and votes on touch", async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "confirm",
        title: "Open session with Ana for Gel refill?",
        lines: [],
        size: "half",
      },
    });
    await waitFor(() => {
      expect(
        screen.getByText("Open session with Ana for Gel refill?"),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => {
      expect(ws.sentStrings()).toContain(
        JSON.stringify({ type: "vote", vote: "yes" }),
      );
    });
  });

  it("a No tap votes no on the same socket", async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: { kind: "confirm", title: "Log Top coat?", lines: [], size: "half" },
    });
    await waitFor(() => {
      expect(screen.getByText("Log Top coat?")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await waitFor(() => {
      expect(ws.sentStrings()).toContain(
        JSON.stringify({ type: "vote", vote: "no" }),
      );
    });
  });

  it("renders goal amounts on screen, never as voice text", async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "goal",
        title: "Monthly goal",
        size: "half",
        data: { name: null, goal: 600, earned: 120 },
      },
    });
    await waitFor(() => {
      expect(screen.getByText("Monthly goal")).toBeTruthy();
      expect(screen.getByText("$600")).toBeTruthy();
    });
    expect(
      screen.queryByRole("button", { name: "Yes" }),
    ).toBeNull();
  });

  it("closes the sheet on a spoken close order, no model round-trip", async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "price",
        title: "Price",
        size: "half",
        data: { service: "Manicure", extras: null, suggested: 35 },
      },
    });
    await waitFor(() => {
      expect(screen.getByText("Price")).toBeTruthy();
    });
    // A short close order with the sheet open dismisses the turn instead
    // of riding to the model.
    ws.serverMessage({
      type: "transcript",
      transcript: "close the price",
      final: true,
    });
    await waitFor(() => {
      expect(ws.sentStrings()).toContain(
        JSON.stringify({ type: "dismiss", transcript: "close the price" }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("Price")).toBeNull();
    });
  });
});

describe("Ali sheet flows", () => {
  it("auto-hides the booked sheet after 3 s", { timeout: 15000 }, async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "booked",
        title: "Appointment booked",
        size: "half",
        data: { client: "Daniel", service: "Manicure", day: "2026-11-03", time: "10:00 a.m." },
      },
    });
    await waitFor(() => {
      expect(screen.getByText("Appointment booked")).toBeTruthy();
    });
    await waitFor(
      () => {
        expect(screen.queryByText("Appointment booked")).toBeNull();
      },
      { timeout: 5000 },
    );
    expect(ws.sentStrings()).toContain(JSON.stringify({ type: "sheet-closed" }));
  });

  it("runs summary, then Good job, then back to awake", { timeout: 30000 }, async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "session_summary",
        title: "Session summary",
        size: "full",
        data: {
          client: "David",
          date: "Nov 2, 2026",
          service: { name: "Gel removal", price: 24 },
          extras: [],
          suggested: 24,
          charged: 24,
          timeTotal: "11m",
          timeParts: [],
          costs: [],
          fixedDetail: null,
        },
      },
    });
    await waitFor(() => {
      expect(screen.getByText("Session summary")).toBeTruthy();
    });
    await waitFor(
      () => {
        expect(screen.queryByText("Session summary")).toBeNull();
      },
      { timeout: 8000 },
    );
    await waitFor(
      () => {
        expect(screen.getByText("Good job!")).toBeTruthy();
      },
      { timeout: 8000 },
    );
    await waitFor(
      () => {
        expect(screen.queryByText("Good job!")).toBeNull();
      },
      { timeout: 8000 },
    );
  });

  it("opens the photos sheet from a visit tap", async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "client_card",
        title: "Daniel",
        size: "half",
        data: {
          name: "David",
          birthday: null,
          sex: null,
          phone: null,
          email: null,
          visits: [{ date: "2026-10-20", service: "Gel removal" }],
          visitsMore: 0,
          healthNotes: [],
          noteTags: [],
        },
      },
    });
    await waitFor(() => {
      expect(screen.getByText("David")).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", { name: /open the photos of this visit/ }),
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Photos" })).toBeTruthy();
    });
  });

  it("closes the card on its X and reports sheet-closed", async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "client_card",
        title: "Daniel",
        size: "half",
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
      },
    });
    await waitFor(() => {
      expect(screen.getByText("David")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Close client card" }));
    await waitFor(() => {
      expect(screen.queryByText("David")).toBeNull();
    });
    expect(ws.sentStrings()).toContain(JSON.stringify({ type: "sheet-closed" }));
  });

  it("runs Final photo then Accept into the result sheet", async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: { kind: "camera_save_as", title: "Save photo as", size: "half", data: {} },
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Save photo as" })).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Final photo"));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Save final photo" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Final result" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Close final result" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Final result" })).toBeNull();
    });
  });

  it("dismisses the price sheet on Accept with no vote", async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "price",
        title: "Price",
        size: "half",
        data: { service: "Manicure", extras: null, suggested: 35 },
      },
    });
    await waitFor(() => {
      expect(screen.getByText("Price")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(screen.queryByText("Price")).toBeNull();
    });
    expect(ws.sentStrings()).not.toContain(JSON.stringify({ type: "vote", vote: "yes" }));
  });
});
