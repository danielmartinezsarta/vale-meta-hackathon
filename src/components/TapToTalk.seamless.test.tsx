import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapToTalk } from "./TapToTalk";
import {
  isSeamlessAvailable,
  setSeamlessAvailable,
  setVoiceEngine,
  voiceEngine,
} from "@/lib/speak";

function stubUnconfigured() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/api/status")) {
        return new Response(JSON.stringify({ seamless: false }), {
          status: 200,
        });
      }
      return new Response("unconfigured", { status: 503 });
    }),
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

describe("TapToTalk Seamless guard", () => {
  it("stays on browser when the server reports Seamless unconfigured", async () => {
    stubUnconfigured();
    setVoiceEngine("seamless");
    expect(window.localStorage.getItem("vale-engine")).toBe("seamless");

    render(<TapToTalk />);

    await waitFor(() => {
      expect(isSeamlessAvailable()).toBe(false);
    });
    expect(voiceEngine()).toBe("browser");
    expect(window.localStorage.getItem("vale-engine")).toBe("browser");
  });
});
