import type { Bbox } from "../bbox-utils";
import { bboxIntersects, expandBbox } from "../bbox-utils";
import type { CandidateLocation, CandidateLocationRegion } from "../../map-candidate-location";

/** Extract an axis-aligned bounding box from any region type. */
function regionToBbox(region: CandidateLocationRegion): Bbox {
  switch (region.type) {
    case "BBOX":
      return region.bbox;
    case "Polygon": {
      const coords = region.coordinates.flat();
      let minLat = Infinity, maxLat = -Infinity;
      let minLng = Infinity, maxLng = -Infinity;
      for (const [lng, lat] of coords) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
      return { min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng };
    }
    case "LineString": {
      let minLat = Infinity, maxLat = -Infinity;
      let minLng = Infinity, maxLng = -Infinity;
      for (const [lng, lat] of region.coordinates) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
      return { min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng };
    }
    case "Point":
      return { min_lat: region.coordinates[1], min_lng: region.coordinates[0], max_lat: region.coordinates[1], max_lng: region.coordinates[0] };
  }
}

/**
 * Kinds whose candidates should NOT be merged by bbox overlap. Sidewalks are
 * inherently linear and per-segment useful for spawn placement; clustering by
 * bbox overlap would (a) collapse the polyline geometry to a single BBOX and
 * (b) pull adjacent street-block sidewalks into one super-cluster the moment
 * their buffered bboxes touch, defeating the per-feature granularity the
 * scenario-creator LLM relies on for sampling pedestrian start positions.
 */
const NON_CLUSTERING_KINDS: ReadonlySet<string> = new Set(["sidewalk_segment"]);

/** Minimum bbox radius in meters for clustering overlap detection.
 *  Kept small so clusters don't balloon candidate regions unnecessarily. */
export const MIN_BBOX_RADIUS_M = 10;

/**
 * Merge overlapping same-type candidate locations into clusters.
 *
 * 1. Expand each location's bbox to the minimum radius (25m)
 * 2. Greedily merge any overlapping bboxes into one
 * 3. Re-compute centroid, combine evidence, scale confidence by feature count
 *
 * This prevents 200 parking spaces from producing 200 separate candidate locations —
 * instead they collapse into a few clusters.
 */
export function clusterLocations(
  rawLocations: CandidateLocation[],
  mapBbox?: Bbox,
): CandidateLocation[] {
  return clusterLocationsKeyed(
    rawLocations.map((location) => ({ location, key: location.id })),
    mapBbox,
  ).map((r) => r.location);
}

/**
 * Variant of `clusterLocations` that tracks a stable per-input key through
 * clustering. After merging, each cluster's `key` is the sorted, joined list of
 * member keys — a deterministic identity that survives any reordering of the
 * input array. Callers (e.g. the Overture pipeline) hash this into the
 * persisted candidate-row ID so the same semantic cluster keeps the same row
 * across runs.
 */
export function clusterLocationsKeyed(
  rawLocations: Array<{ location: CandidateLocation; key: string }>,
  mapBbox?: Bbox,
): Array<{ location: CandidateLocation; key: string }> {
  if (rawLocations.length === 0) return [];

  // Per-segment kinds (sidewalk_segment today) skip clustering entirely — the
  // raw inputs are returned as-is so each Overture feature stays a distinct
  // candidate with its own LineString geometry intact. Per-input key is
  // already populated by the caller, so row-id stability is preserved.
  const firstKind = rawLocations[0]?.location.kind;
  if (firstKind && NON_CLUSTERING_KINDS.has(firstKind)) {
    return rawLocations;
  }

  // 1. Expand each to minimum radius
  type ClusterEntry = {
    bbox: Bbox;
    members: CandidateLocation[];
    keys: string[];
  };

  const entries: ClusterEntry[] = rawLocations.map(({ location, key }) => ({
    bbox: expandBbox(regionToBbox(location.region), MIN_BBOX_RADIUS_M),
    members: [location],
    keys: [key],
  }));

  // 2. Greedy merge: while any two entries overlap, merge them
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (bboxIntersects(entries[i]!.bbox, entries[j]!.bbox)) {
          // Union bboxes
          const a = entries[i]!;
          const b = entries[j]!;
          a.bbox = {
            min_lat: Math.min(a.bbox.min_lat, b.bbox.min_lat),
            min_lng: Math.min(a.bbox.min_lng, b.bbox.min_lng),
            max_lat: Math.max(a.bbox.max_lat, b.bbox.max_lat),
            max_lng: Math.max(a.bbox.max_lng, b.bbox.max_lng),
          };
          a.members.push(...b.members);
          a.keys.push(...b.keys);
          entries.splice(j, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }

  // 3. Build output locations from clusters
  return entries.map((entry) => {
    const featureCount = entry.members.length;
    const first = entry.members[0]!;

    // Clip to map bbox if provided
    let bbox = entry.bbox;
    if (mapBbox) {
      bbox = {
        min_lat: Math.max(bbox.min_lat, mapBbox.min_lat),
        min_lng: Math.max(bbox.min_lng, mapBbox.min_lng),
        max_lat: Math.min(bbox.max_lat, mapBbox.max_lat),
        max_lng: Math.min(bbox.max_lng, mapBbox.max_lng),
      };
    }

    const center = {
      lat: (bbox.min_lat + bbox.max_lat) / 2,
      lng: (bbox.min_lng + bbox.max_lng) / 2,
    };

    // Combine evidence from all members
    const allEvidence = entry.members.flatMap((m) => m.evidence);

    // Union tags from all members
    const allTags = [...new Set(entry.members.flatMap((m) => m.tags))];

    // Confidence scales with feature count
    const confidence = Math.min(1.0, 0.7 + 0.05 * featureCount);

    // Build descriptive label
    const kindLabel = first.kind.replace(/_/g, " ");
    const label =
      featureCount > 1
        ? `${capitalize(kindLabel)} (${featureCount} features)`
        : first.label;

    const reason =
      featureCount > 1
        ? `${featureCount} ${kindLabel} features clustered in this area`
        : first.reason;

    // Sort the per-input keys so two runs that produce the same set of
    // input features in any order yield the same cluster key. The caller
    // hashes this into the persisted row ID for stable identity.
    const sortedKeys = [...entry.keys].sort();
    const clusterKey = sortedKeys.join("|");

    const location: CandidateLocation = {
      id: first.id, // Will be reassigned by caller using `clusterKey`.
      map_asset_id: first.map_asset_id,
      kind: first.kind,
      source: first.source,
      label,
      description: featureCount > 1
        ? `Cluster of ${featureCount} ${kindLabel} features`
        : first.description,
      reason,
      confidence,
      tags: allTags,
      evidence: allEvidence,
      region: { type: "BBOX" as const, bbox },
      center,
    };
    return { location, key: clusterKey };
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
