import type {
  MapAsset,
  SemanticMapOverlay,
  SemanticSiteQueryResult,
  SceneFormation,
  SceneFormationSolution,
} from "@simforge-oss/studio-shared";
import { lngLatToRuntimePoint, runtimePointToLngLat } from "./coordinates";
import type { GeoJsonFeature, GeoJsonFeatureCollection } from "./types";

// Semantic overlay polylines are runtime-world meters (CARLA basis, y-up) —
// the same frame as `runtime.road_segments` — so every conversion here goes
// through `runtimePointToLngLat`. No browser code may fabricate runtime IDs
// from geometry; every feature carries the server-issued semantic ID verbatim.

export type SemanticFeatureKind =
  | "corridor"
  | "movement"
  | "conflict_zone"
  | "environment_feature";

/** Stable per-feature key used for selected/hover layer filters. */
export function semanticFeatureKey(kind: SemanticFeatureKind, id: string) {
  return `${kind}:${id}`;
}

/** Payload delivered on semantic feature hover/click hit tests. */
export type SemanticFeatureSelection = {
  kind: SemanticFeatureKind;
  /** Corridor id, movement id, or conflict-zone id (server-issued). */
  id: string;
  /** `semanticFeatureKey(kind, id)` — filter key for highlight layers. */
  key: string;
  label: string;
  authoringStatus: string;
  diagnosticCodes: string[];
  /** Movement hits only: the concrete variant polyline that was hit. */
  variantId: string | null;
  turnRelation: string | null;
  junctionId: string | null;
  /** Nearest point on the feature axis in [lng, lat]. */
  point: [number, number];
  /** Corridor hits only: normalized arc fraction along the centerline. */
  fraction: number | null;
  /** Corridor hits only: exact server-issued corridor length in meters. */
  lengthM: number | null;
  /** Corridor hits only: station in meters (`fraction` × exact `lengthM`). */
  stationM: number | null;
  /** Corridor hits only: server-issued predecessor corridor ids. */
  predecessorCorridorIds: string[];
  /** Corridor hits only: server-issued successor corridor ids. */
  successorCorridorIds: string[];
};

export type SemanticLayerVisibility = {
  corridors: boolean;
  movements: boolean;
  conflicts: boolean;
  /** Parking, walking, crosswalk, occlusion, and other source-fused context. */
  context: boolean;
  /** Show features whose authoring status is not `authorable`. */
  diagnostics: boolean;
};

export const DEFAULT_SEMANTIC_LAYER_VISIBILITY: SemanticLayerVisibility = {
  corridors: true,
  movements: true,
  conflicts: true,
  context: true,
  diagnostics: false,
};

export type SemanticOverlayFeatureCounts = {
  corridors: number;
  authorableCorridors: number;
  movements: number;
  authorableMovements: number;
  conflictZones: number;
  authorableConflictZones: number;
  environmentFeatures: number;
  authorableEnvironmentFeatures: number;
  diagnosticFeatures: number;
};

export type SemanticOverlayGeoJSON = {
  data: GeoJsonFeatureCollection;
  counts: SemanticOverlayFeatureCounts;
};

/** Project deterministic site-query candidates for numbered map previews. */
export function buildSemanticSiteQueryGeoJSON(
  result: SemanticSiteQueryResult | null,
  asset: ProjectableAsset,
): GeoJsonFeatureCollection | null {
  if (!result) return null;
  const features: GeoJsonFeature[] = [];
  for (const candidate of result.candidates) {
    const properties = {
      feature_kind: "semantic_site_candidate",
      site_id: candidate.id,
      anchor_kind: candidate.anchorKind,
      anchor_id: candidate.anchorId,
      rank: candidate.rank,
      rank_label: String(candidate.rank),
      compatibility_score: candidate.compatibilityScore,
      diversity_cluster: candidate.diversityCluster,
    };
    const preview = candidate.previewGeometry;
    if (preview.type === "point") {
      const point = runtimePointToLngLat(preview.point, asset);
      if (point) features.push({ type: "Feature", geometry: { type: "Point", coordinates: point }, properties });
    } else if (preview.type === "polyline") {
      const line = projectPolyline(preview.points, asset);
      if (line.length >= 2) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line }, properties });
    } else {
      const rings = preview.rings
        .map((ring) => projectPolyline(ring, asset))
        .filter((ring) => ring.length >= 3);
      if (rings.length > 0) features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: rings }, properties });
    }
    const anchor = runtimePointToLngLat(candidate.point, asset);
    if (anchor) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: anchor },
        properties: { ...properties, feature_kind: "semantic_site_candidate_anchor" },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Visual proof for persisted semantic formations and immutable solutions. */
export function buildSemanticScenarioProofGeoJSON(
  formations: readonly SceneFormation[],
  solutions: readonly SceneFormationSolution[],
  asset: ProjectableAsset,
): GeoJsonFeatureCollection | null {
  const features: GeoJsonFeature[] = [];
  for (const formation of formations) {
    const solution = solutions.find((item) => item.formationId === formation.id) ?? null;
    const anchors = new Map(formation.anchors.map((anchor) => [anchor.id, anchor]));
    for (const anchor of formation.anchors) {
      const point = runtimePointToLngLat(anchor.origin, asset);
      if (!point) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: point },
        properties: {
          feature_kind: "semantic_proof_anchor",
          formation_id: formation.id,
          label: `${formation.kind} anchor`,
          status: solution?.report.status ?? "intent",
        },
      });
    }
    for (const member of formation.members) {
      const anchor = anchors.get(member.anchorId);
      if (!anchor) continue;
      const runtimePoint = {
        x: anchor.origin.x + anchor.tangent.x * member.pose.longitudinalM + anchor.normal.x * member.pose.lateralM,
        y: anchor.origin.y + anchor.tangent.y * member.pose.longitudinalM + anchor.normal.y * member.pose.lateralM,
      };
      const point = runtimePointToLngLat(runtimePoint, asset);
      if (!point) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: point },
        properties: {
          feature_kind: "semantic_proof_intent_member",
          formation_id: formation.id,
          member_id: member.sourceActorId,
          label: member.sourceActorId,
          status: "intent",
        },
      });
    }
    if (!solution) continue;
    const solutionPoints = new Map<string, [number, number]>();
    for (const member of solution.members) {
      const point = runtimePointToLngLat(member.spawn, asset);
      if (!point) continue;
      solutionPoints.set(member.sourceActorId, point);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: point },
        properties: {
          feature_kind: "semantic_proof_solved_member",
          formation_id: formation.id,
          member_id: member.sourceActorId,
          label: member.sourceActorId,
          status: solution.report.status,
        },
      });
      const path = member.path.map((entry) => runtimePointToLngLat(entry, asset)).filter((entry): entry is [number, number] => entry != null);
      if (path.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: path },
          properties: {
            feature_kind: "semantic_proof_path",
            formation_id: formation.id,
            member_id: member.sourceActorId,
            status: solution.report.status,
          },
        });
      }
    }
    const residuals = new Map(solution.report.residuals.map((item) => [item.constraintId, item]));
    for (const constraint of solution.constraints) {
      const subject = solutionPoints.get(constraint.subjectMemberId);
      const objectId = constraint.observerMemberId ?? constraint.objectMemberIds[0];
      const object = objectId ? solutionPoints.get(objectId) : null;
      if (!subject || !object) continue;
      const residual = residuals.get(constraint.id);
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [subject, object] },
        properties: {
          feature_kind: "semantic_proof_constraint",
          formation_id: formation.id,
          constraint_id: constraint.id,
          constraint_kind: constraint.kind,
          strength: constraint.strength,
          passed: residual?.passed ?? true,
          residual: residual?.residual ?? null,
          tolerance: residual?.tolerance ?? constraint.compileTolerance,
        },
      });
    }
  }
  return features.length > 0 ? { type: "FeatureCollection", features } : null;
}

export type SemanticOverlayViewport = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Extra margin so corridors that graze the asset bbox still project fully. */
const VIEWPORT_PADDING_M = 50;
/**
 * A single semantic authoring neighborhood. Dense urban graphs can exceed the
 * 2 MiB overlay contract even when MapLibre is showing a much wider basemap
 * extent. We therefore crop visible-view requests around their center and
 * fetch the next neighborhood as the operator pans.
 */
export const SEMANTIC_OVERLAY_MAX_VIEW_SPAN_M = 400;
const FALLBACK_CORRIDOR_WIDTH_M = 3.5;
const CONFLICT_RING_SEGMENTS = 24;

/**
 * Bounded local-map viewport for the semantic overlay request, derived from
 * the asset's WGS84 bbox projected into runtime meters. Returns null when the
 * asset has no usable projection or a degenerate bbox — callers must treat
 * that as "semantic overlay unavailable", never guess a viewport.
 */
export function semanticOverlayViewportForAsset(
  asset: Pick<MapAsset, "bbox" | "map_coordinate_ref"> | null | undefined,
): SemanticOverlayViewport | null {
  if (!asset?.bbox) return null;
  const { min_lat, min_lng, max_lat, max_lng } = asset.bbox;
  if (!(min_lat < max_lat) || !(min_lng < max_lng)) return null;
  const corners = [
    [min_lng, min_lat],
    [min_lng, max_lat],
    [max_lng, min_lat],
    [max_lng, max_lat],
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of corners) {
    const point = lngLatToRuntimePoint(lng, lat, asset);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return null;
    }
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!(minX < maxX) || !(minY < maxY)) return null;
  return {
    minX: minX - VIEWPORT_PADDING_M,
    minY: minY - VIEWPORT_PADDING_M,
    maxX: maxX + VIEWPORT_PADDING_M,
    maxY: maxY + VIEWPORT_PADDING_M,
  };
}

/** Current map view bounds in WGS84, as reported by MapLibre `getBounds()`. */
export type MapViewBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

/**
 * Bounded local-map viewport derived from the CURRENT map view instead of the
 * whole asset bbox. This is the 413 recovery path: when the full-map overlay
 * exceeds the response budget, requests constrain to what the user is looking
 * at and re-issue as they pan/zoom. Returns null when the bounds are
 * degenerate or unprojectable — callers must treat that as "no viewport",
 * never guess one.
 */
export function semanticOverlayViewportForBounds(
  bounds: MapViewBounds | null | undefined,
  asset: Pick<MapAsset, "map_coordinate_ref"> | null | undefined,
): SemanticOverlayViewport | null {
  if (!bounds || !asset) return null;
  const { west, south, east, north } = bounds;
  if (!(south < north) || !(west < east)) return null;
  const corners = [
    [west, south],
    [west, north],
    [east, south],
    [east, north],
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of corners) {
    const point = lngLatToRuntimePoint(lng, lat, asset);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return null;
    }
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!(minX < maxX) || !(minY < maxY)) return null;
  return constrainSemanticOverlayViewport({
    minX: minX - VIEWPORT_PADDING_M,
    minY: minY - VIEWPORT_PADDING_M,
    maxX: maxX + VIEWPORT_PADDING_M,
    maxY: maxY + VIEWPORT_PADDING_M,
  });
}

/** Center-crop a runtime viewport without changing its coordinate frame. */
export function constrainSemanticOverlayViewport(
  viewport: SemanticOverlayViewport,
  maxSpanM = SEMANTIC_OVERLAY_MAX_VIEW_SPAN_M,
): SemanticOverlayViewport {
  const boundedSpan = Number.isFinite(maxSpanM) && maxSpanM > 0
    ? maxSpanM
    : SEMANTIC_OVERLAY_MAX_VIEW_SPAN_M;
  const centerX = (viewport.minX + viewport.maxX) / 2;
  const centerY = (viewport.minY + viewport.maxY) / 2;
  const halfWidth = Math.min(viewport.maxX - viewport.minX, boundedSpan) / 2;
  const halfHeight = Math.min(viewport.maxY - viewport.minY, boundedSpan) / 2;
  return {
    minX: centerX - halfWidth,
    minY: centerY - halfHeight,
    maxX: centerX + halfWidth,
    maxY: centerY + halfHeight,
  };
}

type RuntimeVec2 = { x: number; y: number };
type RuntimeVec3 = { x: number; y: number; z?: number | null };
type ProjectableAsset = Pick<MapAsset, "map_coordinate_ref">;

function projectPolyline(
  polyline: readonly RuntimeVec2[],
  asset: ProjectableAsset,
): Array<[number, number]> {
  const projected: Array<[number, number]> = [];
  for (const point of polyline) {
    const lngLat = runtimePointToLngLat(point, asset);
    if (lngLat) projected.push(lngLat);
  }
  return projected;
}

/**
 * Project a corridor centerline and keep, per projected vertex, its cumulative
 * arc fraction measured in RUNTIME meters (3D when Z is present). Hit testing
 * interpolates stations from these fractions instead of measuring arc length
 * in lng/lat degree space, where east–west and north–south spans have
 * different scales and stations on turning corridors drift by meters.
 */
function projectCorridorCenterline(
  polyline: readonly RuntimeVec3[],
  asset: ProjectableAsset,
): { coordinates: Array<[number, number]>; fractions: number[] } | null {
  const cumulative: number[] = [0];
  for (let index = 1; index < polyline.length; index += 1) {
    const previous = polyline[index - 1]!;
    const current = polyline[index]!;
    cumulative.push(
      cumulative[index - 1]! +
        Math.hypot(
          current.x - previous.x,
          current.y - previous.y,
          (current.z ?? 0) - (previous.z ?? 0),
        ),
    );
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  const coordinates: Array<[number, number]> = [];
  const fractions: number[] = [];
  for (let index = 0; index < polyline.length; index += 1) {
    const lngLat = runtimePointToLngLat(polyline[index]!, asset);
    if (!lngLat) continue;
    coordinates.push(lngLat);
    fractions.push(total > 1e-9 ? cumulative[index]! / total : 0);
  }
  return coordinates.length >= 2 ? { coordinates, fractions } : null;
}

/**
 * Closed ribbon ring around a runtime-frame polyline, offsetting each vertex
 * ±halfWidth along the local normal (same construction as the raw runtime
 * lane overlay so semantic ribbons sit exactly over their bound lanes).
 */
function ribbonRing(
  polyline: readonly RuntimeVec2[],
  halfWidthM: number,
  asset: ProjectableAsset,
): Array<[number, number]> | null {
  if (polyline.length < 2) return null;
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let index = 0; index < polyline.length; index += 1) {
    const prev = polyline[Math.max(0, index - 1)]!;
    const next = polyline[Math.min(polyline.length - 1, index + 1)]!;
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const length = Math.hypot(tx, ty);
    if (length < 1e-9) continue;
    tx /= length;
    ty /= length;
    const nx = -ty;
    const ny = tx;
    const point = polyline[index]!;
    const leftPoint = runtimePointToLngLat(
      { x: point.x + nx * halfWidthM, y: point.y + ny * halfWidthM },
      asset,
    );
    const rightPoint = runtimePointToLngLat(
      { x: point.x - nx * halfWidthM, y: point.y - ny * halfWidthM },
      asset,
    );
    if (leftPoint) left.push(leftPoint);
    if (rightPoint) right.push(rightPoint);
  }
  if (left.length < 2 || right.length < 2) return null;
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]!);
  return ring;
}

function circleRing(
  center: RuntimeVec2,
  radiusM: number,
  asset: ProjectableAsset,
): Array<[number, number]> | null {
  const ring: Array<[number, number]> = [];
  for (let index = 0; index <= CONFLICT_RING_SEGMENTS; index += 1) {
    const angle = (index / CONFLICT_RING_SEGMENTS) * Math.PI * 2;
    const point = runtimePointToLngLat(
      {
        x: center.x + Math.cos(angle) * radiusM,
        y: center.y + Math.sin(angle) * radiusM,
      },
      asset,
    );
    if (point) ring.push(point);
  }
  return ring.length > 3 ? ring : null;
}

/**
 * Convert a compact semantic overlay (runtime meters) into a single GeoJSON
 * FeatureCollection in [lng, lat] for the Mapbox semantic layers. Corridors
 * become filled ribbons carrying their centerline in properties (hit testing
 * recovers the axis from it), movement variants become LineStrings, and
 * conflict zones become metric circle polygons.
 */
export function buildSemanticOverlayGeoJSON(
  overlay: SemanticMapOverlay,
  asset: ProjectableAsset,
): SemanticOverlayGeoJSON {
  const features: GeoJsonFeature[] = [];
  const counts: SemanticOverlayFeatureCounts = {
    corridors: 0,
    authorableCorridors: 0,
    movements: 0,
    authorableMovements: 0,
    conflictZones: 0,
    authorableConflictZones: 0,
    environmentFeatures: 0,
    authorableEnvironmentFeatures: 0,
    diagnosticFeatures: 0,
  };

  for (const corridor of overlay.corridors) {
    const halfWidth =
      (corridor.representativeWidthM ?? FALLBACK_CORRIDOR_WIDTH_M) / 2;
    const ring = ribbonRing(corridor.polyline, halfWidth, asset);
    const centerline = projectCorridorCenterline(corridor.polyline, asset);
    if (!ring || !centerline) continue;
    const authorable = corridor.authoringStatus === "authorable";
    counts.corridors += 1;
    if (authorable) counts.authorableCorridors += 1;
    else counts.diagnosticFeatures += 1;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        feature_kind: "semantic_corridor",
        semantic_kind: "corridor",
        semantic_id: corridor.id,
        semantic_key: semanticFeatureKey("corridor", corridor.id),
        label: `Corridor ${corridor.id}`,
        authoring_status: corridor.authoringStatus,
        diagnostic: !authorable,
        diagnostic_codes: corridor.diagnosticCodes,
        length_m: corridor.lengthM,
        width_m: corridor.representativeWidthM,
        predecessor_corridor_ids: corridor.predecessorCorridorIds,
        successor_corridor_ids: corridor.successorCorridorIds,
        centerline: centerline.coordinates,
        // Per-vertex cumulative arc fractions measured in RUNTIME meters;
        // hit testing interpolates stations from these instead of measuring
        // arc length in lng/lat degree space.
        centerline_fractions: centerline.fractions,
      },
    });
    // A second feature carries the exact same server-issued corridor axis for
    // display only. Polygon ribbons remain the metric hit target, while this
    // axis lets MapLibre draw joined, round-capped road casing across small
    // graph seams. It never participates in semantic hit testing.
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: centerline.coordinates },
      properties: {
        feature_kind: "semantic_corridor_axis",
        semantic_kind: "corridor",
        semantic_id: corridor.id,
        semantic_key: semanticFeatureKey("corridor", corridor.id),
        authoring_status: corridor.authoringStatus,
        diagnostic: !authorable,
      },
    });
  }

  const movementsById = new Map(
    overlay.movements.map((movement) => [movement.id, movement]),
  );
  const countedMovementIds = new Set<string>();
  for (const variant of overlay.movementVariants) {
    const movement = movementsById.get(variant.movementId) ?? null;
    const line = projectPolyline(variant.polyline, asset);
    if (line.length < 2) continue;
    const authorable = variant.authoringStatus === "authorable";
    if (!countedMovementIds.has(variant.movementId)) {
      countedMovementIds.add(variant.movementId);
      counts.movements += 1;
      if (movement?.authoringStatus === "authorable") {
        counts.authorableMovements += 1;
      }
    }
    if (!authorable) counts.diagnosticFeatures += 1;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: line },
      properties: {
        feature_kind: "semantic_movement",
        semantic_kind: "movement",
        semantic_id: variant.movementId,
        semantic_key: semanticFeatureKey("movement", variant.movementId),
        label: movement
          ? `${movement.turnRelation} movement ${variant.movementId}`
          : `Movement ${variant.movementId}`,
        variant_id: variant.id,
        is_representative: movement?.representativeVariantId === variant.id,
        turn_relation: movement?.turnRelation ?? null,
        junction_id: movement?.junctionId ?? null,
        authoring_status: variant.authoringStatus,
        diagnostic: !authorable,
        diagnostic_codes: variant.diagnosticCodes,
        incoming_corridor_id: variant.incomingCorridorId,
        outgoing_corridor_id: variant.outgoingCorridorId,
      },
    });
  }

  for (const zone of overlay.conflictZones) {
    const ring = circleRing(zone.center, zone.radiusM, asset);
    if (!ring) continue;
    const authorable = zone.authoringStatus === "authorable";
    counts.conflictZones += 1;
    if (authorable) counts.authorableConflictZones += 1;
    else counts.diagnosticFeatures += 1;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        feature_kind: "semantic_conflict",
        semantic_kind: "conflict_zone",
        semantic_id: zone.id,
        semantic_key: semanticFeatureKey("conflict_zone", zone.id),
        label: `${zone.kind} conflict ${zone.id}`,
        conflict_kind: zone.kind,
        junction_id: zone.junctionId,
        movement_ids: zone.movementIds,
        radius_m: zone.radiusM,
        authoring_status: zone.authoringStatus,
        diagnostic: !authorable,
        diagnostic_codes: zone.diagnosticCodes,
      },
    });
  }

  for (const feature of overlay.environmentFeatures) {
    let geometry: GeoJsonFeature["geometry"] = null;
    if (feature.geometry.type === "point") {
      const point = runtimePointToLngLat(feature.geometry.point, asset);
      if (point) geometry = { type: "Point", coordinates: point };
    } else if (feature.geometry.type === "polyline") {
      const line = projectPolyline(feature.geometry.points, asset);
      if (line.length >= 2) geometry = { type: "LineString", coordinates: line };
    } else {
      const rings = feature.geometry.rings
        .map((ring) => projectPolyline(ring, asset))
        .filter((ring) => ring.length >= 3)
        .map((ring) => {
          const first = ring[0]!;
          const last = ring[ring.length - 1]!;
          return first[0] === last[0] && first[1] === last[1]
            ? ring
            : [...ring, first];
        });
      if (rings.length > 0) geometry = { type: "Polygon", coordinates: rings };
    }
    if (!geometry) continue;
    const authorable = feature.authoringStatus === "authorable";
    counts.environmentFeatures += 1;
    if (authorable) counts.authorableEnvironmentFeatures += 1;
    else counts.diagnosticFeatures += 1;
    features.push({
      type: "Feature",
      geometry,
      properties: {
        feature_kind: "semantic_context",
        semantic_kind: "environment_feature",
        context_kind: feature.kind,
        semantic_id: feature.id,
        semantic_key: semanticFeatureKey("environment_feature", feature.id),
        label: feature.label,
        primary_source: feature.primarySource,
        runtime_binding_status: feature.runtimeBindingStatus,
        authoring_status: feature.authoringStatus,
        diagnostic: !authorable,
        diagnostic_codes: feature.diagnosticCodes,
      },
    });
  }

  return {
    data: { type: "FeatureCollection", features },
    counts,
  };
}
