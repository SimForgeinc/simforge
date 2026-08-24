/**
 * Actual (esmini-simulated) actor trajectories for the map-assets AI panel.
 *
 * Sibling of `scenario-trajectories.ts`, which renders the *planned* paths a
 * draft authored. This module renders what esmini *actually* did when it ran
 * the compiled OpenSCENARIO headless: the per-actor state-log polyline plus
 * any collision points. Overlaying both lets a reviewer compare intent
 * (planned) against ground truth (esmini) on the same map.
 *
 * esmini emits positions in OpenDRIVE world coordinates (meters). The writer
 * authors WorldPosition straight from the draft's runtime-frame x/y with no
 * transform (see the UniScenarios OpenSCENARIO compiler), so the esmini output frame is
 * the runtime frame — the same `runtimePointToLngLat` projection the planned
 * overlay uses. That equivalence is what makes the two overlays line up.
 */

import type { EsminiValidationMetrics, MapAsset } from "@simcloud/shared";
import { runtimePointToLngLat } from "@/app/lib/editor-map/coordinates";
import { deriveActorColor } from "@/app/lib/scenario-editor/actor-color";

type LngLat = [number, number];

type FeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry:
      | { type: "LineString"; coordinates: LngLat[] }
      | { type: "Point"; coordinates: LngLat };
    properties: Record<string, unknown>;
  }>;
};


/**
 * Color an esmini actor track to match its planned-overlay counterpart. Entity
 * ids are the authored actor ids, so the caller can pass the id of the first
 * sensor-carrying vehicle rather than guessing identity from an id spelling.
 */
function trackColor(actorId: string, subjectActorId: string | null): string {
  return deriveActorColor({
    actorId,
    kind: "vehicle",
    role: actorId === subjectActorId ? "subject" : "traffic",
    isStatic: false,
    authoredColor: null,
  });
}

/**
 * Build the 2D GeoJSON overlay for esmini's actual trajectories: one
 * LineString per actor (≥2 projected points), a start dot per actor, and a
 * marker at each reported collision point. Returns null when there is nothing
 * projectable (no metrics, no asset projection, or every track degenerate).
 */
export function buildEsminiTrajectoryGeoJSON(
  metrics: EsminiValidationMetrics | null | undefined,
  asset: Pick<MapAsset, "map_coordinate_ref"> | null | undefined,
  subjectActorId: string | null = null,
): FeatureCollection | null {
  if (!metrics || !asset) return null;

  const features: FeatureCollection["features"] = [];

  for (const track of metrics.actor_trajectories) {
    const coords = track.points
      .map((p) => runtimePointToLngLat({ x: p.x, y: p.y }, asset))
      .filter((c): c is LngLat => c != null);
    if (coords.length < 2) continue;

    const color = trackColor(track.actor_id, subjectActorId);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {
        id: `${track.actor_id}-esmini-line`,
        label: track.actor_id,
        color,
        kind: "esmini-line",
      },
    });
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: coords[0]! },
      properties: {
        id: `${track.actor_id}-esmini-start`,
        label: track.actor_id,
        color,
        kind: "esmini-start",
      },
    });
  }

  for (const [i, collision] of metrics.collisions.entries()) {
    const point = runtimePointToLngLat(
      { x: collision.point.x, y: collision.point.y },
      asset,
    );
    if (!point) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: point },
      properties: {
        id: `esmini-collision-${i}`,
        label: `${collision.actor_a} ↔ ${collision.actor_b}`,
        kind: "esmini-collision",
      },
    });
  }

  if (features.length === 0) return null;
  return { type: "FeatureCollection", features };
}
