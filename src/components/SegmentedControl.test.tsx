import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

const options = [
  { value: "en", label: "EN" },
  { value: "es", label: "ES" },
];

afterEach(() => {
  cleanup();
});

describe("SegmentedControl", () => {
  it("marks the current value checked and switches on click", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SegmentedControl label="Language" value="en" onChange={onChange} options={options} />,
    );

    const en = screen.getByRole("radio", { name: "EN" });
    const es = screen.getByRole("radio", { name: "ES" });
    expect(en.getAttribute("aria-checked")).toBe("true");
    expect(es.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(es);
    expect(onChange).toHaveBeenCalledWith("es");

    rerender(
      <SegmentedControl label="Language" value="es" onChange={onChange} options={options} />,
    );
    expect(screen.getByRole("radio", { name: "ES" }).getAttribute("aria-checked")).toBe("true");
  });

  it("moves with arrow keys", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl label="Language" value="en" onChange={onChange} options={options} />,
    );

    fireEvent.keyDown(screen.getByRole("radio", { name: "EN" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("es");
  });

  it("ignores clicks on a disabled side and skips it with arrows", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Voice"
        value="browser"
        onChange={onChange}
        options={[
          { value: "browser", label: "Browser" },
          { value: "seamless", label: "Seamless", disabled: true },
        ]}
      />,
    );

    const seamless = screen.getByRole("radio", { name: "Seamless" });
    expect((seamless as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(seamless);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("radio", { name: "Browser" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("browser");
  });
});
