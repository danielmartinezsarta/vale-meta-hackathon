import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HomeData } from "@/lib/home-data";
import { HomeScreen } from "./HomeScreen";

afterEach(cleanup);

const DATA: HomeData = {
  userName: "Daniel",
  today: [{ time: "10:00", client: "Maya", service: "Gel manicure" }],
  goal: { earned: 408, goal: 600, pct: 68, month: "2026-11" },
  supplies: [{ name: "Base coat", qty: 2 }],
};

function renderHome(overrides: Partial<HomeData> = {}, language: "en" | "es" = "en") {
  const onLanguageChange = vi.fn();
  const onWake = vi.fn();
  render(
    <HomeScreen
      data={{ ...DATA, ...overrides }}
      language={language}
      onLanguageChange={onLanguageChange}
      onWake={onWake}
    />,
  );
  return { onLanguageChange, onWake };
}

describe("HomeScreen (Vale asleep)", () => {
  it("shows today, the month goal, supplies and the Wake Vale button", () => {
    renderHome();
    expect(screen.getByText("Maya", { exact: false })).toBeTruthy();
    expect(screen.getByText("Gel manicure")).toBeTruthy();
    expect(screen.getByText("Base coat")).toBeTruthy();
    expect(screen.getByText("Monthly goal")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wake Vale" })).toBeTruthy();
  });

  it("opens the side menu without language or theme toggles", () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeTruthy();
    expect(
      screen
        .getByRole("dialog", { name: "Menu" })
        .querySelectorAll('path[d="M9 6l6 6-6 6"]').length,
    ).toBe(8);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
  });

  it("switches the app language from Preferences", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    try {
      const { onLanguageChange } = renderHome();
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      fireEvent.click(screen.getByRole("button", { name: "Preferences" }));
      fireEvent.click(await screen.findByRole("radio", { name: "ES" }));
      expect(onLanguageChange).toHaveBeenCalledWith("es");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wakes Vale from the sleeper button", () => {
    const { onWake } = renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Wake Vale" }));
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("renders the frame in Spanish with language es", () => {
    renderHome({}, "es");
    const greetings = ["Buenos días", "Buenas tardes", "Buenas noches"];
    expect(greetings.some((greeting) => screen.queryByText(greeting, { exact: false }))).toBe(true);
    expect(screen.getByText("Hoy", { exact: false })).toBeTruthy();
    expect(screen.getByText("Materiales por comprar")).toBeTruthy();
    expect(screen.getByText("Meta mensual")).toBeTruthy();
    expect(screen.getByText("noviembre")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByText("Fichas de clientes")).toBeTruthy();
    expect(screen.getByText("Metas")).toBeTruthy();
  });
});
