/**
 * The ONE definition of "a fully resolved scenario document".
 *
 * Two places publish a content hash of the engine's input: the materializer
 * stamps `manifest.inputHash` (and writes the document into the instance file),
 * and the engine stamps `trace.header.inputHash`. They can only ever describe
 * the same bytes if they both resolve the document the same way, in the same
 * order. This function is that resolution, and it is the only implementation of
 * it — the materializer's last act before hashing is the engine's first act on
 * receipt, so `resolveSimScenarioInput` is applied to its own output and, being
 * a fixed point, changes nothing the second time.
 *
 * Defect TG-H1 was the absence of this function: the engine resolved coincident
 * control-lane bindings AFTER the materializer had hashed, so the instance and
 * the trace hashed different documents and the cell's own evidence stopped
 * agreeing with itself.
 */

import { issue, type SimIssue } from '../errors.js';
import type { LaneGraph } from '../map/lane-graph.js';
import { normalizeSimScenarioInput, type SimScenarioInput } from '../schema/input.js';
import { resolveOverlappingControlLanes } from '../sim/signals.js';
import { resolveArrivalTriggers, type ArrivalSolution } from './arrival.js';

export interface ResolvedSimScenarioInput {
  /** Normalised, control-bound, arrival-baked. Hash THIS, never the raw input. */
  readonly input: SimScenarioInput;
  readonly arrival: ArrivalSolution[];
  /** Repair warnings and unsolvable-arrival diagnostics, in resolution order. */
  readonly issues: SimIssue[];
}

export function resolveSimScenarioInput(
  input: SimScenarioInput,
  graph: LaneGraph,
): ResolvedSimScenarioInput {
  const control = resolveOverlappingControlLanes(normalizeSimScenarioInput(input), graph);
  const arrival = resolveArrivalTriggers(control.input, graph);
  return {
    input: arrival.input,
    arrival: arrival.solutions,
    issues: [
      ...control.repairs.map((repair) => issue(
        'traffic_control_binding_repaired',
        `${repair.source}.${repair.controlId}`,
        `A coincident OpenDRIVE lane was bound to ${repair.routeRsl} so this route can obey the physical control. Choose an unambiguous lane when portability matters.`,
        { ...repair },
        'warning',
      )),
      ...arrival.issues,
    ],
  };
}
