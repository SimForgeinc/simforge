/**
 * The authoring time grid: quantum, snapping, and time labels.
 *
 * ## Why the quantum is defined here and not imported
 *
 * `BEHAVIOR_TIME_QUANTUM_S = 0.1` exists twice in `packages/shared` — `scenario-behavior.ts:57` and
 * `preview-engine/constants.ts:20` — and this is deliberately NOT a third alias of either. Both live
 * in the v1 package, every one of that package's `preview-engine` consumers is a v1 file, and
 * `lib/scenario/**` presently imports `@simforge-oss/studio-shared` in zero files. Reaching across would make
 * this the first v2→v1 dependency in an otherwise clean tree, in a constant, on the eve of v1's
 * deletion.
 *
 * The v2 document schema has no quantum of its own: `AtTriggerSchema.t` accepts any finite number, and
 * `NumberOrExpr` accepts an expression. Quantization is an AUTHORING concern — it exists so a dragged
 * chip lands somewhere the author can retype — not a document invariant, which is why it belongs to
 * the editor and not to `@simforge-oss/scenario`.
 *
 * So: when v1 dies, the two `packages/shared` copies go with it and this becomes the single
 * definition. That is the resolution to the duplication, not a cross-import.
 */

/** Authoring resolution of the timeline, seconds. Drags and typed times land on this grid. */
export const TIMELINE_TIME_QUANTUM_S = 0.1;

/**
 * Snap a time to the authoring grid.
 *
 * Rounds rather than truncates, so dragging left and dragging right behave symmetrically, and
 * normalizes `-0` to `0` — `(-0).toFixed(1)` prints `"-0.0"`, which reads as a warm-up time on a rail
 * where negative genuinely means warm-up.
 */
export function snapToTimeGrid(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  const snapped =
    Math.round(seconds / TIMELINE_TIME_QUANTUM_S) * TIMELINE_TIME_QUANTUM_S;
  // Binary floating point leaves 0.30000000000000004 behind; the grid is one decimal by definition.
  const rounded = Number(snapped.toFixed(1));
  return rounded === 0 ? 0 : rounded;
}

/** Whether a time already sits on the grid, within float tolerance. */
export function isOnTimeGrid(seconds: number): boolean {
  return Number.isFinite(seconds) && Math.abs(seconds - snapToTimeGrid(seconds)) < 1e-9;
}

/**
 * A time as it reads in a chip, a tooltip, or a trigger summary.
 *
 * Warm-up times keep their sign, because that sign is the only thing distinguishing "before recording
 * starts" from "at the first frame" in a label.
 */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  return `${snapToTimeGrid(seconds).toFixed(1)}s`;
}
