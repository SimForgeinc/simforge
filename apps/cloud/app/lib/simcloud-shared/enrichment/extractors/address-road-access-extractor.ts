import { parseRoadSegments, snapPointToNearestRoad } from "../snap-to-road";
import type { RoadSegmentForMatching } from "../street-name-resolver";
import type { ExtractedAddress } from "./overture-address-extractor";

/**
 * Snap each address point onto the closest named drivable Overture road
 * segment, in place. Populates the `road_access_*` fields on every passed
 * address row.
 *
 * Why this exists: an address point sits on the lot or rooftop, not on a
 * drivable surface — a vehicle simulation can't spawn there. The snapped
 * point on a road segment is the closest legal start position, and the
 * distance gives a sanity signal ("if a snap is 200 m away, the address
 * is probably misplaced or sits on a private drive we don't have").
 *
 * Pure function — no I/O. Mutates `addresses[*].row.road_access_*` and
 * returns the same array for ergonomics.
 */

export interface AttachRoadAccessOptions {
  /**
   * Maximum search radius (metres). Addresses with no road segment within
   * this distance get null road-access fields rather than being snapped to
   * the nearest *anything*. Default 250 m — enough for rural driveways
   * (typical lot-to-road distance ~50–150 m) without grabbing the wrong
   * road on the next block over (~250–400 m in suburban grids).
   */
  maxDistanceM?: number;
}

const DEFAULT_MAX_DISTANCE_M = 250;

/**
 * Walk every address × every road segment via the shared snap core. The
 * address layer is already road-proximity-filtered (50 m default) AND
 * road-class-filtered (motorway through unclassified) before this runs,
 * so the count is bounded — even a dense Bay Area asset has roughly
 * N_addresses ≤ 5k and N_segments ≤ 500.
 */
export function attachRoadAccessToAddresses(
  addresses: ExtractedAddress[],
  roadSegments: RoadSegmentForMatching[],
  options: AttachRoadAccessOptions = {},
): ExtractedAddress[] {
  const maxDistanceM = options.maxDistanceM ?? DEFAULT_MAX_DISTANCE_M;
  if (addresses.length === 0 || roadSegments.length === 0) return addresses;

  // Pre-parse every segment's LineString once — the parse is the dominant
  // per-call cost when iterated over thousands of addresses.
  const parsed = parseRoadSegments(roadSegments);

  for (const a of addresses) {
    const snap = snapPointToNearestRoad(a.row.lat, a.row.lng, parsed, { maxDistanceM });
    if (snap != null) {
      a.row.road_access_lat = snap.lat;
      a.row.road_access_lng = snap.lng;
      a.row.road_access_distance_m = snap.distanceM;
      a.row.road_access_road_name = snap.roadName;
      // Mirror onto the GeoJSON feature properties so the S3 overlay can
      // render the access link without needing a separate Aurora lookup.
      a.feature.properties.road_access_lat = snap.lat;
      a.feature.properties.road_access_lng = snap.lng;
      a.feature.properties.road_access_distance_m = snap.distanceM;
      a.feature.properties.road_access_road_name = snap.roadName;
    } else {
      a.row.road_access_lat = null;
      a.row.road_access_lng = null;
      a.row.road_access_distance_m = null;
      a.row.road_access_road_name = null;
    }
  }

  return addresses;
}
