// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createValeState, settledSpeechState } from "./vale-state";

describe("vale state", () => {
  it("starts idle and notifies once per change", () => {
    const store = createValeState();
    expect(store.get()).toBe("idle");
    const seen: string[] = [];
    const stop = store.subscribe((state) => void seen.push(state));
    store.set("listening");
    store.set("listening");
    store.set("thinking");
    expect(store.get()).toBe("thinking");
    expect(seen).toEqual(["listening", "thinking"]);
    stop();
    store.set("idle");
    expect(seen).toEqual(["listening", "thinking"]);
  });

  it("a throwing view never breaks the state", () => {
    const store = createValeState("listening");
    store.subscribe(() => {
      throw new Error("view blew up");
    });
    store.set("speaking");
    expect(store.get()).toBe("speaking");
  });

  it("settled speech falls back to listening, never out of thinking", () => {
    expect(settledSpeechState("speaking")).toBe("listening");
    expect(settledSpeechState("done")).toBe("listening");
    expect(settledSpeechState("thinking")).toBe("thinking");
    expect(settledSpeechState("listening")).toBe("listening");
    expect(settledSpeechState("idle")).toBe("idle");
    expect(settledSpeechState("error")).toBe("error");
  });
});
