import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayPill } from "./ReplayPill";
import styles from "./ReplayPill.module.css";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetch(state: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      calls.push(String(url));
      if (String(url).includes("/api/status")) {
        return { ok: true, json: async () => ({ key: false, replay: true }) };
      }
      return { ok: true, json: async () => state };
    }),
  );
  return calls;
}

const playing = {
  cursor: 0,
  total: 29,
  paused: false,
  done: false,
  current: { scene: "Daily agenda", indexInScene: 1, sceneCount: 2 },
};

describe("ReplayPill", () => {
  it("stays hidden without replay mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ key: true, replay: false }) })),
    );
    const { container } = render(<ReplayPill />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.firstChild).toBeNull();
  });

  it("shows the scene, the turn inside the scene and every control", async () => {
    mockFetch(playing);
    render(<ReplayPill />);
    expect(await screen.findByText("Daily agenda 1/2")).toBeDefined();
    expect(screen.getByRole("button", { name: "Previous scene" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Pause replay" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Stop replay" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Next scene" })).toBeDefined();
  });

  it("sends each control to the replay state", async () => {
    const calls = mockFetch(playing);
    render(<ReplayPill />);
    await screen.findByText("Daily agenda 1/2");
    fireEvent.click(screen.getByRole("button", { name: "Next scene" }));
    await vi.waitFor(() => {
      expect(calls.some((url) => url.includes("replay=next"))).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause replay" }));
    await vi.waitFor(() => {
      expect(calls.some((url) => url.includes("replay=pause"))).toBe(true);
    });
  });

  it("pauses and resumes from the keyboard", async () => {
    const calls = mockFetch(playing);
    render(<ReplayPill />);
    const region = await screen.findByRole("region", { name: "Replay controls" });
    fireEvent.keyDown(region, { key: " " });
    await vi.waitFor(() => {
      expect(calls.some((url) => url.includes("replay=pause"))).toBe(true);
    });
    fireEvent.keyDown(region, { key: "ArrowRight" });
    await vi.waitFor(() => {
      expect(calls.some((url) => url.includes("replay=next"))).toBe(true);
    });
  });

  it("stays full with no sheet, compacts to a slim bar while one is open", async () => {
    mockFetch(playing);
    render(<ReplayPill />);
    const region = await screen.findByRole("region", { name: "Replay controls" });
    expect(region.getAttribute("data-compact")).toBe("false");
    expect(region.className).not.toContain(styles.slim);
    const sheet = document.createElement("section");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Photos");
    sheet.setAttribute("aria-hidden", "false");
    document.body.appendChild(sheet);
    await vi.waitFor(
      () => {
        expect(screen.getByRole("region", { name: "Replay controls" }).getAttribute("data-compact")).toBe(
          "true",
        );
      },
      { timeout: 3000 },
    );
    expect(screen.getByRole("region", { name: "Replay controls" }).className).toContain(styles.slim);
    sheet.remove();
    await vi.waitFor(
      () => {
        expect(screen.getByRole("region", { name: "Replay controls" }).getAttribute("data-compact")).toBe(
          "false",
        );
      },
      { timeout: 3000 },
    );
    // A hidden dialog (the home menu while closed) never compacts.
    const menu = document.createElement("div");
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Menu");
    menu.setAttribute("aria-hidden", "true");
    document.body.appendChild(menu);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(screen.getByRole("region", { name: "Replay controls" }).getAttribute("data-compact")).toBe(
      "false",
    );
    menu.remove();
  });
});
