import type { Bbox } from "../bbox-utils";
import type { MapCandidateLocation } from "../../map-asset-enrichment";
import type { CandidateLocation, CandidateLocationKind, CandidateLocationSource } from "../../map-candidate-location";
import { clusterLocationsKeyed } from "./cluster-locations";

const KIND_SOURCE_MAP: Record<string, { kind: CandidateLocationKind; source: CandidateLocationSource }> = {
  bus_stop_corridor: { kind: "bus_stop_corridor", source: "overture_bus_stop" },
  school_frontage: { kind: "school_frontage", source: "overture_school" },
  hospital_approach: { kind: "hospital_approach", source: "overture_hospital" },
  gas_station_approach: { kind: "gas_station_approach", source: "overture_gas_station" },
  parking_lot: { kind: "parking_lot", source: "overture_parking" },
  retail_frontage: { kind: "retail_frontage", source: "overture_retail" },
  restaurant_frontage: { kind: "restaurant_frontage", source: "overture_restaurant" },
  hotel_approach: { kind: "hotel_approach", source: "overture_hotel" },
  airport_approach: { kind: "airport_approach", source: "overture_airport" },
  shopping_mall_approach: { kind: "shopping_mall_approach", source: "overture_shopping_mall" },
  transit_stop_corridor: { kind: "transit_stop_corridor", source: "overture_transit_stop" },
  sidewalk_segment: { kind: "sidewalk_segment", source: "overture_sidewalk" },
};

export interface ExtractedOvertureCandidate {
  location: CandidateLocation;
  /**
   * Stable identity for the cluster, derived from the sorted feature IDs of
   * its input members. Callers hash this into the persisted row ID so the
   * same semantic cluster keeps the same row across pipeline runs, even when
   * cluster ordering changes.
   */
  clusterKey: string;
}

/**
 * Convert existing Overture enrichment candidate locations into the new
 * CandidateLocation format for the dedicated table.
 *
 * Groups by kind and clusters nearby candidates (e.g., adjacent bus stops merge
 * into one candidate with a higher confidence). Inputs whose `kind` is not in
 * the closed `KIND_SOURCE_MAP` set are dropped with a warning rather than
 * silently misclassified into a default `overture_bus_stop` bucket — that
 * earlier behaviour corrupted source-scoped delete-and-replace upserts and
 * source-keyed analytics.
 */
export function extractOvertureCandidates(
  enrichmentCandidates: MapCandidateLocation[],
  mapAssetId: string,
  mapBbox: Bbox,
): ExtractedOvertureCandidate[] {
  if (enrichmentCandidates.length === 0) return [];

  type ConvertedEntry = { location: CandidateLocation; key: string };

  const droppedKinds = new Map<string, number>();
  const converted: ConvertedEntry[] = [];

  for (let i = 0; i < enrichmentCandidates.length; i++) {
    const c = enrichmentCandidates[i]!;
    const mapping = KIND_SOURCE_MAP[c.kind];
    if (!mapping) {
      droppedKinds.set(c.kind, (droppedKinds.get(c.kind) ?? 0) + 1);
      continue;
    }

    // Compute the canonical center + carry through whatever region the
    // snapshot emitted (BBOX for point-derived candidates, Polygon for
    // POIs that promoted to a building footprint, LineString for
    // sidewalk_segment candidates). Center stays useful for ranking /
    // clustering even when the region is a polygon or polyline.
    let center: { lat: number; lng: number };
    let region: CandidateLocation["region"];
    if (c.region.type === "Polygon") {
      const ring = c.region.coordinates[0] ?? [];
      let sumLng = 0, sumLat = 0, n = 0;
      for (const [lng, lat] of ring) {
        sumLng += lng;
        sumLat += lat;
        n++;
      }
      center = n > 0 ? { lat: sumLat / n, lng: sumLng / n } : { lat: 0, lng: 0 };
      region = { type: "Polygon", coordinates: c.region.coordinates };
    } else if (c.region.type === "LineString") {
      const coords = c.region.coordinates;
      let sumLng = 0, sumLat = 0;
      for (const [lng, lat] of coords) {
        sumLng += lng;
        sumLat += lat;
      }
      center = coords.length > 0
        ? { lat: sumLat / coords.length, lng: sumLng / coords.length }
        : { lat: 0, lng: 0 };
      region = { type: "LineString", coordinates: coords };
    } else {
      const bbox = c.region.bbox;
      center = {
        lat: (bbox.min_lat + bbox.max_lat) / 2,
        lng: (bbox.min_lng + bbox.max_lng) / 2,
      };
      region = { type: "BBOX", bbox };
    }

    const location: CandidateLocation = {
      id: `_raw_overture_${i}`,
      map_asset_id: mapAssetId,
      kind: mapping.kind,
      source: mapping.source,
      label: c.label,
      description: c.reason,
      reason: c.reason,
      confidence: 0.7,
      tags: c.tags,
      evidence: c.evidence.map((e) => ({
        detectorId: "overture_enrichment_extractor",
        detectorVersion: "1.0.0",
        primitives: {
          layer_id: e.layer_id,
          feature_count: e.feature_ids.length,
        },
        confidence: 0.7,
        matchedTags: c.tags,
        explanation: `${c.kind} from Overture ${e.layer_id} layer`,
      })),
      region,
      center,
    };

    // Stable per-input key: sorted (layer_id, feature_id) tuples drawn from
    // the source MapCandidateLocation evidence. Overture feature IDs are
    // stable across pipeline reruns, so two runs that ingest the same
    // features produce identical keys regardless of query / cluster order.
    const featureKeyParts: string[] = [];
    for (const e of c.evidence) {
      for (const fid of e.feature_ids) {
        featureKeyParts.push(`${e.layer_id}:${fid}`);
      }
    }
    featureKeyParts.sort();
    const key = featureKeyParts.length > 0
      ? featureKeyParts.join(",")
      : `idx:${i}`; // Fallback only — should not occur in practice.

    converted.push({ location, key });
  }

  if (droppedKinds.size > 0) {
    const summary = [...droppedKinds.entries()]
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    console.warn(
      `[overture-candidate-extractor] dropped ${droppedKinds.size} unknown kind(s): ${summary}`,
    );
  }

  // Group by source and cluster each group separately so clustering only
  // merges semantically similar features.
  const bySource = new Map<CandidateLocationSource, ConvertedEntry[]>();
  for (const entry of converted) {
    if (!bySource.has(entry.location.source)) bySource.set(entry.location.source, []);
    bySource.get(entry.location.source)!.push(entry);
  }

  const allClustered: ExtractedOvertureCandidate[] = [];
  for (const [, group] of bySource) {
    const clustered = clusterLocationsKeyed(group, mapBbox);
    for (const { location, key } of clustered) {
      allClustered.push({ location, clusterKey: key });
    }
  }

  return allClustered;
}
