import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Logo } from "./Logo";

afterEach(() => {
  cleanup();
});

describe("Brand Logo", () => {
  it("renders five token-driven voice bars with a lowercase wordmark", () => {
    render(<Logo size={48} />);
    const logo = screen.getByRole("img", { name: "Vale, Just say it." });
    const bars = logo.querySelectorAll("rect");
    expect(bars).toHaveLength(5);
    expect(
      Array.from(bars).map((bar) => bar.getAttribute("fill")),
    ).toEqual([
      "var(--vale-bar-1)",
      "var(--vale-bar-2)",
      "var(--vale-bar-3)",
      "var(--vale-bar-4)",
      "var(--vale-bar-5)",
    ]);
    expect(logo.textContent).toContain("vale");
    expect(logo.textContent).toContain("Just say it.");
  });

  it("supports the Spanish slogan and an explicit theme override", () => {
    render(<Logo size={48} sloganLanguage="es" theme="dark" />);
    const logo = screen.getByRole("img", { name: "Vale, Solo dilo." });
    expect(logo.getAttribute("data-theme")).toBe("dark");
    expect(logo.textContent).toContain("Solo dilo.");
  });
});
