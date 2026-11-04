// The committed demo run plan: scenes in playback order with their voice
// turns. Single source of truth for the recorder (record-replay.ts) and
// the log folder (replay-from-logs.ts): both stamp these scenes in turn
// order, so a plan change lands in both without hand-editing the run.
export interface ReplayPlanTurn {
  scene: string;
  phrase: string;
}

export const REPLAY_PLAN: ReplayPlanTurn[] = [
  // Daily agenda: the day plus the next booking.
  { scene: "Daily agenda", phrase: "Vale, what do I have today?" },
  { scene: "Daily agenda", phrase: "Vale, who is my next client today?" },
  // Agenda management: create, move, cancel, and a dated reminder. The
  // tools write at once with notice cards since #22, so no confirm turns.
  { scene: "Agenda management", phrase: "Vale, book Ana for a gel refill on Friday at 6 PM" },
  { scene: "Agenda management", phrase: "Vale, move Ana's Friday appointment to Saturday at 11 AM" },
  { scene: "Agenda management", phrase: "Vale, cancel Ana's Saturday appointment" },
  { scene: "Agenda management", phrase: "Vale, remind me to bring extra towels on Friday" },
  // Client's card: register, note, health note, card, then the brief.
  { scene: "Client's card", phrase: "Vale, register a new client Nina" },
  { scene: "Client's card", phrase: "Vale, save a note for Nina: she likes dark matte colors" },
  { scene: "Client's card", phrase: "Vale, save a health note for Nina: allergic to acetone" },
  { scene: "Client's card", phrase: "Vale, show me Nina's card" },
  { scene: "Client's card", phrase: "Vale, give me the private brief on Nina" },
  // Work session: open, supply, undo, supply, quote, pay, close.
  { scene: "Work session", phrase: "Vale, open a session with Nina for a gel refill" },
  { scene: "Work session", phrase: "Vale, I used top coat" },
  { scene: "Work session", phrase: "Vale, undo that" },
  { scene: "Work session", phrase: "Vale, I used lint-free wipes" },
  { scene: "Work session", phrase: "Vale, how much do I charge?" },
  // The payment turn is filled in at record time with an amount above the
  // quoted total; the marker below is replaced, never recorded.
  { scene: "Work session", phrase: "Vale, Nina paid {AMOUNT}" },
  { scene: "Work session", phrase: "Vale, close the session" },
  // Nail photo studio: before, reference, preview, final on David's
  // seeded appointment reference. Photo uploads ride the real
  // /api/session-photo endpoint between these turns.
  { scene: "Nail photo studio", phrase: "Vale, open a session with David" },
  { scene: "Nail photo studio", phrase: "Vale, show me the before photo" },
  { scene: "Nail photo studio", phrase: "Vale, show me the reference" },
  { scene: "Nail photo studio", phrase: "Vale, preview the design on her nails" },
  { scene: "Nail photo studio", phrase: "Vale, show me the final photo" },
  { scene: "Nail photo studio", phrase: "Vale, close the session" },
  // Goals: the month at a glance.
  { scene: "Goals", phrase: "Vale, how am I doing with my monthly goal?" },
  // Shopping list: add, remove, show. Provisional: the model cannot call
  // the internal shopping tools yet, so these turns are unproven until
  // the tools are exposed; the run below is NOT re-recorded with them.
  { scene: "Shopping list", phrase: "Vale, add rhinestones to the shopping list" },
  { scene: "Shopping list", phrase: "Vale, remove rhinestones from the shopping list" },
  { scene: "Shopping list", phrase: "Vale, show me my shopping list" },
  // Low stock suggestions: provisional for the same reason.
  { scene: "Low stock suggestions", phrase: "Vale, what is running low on stock?" },
];

/** Scene per turn, in plan order; stamped onto the folded run. */
export function replayPlanScenes(): string[] {
  return REPLAY_PLAN.map((turn) => turn.scene);
}
