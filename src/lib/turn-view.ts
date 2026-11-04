/** One conversation turn, shared by the voice views. */

/** Discarded by the wake gate: shown dimmed, never as dialogue. */
export interface Turn {
  id: number;
  interim: string;
  final: string | null;
  reply: string | null;
  ignored?: boolean;
}

/** An empty turn draws nothing: it never deletes a bubble. */
export function hasVisibleContent(turn: {
  interim: string;
  final: string | null;
  reply: string | null;
}): boolean {
  return (
    (turn.final ?? turn.interim).trim() !== "" ||
    (turn.reply?.trim() ?? "") !== ""
  );
}
