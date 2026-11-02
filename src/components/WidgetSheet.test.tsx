import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetSheet } from "./WidgetSheet";

afterEach(cleanup);

function openSheet(size: "half" | "full" = "half") {
  const onClose = vi.fn();
  render(
    <WidgetSheet size={size} open onClose={onClose} label="Price">
      <p>sheet body</p>
    </WidgetSheet>,
  );
  return onClose;
}

describe("WidgetSheet (generic bottom sheet)", () => {
  it("carries the widget size and stays hidden until open", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <WidgetSheet size="full" open={false} onClose={onClose} label="Price">
        <p>sheet body</p>
      </WidgetSheet>,
    );
    const sheet = screen.getByRole("dialog", { hidden: true });
    expect(sheet.getAttribute("aria-label")).toBe("Price");
    expect(sheet.getAttribute("data-size")).toBe("full");
    expect(sheet.getAttribute("aria-hidden")).toBe("true");
    rerender(
      <WidgetSheet size="full" open onClose={onClose} label="Price">
        <p>sheet body</p>
      </WidgetSheet>,
    );
    expect(sheet.getAttribute("aria-hidden")).toBe("false");
  });

  it("closes with the X button and with Escape", () => {
    const onClose = openSheet();
    fireEvent.click(screen.getByRole("button", { name: "Close Price" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
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
