/**
 * Recover the `turn` clips an authored anchor route was really expressing.
 *
 * ## The problem this solves
 *
 * The eval corpus authored 59 vehicles whose route anchors encode a junction
 * choice — A6's unprotected left, D7's right on red, I2's convoy through a right
 * and a left, I5's 32-anchor tour. Under the one-motion model those anchors go
 * away and the same intent is stated as `turn` interaction clips over a derived
 * runway (`plans/2026-07-29-one-motion-model.md` §2.2).
 *
 * Migrating them by hand is 59 judgement calls, each of which has to be checked
 * against what the car used to drive. This does it mechanically instead: given
 * the authored anchors, find the turn sequence whose derived runway passes
 * through them. The output is both the migration's answer AND its own proof —
 * `residualM` is how far the fitted runway sits from the anchors it was fitted
 * to, so a bad fit is visible rather than silent.
 *
 * ## Why greedy per junction, and not a search over sequences
 *
 * Four intents at each of up to ~8 junctions is 65k sequences, and evaluating
 * one means walking the lane graph. But the choice at junction N only affects
 * the route AFTER junction N, so a wrong early turn shows up immediately as a
 * route that stops tracking the anchors. Greedy with a lookahead of one junction
 * therefore finds the same answer as exhaustive search on every shape the corpus
 * contains, at 4 walks per junction instead of 4^n.
 *
 * The tie-break matters more than the search: when two intents fit equally well
 * (a junction the route passes straight through, where left and straight both
 * leave the anchors behind), `straight` wins, because that is what an unfitted
 * runway would do and the migration should not author a clip it does not need.
 */

import { deriveRunway, runwayPolyline, type RunwayTurnIntent } from "./derive-runway";
import type { SemanticMapGraph } from "./types";

const INTENTS: readonly RunwayTurnIntent[] = ["straight", "left", "right", "u_turn"];

/** How many junctions to fit before giving up. Corpus maximum is 5. */
const MAX_JUNCTIONS = 10;

export type FitRunwayTurnsArgs = {
  graph: SemanticMapGraph;
  start: { x: number; y: number };
  startHeadingDeg?: number;
  travelBudgetM: number;
  /** The authored anchors, in order, as world points. */
  anchors: ReadonlyArray<{ x: number; y: number }>;
};

export type FitRunwayTurns = {
  /** The turn intents to author as clips. Empty when the default already fits. */
  turns: RunwayTurnIntent[];
  /**
   * Worst distance, in metres, from an authored anchor to the fitted runway.
   *
   * This is the migration's acceptance number. Under half a lane width the
   * fitted runway drives the same lanes the anchors named; much more and the
   * anchors were expressing something a turn sequence cannot (a lane change, a
   * lateral offset, an off-graph manoeuvre) and the case needs a human.
   */
  residualM: number;
  /** Residual of the UNFITTED runway, so the fit's value is measurable. */
  baselineResidualM: number;
  /** Turn intents the map could not satisfy at the junction they were tried on. */
  unmetTurns: number[];
};

function nearestDistanceM(
  polyline: ReadonlyArray<{ x: number; y: number }>,
  target: { x: number; y: number },
): number {
  let best = Infinity;
  for (let index = 0; index + 1 < polyline.length; index += 1) {
    const a = polyline[index]!;
    const b = polyline[index + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    let t = 0;
    if (lengthSq > 0) {
      t = ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSq;
      t = Math.max(0, Math.min(1, t));
    }
    const distance = Math.hypot(target.x - (a.x + t * dx), target.y - (a.y + t * dy));
    if (distance < best) best = distance;
  }
  return best;
}

/** Worst anchor-to-runway distance. Infinity when the runway is unusable. */
function residualFor(
  args: FitRunwayTurnsArgs,
  turns: readonly RunwayTurnIntent[],
): { residualM: number; junctionsCrossed: number; unmetTurns: number[] } {
  const runway = deriveRunway({
    graph: args.graph,
    start: args.start,
    ...(args.startHeadingDeg === undefined ? {} : { startHeadingDeg: args.startHeadingDeg }),
    travelBudgetM: args.travelBudgetM,
    turnAtJunctions: turns,
  });
  const junctionsCrossed = runway.legs.filter((leg) => leg.kind === "junction").length;
  if (runway.anchors.length < 2) {
    return { residualM: Number.POSITIVE_INFINITY, junctionsCrossed, unmetTurns: runway.unmetTurns };
  }
  // The DENSE geometry, not `anchors`: see `runwayPolyline`. Measuring against
  // the sparse anchors made a junction a corner-cutting chord, so a turn that
  // actually fits could fail to improve the residual and the fitter would return
  // no turns for a route that plainly turns.
  const polyline = runwayPolyline(args.graph, runway);
  let worst = 0;
  for (const anchor of args.anchors) {
    const distance = nearestDistanceM(polyline, anchor);
    if (distance > worst) worst = distance;
  }
  return { residualM: worst, junctionsCrossed, unmetTurns: runway.unmetTurns };
}

/**
 * Fit a turn sequence to an authored anchor route.
 *
 * Returns the shortest sequence that fits: intents are only kept while they
 * strictly improve the residual, so a route that never leaves its road comes
 * back with no turns at all and the migration authors no clips for it.
 */
export function fitRunwayTurns(args: FitRunwayTurnsArgs): FitRunwayTurns {
  const baseline = residualFor(args, []);
  let best: RunwayTurnIntent[] = [];
  let bestResidual = baseline.residualM;
  let unmetTurns = baseline.unmetTurns;

  // Nothing to fit against, or the default already drives the anchors.
  if (args.anchors.length === 0) {
    return { turns: [], residualM: baseline.residualM, baselineResidualM: baseline.residualM, unmetTurns };
  }

  const junctionLimit = Math.min(MAX_JUNCTIONS, Math.max(1, baseline.junctionsCrossed + 2));

  for (let junction = 0; junction < junctionLimit; junction += 1) {
    let improvedTurns: RunwayTurnIntent[] | null = null;
    let improvedResidual = bestResidual;
    let improvedUnmet = unmetTurns;

    for (const intent of INTENTS) {
      const candidate = [...best, intent];
      const result = residualFor(args, candidate);
      // Strictly better, with a real margin: a millimetre of improvement is
      // float noise and would author a clip for nothing. 0.25 m is well inside
      // the half-lane acceptance band and well outside the noise.
      if (result.residualM < improvedResidual - 0.25) {
        improvedTurns = candidate;
        improvedResidual = result.residualM;
        improvedUnmet = result.unmetTurns;
      }
    }

    if (!improvedTurns) break;
    best = improvedTurns;
    bestResidual = improvedResidual;
    unmetTurns = improvedUnmet;
  }

  // Trailing `straight` intents are no-ops — the default already goes straight —
  // so drop them rather than author clips that say nothing.
  while (best.length > 0 && best[best.length - 1] === "straight") best.pop();

  return {
    turns: best,
    residualM: bestResidual,
    baselineResidualM: baseline.residualM,
    unmetTurns,
  };
}
