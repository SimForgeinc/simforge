/**
 * Intersection-control candidates: which junctions the author can place a
 * control on, and what each one IS (plan 2026-07-26, section 4.3).
 *
 * The complaint this module answers is a referent problem, not a layout
 * problem. `Junction 1069` is an OpenDRIVE integer with no spatial meaning to a
 * human, and every surface in the editor renders that integer and nothing else.
 * A candidate carries identity instead — how many legs it has, which way they
 * point, how many physical heads stand in it, how big it really is — so the
 * marker on the map, the hover card, the SCENE-lane row and the editing card
 * can all say the SAME name. One name in four places is the actual fix.
 *
 * Pure and side-effect free: junction index + runtime traffic lights + the
 * scenario's signal plans in, a candidate list out. No React, no map, no fetch.
 *
 * ## Coordinates
 *
 * Positions are RUNTIME-WORLD METRES, CARLA basis (+y south) — the basis the
 * junction index's centroids and the runtime traffic lights already share.
 * Bearings are degrees CCW from +x in that same basis, matching
 * `JunctionMovementBinding.approach_heading_deg`: the direction of travel
 * ENTERING the junction. The LEG a movement arrives on therefore lies at
 * `bearing + 180`, which is the convention `MovementDiagram` already draws with.
 */

import { compassLabel, type JunctionSignalPlan } from "@simforge/studio-shared";
import {
  headRuntimePoint,
  type Map3DSignalHeadSource,
} from "@/app/lib/scenario-editor/map-3d/signal-head-model";
import {
  attributeLightsToJunctions,
  type SignalJunctionIndex,
  type SignalJunctionSummary,
} from "./junction-index";

/**
 * Structural cover for one head of the map's traffic-light index.
 *
 * An alias of `Map3DSignalHeadSource` (`map-3d/signal-head-model.ts`) rather
 * than a parallel declaration: the ghost previews are built from these same rows
 * by the same pose pipeline the real heads use, so a ghost cannot stand anywhere
 * a real head would not, and the two shapes drifting apart is precisely how that
 * guarantee would be lost.
 */
export type IntersectionCandidateLightSource = Map3DSignalHeadSource;

/**
 * How a light was attributed to its junction.
 *
 * `signal_id` is the exact answer — the head's OpenDRIVE id appearing in a
 * junction movement's `signal_ids`. `footprint` is the 25 m geometric fallback.
 */
export type IntersectionLightAttribution = "signal_id" | "footprint";

export type IntersectionCandidateLight = {
  /** Stable id: the OpenDRIVE `<signal>` id when present, else the actor id. */
  id: string;
  /** Runtime-frame ground position of the head's pole, metres. */
  x: number;
  y: number;
  /** Compass bearing of the head from the junction centroid, degrees. */
  bearingDeg: number;
  attribution: IntersectionLightAttribution;
  /** The runtime row itself — the pose source for the 3D ghost preview. */
  source: IntersectionCandidateLightSource;
};

export type IntersectionCandidate = {
  junctionId: string;
  /** Runtime-frame centroid, from the junction index. */
  center: { x: number; y: number };
  radiusM: number;
  /** Physical heads attributed to this junction, in runtime frame. */
  lights: readonly IntersectionCandidateLight[];
  /** Distinct approach ids from the movement table. */
  approachCount: number;
  movementCount: number;
  /** Bearings of the distinct approaches, degrees, sorted ascending. */
  approachBearingsDeg: readonly number[];
  /** Human identity: `"N–S × E–W"`, `"T-junction (N–S × E)"`, `"3 approaches"`. */
  identity: string;
  /** True when an authored plan exists AND is not the untouched map_default. */
  controlled: boolean;
  /** Whether the map confirms signals here. Uncontrolled + unsignalized = not a candidate. */
  signalized: boolean;
  /**
   * Other candidates whose footprint overlaps this one by more than
   * `OVERLAP_WARN_FRACTION`. Non-empty means the map probably splits one
   * physical intersection across two OpenDRIVE junction ids — a real defect on
   * six of our maps, surfaced honestly rather than papered over (risk R3).
   */
  overlapsJunctionIds: readonly string[];
};

/** Two junction discs this deep into each other are almost certainly one place. */
export const OVERLAP_WARN_FRACTION = 0.6;

/** Approaches within this of each other are the same leg seen twice. */
const APPROACH_CLUSTER_DEG = 45;

function lightId(source: IntersectionCandidateLightSource, index: number): string {
  const openDriveId =
    source.opendrive_id != null ? String(source.opendrive_id).trim() : "";
  if (openDriveId) return openDriveId;
  return source.actor_id != null ? String(source.actor_id) : `light-${index}`;
}

/** `((deg % 360) + 360) % 360`, but tolerant of a non-finite input. */
function wrap360(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return ((degrees % 360) + 360) % 360;
}

/** Shortest signed separation between two bearings, in `(-180, 180]`. */
export function bearingDelta(left: number, right: number): number {
  const delta = wrap360(left - right);
  return delta > 180 ? delta - 360 : delta;
}

/**
 * Collapse near-identical approach bearings into one leg each.
 *
 * A four-way junction's movement table carries one binding per (approach, turn),
 * so its four legs arrive as a dozen bearings that differ by fractions of a
 * degree. Clustering at 45° is what turns those back into "four legs", and it is
 * loose enough to survive a skewed intersection without merging two real legs.
 */
export function clusterApproachBearings(
  bearingsDeg: readonly number[],
  toleranceDeg = APPROACH_CLUSTER_DEG,
): number[] {
  const clusters: Array<{ x: number; y: number; count: number }> = [];
  for (const raw of bearingsDeg) {
    if (!Number.isFinite(raw)) continue;
    const bearing = wrap360(raw);
    const radians = (bearing * Math.PI) / 180;
    const existing = clusters.find((cluster) => {
      const mean = (Math.atan2(cluster.y, cluster.x) * 180) / Math.PI;
      return Math.abs(bearingDelta(bearing, mean)) <= toleranceDeg;
    });
    if (existing) {
      existing.x += Math.cos(radians);
      existing.y += Math.sin(radians);
      existing.count += 1;
      continue;
    }
    clusters.push({ x: Math.cos(radians), y: Math.sin(radians), count: 1 });
  }
  return clusters
    .map((cluster) => wrap360((Math.atan2(cluster.y, cluster.x) * 180) / Math.PI))
    .sort((left, right) => left - right);
}

/** `"NB"` → `"N"`: the axis letter, not the bound. */
function compassLetter(bearingDeg: number): "N" | "E" | "S" | "W" {
  const label = compassLabel((wrap360(bearingDeg) * Math.PI) / 180);
  return label[0] as "N" | "E" | "S" | "W";
}

const OPPOSITE: Record<"N" | "E" | "S" | "W", "N" | "E" | "S" | "W"> = {
  N: "S",
  S: "N",
  E: "W",
  W: "E",
};

function axisLabel(letter: "N" | "E" | "S" | "W"): string {
  return letter === "N" || letter === "S" ? "N–S" : "E–W";
}

function pluralApproaches(count: number): string {
  return count === 1 ? "1 approach" : `${count} approaches`;
}

/**
 * The junction's geometric signature.
 *
 * Street names would be better (`"Page Mill × El Camino"`) but nothing in the
 * junction index or the topology carries them — that needs a per-map
 * reverse-geocode join, and it is a follow-up with a clear trigger (plan Q1).
 * The signature below is derivable from data already in the store, is stable
 * across map rebuilds, and answers "which one is this?" when read next to a
 * marker, which is the only place it is ever read.
 */
export function junctionIdentityLabel(
  clusteredBearingsDeg: readonly number[],
  fallbackApproachCount = 0,
): string {
  const letters = [...new Set(clusteredBearingsDeg.map(compassLetter))];
  if (letters.length === 0) {
    return fallbackApproachCount > 0
      ? pluralApproaches(fallbackApproachCount)
      : "Junction";
  }
  if (letters.length === 4) return "N–S × E–W";
  if (letters.length === 3) {
    const stem = letters.find((letter) => letters.includes(OPPOSITE[letter]));
    const leg = letters.find((letter) => !letters.includes(OPPOSITE[letter]));
    if (stem && leg) return `T-junction (${axisLabel(stem)} × ${leg})`;
  }
  const [first, second] = letters;
  if (letters.length === 2 && first && second === OPPOSITE[first]) {
    return `${axisLabel(first)} crossing`;
  }
  return pluralApproaches(letters.length);
}

/**
 * Does this plan represent a control the author placed?
 *
 * `map_default` is what an UNPLANNED junction already does at runtime — forced
 * green for the whole scenario — so a plan sitting in that mode is a junction
 * that was opened and never authored, not a control. Scripted clips are checked
 * separately because they can outlive a mode reset.
 */
export function isJunctionControlled(
  plan: JunctionSignalPlan | null | undefined,
): boolean {
  if (!plan) return false;
  if (plan.mode !== "map_default") return true;
  return (plan.scripted?.length ?? 0) > 0;
}

export type JunctionApproachSignature = {
  /** Bearings of the distinct approaches, degrees, sorted ascending. */
  bearingsDeg: number[];
  approachCount: number;
  movementCount: number;
  identity: string;
};

/**
 * A junction's approach structure and its human name, from the movement table
 * alone.
 *
 * Exported because the identity string has to be the SAME string on the map
 * marker, in the hover card, on the SCENE-lane row, in the junction list and in
 * the editing card. Four surfaces deriving "which one is this?" independently is
 * how they drift, and drift is the original complaint.
 */
export function junctionApproachSignature(
  junction: SignalJunctionSummary,
): JunctionApproachSignature {
  const byApproach = new Map<string, number>();
  const approaches = new Set<string>();
  for (const movement of junction.movements) {
    approaches.add(movement.approach_id);
    if (movement.approach_heading_deg == null) continue;
    if (!byApproach.has(movement.approach_id)) {
      byApproach.set(movement.approach_id, movement.approach_heading_deg);
    }
  }
  const bearingsDeg = clusterApproachBearings([...byApproach.values()]);
  return {
    bearingsDeg,
    approachCount: approaches.size,
    movementCount: junction.movements.length,
    identity: junctionIdentityLabel(bearingsDeg, approaches.size),
  };
}

/**
 * OpenDRIVE `<signal>` id → the junction whose movement table claims it.
 *
 * This is the EXACT attribution tier, and it is exact because both sides come
 * from the same XODR: the junction index's `signal_ids` are the map's own
 * `<signal>` references, and a head's `opendrive_id` is the id of the signal it
 * physically is. Measured against the real bundles it resolves 99–100% of heads
 * on every lit map (San Ramon P1 146/147, Yale 46/46, Page Mill 70/70, Di Rosa
 * 102/103, El Camino 23/23, Richmond 11/11).
 *
 * It replaced `stop_waypoints[].junction_id`, which was the shipped exact tier
 * and never fired: a stop waypoint sits on the APPROACH lane, outside the
 * junction box, so CARLA reports its junction id as -1 on 90–100% of heads and
 * every light fell through to the geometric fallback.
 *
 * First binding wins, matching `signalIdToMovementIndex`: an id claimed by two
 * junctions is a map defect, and picking deterministically beats a light that
 * changes junction between renders.
 */
export function junctionIdBySignalId(
  junctions: readonly SignalJunctionSummary[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const junction of junctions) {
    for (const movement of junction.movements ?? []) {
      for (const signalId of movement.signal_ids ?? []) {
        const key = String(signalId).trim();
        if (key && !index.has(key)) index.set(key, junction.junction_id);
      }
    }
  }
  return index;
}

export type BuildIntersectionCandidatesInput = {
  index: SignalJunctionIndex | null;
  runtimeLights: readonly IntersectionCandidateLightSource[] | null | undefined;
  plans: readonly JunctionSignalPlan[];
  /** Footprint slack for the geometric fallback; a light stands at the kerb. */
  attributionMarginM?: number;
};

/**
 * Every junction the author may place an intersection control on.
 *
 * Signalized junctions only, PLUS anything already controlled — a city map
 * carries hundreds of junctions with a derivable movement table and no lights,
 * and offering a colour picker for a stop sign is the noise this filter exists
 * to remove (plan Q3). `JunctionListPanel` keeps listing everything for the rare
 * stop-sign case.
 */
export function buildIntersectionCandidates({
  index,
  runtimeLights,
  plans,
  attributionMarginM = 25,
}: BuildIntersectionCandidatesInput): IntersectionCandidate[] {
  if (!index) return [];

  const planByJunction = new Map(plans.map((plan) => [plan.junction_id, plan]));
  const junctionBySignalId = junctionIdBySignalId(index.junctions);

  type Placed = {
    source: IntersectionCandidateLightSource;
    index: number;
    x: number;
    y: number;
  };
  const exactByJunction = new Map<string, Placed[]>();
  const unattributed: Placed[] = [];
  for (const [position, source] of (runtimeLights ?? []).entries()) {
    const point = headRuntimePoint(source);
    if (!point) continue;
    const placed: Placed = { source, index: position, x: point.x, y: point.y };
    const openDriveId =
      source.opendrive_id != null ? String(source.opendrive_id).trim() : "";
    const exact = openDriveId ? junctionBySignalId.get(openDriveId) : undefined;
    if (exact) {
      const existing = exactByJunction.get(exact);
      if (existing) existing.push(placed);
      else exactByJunction.set(exact, [placed]);
      continue;
    }
    unattributed.push(placed);
  }
  const geometricByJunction = attributeLightsToJunctions(
    index.junctions,
    unattributed,
    attributionMarginM,
  );

  const candidates: IntersectionCandidate[] = [];
  for (const junction of index.junctions) {
    const plan = planByJunction.get(junction.junction_id) ?? null;
    const controlled = isJunctionControlled(plan);
    const exact = exactByJunction.get(junction.junction_id) ?? [];
    const geometric = geometricByJunction.get(junction.junction_id) ?? [];
    const signalized = junction.signalized || exact.length + geometric.length > 0;
    if (!signalized && !controlled) continue;

    const lights: IntersectionCandidateLight[] = [
      ...exact.map((placed) => ({ placed, attribution: "signal_id" as const })),
      ...geometric.map((placed) => ({ placed, attribution: "footprint" as const })),
    ]
      .sort((left, right) => left.placed.index - right.placed.index)
      .map(({ placed, attribution }) => ({
        id: lightId(placed.source, placed.index),
        x: placed.x,
        y: placed.y,
        bearingDeg: wrap360(
          (Math.atan2(placed.y - junction.center.y, placed.x - junction.center.x) *
            180) /
            Math.PI,
        ),
        attribution,
        source: placed.source,
      }));

    const signature = junctionApproachSignature(junction);
    candidates.push({
      junctionId: junction.junction_id,
      center: junction.center,
      radiusM: junction.radius_m,
      lights,
      approachCount: signature.approachCount,
      movementCount: signature.movementCount,
      approachBearingsDeg: signature.bearingsDeg,
      identity: signature.identity,
      controlled,
      signalized,
      overlapsJunctionIds: [],
    });
  }

  return withOverlapAnnotations(candidates);
}

/**
 * Fill in `overlapsJunctionIds` — O(n²) over candidates, which is tens of
 * entries on the densest map we ship.
 */
function withOverlapAnnotations(
  candidates: readonly IntersectionCandidate[],
): IntersectionCandidate[] {
  const overlaps = new Map<string, string[]>();
  for (let left = 0; left < candidates.length; left += 1) {
    const leftCandidate = candidates[left];
    if (!leftCandidate) continue;
    for (let right = left + 1; right < candidates.length; right += 1) {
      const rightCandidate = candidates[right];
      if (!rightCandidate) continue;
      if (!candidateFootprintsOverlap(leftCandidate, rightCandidate)) continue;
      pushOverlap(overlaps, leftCandidate.junctionId, rightCandidate.junctionId);
      pushOverlap(overlaps, rightCandidate.junctionId, leftCandidate.junctionId);
    }
  }
  return candidates.map((candidate) => ({
    ...candidate,
    overlapsJunctionIds: overlaps.get(candidate.junctionId) ?? [],
  }));
}

function pushOverlap(
  overlaps: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const existing = overlaps.get(key);
  if (existing) existing.push(value);
  else overlaps.set(key, [value]);
}

/**
 * Do two candidate footprints describe the same physical intersection?
 *
 * `fraction` is how much of the SMALLER disc the larger one covers. Coverage is
 * interpolated linearly between "fully inside" (`d ≤ r₁ − r₂`) and "just
 * touching" (`d ≥ r₁ + r₂`), which is accurate enough for a hover-card warning
 * and does not need a lens-area integral.
 */
export function candidateFootprintsOverlap(
  left: Pick<IntersectionCandidate, "center" | "radiusM">,
  right: Pick<IntersectionCandidate, "center" | "radiusM">,
  fraction = OVERLAP_WARN_FRACTION,
): boolean {
  const smaller = Math.min(left.radiusM, right.radiusM);
  const larger = Math.max(left.radiusM, right.radiusM);
  if (!(smaller > 0)) return false;
  const distance = Math.hypot(
    left.center.x - right.center.x,
    left.center.y - right.center.y,
  );
  return distance <= larger + smaller - 2 * fraction * smaller;
}
