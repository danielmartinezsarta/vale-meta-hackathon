/** Single source of truth for what Vale is doing right now. */

/**
 * idle: at rest. listening: the VAD hears voice. thinking: turn sent, no
 * reply yet. speaking: her voice is audible. done: a tool just worked.
 * error: something failed.
 */
export type ValeState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "done"
  | "error";

type Listener = (state: ValeState) => void;

/** Tiny observable: the indicator view only draws, state changes live here. */
export function createValeState(initial: ValeState = "idle"): {
  get: () => ValeState;
  set: (next: ValeState) => void;
  subscribe: (listener: Listener) => () => void;
} {
  let current = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => current,
    set: (next: ValeState) => {
      if (next === current) return;
      current = next;
      listeners.forEach((listener) => {
        try {
          listener(next);
        } catch {
          /* a view must never break the state */
        }
      });
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ValeStateStore = ReturnType<typeof createValeState>;
