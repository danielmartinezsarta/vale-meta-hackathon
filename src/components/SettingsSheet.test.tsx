import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSheet } from "./SettingsSheet";
import { setVoiceEngine, voiceEngine } from "@/lib/speak";

function stubStatus(seamless: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ seamless }), { status: 200 })),
  );
}

afterEach(() => {
  cleanup();
  setVoiceEngine("browser");
  window.localStorage.removeItem("vale-engine");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voice selector in Settings", () => {
  it("offers both engines and switches live with no reload", async () => {
    stubStatus(true);
    render(<SettingsSheet language="en" onClose={() => {}} />);

    const browser = await screen.findByRole("radio", { name: "Browser" });
    const seamless = screen.getByRole("radio", { name: "Seamless (open model)" });
    expect((browser as HTMLInputElement).disabled).toBe(false);
    expect((seamless as HTMLInputElement).disabled).toBe(false);
    expect((browser as HTMLInputElement).checked).toBe(true);

    fireEvent.click(seamless);
    expect(voiceEngine()).toBe("seamless");
    expect(window.localStorage.getItem("vale-engine")).toBe("seamless");
    expect(screen.queryByText("Seamless voice is not configured.")).toBeNull();

    fireEvent.click(browser);
    expect(voiceEngine()).toBe("browser");
    expect(window.localStorage.getItem("vale-engine")).toBe("browser");
  });

  it("disables Seamless with a notice when the server has no SEAMLESS_URL", async () => {
    stubStatus(false);
    render(<SettingsSheet language="en" onClose={() => {}} />);

    const seamless = await screen.findByRole("radio", {
      name: "Seamless (open model)",
    });
    await waitFor(() => {
      expect((seamless as HTMLInputElement).disabled).toBe(true);
    });
    expect(screen.getByText("Seamless voice is not configured.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Browser" }) as HTMLInputElement).checked).toBe(true);
  });

  it("stays disabled when the status check never answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    render(<SettingsSheet language="en" onClose={() => {}} />);

    const seamless = await screen.findByRole("radio", {
      name: "Seamless (open model)",
    });
    expect((seamless as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("Seamless voice is not configured.")).toBeTruthy();
  });
});
