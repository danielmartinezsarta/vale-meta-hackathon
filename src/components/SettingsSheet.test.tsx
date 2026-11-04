import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSheet } from "./SettingsSheet";
import {
  setSeamlessAvailable,
  setVoiceEngine,
  voiceEngine,
} from "@/lib/speak";
import type { ValeLanguage } from "@/lib/vale-language";

function stubStatus(seamless: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ seamless }), { status: 200 })),
  );
}

afterEach(() => {
  cleanup();
  setSeamlessAvailable(true);
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
    expect((browser as HTMLButtonElement).disabled).toBe(false);
    expect((seamless as HTMLButtonElement).disabled).toBe(false);
    expect((browser as HTMLElement).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(seamless);
    expect(voiceEngine()).toBe("seamless");
    expect(window.localStorage.getItem("vale-engine")).toBe("seamless");
    expect(screen.queryByText("To enable Seamless TTS, set SEAMLESS_URL and SEAMLESS_TOKEN in .env.")).toBeNull();

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
      expect((seamless as HTMLButtonElement).disabled).toBe(true);
    });
    expect(await screen.findByText("To enable Seamless TTS, set SEAMLESS_URL and SEAMLESS_TOKEN in .env.")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Browser" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  it("stays disabled when the status check never answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    render(<SettingsSheet language="en" onClose={() => {}} />);

    const seamless = await screen.findByRole("radio", {
      name: "Seamless (open model)",
    });
    expect((seamless as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText("To enable Seamless TTS, set SEAMLESS_URL and SEAMLESS_TOKEN in .env.")).toBeTruthy();
  });

  it.each([
    {
      language: "en",
      hint: "To enable Seamless TTS, set SEAMLESS_URL and SEAMLESS_TOKEN in .env.",
    },
    {
      language: "es",
      hint: "Para activar Seamless TTS, configura SEAMLESS_URL y SEAMLESS_TOKEN en .env.",
    },
  ] as const)(
    "shows the enable hint in $language when unconfigured",
    async ({ language, hint }: { language: ValeLanguage; hint: string }) => {
      stubStatus(false);
      render(<SettingsSheet language={language} onClose={() => {}} />);

      expect(await screen.findByText(hint)).toBeTruthy();
    },
  );

  it("forces a stale saved Seamless pick back to browser when unconfigured", async () => {
    stubStatus(false);
    setVoiceEngine("seamless");
    expect(window.localStorage.getItem("vale-engine")).toBe("seamless");
    render(<SettingsSheet language="en" onClose={() => {}} />);

    await waitFor(() => {
      expect(voiceEngine()).toBe("browser");
    });
    expect(window.localStorage.getItem("vale-engine")).toBe("browser");
    expect(
      (screen.getByRole("radio", { name: "Browser" }) as HTMLElement).getAttribute("aria-checked"),
    ).toBe("true");
  });
});
