/**
 * Server-side loader: fetch this map's pedestrian geometry and project it from
 * WGS84 into runtime-world meters, ready for the crossing-line resolver.
 *
 * Sources, by role:
 *   - SIDEWALKS come from the map's road-network GeoJSON (`geojson` artifact,
 *     built from the XODR at ingestion) filtered to `LaneType ∈ {sidewalk,
 *     Sidewalk}` — i.e. EXACTLY the "Sidewalks" map-layer panel
 *     (`lanes_sidewalk` in `road-network-feature-types.ts`). This is the
 *     authoritative sidewalk set (hundreds of lanes); the sparse Overture
 *     `sidewalk_segment` enrichment candidates are NOT used. Available for any
 *     map with a geojson artifact (no runtime bundle required).
 *   - CROSSWALKS come from the `crosswalk_zone` enrichment candidates.
 *   - POIs (bus stop / transit / commercial frontage) come from the candidate
 *     index — pedestrian ORIGINS used as a spawn surface and side bias.
 *
 * Returns empty arrays when the map has no usable coordinate reference
 * (un-enriched / legacy) so the planner falls back to topology lanes / road
 * edge with no regression.
 */
import "server-only";
import { MapProjection, type Vec2 } from "@simcloud/shared";
import { getCandidateLocationsByMapAssetId } from "@/app/lib/db/map-candidate-location-store";
import {
  parkingLotSizeClass,
  type ParkingLotSizeClass,
} from "@/app/lib/maps/search/classification-thresholds";
import { getMapAssetByIdFromDb, getMapArtifactRevision } from "@/app/lib/db/map-asset-store";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";
import type {
  ProjectedCrosswalk,
  ProjectedSidewalk,
} from "./planner/pedestrian-crossing-geometry";
import type { ParkingBayRef } from "./scene-population";

/** Candidate kinds that are pedestrian ORIGINS — used as a spawn surface and to
 *  bias the spawn side. Deliberately excludes `crosswalk_zone` /
 *  `sidewalk_segment` (crossing geometry) and parking / occlusion. */
const PED_POI_KINDS = new Set<string>([
  "bus_stop_corridor",
  "transit_stop_corridor",
  "school_frontage",
  "hospital_approach",
  "retail_frontage",
  "restaurant_frontage",
  "hotel_approach",
  "airport_approach",
  "shopping_mall_approach",
]);

/** Matches the "Sidewalks" panel filter (`road-network-feature-types.ts`). */
const SIDEWALK_LANE_TYPES = new Set<string>(["sidewalk", "Sidewalk"]);

/** A pedestrian-origin POI in runtime meters, with its candidate kind retained
 *  so `locationConstraints.nearPoi` can filter by type (e.g. "bus stop"). */
export interface TypedPoi {
  kind: string;
  point: Vec2;
}

/** A roadside occlusion (a street-parking cluster) in runtime meters — a place
 *  where a parked car can hide a pedestrian until it steps into the road. Drives
 *  occlusion-priority ped site ranking (D1) + the parked-car occluder (D2). */
export interface ProjectedOccluder {
  point: Vec2;
  /** Detector confidence in [0,1]; higher = stronger occlusion site. */
  confidence: number;
  /** Occlusion subtype, e.g. "PARKING_NEAR_CONFLICT_POINT". */
  subtype: string;
}

/** Occlusion subtypes that imply a PARKED VEHICLE can serve as the occluder
 *  (so D2 can spawn a car). Geometric occluders (curve/crest/narrow corridor)
 *  are excluded for now — they need a different occluder model. */
const PARKED_VEHICLE_OCCLUSION_SUBTYPES = new Set<string>([
  "PARKING_NEAR_CONFLICT_POINT",
  "COMMERCIAL_DELIVERY_OCCLUSION",
  "BUS_STOP_OCCLUSION",
]);

/** A curated parking-lot area in runtime meters — the operator's COMBINED lots
 *  layer (in-house parking-space aggregation deduped against Overture lots, with a
 *  small/medium/large size class). A junction whose centroid falls inside one of
 *  these polygons is a parking-lot AISLE junction (not a street intersection) — the
 *  signal that lets the turn-site ranker down-rank parking-lot lefts so real street
 *  unprotected-lefts dominate the batch (2026-07-09 review: "only parking-lot lefts
 *  survived"). Spatially curated by the operator — use these, not raw Overture. */
export interface ProjectedParkingLot {
  /** Outer-ring vertices in runtime meters (frontend/Vec2 frame). */
  polygon: Vec2[];
  /** Size class from the curated space count, or "unknown" when not populated. */
  size: ParkingLotSizeClass | "unknown";
}

export interface ProjectedPedestrianRegions {
  crosswalks: ProjectedCrosswalk[];
  sidewalks: ProjectedSidewalk[];
  /** Untyped POI points — pedestrian-spawn surface + side bias (planner). */
  poiPoints: Vec2[];
  /** Same POIs, but kind-tagged — for `nearPoi` constraint filtering. */
  poiTyped: TypedPoi[];
  /** Roadside parked-vehicle occlusion sites (workstream D). */
  occluders: ProjectedOccluder[];
  /** Curated combined parking-lot polygons (for parking-lot junction classification). */
  parkingLots: ProjectedParkingLot[];
  /** RoadRunner ParkingSpace bay centroids (runtime meters) — driveway-classifier
   *  evidence. NOT loaded here (the candidate store carries no bays); callers
   *  with access to the per-map RoadRunner pair fill it in (the emit harness). */
  parkingSpacePoints?: Vec2[];
  /** The same bays with their head-in heading — the second parked-car source for
   *  scene dressing. Filled by the same callers, for the same reason. */
  parkingBays?: ParkingBayRef[];
}

const EMPTY: ProjectedPedestrianRegions = {
  crosswalks: [],
  sidewalks: [],
  poiPoints: [],
  poiTyped: [],
  occluders: [],
  parkingLots: [],
};

// Projecting the 16 MB road-network GeoJSON is expensive, so cache the small
// projected-sidewalk result per map, keyed by the geojson artifact checksum.
const sidewalkCache = new Map<string, ProjectedSidewalk[]>();

interface GeoJsonFeature {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: { LaneType?: string };
}

/**
 * Load + project the road-network sidewalk lanes — the same set the "Sidewalks"
 * map layer renders. Cached by artifact checksum.
 */
async function loadRoadNetworkSidewalks(
  mapAssetId: string,
  proj: MapProjection,
): Promise<ProjectedSidewalk[]> {
  const rev = await getMapArtifactRevision(mapAssetId, "geojson");
  if (!rev) return [];
  const cacheKey = `${mapAssetId}:${rev.sha256 ?? rev.key}`;
  const cached = sidewalkCache.get(cacheKey);
  if (cached) return cached;

  let fc: { features?: GeoJsonFeature[] };
  try {
    fc = JSON.parse(await getS3ObjectUtf8(rev.bucket, rev.key)) as { features?: GeoJsonFeature[] };
  } catch {
    return [];
  }

  const sidewalks: ProjectedSidewalk[] = [];
  for (const f of fc.features ?? []) {
    if (f.geometry?.type !== "LineString") continue;
    if (!f.properties?.LaneType || !SIDEWALK_LANE_TYPES.has(f.properties.LaneType)) continue;
    const line = f.geometry.coordinates as [number, number][] | undefined;
    if (!Array.isArray(line) || line.length < 2) continue;
    sidewalks.push({ polyline: line.map(([lng, lat]) => proj.geoToLocal(lng, lat)) });
  }

  if (sidewalkCache.size > 8) sidewalkCache.delete(sidewalkCache.keys().next().value!);
  sidewalkCache.set(cacheKey, sidewalks);
  return sidewalks;
}

export async function loadProjectedPedestrianRegions(
  mapAssetId: string,
): Promise<ProjectedPedestrianRegions> {
  const asset = await getMapAssetByIdFromDb(mapAssetId);
  const proj = MapProjection.fromCoordinateRef(asset?.map_coordinate_ref ?? {});
  if (!proj) return EMPTY; // no projection → resolver uses topology-only tiers

  const [candidates, sidewalks] = await Promise.all([
    getCandidateLocationsByMapAssetId(mapAssetId),
    loadRoadNetworkSidewalks(mapAssetId, proj),
  ]);

  const crosswalks: ProjectedCrosswalk[] = [];
  const poiPoints: Vec2[] = [];
  const poiTyped: TypedPoi[] = [];
  const occluders: ProjectedOccluder[] = [];
  const parkingLots: ProjectedParkingLot[] = [];

  for (const c of candidates) {
    if (c.kind === "crosswalk_zone" && c.region.type === "Polygon") {
      const ring = c.region.coordinates[0];
      if (ring && ring.length >= 3) {
        crosswalks.push({
          ring: ring.map(([lng, lat]) => proj.geoToLocal(lng, lat)),
        });
      }
      continue;
    }
    // Curated combined parking lots (operator's deduped in-house + Overture layer):
    // project the outer ring so a junction centroid can be tested for containment.
    if (c.kind === "parking_lot" && c.region.type === "Polygon") {
      const ring = c.region.coordinates[0];
      if (ring && ring.length >= 3) {
        const spaceCount = Number(c.evidence?.[0]?.primitives?.space_count);
        parkingLots.push({
          polygon: ring.map(([lng, lat]) => proj.geoToLocal(lng, lat)),
          size:
            (Number.isFinite(spaceCount)
              ? parkingLotSizeClass(spaceCount)
              : undefined) ?? "unknown",
        });
      }
      continue;
    }
    if (c.kind === "occlusion") {
      const subtype = String(
        c.evidence?.[0]?.primitives?.occlusion_subtype ?? "",
      );
      if (PARKED_VEHICLE_OCCLUSION_SUBTYPES.has(subtype)) {
        occluders.push({
          point: proj.geoToLocal(c.center.lng, c.center.lat),
          confidence: typeof c.confidence === "number" ? c.confidence : 0.5,
          subtype,
        });
      }
      continue;
    }
    if (PED_POI_KINDS.has(c.kind)) {
      const point = proj.geoToLocal(c.center.lng, c.center.lat);
      poiPoints.push(point);
      poiTyped.push({ kind: c.kind, point });
    }
  }

  return { crosswalks, sidewalks, poiPoints, poiTyped, occluders, parkingLots };
}
