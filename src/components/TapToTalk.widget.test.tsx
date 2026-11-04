import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

let captureStarted = false;

function stubSessionOnce() {
  captureStarted = false;
  mockStartCapture.mockImplementation(() => {
    captureStarted = true;
    return {
      stop: () => {},
      state: () => "running",
      engine: () => "script" as const,
    };
  });
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

  render(<TapToTalk autoStart />);
  await waitFor(() => {
    expect(FakeWs.instances).toHaveLength(1);
  });
  const ws = FakeWs.instances[0];
  expect(ws.url).toContain("/voice");
  ws.open();
  // Capture (and the first turn) starts only after /voice answers.
  await waitFor(() => {
    expect(captureStarted).toBe(true);
  });
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
    const confirmSheet = await screen.findByRole("dialog", {
      name: "Open session with Ana for Gel refill?",
    });
    expect(
      within(confirmSheet).getByRole("button", { name: "Yes" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => {
      const votes = ws
        .sentStrings()
        .map((raw) => JSON.parse(raw) as { type?: string; vote?: string; turn?: unknown })
        .filter((msg) => msg.type === "vote");
      expect(votes.length).toBeGreaterThan(0);
      expect(votes[votes.length - 1].vote).toBe("yes");
      expect(votes[votes.length - 1].turn).toMatch(/^t\d+$/);
    });
  });

  it("a No tap votes no on the same socket", async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "widget",
      widget: { kind: "confirm", title: "Log Top coat?", lines: [], size: "half" },
    });
    const noSheet = await screen.findByRole("dialog", { name: "Log Top coat?" });
    expect(within(noSheet).getByRole("button", { name: "No" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await waitFor(() => {
      const votes = ws
        .sentStrings()
        .map((raw) => JSON.parse(raw) as { type?: string; vote?: string; turn?: unknown })
        .filter((msg) => msg.type === "vote");
      expect(votes.length).toBeGreaterThan(0);
      expect(votes[votes.length - 1].vote).toBe("no");
      expect(votes[votes.length - 1].turn).toMatch(/^t\d+$/);
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
      const dismisses = ws
        .sentStrings()
        .map(
          (raw) =>
            JSON.parse(raw) as { type?: string; transcript?: string; turn?: unknown },
        )
        .filter((msg) => msg.type === "dismiss");
      expect(dismisses.length).toBeGreaterThan(0);
      expect(dismisses[dismisses.length - 1].transcript).toBe("close the price");
      expect(dismisses[dismisses.length - 1].turn).toMatch(/^t\d+$/);
    });
    await waitFor(() => {
      expect(screen.queryByText("Price")).toBeNull();
    });
  });
});

describe("sheet flows", () => {
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
          earned: null,
          stdMinutes: null,
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

  it("auto-hides a display-only sheet that arrives mid-speech, client card stays", { timeout: 30000 }, async () => {
    const ws = await openConversation();
    // The reply puts Vale in speaking: the note widget arrives mid-speech.
    ws.serverMessage({ type: "reply", text: "Note saved for Nina." });
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "note",
        title: "Note saved",
        size: "half",
        data: { text: "Likes neon colors", client: "David" },
      },
    });
    await waitFor(() => {
      expect(screen.getByText("Note saved")).toBeTruthy();
    });
    await waitFor(
      () => {
        expect(screen.queryByText("Note saved")).toBeNull();
      },
      { timeout: 8000 },
    );
    // The client card never auto-hides, even past the auto-hide delay.
    ws.serverMessage({
      type: "widget",
      widget: {
        kind: "client_card",
        title: "Nina",
        size: "half",
        data: {
          name: "Nina",
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
    const cardSheet = await screen.findByRole("dialog", { name: "Client card" });
    expect(within(cardSheet).getAllByText("Nina").length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect(screen.queryByRole("dialog", { name: "Client card" })).toBeTruthy();
  });

  it("opens the photos sheet from a visit tap", async () => {
    const ws = await openConversation();
    ws.serverMessage({
      type: "board",
      board: {
        session: { id: 7, clientName: "David", serviceName: "Gel manicure", startedAt: "2026-11-02T10:00:00.000Z" },
        card: null,
        list: [],
      },
    });
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
          visits: [{ date: "2026-10-20", service: "Gel removal", photo: null }],
          visitsMore: 0,
          healthNotes: [],
          noteTags: [],
        },
      },
    });
    const cardSheet = await screen.findByRole("dialog", { name: "Client card" });
    expect(within(cardSheet).getByText("David")).toBeTruthy();
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
    const closeSheet = await screen.findByRole("dialog", { name: "Client card" });
    expect(within(closeSheet).getByText("David")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close client card" }));
    await waitFor(() => {
      expect(screen.queryByText("David")).toBeNull();
    });
    expect(ws.sentStrings()).toContain(JSON.stringify({ type: "sheet-closed" }));
  });

  it("runs Final photo upload then Accept into the final photo result sheet", async () => {
    const ws = await openConversation();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).startsWith("/api/session-photo")) {
          return new Response(
            JSON.stringify({
              ok: true,
              sessionId: 7,
              slot: "post",
              photoUrl: "/api/photos?file=post_7.jpg",
              mosaicUrl: "/api/photos?file=mosaic_7.png",
              description: "Matte nude with black lace and copper foil.",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("no", { status: 404 });
      }),
    );
    ws.serverMessage({
      type: "board",
      board: {
        session: { id: 7, clientName: "David", serviceName: "Gel manicure", startedAt: "2026-11-02T10:00:00.000Z" },
        card: null,
        list: [],
      },
    });
    ws.serverMessage({
      type: "widget",
      widget: { kind: "camera_save_as", title: "Save photo as", size: "half", data: {} },
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Save photo as" })).toBeTruthy();
    });
    const created: HTMLInputElement[] = [];
    const origCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const el = origCreate(tagName, options);
      if (tagName === "input") created.push(el as HTMLInputElement);
      return el;
    }) as typeof document.createElement);
    try {
      fireEvent.click(screen.getByText("Final photo"));
      expect(created).toHaveLength(1);
      const file = new File([new Uint8Array([1, 2, 3])], "nail.jpg", { type: "image/jpeg" });
      Object.defineProperty(created[0], "files", { value: [file], configurable: true });
      created[0].dispatchEvent(new window.Event("change", { bubbles: true }));
      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Save final photo" })).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Final result" })).toBeTruthy();
      });
      expect(screen.getByText("Matte nude with black lace and copper foil.")).toBeTruthy();
      expect(document.querySelector(".aw-result-photo img")?.getAttribute("src")).toBe(
        "/api/photos?file=post_7.jpg",
      );
      expect(document.body.innerHTML).not.toContain("mosaic");
      fireEvent.click(screen.getByRole("button", { name: "Close final result" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Final result" })).toBeNull();
      });
    } finally {
      spy.mockRestore();
    }
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
