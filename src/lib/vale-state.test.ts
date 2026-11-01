// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createValeState } from "./vale-state";

describe("vale state", () => {
  it("starts idle and notifies once per change", () => {
    const store = createValeState();
    expect(store.get()).toBe("idle");
    const seen: string[] = [];
    const stop = store.subscribe((state) => void seen.push(state));
    store.set("hearing");
    store.set("hearing");
    store.set("thinking");
    expect(store.get()).toBe("thinking");
    expect(seen).toEqual(["hearing", "thinking"]);
    stop();
    store.set("idle");
    expect(seen).toEqual(["hearing", "thinking"]);
  });

  it("a throwing view never breaks the state", () => {
    const store = createValeState("attentive");
    store.subscribe(() => {
      throw new Error("view blew up");
    });
    store.set("speaking");
    expect(store.get()).toBe("speaking");
  });
});
