import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplashScreen } from "./SplashScreen";

afterEach(cleanup);

describe("SplashScreen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the English slogan and fires onDone after the animation", () => {
    const onDone = vi.fn();
    render(<SplashScreen onDone={onDone} holdMs={400} />);
    expect(
      screen.getByRole("img", { name: "Vale. Just say it." }),
    ).toBeTruthy();
    expect(screen.getByText("vale")).toBeTruthy();
    expect(screen.getByText("Just say it.")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2799);
    });
    expect(onDone).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("shows the Spanish slogan with lang es", () => {
    render(<SplashScreen lang="es" />);
    expect(screen.getByText("Solo dilo.")).toBeTruthy();
  });
});
