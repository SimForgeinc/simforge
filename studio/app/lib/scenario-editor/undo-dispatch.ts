/**
 * Which of the editor's two undo stacks owns ⌘Z right now.
 *
 * Actor setup and signal plans keep separate histories — see
 * `signal-plan-history.ts` for why the signal stack cannot simply join the
 * actors envelope — but the author has one keyboard and one mental model of
 * "undo the last thing I did". So the keystroke routes by recency: the stack
 * holding the newest edit answers ⌘Z, the stack holding the newest UNDO answers
 * ⌘⇧Z.
 *
 * Both stacks stamp epoch milliseconds (the actors stack as ISO text, which
 * `Date.parse` reads back), and both force their stamps strictly increasing, so
 * "newest" is always well defined. A stack with nothing to offer reports `null`
 * and never wins.
 *
 * Interleaving actor and signal edits therefore unwinds in true chronological
 * order, which is the behaviour that needs no explaining. What it does NOT give
 * is a single merged timeline across a reload: only the actors stack persists.
 */

export type UndoTarget = "actors" | "signals";

function newer(
  actors: number | null,
  signals: number | null,
): UndoTarget {
  if (signals === null) return "actors";
  if (actors === null) return "signals";
  return signals > actors ? "signals" : "actors";
}

/** Epoch ms of the actors stack's most recent edit, from its ISO stamp. */
export function isoToEpochMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function routeUndo(input: {
  actorsLastEditAt: number | null;
  signalsLastEditAt: number | null;
}): UndoTarget {
  return newer(input.actorsLastEditAt, input.signalsLastEditAt);
}

export function routeRedo(input: {
  actorsLastUndoAt: number | null;
  signalsLastUndoAt: number | null;
}): UndoTarget {
  return newer(input.actorsLastUndoAt, input.signalsLastUndoAt);
}
