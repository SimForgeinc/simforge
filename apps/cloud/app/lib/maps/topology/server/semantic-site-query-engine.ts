import "server-only";

import {
  SEMANTIC_SITE_QUERY_RESULT_SCHEMA_VERSION,
  SemanticSiteQueryResultSchema,
  type SemanticFeature,
  type SemanticFeatureGeometry,
  type SemanticGraphPublicationManifest,
  type SemanticMapGraph,
  type SemanticSiteQuery,
  type SemanticSiteQueryCandidate,
  type SemanticSiteQueryResult,
  type SemanticFeatureGraph,
} from "@simcloud/shared";

const MAX_ANCHOR_CANDIDATES = 50_000;
const MAX_DISTANCE_COMPARISONS = 1_000_000;

export class SemanticSiteQueryBudgetError extends Error {
  constructor(
    readonly code: "anchor_budget_exhausted" | "distance_budget_exhausted",
    readonly details: Record<string, number>,
  ) {
    super("Semantic site query exceeded its deterministic execution budget.");
    this.name = "SemanticSiteQueryBudgetError";
  }
}

type Point = { x: number; y: number; z?: number | null };
type RawCandidate = Omit<SemanticSiteQueryCandidate, "rank" | "diversityCluster">;

function distance(left: Point, right: Point) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function polylinePoint(points: readonly Point[], fraction: number): { point: Point; headingRad: number } {
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = distance(points[index - 1]!, points[index]!);
    lengths.push(length);
    total += length;
  }
  let remaining = total * Math.max(0, Math.min(1, fraction));
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (remaining <= length || index === lengths.length - 1) {
      const start = points[index]!;
      const end = points[index + 1]!;
      const t = length > 1e-9 ? remaining / length : 0;
      return {
        point: {
          x: start.x + (end.x - start.x) * t,
          y: start.y + (end.y - start.y) * t,
          z: start.z != null && end.z != null ? start.z + (end.z - start.z) * t : null,
        },
        headingRad: Math.atan2(end.y - start.y, end.x - start.x),
      };
    }
    remaining -= length;
  }
  const start = points[0]!;
  const end = points[points.length - 1]!;
  return { point: end, headingRad: Math.atan2(end.y - start.y, end.x - start.x) };
}

function geometryCenter(geometry: SemanticFeatureGeometry): Point {
  if (geometry.type === "point") return geometry.point;
  const points = geometry.type === "polyline" ? geometry.points : geometry.rings[0]!;
  if (geometry.type === "polyline") return polylinePoint(points, 0.5).point;
  const total = points.reduce((value, point) => ({ x: value.x + point.x, y: value.y + point.y }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length, z: null };
}

function pruningCounter() {
  const values = new Map<string, { count: number; message: string }>();
  return {
    add(code: string, message: string) {
      const current = values.get(code);
      values.set(code, { count: (current?.count ?? 0) + 1, message });
    },
    list() {
      return [...values.entries()]
        .map(([code, value]) => ({ code, ...value }))
        .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
    },
  };
}

function laneContext(graph: SemanticMapGraph, corridorId: string) {
  const slots = graph.approaches.flatMap((approach) =>
    approach.laneSlots
      .filter((slot) => slot.corridorId === corridorId)
      .map((slot) => ({ slot, laneCount: approach.laneSlots.length, approachId: approach.id })),
  );
  return slots.sort((left, right) => right.laneCount - left.laneCount || left.approachId.localeCompare(right.approachId))[0] ?? null;
}

function environmentGeometry(feature: SemanticFeature) {
  return feature.geometry.type === "point"
    ? { type: "point" as const, point: feature.geometry.point }
    : feature.geometry.type === "polyline"
      ? { type: "polyline" as const, points: feature.geometry.points }
      : { type: "polygon" as const, rings: feature.geometry.rings };
}

export function executeSemanticSiteQuery(input: {
  query: SemanticSiteQuery;
  manifest: SemanticGraphPublicationManifest;
  semanticMap: SemanticMapGraph;
  featureGraph: SemanticFeatureGraph;
}): SemanticSiteQueryResult {
  const { query, semanticMap: graph, featureGraph } = input;
  const pruning = pruningCounter();
  const raw: RawCandidate[] = [];
  let examinedCount = 0;

  function examine() {
    examinedCount += 1;
    if (examinedCount > MAX_ANCHOR_CANDIDATES) {
      throw new SemanticSiteQueryBudgetError("anchor_budget_exhausted", {
        examinedCount,
        limit: MAX_ANCHOR_CANDIDATES,
      });
    }
  }

  if (query.anchor.kind === "corridor") {
    for (const corridor of graph.corridors) {
      examine();
      if (!query.authoringStatuses.includes(corridor.authoringStatus)) {
        pruning.add("authoring_status", "Anchor is not in an allowed authoring state.");
        continue;
      }
      const filter = query.corridor;
      if (filter?.minimumLengthM != null && corridor.lengthM < filter.minimumLengthM) {
        pruning.add("corridor_too_short", "Corridor is shorter than the required usable length.");
        continue;
      }
      if (filter?.maximumLengthM != null && corridor.lengthM > filter.maximumLengthM) {
        pruning.add("corridor_too_long", "Corridor is longer than the allowed range.");
        continue;
      }
      const width = corridor.representativeWidthM;
      if (filter?.minimumWidthM != null && (width == null || width < filter.minimumWidthM)) {
        pruning.add("corridor_too_narrow", "Corridor width is missing or below the minimum.");
        continue;
      }
      if (filter?.maximumWidthM != null && (width == null || width > filter.maximumWidthM)) {
        pruning.add("corridor_too_wide", "Corridor width is missing or above the maximum.");
        continue;
      }
      if (
        filter?.endpointKinds &&
        (!filter.endpointKinds.includes(corridor.start.kind) || !filter.endpointKinds.includes(corridor.end.kind))
      ) {
        pruning.add("endpoint_kind", "Corridor boundary types do not match the query.");
        continue;
      }
      const lane = laneContext(graph, corridor.id);
      if (filter?.laneRoles && !filter.laneRoles.includes(lane?.slot.role ?? "unknown")) {
        pruning.add("lane_role", "Corridor does not occupy a requested lane role.");
        continue;
      }
      if (filter?.minimumApproachLaneCount != null && (lane?.laneCount ?? 0) < filter.minimumApproachLaneCount) {
        pruning.add("lane_count", "Connected approach has too few lanes.");
        continue;
      }
      const minimumProgress = Math.max(
        filter?.progressRange[0] ?? 0,
        corridor.lengthM > 0 ? (filter?.minimumDistanceFromBoundaryM ?? 0) / corridor.lengthM : 1,
      );
      const maximumProgress = Math.min(
        filter?.progressRange[1] ?? 1,
        corridor.lengthM > 0 ? 1 - (filter?.minimumDistanceFromBoundaryM ?? 0) / corridor.lengthM : 0,
      );
      if (minimumProgress > maximumProgress) {
        pruning.add("usable_midblock_span", "Corridor has no station satisfying its boundary-distance requirement.");
        continue;
      }
      const fractions = [...new Set([minimumProgress, (minimumProgress + maximumProgress) / 2, maximumProgress]
        .map((value) => Math.round(value * 1_000_000) / 1_000_000))];
      for (const fraction of fractions) {
        const placement = polylinePoint(corridor.polyline, fraction);
        raw.push({
          id: `site:corridor:${corridor.id}:${fraction.toFixed(6)}`,
          anchorKind: "corridor",
          anchorId: corridor.id,
          anchorFraction: fraction,
          point: { ...placement.point, z: placement.point.z ?? null },
          headingRad: placement.headingRad,
          previewGeometry: { type: "polyline", points: corridor.polyline },
          compatibilityScore: corridor.diagnosticCodes.length === 0 ? 1 : 0.9,
          matchedReasons: [
            `${corridor.lengthM.toFixed(1)} m usable corridor`,
            `${Math.round(fraction * 100)}% normalized progress`,
            lane ? `${lane.laneCount}-lane approach, ${lane.slot.role}` : "lane role unknown",
          ],
          runtimeBindingStatus: null,
        });
      }
    }
  } else if (query.anchor.kind === "movement") {
    for (const movement of graph.movements) {
      examine();
      if (!query.authoringStatuses.includes(movement.authoringStatus)) {
        pruning.add("authoring_status", "Movement is not in an allowed authoring state.");
        continue;
      }
      if (query.movement?.turnRelations && !query.movement.turnRelations.includes(movement.turnRelation)) {
        pruning.add("turn_relation", "Movement turn relation does not match.");
        continue;
      }
      const variant = graph.movementVariants.find((item) => item.id === movement.representativeVariantId);
      if (!variant) {
        pruning.add("representative_variant_missing", "Movement has no representative runtime path.");
        continue;
      }
      const placement = polylinePoint(variant.polyline, 0.5);
      raw.push({
        id: `site:movement:${movement.id}`,
        anchorKind: "movement",
        anchorId: movement.id,
        anchorFraction: 0.5,
        point: { ...placement.point, z: placement.point.z ?? null },
        headingRad: placement.headingRad,
        previewGeometry: { type: "polyline", points: variant.polyline },
        compatibilityScore: movement.diagnosticCodes.length === 0 ? 1 : 0.9,
        matchedReasons: [`${movement.turnRelation} movement`, `${variant.lengthM.toFixed(1)} m runtime path`],
        runtimeBindingStatus: null,
      });
    }
  } else if (query.anchor.kind === "conflict_zone") {
    for (const zone of graph.conflictZones) {
      examine();
      if (!query.authoringStatuses.includes(zone.authoringStatus)) {
        pruning.add("authoring_status", "Conflict zone is not in an allowed authoring state.");
        continue;
      }
      if (query.conflict?.kinds && !query.conflict.kinds.includes(zone.kind)) {
        pruning.add("conflict_kind", "Conflict zone kind does not match.");
        continue;
      }
      raw.push({
        id: `site:conflict:${zone.id}`,
        anchorKind: "conflict_zone",
        anchorId: zone.id,
        anchorFraction: null,
        point: zone.center,
        headingRad: null,
        previewGeometry: { type: "point", point: zone.center },
        compatibilityScore: zone.diagnosticCodes.length === 0 ? 1 : 0.9,
        matchedReasons: [`${zone.kind} conflict`, `${zone.radiusM.toFixed(1)} m radius`],
        runtimeBindingStatus: null,
      });
    }
  } else {
    for (const feature of featureGraph.features) {
      if (!query.anchor.featureKinds.includes(feature.kind)) continue;
      examine();
      if (!query.authoringStatuses.includes(feature.authoringStatus === "candidate" ? "diagnostic_only" : feature.authoringStatus)) {
        pruning.add("authoring_status", "Environment feature is not in an allowed authoring state.");
        continue;
      }
      const center = geometryCenter(feature.geometry);
      raw.push({
        id: `site:feature:${feature.id}`,
        anchorKind: "environment_feature",
        anchorId: feature.id,
        anchorFraction: null,
        point: { ...center, z: center.z ?? null },
        headingRad: feature.geometry.type === "polyline" ? polylinePoint(feature.geometry.points, 0.5).headingRad : null,
        previewGeometry: environmentGeometry(feature),
        compatibilityScore: feature.runtimeBinding.status === "exact" ? 1 : feature.runtimeBinding.status === "projected" ? 0.85 : 0,
        matchedReasons: [feature.label, `${feature.runtimeBinding.status} runtime binding`],
        runtimeBindingStatus: feature.runtimeBinding.status,
      });
    }
  }

  let distanceComparisons = 0;
  const featureCenters = featureGraph.features.map((feature) => ({ feature, point: geometryCenter(feature.geometry) }));
  const compatible = raw.filter((candidate) => {
    for (const requirement of query.nearby) {
      let count = 0;
      for (const entry of featureCenters) {
        if (!requirement.featureKinds.includes(entry.feature.kind)) continue;
        if (!requirement.bindingStatuses.includes(entry.feature.runtimeBinding.status)) continue;
        distanceComparisons += 1;
        if (distanceComparisons > MAX_DISTANCE_COMPARISONS) {
          throw new SemanticSiteQueryBudgetError("distance_budget_exhausted", {
            distanceComparisons,
            limit: MAX_DISTANCE_COMPARISONS,
          });
        }
        if (distance(candidate.point, entry.point) <= requirement.maximumDistanceM) count += 1;
        if (count >= requirement.minCount) break;
      }
      if (count < requirement.minCount) {
        pruning.add("nearby_requirement", "Required nearby semantic context was not observed within range.");
        return false;
      }
      candidate.matchedReasons.push(
        `${count}+ ${requirement.featureKinds.join("/")} within ${requirement.maximumDistanceM} m`,
      );
    }
    return true;
  });

  compatible.sort((left, right) =>
    right.compatibilityScore - left.compatibilityScore || left.id.localeCompare(right.id));
  const clusterCenters: Point[] = [];
  const candidates = compatible.slice(0, query.limit).map((candidate, index) => {
    let clusterIndex = clusterCenters.findIndex((center) => distance(center, candidate.point) <= query.diversityRadiusM);
    if (clusterIndex < 0) {
      clusterIndex = clusterCenters.length;
      clusterCenters.push(candidate.point);
    }
    return {
      ...candidate,
      rank: index + 1,
      diversityCluster: `cluster-${clusterIndex + 1}`,
    };
  });

  return SemanticSiteQueryResultSchema.parse({
    schemaVersion: SEMANTIC_SITE_QUERY_RESULT_SCHEMA_VERSION,
    query,
    mapAssetId: input.manifest.mapAssetId,
    runtime: "carla_ue5",
    publicationRevision: input.manifest.publicationRevision,
    graphRevision: graph.graphRevision,
    examinedCount,
    compatibleCount: compatible.length,
    candidates,
    pruning: pruning.list(),
    budget: {
      candidateLimit: MAX_ANCHOR_CANDIDATES,
      distanceComparisonLimit: MAX_DISTANCE_COMPARISONS,
      distanceComparisons,
    },
  });
}
