import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AwakeScreen } from "./AwakeScreen";
import type { ValeState } from "@/lib/vale-state";
import type { AwakeBubble } from "./AwakeScreen";

afterEach(() => {
  cleanup();
});

function renderAwake(state: ValeState, bubbles: AwakeBubble[] = []) {
  return render(
    <AwakeScreen
      mode="day"
      robotState={state}
      bubbles={bubbles}
      widget={null}
      language="en"
      muted={false}
      notice={null}
      alert={null}
      onToggleMute={() => {}}
      onSleep={() => {}}
      onCloseWidget={() => {}}
      onVote={() => {}}
    />,
  );
}

describe("awake state line", () => {
  it.each([
    ["idle", "Asleep"],
    ["listening", "Listening"],
    ["thinking", "Thinking"],
    ["speaking", "Speaking"],
    ["done", "Listening"],
    ["error", "Didn't catch that"],
  ])("shows %s as %s", (state, label) => {
    renderAwake(state as ValeState);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("shows Heard you while interim user text is live", () => {
    renderAwake("listening", [
      { id: "turn-1-user", text: "Vale, show", from: "user", live: true },
    ]);
    expect(screen.getByText("Heard you")).toBeTruthy();
  });

  it("shows Listening once the user turn is final", () => {
    renderAwake("listening", [
      { id: "turn-1-user", text: "Vale, show me", from: "user" },
    ]);
    expect(screen.getByText("Listening")).toBeTruthy();
  });

  it("never shows the old prompt", () => {
    renderAwake("listening");
    expect(screen.queryByText("Just say it")).toBeNull();
  });
});
