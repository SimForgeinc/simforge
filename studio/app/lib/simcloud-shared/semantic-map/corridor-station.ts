/**
 * Turning "this far along this corridor" into an anchor the runtime can resolve.
 *
 * A corridor is a semantic object: it spans however many OpenDRIVE lane
 * segments the map happens to be cut into, and its polyline is stored in TRAVEL
 * order (`lanePolyline` normalises that). An executable anchor is an OpenDRIVE
 * object: one `road:section:lane`, plus a fraction along the road's `+s` axis.
 * Everything that places an actor on a corridor has to cross that gap, and
 * getting it wrong is quiet — a plausible anchor that resolves to the wrong end
 * of the lane still runs, it just drives somewhere else.
 *
 * Two callers cross it: the semantic actor binder (author picks an entity) and
 * the autopilot route compiler (a walk produces a series of stations). They
 * shared nothing before, which is exactly how the route compiler ended up
 * shipping a hardcoded `s_fraction` of 0.5 — every anchor collapsing onto its
 * lane's midpoint — while the binder next door had it right. One implementation,
 * so the next caller inherits the correct convention instead of re-deriving it.
 */

import {
  flipFractionForTravel,
  laneTravelIncreasesSByConvention,
} from "../map-topology/lane-travel";
import type { LaneCorridor, SemanticMapPoint } from "./types";

/** A `road:section:lane` key, split. `roadId` stays a string: it is an id. */
export type ParsedRsl = {
  roadId: string;
  sectionId: number;
  laneId: number;
};

/** The executable half of an anchor: where in the OpenDRIVE map it resolves. */
export type RuntimeLaneBinding = ParsedRsl & {
  /** Fraction along the road's `+s` axis, NOT along travel. */
  sFraction: number;
};

/** A corridor station resolved to both an executable lane and a world pose. */
export type CorridorStationAnchor = RuntimeLaneBinding & {
  point: SemanticMapPoint;
  /** Degrees, runtime/frontend frame — the heading of TRAVEL at this station. */
  yaw: number;
};

export function parseRsl(rsl: string): ParsedRsl | null {
  const match = /^(-?\d+):(-?\d+):(-?\d+)$/.exec(rsl);
  if (!match) return null;
  const sectionId = Number(match[2]);
  const laneId = Number(match[3]);
  if (!Number.isInteger(sectionId) || !Number.isInteger(laneId)) return null;
  return { roadId: match[1]!, sectionId, laneId };
}

/**
 * Travel fraction -> road `+s` fraction.
 *
 * Corridors run in travel order; `s_fraction` is measured along the road's `+s`
 * axis, which for a left-hand (positive id) lane points BACKWARDS relative to
 * travel. Getting this inverted places the actor at the far end of the lane
 * facing a plausible direction, so it fails as a wrong journey rather than as
 * an error.
 *
 * KNOWN GAP: this is the lane-id sign convention, not CARLA's resolved answer.
 * Callers here only ever hold a `SemanticMapGraph`, which carries neither the
 * topology index nor its `laneTravelIncreasesS` stamps; closing that means
 * threading the index through the semantic binder and the route compiler, or
 * stamping direction into the semantic graph artifact (a persisted schema
 * change). Safe today: the convention matches the crawl on every map published
 * (San Ramon P1 1999/1999, Munich 389/389).
 */
export function travelFractionToRoadFraction(
  laneId: number,
  fraction: number,
): number {
  return flipFractionForTravel(
    fraction,
    laneTravelIncreasesSByConvention(laneId),
  );
}

/**
 * Interpolate a polyline at an arc-length station, with the heading there.
 *
 * Returns null when the station falls outside the polyline — a caller asking
 * for a station a corridor does not have is a bug worth surfacing, not a value
 * worth clamping.
 */
export function pointAndYawAtStation(
  points: readonly SemanticMapPoint[],
  stationM: number,
): { point: SemanticMapPoint; yaw: number } | null {
  if (points.length < 2 || stationM < 0) return null;
  let consumed = 0;
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]!;
    const right = points[index]!;
    const length = Math.hypot(
      right.x - left.x,
      right.y - left.y,
      (right.z ?? 0) - (left.z ?? 0),
    );
    const isLast = index === points.length - 1;
    if (stationM <= consumed + length || isLast) {
      if (stationM > consumed + length + 1e-6) return null;
      const ratio = length <= 1e-9 ? 0 : (stationM - consumed) / length;
      const bounded = Math.min(1, Math.max(0, ratio));
      return {
        point: {
          x: left.x + (right.x - left.x) * bounded,
          y: left.y + (right.y - left.y) * bounded,
          z:
            left.z == null || right.z == null
              ? null
              : left.z + (right.z - left.z) * bounded,
        },
        yaw: (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI,
      };
    }
    consumed += length;
  }
  return null;
}

/**
 * Which runtime lane covers this station, and how far along it we are.
 *
 * `runtimeFragments` are the OpenDRIVE segments the corridor was stitched from,
 * in travel order with cumulative arc bounds. The last fragment absorbs a
 * station sitting exactly at the corridor's end, so a route that walks to the
 * final vertex still binds.
 */
export function runtimeBindingAtCorridorStation(
  corridor: LaneCorridor,
  stationM: number,
): RuntimeLaneBinding | null {
  if (stationM < -1e-6 || stationM > corridor.lengthM + 1e-6) return null;
  const fragment = corridor.runtimeFragments.find(
    (candidate, index) =>
      stationM >= candidate.startArcM - 1e-6 &&
      (stationM < candidate.endArcM - 1e-6 ||
        index === corridor.runtimeFragments.length - 1),
  );
  if (!fragment) return null;
  const rsl = parseRsl(fragment.rsl);
  if (!rsl) return null;
  const fragmentLength = fragment.endArcM - fragment.startArcM;
  if (fragmentLength <= 1e-9) return null;
  const travelFraction = (stationM - fragment.startArcM) / fragmentLength;
  return {
    ...rsl,
    sFraction: travelFractionToRoadFraction(rsl.laneId, travelFraction),
  };
}

/** The runtime binding AND the world pose at a corridor station. */
export function corridorStationAnchor(
  corridor: LaneCorridor,
  stationM: number,
): CorridorStationAnchor | null {
  const binding = runtimeBindingAtCorridorStation(corridor, stationM);
  if (!binding) return null;
  const world = pointAndYawAtStation(corridor.polyline, stationM);
  if (!world) return null;
  return { ...binding, point: world.point, yaw: world.yaw };
}
