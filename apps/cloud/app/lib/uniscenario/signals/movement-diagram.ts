/**
 * Geometry for the movement diagram — the junction seen from above, one arrow
 * per movement, click an arrow to author it.
 *
 * The diagram is a component (`MovementDiagram.tsx`, manifest #113) and lives
 * under `editor/`; this module is the part of it that is domain rather than
 * presentation. Bearings and turn arcs are measured off the topology's own lane
 * polylines, which is a pure computation over real map geometry, unit-testable
 * without a DOM — and it is the part that was wrong in the obvious ways when
 * done by eye.
 *
 * ## Coordinates
 *
 * Inputs are `TopologyLane.polyline` vertices, which are **OpenDRIVE-local**
 * metres (x east, y north). Outputs are a unit-square diagram space with the
 * origin at the junction centre, +x right and +y DOWN, because that is what an
 * SVG viewBox wants. The flip happens once, here, rather than in the component;
 * v1's equivalent did it at the draw site and the diagram was mirrored on the
 * first map that was not axis-aligned.
 *
 * ## Approach bearing is measured at the stop line, not over the whole lane
 *
 * A lane polyline can curve for 200 m before it reaches the junction. Averaging
 * it gives a bearing that points somewhere the driver never faces. The bearing
 * that matters is the tangent at the lane's junction-facing END, so that is what
 * {@link approachBearingRad} measures — over the last few vertices rather than
 * the last one, since a single segment can be a metre long and noisy.
 */

import type { EditorSignalIndex } from "./stages";
import type { EditorSignalMovement } from "./types";

/** A vertex of a topology lane polyline, OpenDRIVE-local metres. */
export type LocalVertex = { readonly x: number; readonly y: number };

/** How much of a lane's tail defines its bearing. */
const BEARING_WINDOW_M = 8;

/**
 * Tangent at the junction-facing end of an approach lane, radians CCW from +x.
 *
 * `towardsJunction` says which end of the stored polyline faces the junction.
 * OpenDRIVE stores vertices in `s` order and a lane's travel direction depends
 * on the sign of its lane id, so the caller supplies the answer rather than this
 * function assuming it — the same reason `LaneIndex` carries `forward` per lane
 * instead of deriving it at query time.
 *
 * Returns `null` for a polyline with fewer than two distinct vertices: a lane
 * with no extent has no bearing, and inventing 0 would point every such approach
 * due east.
 */
export function approachBearingRad(
  polyline: readonly LocalVertex[],
  towardsJunction: "end" | "start",
): number | null {
  if (polyline.length < 2) return null;
  const ordered = towardsJunction === "end" ? polyline : [...polyline].reverse();
  const tip = ordered[ordered.length - 1]!;
  // Walk back until the window is covered or the polyline runs out, so a lane
  // built from many short segments gets the same bearing as one built from few.
  let at = ordered.length - 2;
  let anchor = ordered[at]!;
  while (at > 0 && Math.hypot(tip.x - anchor.x, tip.y - anchor.y) < BEARING_WINDOW_M) {
    at -= 1;
    anchor = ordered[at]!;
  }
  const dx = tip.x - anchor.x;
  const dy = tip.y - anchor.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  return Math.atan2(dy, dx);
}

/** Into `(-PI, PI]`, so a bearing never depends on how many turns produced it. */
export function normalizeRadians(value: number): number {
  let radians = value % (Math.PI * 2);
  if (radians > Math.PI) radians -= Math.PI * 2;
  if (radians <= -Math.PI) radians += Math.PI * 2;
  return radians;
}

/** Signed smallest rotation from `from` to `to`. Positive is counter-clockwise. */
export function bearingDelta(from: number, to: number): number {
  return normalizeRadians(to - from);
}

/**
 * A compass label for an approach, from its inbound bearing.
 *
 * The direction traffic TRAVELS, so a lane whose tangent points east is
 * "Eastbound". Eight points rather than four: on a skewed junction — which most
 * real ones are — four points put two different approaches in the same bucket
 * and the panel shows two rows with identical names.
 */
const COMPASS: readonly { readonly label: string; readonly bearingRad: number }[] = [
  { label: "Eastbound", bearingRad: 0 },
  { label: "Northeastbound", bearingRad: Math.PI / 4 },
  { label: "Northbound", bearingRad: Math.PI / 2 },
  { label: "Northwestbound", bearingRad: (3 * Math.PI) / 4 },
  { label: "Westbound", bearingRad: Math.PI },
  { label: "Southwestbound", bearingRad: (-3 * Math.PI) / 4 },
  { label: "Southbound", bearingRad: -Math.PI / 2 },
  { label: "Southeastbound", bearingRad: -Math.PI / 4 },
];

export function compassLabel(bearingRad: number): string {
  let best = COMPASS[0]!;
  let bestError = Math.PI * 2;
  for (const point of COMPASS) {
    const error = Math.abs(bearingDelta(bearingRad, point.bearingRad));
    if (error < bestError) {
      bestError = error;
      best = point;
    }
  }
  return best.label;
}

/** Turn glyph the diagram draws for a movement. */
export type MovementTurnGlyph = "left" | "right" | "uturn" | "straight" | "unknown";

const GLYPH_BY_RELATION: Readonly<Record<string, MovementTurnGlyph>> = {
  left: "left",
  right: "right",
  uturn: "uturn",
  straight: "straight",
  through: "straight",
};

/**
 * The glyph for a movement.
 *
 * A movement spanning several gates can carry several turn relations — a ball
 * lens on a through approach legitimately serves through AND right. It draws
 * `straight` when through is among them, because that is the movement's dominant
 * character; anything else with a single relation draws that relation, and a
 * mixed non-through set draws `unknown` rather than picking one arbitrarily.
 */
export function movementTurnGlyph(movement: EditorSignalMovement): MovementTurnGlyph {
  const relations = movement.turnRelations;
  if (relations.length === 0) return "unknown";
  if (relations.some((relation) => GLYPH_BY_RELATION[relation] === "straight")) return "straight";
  if (relations.length === 1) return GLYPH_BY_RELATION[relations[0]!] ?? "unknown";
  return "unknown";
}

/** One arrow on the diagram. */
export type MovementDiagramArrow = {
  readonly movementId: string;
  /** Stage that commands it, so the diagram can tint by stage. */
  readonly controllerIds: readonly string[];
  readonly headIds: readonly string[];
  readonly approachLaneRsl: string;
  /** Inbound bearing, radians CCW from +x, OpenDRIVE-local. */
  readonly approachBearingRad: number;
  /** Where the arrow's tail sits on the diagram's unit circle. */
  readonly tail: { readonly x: number; readonly y: number };
  readonly glyph: MovementTurnGlyph;
  readonly label: string;
};

/**
 * Lay the junction's movements out around a unit circle.
 *
 * `radius` is 1 by convention and the component scales; the tail is placed on
 * the circle at the approach's bearing, so movements entering from the same
 * direction cluster and the diagram matches the map's orientation rather than an
 * arbitrary rotation. Movements whose approach bearing cannot be measured are
 * dropped: an arrow at a fabricated bearing points a real author at the wrong
 * approach, which is worse than one arrow missing.
 *
 * `+y` is DOWN in the returned coordinates. See the module header.
 */
export function buildMovementDiagram(input: {
  readonly index: EditorSignalIndex;
  readonly junctionId: string;
  /** Approach lane rsl → its polyline and which end faces the junction. */
  readonly approaches: ReadonlyMap<
    string,
    { readonly polyline: readonly LocalVertex[]; readonly towardsJunction: "end" | "start" }
  >;
}): MovementDiagramArrow[] {
  const junction = input.index.junctionById.get(input.junctionId);
  if (!junction) return [];

  const arrows: MovementDiagramArrow[] = [];
  for (const movementId of junction.movementIds) {
    const movement = input.index.movementById.get(movementId);
    if (!movement) continue;
    for (const approachLaneRsl of movement.approachLaneRsls) {
      const approach = input.approaches.get(approachLaneRsl);
      if (!approach) continue;
      const bearing = approachBearingRad(approach.polyline, approach.towardsJunction);
      if (bearing === null) continue;
      // The tail sits on the far side of the circle from where the traffic is
      // headed, so the arrow points inward the way the driver does.
      arrows.push({
        movementId,
        controllerIds: movement.controllerIds,
        headIds: movement.headIds,
        approachLaneRsl,
        approachBearingRad: bearing,
        tail: { x: -Math.cos(bearing), y: Math.sin(bearing) },
        glyph: movementTurnGlyph(movement),
        label: `${compassLabel(bearing)} ${movementTurnGlyph(movement)}`,
      });
    }
  }
  return arrows.sort(
    (left, right) =>
      left.approachBearingRad - right.approachBearingRad ||
      left.movementId.localeCompare(right.movementId),
  );
}
