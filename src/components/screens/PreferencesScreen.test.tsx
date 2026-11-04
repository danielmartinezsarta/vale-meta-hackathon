import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferencesScreen } from "./PreferencesScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function stubFetch() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, method: options?.method ?? "GET" });
      if (href.includes("/api/manage/profile") && (options?.method ?? "GET") === "GET") {
        return Response.json({ name: "demo" });
      }
      if (href.includes("/api/manage/profile")) return Response.json({ ok: true, message: "Profile saved." });
      if (href.includes("/api/status")) return Response.json({ seamless: false });
      return Response.json({ ok: true, message: "Done." });
    }),
  );
  return calls;
}

describe("PreferencesScreen", () => {
  it("renders the profile name with language and voice pickers", async () => {
    stubFetch();
    render(<PreferencesScreen onBack={() => {}} language="en" onLanguageChange={() => {}} />);
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.value).toBe("demo");
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.getByText("Seamless voice is not configured.")).toBeTruthy();
  });

  it("saves the edited profile name", async () => {
    const calls = stubFetch();
    render(<PreferencesScreen onBack={() => {}} language="en" onLanguageChange={() => {}} />);
    await screen.findByLabelText("Name");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Demo User" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/api/manage/profile") && call.method === "POST")).toBe(true);
    });
  });

  it("switches language and voice engine from the screen", async () => {
    stubFetch();
    const onLanguageChange = vi.fn();
    render(<PreferencesScreen onBack={() => {}} language="en" onLanguageChange={onLanguageChange} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByLabelText("ES"));
    expect(onLanguageChange).toHaveBeenCalledWith("es");
    fireEvent.click(screen.getByLabelText("Browser"));
    expect(screen.getByLabelText("Browser")).toBeTruthy();
  });
});
