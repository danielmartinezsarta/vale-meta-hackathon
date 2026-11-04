import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeSwitch } from "./ThemeSwitch";

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("ThemeSwitch", () => {
  it("starts dark with nothing saved", () => {
    render(<ThemeSwitch language="en" />);
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("false");
  });

  it("switches to light on click and persists it", () => {
    render(<ThemeSwitch language="en" />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(window.localStorage.getItem("vale-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the saved choice across a fresh render", () => {
    const { unmount } = render(<ThemeSwitch language="en" />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    unmount();
    render(<ThemeSwitch language="en" />);
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
  });

  it("moves with arrow keys", () => {
    render(<ThemeSwitch language="en" />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "Dark" }), { key: "ArrowLeft" });
    expect(window.localStorage.getItem("vale-theme")).toBe("light");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Light" }), { key: "ArrowRight" });
    expect(window.localStorage.getItem("vale-theme")).toBe("dark");
  });

  it("moves every mounted switch together", () => {
    render(
      <>
        <ThemeSwitch language="en" />
        <ThemeSwitch language="en" />
      </>,
    );
    fireEvent.click(screen.getAllByRole("radio", { name: "Light" })[0]);
    for (const light of screen.getAllByRole("radio", { name: "Light" })) {
      expect(light.getAttribute("aria-checked")).toBe("true");
    }
  });

  it("labels the segments in Spanish", () => {
    render(<ThemeSwitch language="es" />);
    expect(screen.getByRole("radio", { name: "Claro" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Oscuro" })).toBeTruthy();
  });
});
