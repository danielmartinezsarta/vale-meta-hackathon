import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetSheet } from "./WidgetSheet";

afterEach(cleanup);

function openSheet(size: "half" | "full" = "half") {
  const onClose = vi.fn();
  render(
    <WidgetSheet size={size} onClose={onClose} label="Price">
      <p>sheet body</p>
    </WidgetSheet>,
  );
  return onClose;
}

describe("WidgetSheet (generic bottom sheet)", () => {
  it("carries the widget size", () => {
    openSheet("full");
    const sheet = screen.getByRole("dialog", { name: "Price" });
    expect(sheet.getAttribute("data-size")).toBe("full");
  });

  it("closes with the X button, the handle tap and with Escape", () => {
    const onClose = openSheet();
    fireEvent.click(screen.getByRole("button", { name: "Close Price" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Drag down to close Price" }),
    );
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  // jsdom has no PointerEvent: dispatch plain events carrying clientY,
  // which is all the sheet reads from the gesture.
  function drag(startY: number, endY: number): void {
    const handle = screen.getByRole("button", {
      name: "Drag down to close Price",
    });
    for (const [kind, clientY] of [
      ["pointerdown", startY],
      ["pointermove", endY],
    ] as const) {
      const event = new Event(kind, { bubbles: true });
      (event as Event & { clientY?: number }).clientY = clientY;
      handle.dispatchEvent(event);
    }
    handle.dispatchEvent(new Event("pointerup", { bubbles: true }));
  }

  it("closes on a downward drag from the handle", () => {
    const onClose = openSheet();
    drag(100, 200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on a short drag from the handle", () => {
    const onClose = openSheet();
    drag(100, 120);
    expect(onClose).not.toHaveBeenCalled();
  });
});
