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

  render(<TapToTalk />);
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
      widget: { kind: "confirm", title: "Log Top coat?", lines: [] },
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
        kind: "meta",
        title: "Month goal",
        lines: ["120.00 USD of 600.00 USD (20%)"],
      },
    });
    await waitFor(() => {
      expect(screen.getByText("Month goal")).toBeTruthy();
      expect(screen.getByText("120.00 USD of 600.00 USD (20%)")).toBeTruthy();
    });
    expect(
      screen.queryByRole("button", { name: "Yes" }),
    ).toBeNull();
  });
});
