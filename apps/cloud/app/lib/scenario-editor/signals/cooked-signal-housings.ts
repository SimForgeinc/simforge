import {
  carlaPointToRuntimePoint,
  carlaYawToRuntimeYaw,
} from "@/app/lib/editor-map/coordinate-frames";
import type {
  EditorSignalHousing,
  EditorSignalLamp,
  RuntimeTrafficLightRowLike,
} from "./editor-traffic-lights";

const MAX_HOUSING_ACTOR_DISTANCE_M = 1.5;
const MAX_LAMP_HOUSING_DISTANCE_M = 1.5;
const MAX_HOUSING_MAST_DISTANCE_M = 12;
// The shortest real poles are 4.0 m pedestal posts. Keep this inclusive cutoff
// deliberately below that height so export rounding cannot orphan their heads.
const MIN_MAST_HEIGHT_M = 3;

type Point2 = { x: number; y: number };
type Point3 = Point2 & { z: number };

type EnvironmentTrafficLight = {
  location: Point3;
  extent: Point3;
  yaw: number;
};

type HousingCandidate = EnvironmentTrafficLight & {
  lamps: EditorSignalLamp[];
  mast: CookedMastCandidate | null;
};

type CookedMastCandidate = {
  id: string;
  location: Point3;
  extent: Point3;
};

export type CookedSignalHousingJoinDiagnostics = {
  housing_candidate_count: number;
  matched_housing_count: number;
  dropped_housing_count: number;
  selected_housing_count: number;
  extra_housing_count: number;
  lamp_candidate_count: number;
  matched_lamp_count: number;
  dropped_lamp_count: number;
  duplicate_lamp_count: number;
  housing_lamp_count_mismatch_count: number;
  mast_candidate_count: number;
  matched_housing_mast_count: number;
  unmatched_housing_mast_count: number;
  selected_mast_count: number;
  max_housing_actor_distance_m: number | null;
  max_lamp_housing_distance_m: number | null;
  max_housing_mast_distance_m: number | null;
};

/**
 * A row-indexed housing join.
 *
 * The key is the traffic-light row's original array index, not its actor id.
 * That keeps the join usable for structurally valid rows whose actor id is
 * absent and lets `projectEditorTrafficLights` attach housings before it drops
 * an otherwise unplaceable row.
 */
export class CookedSignalHousingMap extends Map<number, EditorSignalHousing> {
  constructor(
    entries: Iterable<readonly [number, EditorSignalHousing]>,
    readonly diagnostics: CookedSignalHousingJoinDiagnostics,
  ) {
    super(entries);
  }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function trafficLightObject(value: unknown): EnvironmentTrafficLight | null {
  if (!value || typeof value !== "object") return null;
  const object = value as {
    type?: unknown;
    bounding_box?: {
      location?: { x?: unknown; y?: unknown; z?: unknown };
      extent?: { x?: unknown; y?: unknown; z?: unknown };
      rotation?: { yaw?: unknown };
    };
  };
  if (object.type !== "TrafficLight") return null;
  const location = object.bounding_box?.location;
  const extent = object.bounding_box?.extent;
  if (
    !finite(location?.x)
    || !finite(location.y)
    || !finite(location.z)
    || !finite(extent?.x)
    || !finite(extent.y)
    || !finite(extent.z)
  ) {
    return null;
  }
  return {
    location: { x: location.x, y: location.y, z: location.z },
    extent: { x: extent.x, y: extent.y, z: extent.z },
    yaw: finite(object.bounding_box?.rotation?.yaw)
      ? object.bounding_box.rotation.yaw
      : 0,
  };
}

function mastCandidate(value: unknown): CookedMastCandidate | null {
  if (!value || typeof value !== "object") return null;
  const object = value as {
    id?: unknown;
    name?: unknown;
    bounding_box?: {
      location?: { x?: unknown; y?: unknown; z?: unknown };
      extent?: { x?: unknown; y?: unknown; z?: unknown };
    };
  };
  const location = object.bounding_box?.location;
  const extent = object.bounding_box?.extent;
  if (
    !finite(location?.x)
    || !finite(location.y)
    || !finite(location.z)
    || !finite(extent?.x)
    || !finite(extent.y)
    || !finite(extent.z)
    || extent.z * 2 < MIN_MAST_HEIGHT_M
    || Math.max(extent.x * 2, extent.y * 2) >= 1
  ) {
    return null;
  }

  const meshIdentity =
    typeof object.name === "string" && object.name.trim()
      ? object.name.trim()
      : typeof object.id === "string" || typeof object.id === "number"
        ? String(object.id)
        : "";
  if (!meshIdentity) return null;

  return {
    id: `cooked-mast:${meshIdentity}`,
    location: { x: location.x, y: location.y, z: location.z },
    extent: { x: extent.x, y: extent.y, z: extent.z },
  };
}

function actorLocation(row: RuntimeTrafficLightRowLike | null | undefined): Point2 | null {
  if (!row) return null;
  const location = row.location;
  if (!finite(location?.x) || !finite(location.y)) return null;
  return { x: location.x, y: location.y };
}

function distance2d(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distance3d(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function nearestIndex<Point extends Point2, Location extends Point2>(
  point: Point,
  locations: readonly (Location | null)[],
  distance: (a: Point, b: Location) => number,
): { index: number; distance: number } | null {
  let nearest: { index: number; distance: number } | null = null;
  for (let index = 0; index < locations.length; index += 1) {
    const location = locations[index];
    if (!location) continue;
    const candidateDistance = distance(point, location);
    if (!nearest || candidateDistance < nearest.distance) {
      nearest = { index, distance: candidateDistance };
    }
  }
  return nearest;
}

/** Millimetre identity removes byte-for-byte duplicate lens exports. */
function lampPositionKey(lamp: EditorSignalLamp): string {
  return `${round(lamp.x)}:${round(lamp.y)}:${round(lamp.z)}`;
}

function toHousing(candidate: HousingCandidate): EditorSignalHousing {
  const runtime = carlaPointToRuntimePoint(candidate.location);
  const mastRuntime = candidate.mast
    ? carlaPointToRuntimePoint(candidate.mast.location)
    : null;
  return {
    x: round(runtime.x),
    y: round(runtime.y),
    z: round(candidate.location.z),
    size_x: round(candidate.extent.x * 2, 2),
    size_y: round(candidate.extent.y * 2, 2),
    size_z: round(candidate.extent.z * 2, 2),
    yaw: round(carlaYawToRuntimeYaw(candidate.yaw), 2),
    // `environment_objects` has absolute elevations but no ground reference.
    // `projectEditorTrafficLights` supplies the authored `<signal zOffset>`
    // after this geometry is joined to the XODR head.
    height_above_ground_m: null,
    lamps: [...candidate.lamps].sort((a, b) => b.z - a.z),
    // These z values are absolute until `projectEditorTrafficLights` recovers
    // the road elevation from the authored signal and converts both to heights.
    mast: candidate.mast && mastRuntime
      ? {
          id: candidate.mast.id,
          x: round(mastRuntime.x),
          y: round(mastRuntime.y),
          base_height_m: round(
            candidate.mast.location.z - candidate.mast.extent.z,
          ),
          top_height_m: round(
            candidate.mast.location.z + candidate.mast.extent.z,
          ),
        }
      : null,
  };
}

/**
 * Join cooked `environment_objects` signal geometry to traffic-light rows.
 *
 * Both inputs are in CARLA coordinates for this join. Coordinates are converted
 * to the runtime frame only when the returned editor housing is materialized.
 * Housings farther than 1.5 m in XY and lenses farther than 1.5 m in 3D are
 * counted and dropped rather than force-matched.
 */
export function joinCookedSignalHousings(
  environmentObjects: readonly unknown[],
  rows: readonly (RuntimeTrafficLightRowLike | null | undefined)[] | null | undefined,
): CookedSignalHousingMap {
  const trafficLights = environmentObjects
    .map(trafficLightObject)
    .filter((value): value is EnvironmentTrafficLight => value !== null);
  const housings: HousingCandidate[] = trafficLights
    .filter((object) => object.extent.z * 2 > 0.5)
    .map((object) => ({ ...object, lamps: [], mast: null }));
  const lamps = trafficLights.filter((object) => object.extent.z * 2 <= 0.5);
  const housingLocations = housings.map((housing) => housing.location);
  const masts = environmentObjects
    .map(mastCandidate)
    .filter((value): value is CookedMastCandidate => value !== null);
  const mastLocations = masts.map((mast) => mast.location);

  let matchedLampCount = 0;
  let droppedLampCount = 0;
  let duplicateLampCount = 0;
  let maxLampHousingDistance = 0;
  const lampKeysByHousing = housings.map(() => new Set<string>());
  for (const lamp of lamps) {
    const nearest = nearestIndex(lamp.location, housingLocations, distance3d);
    if (!nearest || nearest.distance > MAX_LAMP_HOUSING_DISTANCE_M) {
      droppedLampCount += 1;
      continue;
    }
    maxLampHousingDistance = Math.max(maxLampHousingDistance, nearest.distance);
    const runtime = carlaPointToRuntimePoint(lamp.location);
    const projected = {
      x: round(runtime.x),
      y: round(runtime.y),
      z: round(lamp.location.z),
    };
    const key = lampPositionKey(projected);
    const keys = lampKeysByHousing[nearest.index]!;
    if (keys.has(key)) {
      duplicateLampCount += 1;
      continue;
    }
    keys.add(key);
    housings[nearest.index]!.lamps.push(projected);
    matchedLampCount += 1;
  }

  let matchedHousingMastCount = 0;
  let maxHousingMastDistance = 0;
  const selectedMastIds = new Set<string>();
  for (const housing of housings) {
    const nearest = nearestIndex(housing.location, mastLocations, distance2d);
    if (!nearest || nearest.distance > MAX_HOUSING_MAST_DISTANCE_M) continue;
    const mast = masts[nearest.index]!;
    housing.mast = mast;
    matchedHousingMastCount += 1;
    maxHousingMastDistance = Math.max(maxHousingMastDistance, nearest.distance);
    selectedMastIds.add(mast.id);
  }

  const actorLocations = (rows ?? []).map(actorLocation);
  const selected = new Map<
    number,
    { housing: HousingCandidate; distance: number }
  >();
  let matchedHousingCount = 0;
  let droppedHousingCount = 0;
  let extraHousingCount = 0;
  let maxHousingActorDistance = 0;
  for (const housing of housings) {
    const nearest = nearestIndex(housing.location, actorLocations, distance2d);
    if (!nearest || nearest.distance > MAX_HOUSING_ACTOR_DISTANCE_M) {
      droppedHousingCount += 1;
      continue;
    }
    matchedHousingCount += 1;
    maxHousingActorDistance = Math.max(maxHousingActorDistance, nearest.distance);
    const current = selected.get(nearest.index);
    if (!current) {
      selected.set(nearest.index, { housing, distance: nearest.distance });
    } else {
      extraHousingCount += 1;
      if (nearest.distance < current.distance) {
        selected.set(nearest.index, { housing, distance: nearest.distance });
      }
    }
  }

  const entries: Array<readonly [number, EditorSignalHousing]> = [];
  for (const [rowIndex, match] of selected) {
    entries.push([rowIndex, toHousing(match.housing)]);
  }

  return new CookedSignalHousingMap(entries, {
    housing_candidate_count: housings.length,
    matched_housing_count: matchedHousingCount,
    dropped_housing_count: droppedHousingCount,
    selected_housing_count: entries.length,
    extra_housing_count: extraHousingCount,
    lamp_candidate_count: lamps.length,
    matched_lamp_count: matchedLampCount,
    dropped_lamp_count: droppedLampCount,
    duplicate_lamp_count: duplicateLampCount,
    housing_lamp_count_mismatch_count: housings.filter(
      (housing) => housing.lamps.length !== 3,
    ).length,
    mast_candidate_count: masts.length,
    matched_housing_mast_count: matchedHousingMastCount,
    unmatched_housing_mast_count: housings.length - matchedHousingMastCount,
    selected_mast_count: selectedMastIds.size,
    max_housing_actor_distance_m:
      matchedHousingCount > 0 ? round(maxHousingActorDistance) : null,
    max_lamp_housing_distance_m:
      matchedLampCount > 0 ? round(maxLampHousingDistance) : null,
    max_housing_mast_distance_m:
      matchedHousingMastCount > 0 ? round(maxHousingMastDistance) : null,
  });
}
