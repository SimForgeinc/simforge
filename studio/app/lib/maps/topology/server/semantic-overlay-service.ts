import "server-only";

import {
  SEMANTIC_MAP_OVERLAY_SCHEMA_VERSION,
  SemanticMapOverlaySchema,
  type SemanticMapGraph,
  type SemanticMapOverlay,
  type SemanticFeatureGeometry,
  type SemanticFeatureGraph,
} from "@simforge-oss/studio-shared";

export const SEMANTIC_OVERLAY_MAX_BYTES = 2 * 1024 * 1024;
const MAX_POLYLINE_POINTS = 256;

export type SemanticOverlayViewport = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export class SemanticOverlayTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super("Semantic overlay exceeds the viewport response budget.");
    this.name = "SemanticOverlayTooLargeError";
  }
}

type OverlayPoint = { x: number; y: number };

function intersectsViewport(
  points: readonly OverlayPoint[],
  viewport: SemanticOverlayViewport,
): boolean {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return !(
    maxX < viewport.minX ||
    minX > viewport.maxX ||
    maxY < viewport.minY ||
    minY > viewport.maxY
  );
}

function compactPolyline(points: readonly OverlayPoint[]) {
  if (points.length <= MAX_POLYLINE_POINTS) {
    return points.map(({ x, y }) => ({ x, y }));
  }
  return Array.from({ length: MAX_POLYLINE_POINTS }, (_, index) => {
    const sourceIndex = Math.round(
      (index * (points.length - 1)) / (MAX_POLYLINE_POINTS - 1),
    );
    const point = points[sourceIndex]!;
    return { x: point.x, y: point.y };
  });
}

function geometryPoints(geometry: SemanticFeatureGeometry): OverlayPoint[] {
  if (geometry.type === "point") return [geometry.point];
  if (geometry.type === "polyline") return geometry.points;
  return geometry.rings.flat();
}

function compactGeometry(geometry: SemanticFeatureGeometry): SemanticFeatureGeometry {
  if (geometry.type === "point") return geometry;
  if (geometry.type === "polyline") {
    return { type: "polyline", points: compactPolyline(geometry.points) };
  }
  return {
    type: "polygon",
    rings: geometry.rings.map((ring) => compactPolyline(ring)),
  };
}

export function projectSemanticMapOverlay(input: {
  graph: SemanticMapGraph;
  featureGraph?: SemanticFeatureGraph | null;
  viewport: SemanticOverlayViewport;
}): SemanticMapOverlay {
  const { graph, viewport } = input;
  const corridors = graph.corridors
    .filter((corridor) => intersectsViewport(corridor.polyline, viewport))
    .map((corridor) => ({
      id: corridor.id,
      polyline: compactPolyline(corridor.polyline),
      lengthM: corridor.lengthM,
      representativeWidthM: corridor.representativeWidthM,
      predecessorCorridorIds: corridor.predecessorCorridorIds,
      successorCorridorIds: corridor.successorCorridorIds,
      lateralAdjacencies: corridor.lateralAdjacencies,
      authoringStatus: corridor.authoringStatus,
      diagnosticCodes: corridor.diagnosticCodes,
    }));
  const corridorIds = new Set(corridors.map((corridor) => corridor.id));
  const movementVariants = graph.movementVariants
    .filter(
      (variant) =>
        intersectsViewport(variant.polyline, viewport) ||
        corridorIds.has(variant.incomingCorridorId) ||
        corridorIds.has(variant.outgoingCorridorId),
    )
    .map((variant) => ({
      id: variant.id,
      movementId: variant.movementId,
      incomingCorridorId: variant.incomingCorridorId,
      outgoingCorridorId: variant.outgoingCorridorId,
      polyline: compactPolyline(variant.polyline),
      authoringStatus: variant.authoringStatus,
      diagnosticCodes: variant.diagnosticCodes,
    }));
  const movementIds = new Set(
    movementVariants.map((variant) => variant.movementId),
  );
  const conflictZones = graph.conflictZones
    .filter(
      (zone) =>
        zone.movementIds.some((movementId) => movementIds.has(movementId)) ||
        !(
          zone.center.x + zone.radiusM < viewport.minX ||
          zone.center.x - zone.radiusM > viewport.maxX ||
          zone.center.y + zone.radiusM < viewport.minY ||
          zone.center.y - zone.radiusM > viewport.maxY
        ),
    )
    .map((zone) => ({
      id: zone.id,
      junctionId: zone.junctionId,
      kind: zone.kind,
      movementIds: zone.movementIds,
      center: { x: zone.center.x, y: zone.center.y },
      radiusM: zone.radiusM,
      authoringStatus: zone.authoringStatus,
      diagnosticCodes: zone.diagnosticCodes,
    }));
  for (const zone of conflictZones) {
    for (const movementId of zone.movementIds) movementIds.add(movementId);
  }
  const includedVariantIds = new Set(
    movementVariants.map((variant) => variant.id),
  );
  movementVariants.push(
    ...graph.movementVariants
      .filter(
        (variant) =>
          movementIds.has(variant.movementId) &&
          !includedVariantIds.has(variant.id),
      )
      .map((variant) => ({
        id: variant.id,
        movementId: variant.movementId,
        incomingCorridorId: variant.incomingCorridorId,
        outgoingCorridorId: variant.outgoingCorridorId,
        polyline: compactPolyline(variant.polyline),
        authoringStatus: variant.authoringStatus,
        diagnosticCodes: variant.diagnosticCodes,
      })),
  );
  const movements = graph.movements
    .filter((movement) => movementIds.has(movement.id))
    .map((movement) => ({
      id: movement.id,
      junctionId: movement.junctionId,
      incomingApproachId: movement.incomingApproachId,
      outgoingApproachId: movement.outgoingApproachId,
      turnRelation: movement.turnRelation,
      variantIds: movement.variantIds,
      representativeVariantId: movement.representativeVariantId,
      conflictZoneIds: movement.conflictZoneIds,
      authoringStatus: movement.authoringStatus,
      diagnosticCodes: movement.diagnosticCodes,
    }));
  const approachIds = new Set(
    movements.flatMap((movement) => [
      movement.incomingApproachId,
      movement.outgoingApproachId,
    ]),
  );
  const approaches = graph.approaches
    .filter(
      (approach) =>
        approachIds.has(approach.id) ||
        approach.corridorIds.some((corridorId) => corridorIds.has(corridorId)),
    )
    .map((approach) => ({
      id: approach.id,
      junctionId: approach.junctionId,
      direction: approach.direction,
      boundaryCenter: {
        x: approach.boundaryCenter.x,
        y: approach.boundaryCenter.y,
      },
      headingRad: approach.headingRad,
      corridorIds: approach.corridorIds,
      laneSlots: approach.laneSlots.map((slot) => ({
        corridorId: slot.corridorId,
        ordinalFromLeft: slot.ordinalFromLeft,
        role: slot.role,
      })),
      movementIds: approach.movementIds,
      authoringStatus: approach.authoringStatus,
      diagnosticCodes: approach.diagnosticCodes,
    }));
  const environmentFeatures = (input.featureGraph?.features ?? [])
    .filter((feature) =>
      !["driving_corridor", "junction_movement", "vehicle_conflict_zone"].includes(feature.kind) &&
      intersectsViewport(geometryPoints(feature.geometry), viewport))
    .map((feature) => ({
      id: feature.id,
      kind: feature.kind,
      label: feature.label,
      geometry: compactGeometry(feature.geometry),
      primarySource: feature.sources[0]!.source,
      runtimeBindingStatus: feature.runtimeBinding.status,
      authoringStatus: feature.authoringStatus,
      diagnosticCodes: feature.diagnosticCodes,
    }));
  const overlay = SemanticMapOverlaySchema.parse({
    schemaVersion: SEMANTIC_MAP_OVERLAY_SCHEMA_VERSION,
    graphRevision: graph.graphRevision,
    compilerVersion: graph.compilerVersion,
    runtimeProvenance: graph.source.runtimeProvenance,
    authority: graph.authority,
    authoringReady: graph.authoringReady,
    viewport,
    corridors,
    approaches,
    movementVariants,
    movements,
    conflictZones,
    environmentFeatures,
  });
  const sizeBytes = Buffer.byteLength(JSON.stringify(overlay), "utf8");
  if (sizeBytes > SEMANTIC_OVERLAY_MAX_BYTES) {
    throw new SemanticOverlayTooLargeError(sizeBytes);
  }
  return overlay;
}
