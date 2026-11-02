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

function renderHome(overrides: Partial<HomeData> = {}) {
  const onLanguageChange = vi.fn();
  const onWake = vi.fn();
  render(
    <HomeScreen
      data={{ ...DATA, ...overrides }}
      language="en"
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

  it("opens the side menu and switches language from it", () => {
    const { onLanguageChange } = renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("ES"));
    expect(onLanguageChange).toHaveBeenCalledWith("es");
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
  });

  it("wakes Vale from the sleeper button", () => {
    const { onWake } = renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Wake Vale" }));
    expect(onWake).toHaveBeenCalledTimes(1);
  });
});
