import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import { FakeVoiceSocket, stubVoiceSocket } from "./test-voice-socket";
import { startCapture } from "@/lib/capture";

vi.mock("@/lib/capture", () => ({
  startCapture: vi.fn(),
}));

const mockStartCapture = vi.mocked(startCapture);
const STARTED_AT = new Date(Date.now() - 3723 * 1000).toISOString();

function answerSessionTurn() {
  const ws = FakeVoiceSocket.instances[0];
  ws.serverMessage({
    type: "transcript",
    transcript: "vale open a session",
    final: true,
  });
  ws.serverMessage({
    type: "board",
    board: {
      session: {
        id: 7,
        clientName: "David",
        serviceName: "Gel manicure",
        startedAt: STARTED_AT,
      },
      card: null,
      list: [],
    },
  });
  ws.serverMessage({ type: "done" });
}

function driveSession() {
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  stubVoiceSocket();
  mockStartCapture.mockImplementation((_stream, callbacks) => {
    const frame = new Int16Array(960).fill(4000);
    window.setTimeout(() => {
      callbacks.onFrame(frame);
      callbacks.onSpeechStart();
      for (let i = 0; i < 8; i += 1) callbacks.onFrame(frame);
      callbacks.onSpeechEnd();
    }, 0);
    return { stop: () => {}, state: () => "running", engine: () => "script" as const };
  });
}

function stubRoutes(opts: {
  photos: (file: string) => boolean;
  upload: (slot: string) => { status: number; body: unknown };
}) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("/api/session-photo")) {
      const slot = String((init?.body as FormData).get("slot") ?? "");
      const { status, body } = opts.upload(slot);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    }
    if (u.startsWith("/api/photos?file=")) {
      const file = decodeURIComponent(u.split("file=")[1] ?? "");
      return opts.photos(file)
        ? { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }
        : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    // No voice transport on fetch: photo uploads ride REST, turns ride /voice.
    return { ok: false, status: 500, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

const UPLOAD_OK = (slot: string) =>
  slot === "after"
    ? {
        status: 200,
        body: {
          ok: true,
          sessionId: 7,
          slot: "post",
          photoUrl: "/api/photos?file=post_7.jpg",
          mosaicUrl: "/api/photos?file=mosaic_7.png",
          description: "Matte nude with black lace and copper foil.",
        },
      }
    : {
        status: 200,
        body: {
          ok: true,
          sessionId: 7,
          slot: "pre",
          photoUrl: "/api/photos?file=pre_7.jpg",
        },
      };

/** Captures the picker input the camera flow creates imperatively. */
function capturePicker(): HTMLInputElement[] {
  const created: HTMLInputElement[] = [];
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    const el = origCreate(tagName, options);
    if (tagName === "input") created.push(el as HTMLInputElement);
    return el;
  }) as typeof document.createElement);
  return created;
}

function pickFile(input: HTMLInputElement): void {
  const file = new File([new Uint8Array([1, 2, 3])], "nail.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

async function openSessionScreen() {
  driveSession();
  render(<TapToTalk autoStart />);
  await waitFor(() => {
    expect(
      FakeVoiceSocket.instances[0]
        ?.sentStrings()
        .some((raw) => raw.includes("endStream")),
    ).toBe(true);
  });
  answerSessionTurn();
  await waitFor(() => {
    expect(screen.getByRole("timer", { name: "Session time" })).toBeTruthy();
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("session photo flows (mocked fetch, no network)", () => {
  it("opens photos empty when nothing is stored", async () => {
    vi.stubGlobal("fetch", stubRoutes({ photos: () => false, upload: UPLOAD_OK }));
    await openSessionScreen();
    fireEvent.click(
      screen.getByRole("button", { name: "Photos: before, reference and expected result" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Photos" })).toBeTruthy();
    });
    expect(document.querySelector(".aw-pics img")).toBeNull();
  });

  it("shows stored slots when present, final replacing the preview", async () => {
    vi.stubGlobal("fetch", stubRoutes({ photos: () => true, upload: UPLOAD_OK }));
    await openSessionScreen();
    fireEvent.click(
      screen.getByRole("button", { name: "Photos: before, reference and expected result" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Photos" })).toBeTruthy();
    });
    const srcs = Array.from(document.querySelectorAll(".aw-pics img")).map((img) =>
      (img as HTMLImageElement).getAttribute("src"),
    );
    expect(srcs).toHaveLength(3);
    expect(srcs).toContain("/api/photos?file=pre_7.jpg");
    expect(srcs).toContain("/api/photos?file=seed-assets%2Fdavid-appointment-reference.jpg");
    expect(srcs).toContain("/api/photos?file=post_7.jpg");
    expect(srcs).not.toContain("/api/photos?file=preview_7.png");
    expect(document.querySelector(".aw-pics__note")).toBeNull();
  });

  it("shows the expected tile with its credit when no final exists", async () => {
    vi.stubGlobal(
      "fetch",
      stubRoutes({ photos: (file) => file !== "post_7.jpg", upload: UPLOAD_OK }),
    );
    await openSessionScreen();
    fireEvent.click(
      screen.getByRole("button", { name: "Photos: before, reference and expected result" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Photos" })).toBeTruthy();
    });
    const srcs = Array.from(document.querySelectorAll(".aw-pics img")).map((img) =>
      (img as HTMLImageElement).getAttribute("src"),
    );
    expect(srcs).toHaveLength(3);
    expect(srcs).toContain("/api/photos?file=preview_7.png");
    expect(screen.getByText("Preview generated by Muse Image")).toBeTruthy();
  });

  it("uploads before with the camera hint on phones, then shows it", async () => {
    vi.stubGlobal("fetch", stubRoutes({ photos: () => false, upload: UPLOAD_OK }));
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
    );
    const created = capturePicker();
    await openSessionScreen();
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    fireEvent.click(screen.getByText("Before"));
    expect(created).toHaveLength(1);
    expect(created[0].getAttribute("capture")).toBe("camera");
    pickFile(created[0]);
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Photos" })).toBeTruthy();
    });
    const img = document.querySelector(".aw-pics img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("/api/photos?file=pre_7.jpg");
  });

  it("uploads final, confirms, and shows the final photo result", async () => {
    vi.stubGlobal("fetch", stubRoutes({ photos: () => false, upload: UPLOAD_OK }));
    const created = capturePicker();
    await openSessionScreen();
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    fireEvent.click(screen.getByText("Final photo"));
    expect(created).toHaveLength(1);
    expect(created[0].getAttribute("capture")).toBeNull();
    pickFile(created[0]);
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Save final photo" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Final result" })).toBeTruthy();
    });
    expect(document.querySelector('.aw-result-photo img')?.getAttribute("src")).toBe(
      "/api/photos?file=post_7.jpg",
    );
    expect(screen.getByText("Matte nude with black lace and copper foil.")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("mosaic");
  });

  it("shows a notice when the upload fails", async () => {
    vi.stubGlobal(
      "fetch",
      stubRoutes({
        photos: () => false,
        upload: () => ({ status: 500, body: { error: "Nope.", code: "E-STORE" } }),
      }),
    );
    const created = capturePicker();
    await openSessionScreen();
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    fireEvent.click(screen.getByText("Before"));
    pickFile(created[0]);
    await waitFor(() => {
      expect(screen.getByText("Photo upload failed.")).toBeTruthy();
    });
  });
});
