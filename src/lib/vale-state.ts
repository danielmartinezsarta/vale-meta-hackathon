/** Single source of truth for what Vale is doing right now. */

/** idle: no session. attentive: live session, listening. hearing: VAD speech. thinking: turn posted, reply pending. speaking: her voice audible. error: tap to retry. */
export type ValeState =
  | "idle"
  | "attentive"
  | "hearing"
  | "thinking"
  | "speaking"
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
