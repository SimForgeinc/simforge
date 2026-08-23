/**
 * Parking cluster scene-graph builder.
 *
 * Extracts two flavors of parking geometry from RoadRunner GeoJSON and emits
 * ParkingClusterEntity records:
 *
 *   • Lane-backed clusters — Lane[LaneType=Parking] LineStrings buffered into
 *     polygons, clustered by proximity. These surface in search as on-street
 *     curb parking (kind "street_parking").
 *   • Standalone parking lots — ParkingSpace polygons that aren't adjacent to
 *     any parking lane, clustered by centroid proximity and wrapped in a
 *     convex hull. These surface in search as off-street parking lots (kind
 *     "parking_lot").
 *
 * For every cluster, the builder also scans nearby Lane[LaneType=driving]
 * centerlines and records candidate entry/exit access points on the cluster
 * boundary.
 */

import type {
  ParkingClusterEntity,
} from "../../map-intelligence";
import { simplifyPolygon } from "../simplify-polygon";
import { bufferLineString } from "../buffer-line-string";
import { convexHull } from "../convex-hull";
import {
  type LngLat,
  type DrivingLane,
  closeRing,
  polygonCentroid,
  polygonAreaM2,
  ringBbox,
  ringSpanM,
  ringsWithinThresholdDeg,
  pointInPolygon,
  computeAccessPoints,
  dedupeAccessPoints,
  nearestDrivingLaneDistM,
  computePolygonCentroid,
  firstPolygonRing,
} from "./parking-geometry-helpers";
import {
  type ParkingSpace,
  type ParkingLane,
  parseLaneLinkIds,
  connectedLaneComponents,
  stitchLaneCenterlines,
  spacePerpToLane,
  clusterParkingSpaces,
} from "./parking-clustering";

export type BuildParkingClustersResult = {
  entities: ParkingClusterEntity[];
  warnings: string[];
};

/**
 * Perpendicular distance (meters) within which a ParkingSpace counts as
 * sitting *on* a parking lane and is collapsed into that lane's street-parking
 * location. Matches LANE_BUFFER_M — the lane's rendered footprint half-width —
 * so "on the lane" means "inside the lane polygon". Calibrated on Di Rosa:
 * on-lane stalls sit within ~5 m of the centerline and the next-nearest stalls
 * are ~44 m away, so 8 m captures the curb row cleanly without reaching across
 * a street. The earlier centroid-radius test measured distance from the lane
 * *cluster's* mean point and so dropped stalls near the ends of long
 * (40-110 m) lanes — ~507 of Di Rosa's on-lane stalls leaked out that way.
 */
const LANE_SPACE_PERP_M = 8;
/**
 * Maximum distance (degrees) between ParkingSpace polygons in the same lot
 * cluster. ~25 m — tight enough to avoid chaining two lots that flank a
 * narrow street, loose enough that back-to-back parking rows separated by a
 * typical drive aisle still belong to one lot.
 */
const SPACE_CLUSTER_DIST_DEG = 0.000225;
/** Lane centerline buffer for lane-backed cluster regions. */
const LANE_BUFFER_M = 8;
/**
 * Perpendicular distance (meters) below which a ParkingSpace counts as
 * lining a driving lane — i.e. on-street curb parking. Matches the
 * `ADJACENCY_THRESHOLD_M` the standalone street-parking extractor used, so
 * the two agree on what "next to the road" means. ~p75 of Di Rosa's
 * stall-to-lane distances is 11 m, so 12 m captures real curb rows without
 * reaching across a typical street.
 */
const STREET_SPACE_ADJACENCY_M = 12;
/**
 * Fraction of a ParkingSpace cluster's members that must line a driving lane
 * for the whole cluster to be treated as on-street parking rather than an
 * off-street lot. A curb row scores ~1.0 here; a 2-D lot (multiple rows, an
 * interior set back from the road) scores well below. Calibrated against Di
 * Rosa: street rows hug at 0.78-1.0, genuine lots at 0.12-0.54, so 0.70
 * separates them cleanly while keeping a lot whose perimeter row sits near a
 * road on the lot side ("lot wins for dense clusters").
 */
const STREET_CLUSTER_HUG_FRACTION = 0.7;

/**
 * Average lot footprint per parking space in m². Calibrated against 119
 * Bay Area Overture lots that carry both a declared capacity and a real
 * polygon — median 30.5 m² (p25-p75: 20.5-38.4). Matches the standard
 * parking-design rule of one stall (~12.5 m²) plus its half-share of
 * drive aisle (~17.5 m²). Used when neither Overture capacity nor any
 * in-house ParkingSpace landed inside the polygon.
 */
const M2_PER_PARKING_SPACE = 30;

/**
 * Maximum distance (degrees) between two parking-lot polygons that will
 * be merged into one cluster in the post-aggregation pass. Matches
 * `SPACE_CLUSTER_DIST_DEG` so the same "this looks like one parking
 * facility" rule applies whether the inputs are individual ParkingSpace
 * polygons (early aggregation) or already-formed lot clusters (late
 * aggregation). ~25 m at 37° latitude — wide enough to bridge the drive
 * aisle / curb-island gap between sub-lots Overture carved up, tight
 * enough to keep two lots flanking a real street separate without an
 * explicit road-crossing check.
 */
const LOT_MERGE_DIST_DEG = SPACE_CLUSTER_DIST_DEG;

type ParkingGeometry = {
  parkingLanes: ParkingLane[];
  parkingSpaces: ParkingSpace[];
  drivingLanes: DrivingLane[];
};

/**
 * Caller-supplied parking lot polygon (typically from Overture
 * `theme=base/type=infrastructure` `class IN ('parking', 'parking_space')`).
 * Used as the canonical lot boundary by `buildParkingClusters` when present:
 * each ParkingSpace whose centroid falls inside an Overture polygon is
 * absorbed into a cluster keyed on that polygon, instead of running our
 * convex-hull aggregation. Spaces outside every polygon fall back to the
 * existing aggregation (orphan path).
 */
export type OvertureParkingLot = {
  /** Stable Overture feature ID — flows into `provenance.sourceIds`. */
  id: string;
  /** Outer ring of the lot boundary as `[lng, lat]` pairs. */
  polygon: LngLat[];
  /**
   * Declared capacity from Overture's `source_tags.capacity` (OSM
   * "capacity=*" tag), when populated. ~8% of Bay Area parking lots
   * carry a real value. When present and > 0 it wins over both the
   * in-house ParkingSpace member count and the area-based estimate
   * for the cluster's `spaceCount`.
   */
  capacity?: number;
};

export function buildParkingClusters(
  geojsonText: string,
  overtureLots: OvertureParkingLot[] = [],
): BuildParkingClustersResult {
  const warnings: string[] = [];

  let root: unknown;
  try {
    root = JSON.parse(geojsonText) as unknown;
  } catch {
    warnings.push("parking-builder: invalid GeoJSON, skipping");
    return { entities: [], warnings };
  }

  const geometry = collectParkingGeometry(root, warnings);
  if (
    geometry.parkingLanes.length === 0 &&
    geometry.parkingSpaces.length === 0 &&
    overtureLots.length === 0
  ) {
    return { entities: [], warnings };
  }

  const entities: ParkingClusterEntity[] = [];

  // 1. Street parking on parking lanes. Each Lane[LaneType=Parking] is its own
  //    street-parking location; every ParkingSpace sitting on the lane (within
  //    LANE_SPACE_PERP_M perpendicular of the lane line and alongside its span)
  //    is collapsed into it. This runs first and consumes those stalls, so the
  //    driving-lane-adjacency and lot paths below only see the leftovers — a
  //    parking lane's stalls are never split into individual locations or
  //    merged with other parking. Each stall is assigned to its single nearest
  //    parking lane; lanes are never merged with each other.
  const spaceConsumedByLane = new Set<number>();
  const spacesByLane = new Map<number, number[]>();
  for (const space of geometry.parkingSpaces) {
    const mPerDegLat = 111_320;
    const mPerDegLng = 111_320 * Math.max(Math.cos((space.centroid.lat * Math.PI) / 180), 0.2);
    const point: LngLat = [space.centroid.lng, space.centroid.lat];
    let best = { laneIdx: -1, distM: Infinity };
    for (let li = 0; li < geometry.parkingLanes.length; li++) {
      const r = spacePerpToLane(point, geometry.parkingLanes[li]!.coordinates, mPerDegLat, mPerDegLng);
      if (r.alongside && r.distM < best.distM) best = { laneIdx: li, distM: r.distM };
    }
    if (best.laneIdx >= 0 && best.distM <= LANE_SPACE_PERP_M) {
      const bucket = spacesByLane.get(best.laneIdx);
      if (bucket) bucket.push(space.index);
      else spacesByLane.set(best.laneIdx, [space.index]);
      spaceConsumedByLane.add(space.index);
    }
  }

  // Group connected parking lanes. A lane's Predecessors/Successors links to
  // another *parking* lane mean they're one continuous curb (RoadRunner splits
  // a physical parking strip into multiple Lane features at lane-section
  // breaks). Each connected component becomes ONE street-parking location whose
  // region is the buffered, stitched-together centerline of all its lanes and
  // which owns every stall absorbed by any member lane. A lane with no
  // parking-lane links is a single-member component, identical to the old
  // per-lane output.
  for (const component of connectedLaneComponents(geometry.parkingLanes)) {
    const memberLanes = component.map((i) => geometry.parkingLanes[i]!);
    const onLaneSpaceIndices = component.flatMap((i) => spacesByLane.get(i) ?? []);
    const laneIds = memberLanes.map((l) => l.id);

    const center = {
      lat: memberLanes.reduce((s, l) => s + l.center.lat, 0) / memberLanes.length,
      lng: memberLanes.reduce((s, l) => s + l.center.lng, 0) / memberLanes.length,
    };
    const mergedCenterline = stitchLaneCenterlines(memberLanes);
    const regionPolygon = simplifyPolygon(
      bufferLineString(mergedCenterline, LANE_BUFFER_M, center.lat),
      32,
    );
    const region: ParkingClusterEntity["region"] = {
      type: "Polygon",
      coordinates: [regionPolygon],
    };
    const accessPoints = computeAccessPoints(regionPolygon, geometry.drivingLanes);
    const absorbedSpaceIds = onLaneSpaceIndices.map((i) => `space_${i}`);
    entities.push({
      // component[0] is the smallest member index, so a lone lane keeps its
      // historical `parking_lane_${idx}` entityId.
      entityId: `parking_lane_${component[0]}`,
      kind: "parking_cluster",
      center,
      region,
      provenance: {
        sourceFile: "geojson",
        sourceIds: laneIds,
        extractorVersion: "1.4.0",
      },
      parkingLaneIds: laneIds,
      ...(absorbedSpaceIds.length > 0 ? { parkingSpaceIds: absorbedSpaceIds } : {}),
      totalLengthM: Math.round(memberLanes.reduce((s, l) => s + l.lengthM, 0)),
      spaceCount: onLaneSpaceIndices.length > 0 ? onLaneSpaceIndices.length : undefined,
      isStreetParking: true,
      isLotParking: false,
      isStandaloneLot: false,
      ...(accessPoints.length > 0 ? { accessPoints } : {}),
    });
  }

  // 2. Off-street lots. Two paths:
  //
  //   (a) Overture-as-aggregator: when caller provides Overture parking
  //       polygons, each one becomes a cluster and we sweep up the spaces
  //       whose centroids fall inside it. Convex-hull aggregation runs only
  //       on the leftover orphans. Overture polygons with zero in-house
  //       spaces inside still emit a cluster (the user wants those — they
  //       represent parking lots Overture knows about that we don't have
  //       ground-truth ParkingSpace data for).
  //
  //   (b) No Overture input: today's behavior — convex-hull cluster all
  //       unconsumed ParkingSpaces.
  //
  // We treat centroid-in-polygon as a stand-in for the user's "≥50% area
  // inside" criterion. ParkingSpace polygons are small (~50 m²) relative to
  // Overture lots, so the two metrics agree in >95% of cases without the
  // cost of a full polygon-intersection library.
  let unconsumedSpaces = geometry.parkingSpaces.filter(
    (s) => !spaceConsumedByLane.has(s.index),
  );

  if (overtureLots.length > 0) {
    const consumedByOverture = new Set<number>();
    for (let i = 0; i < overtureLots.length; i++) {
      const lot = overtureLots[i]!;
      const insideSpaces: ParkingSpace[] = [];
      for (const space of unconsumedSpaces) {
        if (consumedByOverture.has(space.index)) continue;
        if (pointInPolygon([space.centroid.lng, space.centroid.lat], lot.polygon)) {
          insideSpaces.push(space);
          consumedByOverture.add(space.index);
        }
      }

      const ring = closeRing(lot.polygon);
      const region: ParkingClusterEntity["region"] = {
        type: "Polygon",
        coordinates: [ring],
      };
      const center =
        insideSpaces.length > 0
          ? {
              lat: insideSpaces.reduce((s, x) => s + x.centroid.lat, 0) / insideSpaces.length,
              lng: insideSpaces.reduce((s, x) => s + x.centroid.lng, 0) / insideSpaces.length,
            }
          : polygonCentroid(ring);

      const accessPoints = computeAccessPoints(ring, geometry.drivingLanes);
      const insideSpaceIds = insideSpaces.map((s) => `space_${s.index}`);

      // spaceCount priority for Overture-aggregated lots:
      //   1. Overture explicit capacity (from source_tags.capacity) — most
      //      authoritative when populated.
      //   2. In-house ParkingSpace count — accurate when our RoadRunner
      //      mapping has dense ground truth inside the lot.
      //   3. Area / 30 m² — fallback for lots Overture knows about but for
      //      which neither capacity nor in-house ParkingSpaces are available.
      let spaceCount: number | undefined;
      if (lot.capacity != null && lot.capacity > 0) {
        spaceCount = lot.capacity;
      } else if (insideSpaces.length > 0) {
        spaceCount = insideSpaces.length;
      } else {
        const areaM2 = polygonAreaM2(ring);
        const estimated = Math.round(areaM2 / M2_PER_PARKING_SPACE);
        spaceCount = estimated > 0 ? estimated : undefined;
      }

      entities.push({
        entityId: `parking_lot_overture_${i}`,
        kind: "parking_cluster",
        center,
        region,
        provenance: {
          sourceFile: "overture",
          sourceIds: [lot.id],
          extractorVersion: "1.3.0",
        },
        parkingLaneIds: [],
        ...(insideSpaceIds.length > 0 ? { parkingSpaceIds: insideSpaceIds } : {}),
        totalLengthM: 0,
        spaceCount,
        isStreetParking: false,
        isLotParking: true,
        isStandaloneLot: true,
        ...(accessPoints.length > 0 ? { accessPoints } : {}),
      });
    }

    // Drop spaces absorbed by Overture polygons before falling through to the
    // convex-hull path for the orphans.
    unconsumedSpaces = unconsumedSpaces.filter(
      (s) => !consumedByOverture.has(s.index),
    );
  }

  // 2c. Street parking from road-adjacent ParkingSpaces. On dense urban maps
  // on-street parking is frequently mapped as individual ParkingSpace
  // polygons lining a driving lane rather than as Lane[LaneType=Parking]
  // centerlines (Di Rosa has 1731 such stalls but only 72 parking lanes).
  // Without this step those stalls fall into the convex-hull lot path below
  // and the late-stage merge fuses them — across intersections — into
  // oversized "parking lots". We claim them as street parking here, before
  // lot aggregation, so they are excluded from it.
  //
  // Classification is per spatial cluster, not per space, so a genuine
  // off-street lot whose perimeter row happens to sit near a road stays a
  // lot ("lot wins for dense clusters"): a cluster is street parking only
  // when at least STREET_CLUSTER_HUG_FRACTION of its members lie within
  // STREET_SPACE_ADJACENCY_M of a driving lane. Claimed stalls are then
  // grouped by their spatial cluster and nearest driving lane, so stalls from
  // two streets meeting at an intersection split into separate per-street
  // strips, and disjoint curb segments sharing a road are never fused into
  // one cross-block blob.
  if (geometry.drivingLanes.length > 0 && unconsumedSpaces.length > 0) {
    const nearestLane = new Map<number, { distM: number; laneKey: string }>();
    for (const s of unconsumedSpaces) {
      nearestLane.set(s.index, nearestDrivingLaneDistM(s.centroid, geometry.drivingLanes));
    }
    const isAdjacent = (s: ParkingSpace) =>
      (nearestLane.get(s.index)?.distM ?? Infinity) <= STREET_SPACE_ADJACENCY_M;

    const streetConsumed = new Set<number>();
    const streetGroups = new Map<string, ParkingSpace[]>();
    const claim = (s: ParkingSpace, clusterId: number) => {
      // Key by spatial cluster *and* nearest lane. Within a cluster, stalls
      // hugging different lanes (two streets meeting at an intersection) split
      // apart; across clusters, disjoint curb segments that merely share a
      // lane/road are never fused — so a convex hull can't bridge the gap
      // between separate rows and re-inflate the geometry this step prevents.
      const key = `${clusterId}:${nearestLane.get(s.index)?.laneKey ?? "lane:unknown"}`;
      const bucket = streetGroups.get(key);
      if (bucket) bucket.push(s);
      else streetGroups.set(key, [s]);
      streetConsumed.add(s.index);
    };

    let clusterId = 0;
    for (const cluster of clusterParkingSpaces(unconsumedSpaces, SPACE_CLUSTER_DIST_DEG)) {
      if (cluster.length >= 2) {
        const adjacent = cluster.reduce((n, s) => n + (isAdjacent(s) ? 1 : 0), 0);
        if (adjacent / cluster.length >= STREET_CLUSTER_HUG_FRACTION) {
          for (const s of cluster) claim(s, clusterId);
        }
        // Otherwise it's a 2-D off-street lot — leave it for the convex-hull path.
      } else if (isAdjacent(cluster[0]!)) {
        // A lone stall is street parking only when it actually hugs a road.
        claim(cluster[0]!, clusterId);
      }
      clusterId++;
    }

    let streetIdx = 0;
    for (const members of streetGroups.values()) {
      const hullPoints: LngLat[] = [];
      for (const s of members) for (const pt of s.polygon) hullPoints.push(pt);
      const hull = simplifyPolygon(convexHull(hullPoints), 32);
      const region: ParkingClusterEntity["region"] = { type: "Polygon", coordinates: [hull] };
      const center = {
        lat: members.reduce((a, s) => a + s.centroid.lat, 0) / members.length,
        lng: members.reduce((a, s) => a + s.centroid.lng, 0) / members.length,
      };
      const accessPoints = computeAccessPoints(hull, geometry.drivingLanes);
      const memberSpaceIds = members.map((s) => `space_${s.index}`);
      entities.push({
        entityId: `street_parking_spaces_${streetIdx++}`,
        kind: "parking_cluster",
        center,
        region,
        provenance: {
          sourceFile: "geojson",
          sourceIds: memberSpaceIds,
          extractorVersion: "1.3.0",
        },
        parkingLaneIds: [],
        parkingSpaceIds: memberSpaceIds,
        totalLengthM: Math.round(ringSpanM(hull)),
        spaceCount: members.length,
        isStreetParking: true,
        isLotParking: false,
        isStandaloneLot: false,
        ...(accessPoints.length > 0 ? { accessPoints } : {}),
      });
    }

    unconsumedSpaces = unconsumedSpaces.filter((s) => !streetConsumed.has(s.index));
  }

  // Convex-hull aggregation for orphan ParkingSpaces (or for all unconsumed
  // spaces when no Overture input was supplied — back-compat path). Uses
  // the tighter SPACE_CLUSTER_DIST_DEG (~25m) to avoid chaining two lots
  // that flank a narrow street while still linking back-to-back parking rows
  // separated by a typical drive aisle.
  const lotClusters = clusterParkingSpaces(unconsumedSpaces, SPACE_CLUSTER_DIST_DEG);

  for (let i = 0; i < lotClusters.length; i++) {
    const cluster = lotClusters[i]!;
    // Skip single-space "clusters" — a lone ParkingSpace is not a parking lot.
    if (cluster.length < 2) continue;

    const avgLat = cluster.reduce((sum, s) => sum + s.centroid.lat, 0) / cluster.length;
    const avgLng = cluster.reduce((sum, s) => sum + s.centroid.lng, 0) / cluster.length;
    const clusterCenter = { lat: avgLat, lng: avgLng };

    const hullPoints: LngLat[] = [];
    for (const space of cluster) {
      for (const pt of space.polygon) hullPoints.push(pt);
    }
    const hull = simplifyPolygon(convexHull(hullPoints), 32);
    const region: ParkingClusterEntity["region"] = {
      type: "Polygon",
      coordinates: [hull],
    };

    const accessPoints = computeAccessPoints(hull, geometry.drivingLanes);

    const memberSpaceIds = cluster.map((s) => `space_${s.index}`);
    entities.push({
      entityId: `parking_lot_${i}`,
      kind: "parking_cluster",
      center: clusterCenter,
      region,
      provenance: {
        sourceFile: "geojson",
        sourceIds: memberSpaceIds,
        extractorVersion: "1.3.0",
      },
      parkingLaneIds: [],
      parkingSpaceIds: memberSpaceIds,
      totalLengthM: 0,
      spaceCount: cluster.length,
      isStreetParking: false,
      isLotParking: true,
      isStandaloneLot: true,
      ...(accessPoints.length > 0 ? { accessPoints } : {}),
    });
  }

  // 3. Late-stage aggregation. Overture commonly carves what's logically a
  // single parking facility into multiple adjacent polygons (drive aisles,
  // curb islands, internal divisions). For simulation purposes those are
  // one lot. Merge any standalone-lot clusters whose outer-ring vertices
  // are within LOT_MERGE_DIST_DEG (~25 m). Lane-backed street-parking
  // clusters are left alone — those have their own semantic. Polygons
  // with holes (Overture sometimes carries inner rings for buildings or
  // courtyards inside a lot) are handled by operating on the outer ring
  // only; holes from individual members are dropped in the merged hull,
  // which is fine for candidate-boundary purposes (the convex hull
  // describes the lot's overall extent, not its internal navigability).
  const aggregatedEntities = aggregateAdjacentLotClusters(
    entities,
    LOT_MERGE_DIST_DEG,
    geometry.drivingLanes,
  );

  return { entities: aggregatedEntities, warnings };
}

// ── Late-stage aggregation: merge nearby standalone-lot clusters ──────────

function aggregateAdjacentLotClusters(
  entities: ParkingClusterEntity[],
  thresholdDeg: number,
  drivingLanes: DrivingLane[],
): ParkingClusterEntity[] {
  // Lane-backed (street_parking) clusters and any non-Polygon-region cluster
  // pass through unchanged — only off-street lots are aggregation candidates.
  const lots: { entity: ParkingClusterEntity; outerRing: LngLat[] }[] = [];
  const passthrough: ParkingClusterEntity[] = [];
  for (const e of entities) {
    if (
      !e.isStreetParking &&
      e.region.type === "Polygon" &&
      Array.isArray(e.region.coordinates) &&
      e.region.coordinates.length > 0
    ) {
      const outer = e.region.coordinates[0] as LngLat[];
      if (outer.length >= 3) {
        lots.push({ entity: e, outerRing: outer });
        continue;
      }
    }
    passthrough.push(e);
  }
  if (lots.length < 2) return entities;

  // Single-linkage union-find on vertex-to-vertex proximity.
  const n = lots.length;
  const bboxes = lots.map(({ outerRing }) => ringBbox(outerRing));
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) {
      const next = parent[x]!;
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (
        ringsWithinThresholdDeg(
          lots[i]!.outerRing,
          lots[j]!.outerRing,
          bboxes[i]!,
          bboxes[j]!,
          thresholdDeg,
        )
      ) {
        union(i, j);
      }
    }
  }

  // Group by root.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let bucket = groups.get(root);
    if (!bucket) groups.set(root, (bucket = []));
    bucket.push(i);
  }

  // Build merged or pass-through clusters per group.
  const out: ParkingClusterEntity[] = [...passthrough];
  let mergedIdx = 0;
  for (const [, indices] of groups) {
    if (indices.length === 1) {
      out.push(lots[indices[0]!]!.entity);
      continue;
    }
    const members = indices.map((i) => lots[i]!.entity);
    out.push(mergeLotClusters(members, mergedIdx++, drivingLanes));
  }
  return out;
}

/**
 * Combine N standalone-lot clusters into one. The merged region is the
 * convex hull of every member's outer ring — fills in drive-aisle gaps
 * between sub-lots, which is the right semantic for "this is one logical
 * facility". Holes from individual members are intentionally dropped:
 * computing the surviving holes after a polygon union requires a full
 * polygon-clipping library, and for candidate-boundary purposes the outer
 * extent is what matters.
 *
 * Provenance prefers Overture when any member is Overture-sourced (an
 * Overture-bounded cluster is more authoritative for the lot's identity
 * than a convex-hull-of-ParkingSpaces orphan), so the merged candidate
 * row will be classified as `overture_parking` downstream.
 */
function mergeLotClusters(
  members: ParkingClusterEntity[],
  mergedIdx: number,
  drivingLanes: DrivingLane[],
): ParkingClusterEntity {
  // Collect all outer-ring vertices across members.
  const hullInput: LngLat[] = [];
  for (const m of members) {
    const outer = (m.region as { coordinates: LngLat[][] }).coordinates[0]!;
    for (const pt of outer) hullInput.push(pt);
  }
  const hull = simplifyPolygon(convexHull(hullInput), 32);
  const region: ParkingClusterEntity["region"] = {
    type: "Polygon",
    coordinates: [hull],
  };

  // Center: weighted by spaceCount when available, else simple average.
  let sumLat = 0;
  let sumLng = 0;
  let weight = 0;
  for (const m of members) {
    const w = Math.max(m.spaceCount ?? 1, 1);
    sumLat += m.center.lat * w;
    sumLng += m.center.lng * w;
    weight += w;
  }
  const center = { lat: sumLat / weight, lng: sumLng / weight };

  // spaceCount: sum across members (treating undefined as 0). When some
  // members carry an Overture capacity and others have only a member count
  // or area estimate, summing keeps the ratio roughly right.
  let spaceCount = 0;
  let anySpaceCount = false;
  for (const m of members) {
    if (typeof m.spaceCount === "number" && m.spaceCount > 0) {
      spaceCount += m.spaceCount;
      anySpaceCount = true;
    }
  }

  // Provenance: Overture wins when any member is Overture-sourced.
  const anyOverture = members.some((m) => m.provenance.sourceFile === "overture");
  const sourceIds = dedupeStrings(members.flatMap((m) => m.provenance.sourceIds));

  // Member feature IDs (parkingSpaceIds) — union with dedupe.
  const memberSpaceIds = dedupeStrings(
    members.flatMap((m) => m.parkingSpaceIds ?? []),
  );

  // Access points: recompute against the merged hull. Driving lanes haven't
  // changed, and access points along the new (filled-in) hull boundary may
  // differ from the per-member access points — recomputing gives a cleaner
  // result than concatenating member access points.
  const accessPoints = dedupeAccessPoints(computeAccessPoints(hull, drivingLanes));

  return {
    entityId: `parking_lot_merged_${mergedIdx}`,
    kind: "parking_cluster",
    center,
    region,
    provenance: {
      sourceFile: anyOverture ? "overture" : "geojson",
      sourceIds,
      extractorVersion: "1.1.0",
    },
    parkingLaneIds: [],
    ...(memberSpaceIds.length > 0 ? { parkingSpaceIds: memberSpaceIds } : {}),
    totalLengthM: 0,
    spaceCount: anySpaceCount ? spaceCount : undefined,
    isStreetParking: false,
    isLotParking: true,
    isStandaloneLot: true,
    ...(accessPoints.length > 0 ? { accessPoints } : {}),
  };
}

// ── Geometry collection ────────────────────────────────────────────────────

function collectParkingGeometry(
  root: unknown,
  warnings: string[],
): ParkingGeometry {
  const parkingLanes: ParkingLane[] = [];
  const parkingSpaces: ParkingSpace[] = [];
  const drivingLanes: DrivingLane[] = [];

  function visitFeature(feature: Record<string, unknown>) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const geom = feature.geometry as Record<string, unknown> | null | undefined;
    if (!geom) return;

    const featureType = String(props.Type ?? props.type ?? "");
    const geomType = String(geom.type ?? "");

    if (featureType === "ParkingSpace" && (geomType === "Polygon" || geomType === "MultiPolygon")) {
      const rawCoords = geom.coordinates as unknown;
      const centroid = computePolygonCentroid(rawCoords, geomType);
      if (!centroid) return;
      const polygon = firstPolygonRing(rawCoords, geomType);
      parkingSpaces.push({
        index: parkingSpaces.length,
        centroid,
        polygon: polygon ?? [[centroid.lng, centroid.lat]],
      });
      return;
    }

    if (featureType !== "Lane") return;
    const laneType = String(props.LaneType ?? "");
    if (geomType !== "LineString") return;

    const rawCoords = geom.coordinates as number[][] | undefined;
    if (!Array.isArray(rawCoords) || rawCoords.length < 2) return;
    const coords = rawCoords.map((c) => [c[0]!, c[1]!] as LngLat);

    if (laneType === "Driving" || laneType === "driving") {
      drivingLanes.push({
        roadId: String(props.RoadID ?? props.RoadId ?? props.road_id ?? ""),
        laneId: String(props.Id ?? props.LaneID ?? props.LaneId ?? ""),
        coordinates: coords,
      });
      return;
    }

    if (laneType !== "Parking") return;

    let sumLng = 0, sumLat = 0;
    let lengthM = 0;
    for (let j = 0; j < coords.length; j++) {
      sumLng += coords[j]![0];
      sumLat += coords[j]![1];
      if (j > 0) {
        const [x1, y1] = coords[j - 1]!;
        const [x2, y2] = coords[j]!;
        const dlat = (y2 - y1) * 111_320;
        const dlng = (x2 - x1) * 111_320 * Math.cos((y1 * Math.PI) / 180);
        lengthM += Math.sqrt(dlat * dlat + dlng * dlng);
      }
    }

    const center = {
      lat: sumLat / coords.length,
      lng: sumLng / coords.length,
    };

    const laneId = String(props.Id ?? "");
    const linkIds = dedupeStrings([
      ...parseLaneLinkIds(props.Predecessors, laneId, "Predecessors", warnings),
      ...parseLaneLinkIds(props.Successors, laneId, "Successors", warnings),
    ]);
    parkingLanes.push({
      id: laneId,
      coordinates: coords,
      center,
      lengthM,
      linkIds,
    });
  }

  function walk(obj: unknown) {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    if (o.type === "Feature") { visitFeature(o); return; }
    if (o.type === "FeatureCollection" && Array.isArray(o.features)) {
      for (const f of o.features) walk(f);
    }
  }

  walk(root);
  return { parkingLanes, parkingSpaces, drivingLanes };
}

// ── Utilities ──────────────────────────────────────────────────────────────

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
