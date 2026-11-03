import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyStatusBanner } from "./KeyStatusBanner";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubStatus(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body })),
  );
}

describe("KeyStatusBanner", () => {
  it("says on screen that the voice is not set up when key and replay are missing", async () => {
    stubStatus({ key: false, replay: false });
    render(<KeyStatusBanner language="en" />);
    await waitFor(() => {
      expect(screen.getByText(/Voice is not set up/, { exact: false })).toBeTruthy();
    });
    expect(screen.getByText(/VALE_REPLAY=1/, { exact: false })).toBeTruthy();
  });

  it("says it in Spanish on the Spanish screen", async () => {
    stubStatus({ key: false, replay: false });
    render(<KeyStatusBanner language="es" />);
    await waitFor(() => {
      expect(screen.getByText(/no está configurada/, { exact: false })).toBeTruthy();
    });
  });

  it("stays out of the way with a key or with replay on", async () => {
    stubStatus({ key: true, replay: false });
    const { unmount } = render(<KeyStatusBanner language="en" />);
    await waitFor(() => {
      expect(document.body.textContent).toBe("");
    });
    unmount();
    stubStatus({ key: false, replay: true });
    render(<KeyStatusBanner language="en" />);
    await waitFor(() => {
      expect(document.body.textContent).toBe("");
    });
  });
});
