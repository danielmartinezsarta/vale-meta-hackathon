// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PhoneFrame } from "./PhoneFrame";

describe("phone frame", () => {
  it("centers the screen column and reuses its background in the gutters", () => {
    const { container } = render(
      <PhoneFrame background="rgb(20, 34, 79)">
        <div data-testid="screen">vale</div>
      </PhoneFrame>,
    );
    expect(screen.getByTestId("screen")).toBeTruthy();
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.background).toBe("rgb(20, 34, 79)");
    expect(frame.firstElementChild?.className).toBeTruthy();
  });
});
