import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ValeScreenShell } from "./ValeScreenShell";

afterEach(() => {
  cleanup();
});

function shell(widget: { kind: string } | null) {
  return render(
    <ValeScreenShell
      mode="day"
      robotState="done"
      title="Vale"
      bubbles={[]}
      widget={widget as never}
      language="en"
      muted={false}
      notice={null}
      alert={null}
      onToggleMute={vi.fn()}
      onSleep={vi.fn()}
      onCloseWidget={vi.fn()}
      onVote={vi.fn()}
    />,
  );
}

describe("ValeScreenShell good-job caption", () => {
  it("shows the design subtitle under Good job!", () => {
    shell({ kind: "good_job" });
    expect(screen.getByText("Good job!")).toBeTruthy();
    expect(
      screen.getByText("Don't forget to hydrate and do some stretching before moving on."),
    ).toBeTruthy();
  });

  it("keeps the live state line when no widget is set", () => {
    shell(null);
    expect(screen.queryByText("Good job!")).toBeNull();
    expect(
      screen.queryByText("Don't forget to hydrate and do some stretching before moving on."),
    ).toBeNull();
  });
});
