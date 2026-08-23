import type { Intersection, Object3D } from "three";

import {
  setTrafficLightOrbHighlights,
  setTrafficLightOrbStates,
  signalIdForHit,
  trafficLightOrbIdForHit,
  type TrafficLightOrbHighlightSelection,
} from "@simforge/maps/opendrive";
import {
  selectSignalHead,
  type ControlIndication,
  type EditorSignalIndex,
  type SignalHeadSelection,
} from "@/app/lib/uniscenario/signals";

/**
 * The 3D layer's side of head selection. Manifest #120.
 *
 * `SignalHeadSelection` carries controller-stage and junction membership for
 * authoring and safe-state evaluation. Those sets are not visual selection:
 * choosing a timeline lane must emphasize only its physical reference head.
 */

/**
 * Resolve a raycast hit to a head selection, or `null`.
 *
 * Both resolvers are tried because the editor draws two things a pointer can
 * land on: the detailed instanced overlay (`signalIdForHit`) and the always-
 * readable orb point cloud (`trafficLightOrbIdForHit`). A hit on either is the
 * same author intent, and which one is in front depends on the orb layer's
 * `depthMode`, which is a display preference rather than a selection rule.
 */
export function selectSignalHeadFromHit(
  index: EditorSignalIndex,
  hit: Intersection,
  preferred: { movementId?: string | null; controllerId?: string | null } = {},
): SignalHeadSelection | null {
  const headId = signalIdForHit(hit) ?? trafficLightOrbIdForHit(hit);
  return headId ? selectSignalHead(index, headId, preferred) : null;
}

/** Reduce authoring context to the one physical head the user selected. */
export function selectedHeadHighlight(
  selection: SignalHeadSelection | null,
): TrafficLightOrbHighlightSelection | null {
  if (!selection) return null;
  return {
    selectedHeadId: selection.selectedHeadId,
    movementHeadIds: [],
    intersectionHeadIds: [],
  };
}

/** Push one physical head highlight into the orb layer. */
export function applySignalHeadHighlights(
  orbGroup: Object3D | null,
  selection: SignalHeadSelection | null,
): number {
  if (!orbGroup) return 0;
  return setTrafficLightOrbHighlights(orbGroup, selectedHeadHighlight(selection));
}

/**
 * Colour every head from what its stage shows at this instant.
 *
 * `indicationByController` is the map the panel already derives through
 * `buildStageTimelineRows`, so the orbs, the movement diagram and the timeline
 * lane are three views of one evaluation rather than three evaluations.
 *
 * A head in no stage is left out of the state map, which the setter renders as
 * `unknown` — visibly "no information", which is what it is.
 */
export function applySignalHeadStates(
  orbGroup: Object3D | null,
  index: EditorSignalIndex,
  indicationByController: ReadonlyMap<string, ControlIndication>,
  flashOn = true,
): number {
  if (!orbGroup) return 0;
  const states: Record<string, ControlIndication> = {};
  for (const [controllerId, indication] of indicationByController) {
    const controller = index.controllerById.get(controllerId);
    if (!controller) continue;
    for (const headId of controller.headIds) states[headId] = indication;
  }
  return setTrafficLightOrbStates(orbGroup, states, flashOn);
}
