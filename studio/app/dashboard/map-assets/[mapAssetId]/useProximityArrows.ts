"use client";

import { useMemo } from "react";
import { lonLatToScene } from "@/app/components/city-viewer/geo-utils";
import type { MapAsset } from "@simcloud/shared";
import { resolvePlaceHighlight } from "@/app/lib/maps/frontend/place-highlight";
import type { PlaceHighlight, PlaceHighlightContext } from "@/app/lib/maps/frontend/place-highlight";
import type { MapSearchResult } from "@/app/lib/maps/search/map-search";

/**
 * Initial bearing in degrees (clockwise from north) from one lng/lat to
 * another, measured in a flat local frame. Close-enough for intra-map arrow
 * glyph rotation at Belmont-scale distances; we don't need great-circle
 * precision here.
 */
export function bearingDegrees(
  fromLng: number,
  fromLat: number,
  toLng: number,
  toLat: number,
): number {
  const dx = toLng - fromLng;
  const dy = toLat - fromLat;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const TOPOLOGY_RELATION_OPS = new Set([
  "leads_to",
  "connected_to",
  "upstream_of",
  "downstream_of",
]);

function isTopologyRelation(op: string): boolean {
  return TOPOLOGY_RELATION_OPS.has(op);
}

interface UseProximityArrowsInput {
  selectedSearchResultId: string | null;
  placeHighlight: Pick<PlaceHighlight, "overlayCoords" | "bounds" | "focusTarget" | "highlightedFeatureIds" | "candidateId" | "overlayCoords">;
  highlightedRelatedObjectId: string | null;
  searchResults: MapSearchResult[];
  aiChatCandidates: MapSearchResult[];
  viewMode: "2d" | "3d";
  currentAsset: MapAsset;
  /** Context for resolving related-ref geometry (candidates, road network, enrichment, coordRef). */
  ctx: PlaceHighlightContext;
}

type ArrowFeature = {
  type: "Feature";
  geometry:
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "Point"; coordinates: [number, number] }
    | { type: "Polygon"; coordinates: [number, number][][] };
  properties: Record<string, unknown>;
};

export function useProximityArrows({
  selectedSearchResultId,
  placeHighlight,
  highlightedRelatedObjectId,
  searchResults,
  aiChatCandidates,
  viewMode,
  currentAsset,
  ctx,
}: UseProximityArrowsInput) {
  // Resolve related refs for the selected result — used by arrows, highlights, and topology paths.
  const resolvedRelatedRefs = useMemo(() => {
    if (!selectedSearchResultId) return [];
    const result =
      searchResults.find((r) => r.id === selectedSearchResultId) ??
      aiChatCandidates.find((r) => r.id === selectedSearchResultId);
    const refs = result?.relatedObjectRefs;
    if (!refs || refs.length === 0) return [];
    return refs.map((ref) => {
      const hl = ref.geometryReference
        ? resolvePlaceHighlight(ref.geometryReference, ctx)
        : null;
      let effectivePos: [number, number] | null = null;
      if (hl?.overlayCoords) {
        effectivePos = [hl.overlayCoords[0], hl.overlayCoords[1]];
      } else if (hl?.bounds) {
        const [[minLng, minLat], [maxLng, maxLat]] = hl.bounds;
        effectivePos = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
      } else if (ref.centroid) {
        effectivePos = [ref.centroid[0], ref.centroid[1]];
      }
      return { ref, hl, effectivePos };
    });
  }, [
    selectedSearchResultId,
    searchResults,
    aiChatCandidates,
    ctx,
  ]);

  // Derived highlight sets for the map layer (related feature ids, candidate ids, overlay coords).
  const relatedHighlights = useMemo(() => {
    if (resolvedRelatedRefs.length === 0) {
      return { featureIds: [] as number[], candidateIds: [] as string[], overlayCoords: [] as [number, number][] };
    }
    const primaryFeatureIds = new Set(placeHighlight.highlightedFeatureIds);
    const primaryCandidateId = placeHighlight.candidateId ?? null;
    const primaryOverlay = placeHighlight.overlayCoords;
    const featureIds = new Set<number>();
    const candidateIds = new Set<string>();
    const overlayCoords: [number, number][] = [];
    const overlaySeen = new Set<string>();
    for (const { hl } of resolvedRelatedRefs) {
      if (!hl) continue;
      for (const id of hl.highlightedFeatureIds) {
        if (!primaryFeatureIds.has(id)) featureIds.add(id);
      }
      if (hl.candidateId && hl.candidateId !== primaryCandidateId) {
        candidateIds.add(hl.candidateId);
      }
      if (hl.overlayCoords) {
        const [lng, lat] = hl.overlayCoords;
        if (primaryOverlay && primaryOverlay[0] === lng && primaryOverlay[1] === lat) continue;
        const key = `${lng.toFixed(6)},${lat.toFixed(6)}`;
        if (overlaySeen.has(key)) continue;
        overlaySeen.add(key);
        overlayCoords.push([lng, lat]);
      }
    }
    return {
      featureIds: [...featureIds],
      candidateIds: [...candidateIds],
      overlayCoords,
    };
  }, [
    resolvedRelatedRefs,
    placeHighlight.highlightedFeatureIds,
    placeHighlight.candidateId,
    placeHighlight.overlayCoords,
  ]);

  // Proximity arrows: dashed shaft + filled triangle arrowhead from the
  // selected spatial result's subject to each of its top-2 matched neighbors.
  const proximityArrowGeoJSON = useMemo(() => {
    if (!selectedSearchResultId || resolvedRelatedRefs.length === 0) return null;
    const result =
      searchResults.find((r) => r.id === selectedSearchResultId) ??
      aiChatCandidates.find((r) => r.id === selectedSearchResultId);
    if (!result) return null;

    let subLng: number | undefined;
    let subLat: number | undefined;
    if (placeHighlight.overlayCoords) {
      [subLng, subLat] = placeHighlight.overlayCoords;
    } else if (placeHighlight.bounds) {
      const [[minLng, minLat], [maxLng, maxLat]] = placeHighlight.bounds;
      subLng = (minLng + maxLng) / 2;
      subLat = (minLat + maxLat) / 2;
    } else if (result.centroid) {
      [subLng, subLat] = result.centroid;
    }
    if (subLng == null || subLat == null) return null;

    const features: ArrowFeature[] = [];

    const M_PER_DEG_LAT = 110_540;
    const HEAD_LENGTH_M = 4;
    const HEAD_HALF_WIDTH_M = 2;

    function emitArrow(
      refLng: number,
      refLat: number,
      refId: string,
      isHighlighted: boolean,
    ): void {
      if (refLng === subLng && refLat === subLat) return;
      const bearingRad = (bearingDegrees(subLng!, subLat!, refLng, refLat) * Math.PI) / 180;
      const sinB = Math.sin(bearingRad);
      const cosB = Math.cos(bearingRad);
      const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);
      const baseCenterLng = refLng - (sinB * HEAD_LENGTH_M) / mPerDegLng;
      const baseCenterLat = refLat - (cosB * HEAD_LENGTH_M) / M_PER_DEG_LAT;
      const rightLng = baseCenterLng + (cosB * HEAD_HALF_WIDTH_M) / mPerDegLng;
      const rightLat = baseCenterLat - (sinB * HEAD_HALF_WIDTH_M) / M_PER_DEG_LAT;
      const leftLng = baseCenterLng - (cosB * HEAD_HALF_WIDTH_M) / mPerDegLng;
      const leftLat = baseCenterLat + (sinB * HEAD_HALF_WIDTH_M) / M_PER_DEG_LAT;

      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [subLng!, subLat!],
            [baseCenterLng, baseCenterLat],
          ],
        },
        properties: { role: "shaft", refId, highlight: isHighlighted },
      });
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [refLng, refLat],
              [rightLng, rightLat],
              [leftLng, leftLat],
              [refLng, refLat],
            ],
          ],
        },
        properties: { role: "head", refId, highlight: isHighlighted },
      });
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [refLng, refLat] },
        properties: { role: "landing", refId, highlight: isHighlighted },
      });
    }

    const drawnIds = new Set<string>();
    for (const { ref, effectivePos } of resolvedRelatedRefs.slice(0, 2)) {
      if (!effectivePos) continue;
      if (isTopologyRelation(ref.relation)) continue;
      const isHighlighted = highlightedRelatedObjectId === ref.objectId;
      emitArrow(effectivePos[0], effectivePos[1], ref.objectId, isHighlighted);
      drawnIds.add(ref.objectId);
    }

    if (highlightedRelatedObjectId && !drawnIds.has(highlightedRelatedObjectId)) {
      const refMatch = resolvedRelatedRefs.find(
        ({ ref }) => ref.objectId === highlightedRelatedObjectId,
      );
      if (refMatch && !isTopologyRelation(refMatch.ref.relation) && refMatch.effectivePos) {
        emitArrow(
          refMatch.effectivePos[0],
          refMatch.effectivePos[1],
          highlightedRelatedObjectId,
          true,
        );
      }
    }

    if (features.length === 0) return null;
    return { type: "FeatureCollection" as const, features };
  }, [
    selectedSearchResultId,
    searchResults,
    aiChatCandidates,
    resolvedRelatedRefs,
    placeHighlight.overlayCoords,
    placeHighlight.bounds,
    highlightedRelatedObjectId,
  ]);

  // Topology relations get their own visualization: a line that traces the
  // actual graph route from subject through every intermediate hop to the endpoint.
  const topologyPathGeoJSON = useMemo(() => {
    if (!selectedSearchResultId || resolvedRelatedRefs.length === 0) return null;
    const result =
      searchResults.find((r) => r.id === selectedSearchResultId) ??
      aiChatCandidates.find((r) => r.id === selectedSearchResultId);
    if (!result) return null;

    let subLng: number | undefined;
    let subLat: number | undefined;
    if (placeHighlight.overlayCoords) {
      [subLng, subLat] = placeHighlight.overlayCoords;
    } else if (placeHighlight.bounds) {
      const [[minLng, minLat], [maxLng, maxLat]] = placeHighlight.bounds;
      subLng = (minLng + maxLng) / 2;
      subLat = (minLat + maxLat) / 2;
    } else if (result.centroid) {
      [subLng, subLat] = result.centroid;
    }
    if (subLng == null || subLat == null) return null;

    type PathFeature = {
      type: "Feature";
      geometry:
        | { type: "LineString"; coordinates: [number, number][] }
        | { type: "Point"; coordinates: [number, number] }
        | { type: "Polygon"; coordinates: [number, number][][] };
      properties: Record<string, unknown>;
    };
    const features: PathFeature[] = [];

    const M_PER_DEG_LAT_PATH = 110_540;
    const PATH_HEAD_LENGTH_M = 5;
    const PATH_HEAD_HALF_WIDTH_M = 2.5;
    const PATH_HEAD_LENGTH_M_HL = 8;
    const PATH_HEAD_HALF_WIDTH_M_HL = 4;

    for (const { ref } of resolvedRelatedRefs.slice(0, 2)) {
      if (!isTopologyRelation(ref.relation)) continue;
      const path = ref.path;
      if (!path || path.length < 2) continue;
      const coords: [number, number][] = [[subLng, subLat]];
      for (let i = 1; i < path.length; i += 1) {
        const c = path[i]!.centroid;
        if (!c) continue;
        coords.push([c[0], c[1]]);
      }
      if (coords.length < 2) continue;

      const refIsHighlighted = highlightedRelatedObjectId === ref.objectId;
      const stepIsHighlighted =
        !!highlightedRelatedObjectId &&
        path.some((s) => s.objectId === highlightedRelatedObjectId);
      const isHl = refIsHighlighted || stepIsHighlighted;

      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: {
          role: "path",
          refId: ref.objectId,
          highlight: isHl,
        },
      });

      const last = coords[coords.length - 1]!;
      const prev = coords[coords.length - 2]!;
      const [endLng, endLat] = last;
      const bearingRad =
        (bearingDegrees(prev[0], prev[1], endLng, endLat) * Math.PI) / 180;
      const sinB = Math.sin(bearingRad);
      const cosB = Math.cos(bearingRad);
      const mPerDegLngEnd = 111_320 * Math.cos((endLat * Math.PI) / 180);
      const headLen = isHl ? PATH_HEAD_LENGTH_M_HL : PATH_HEAD_LENGTH_M;
      const headHalfW = isHl ? PATH_HEAD_HALF_WIDTH_M_HL : PATH_HEAD_HALF_WIDTH_M;
      const baseCenterLng = endLng - (sinB * headLen) / mPerDegLngEnd;
      const baseCenterLat = endLat - (cosB * headLen) / M_PER_DEG_LAT_PATH;
      const rightLng = baseCenterLng + (cosB * headHalfW) / mPerDegLngEnd;
      const rightLat = baseCenterLat - (sinB * headHalfW) / M_PER_DEG_LAT_PATH;
      const leftLng = baseCenterLng - (cosB * headHalfW) / mPerDegLngEnd;
      const leftLat = baseCenterLat + (sinB * headHalfW) / M_PER_DEG_LAT_PATH;
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [endLng, endLat],
              [rightLng, rightLat],
              [leftLng, leftLat],
              [endLng, endLat],
            ],
          ],
        },
        properties: {
          role: "terminal-head",
          refId: ref.objectId,
          highlight: isHl,
        },
      });
    }

    if (highlightedRelatedObjectId) {
      for (const { ref } of resolvedRelatedRefs.slice(0, 2)) {
        if (!isTopologyRelation(ref.relation)) continue;
        if (ref.objectId === highlightedRelatedObjectId) continue;
        const step = ref.path?.find(
          (s) => s.objectId === highlightedRelatedObjectId,
        );
        if (!step?.centroid) continue;
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [step.centroid[0], step.centroid[1]] },
          properties: {
            role: "step-landing",
            refId: ref.objectId,
            stepId: step.objectId,
            highlight: true,
          },
        });
        break;
      }
    }

    if (features.length === 0) return null;
    return { type: "FeatureCollection" as const, features };
  }, [
    selectedSearchResultId,
    searchResults,
    aiChatCandidates,
    resolvedRelatedRefs,
    placeHighlight.overlayCoords,
    placeHighlight.bounds,
    highlightedRelatedObjectId,
  ]);

  // 3D proximity arrows — mirror the 2D "subject → neighbor" visual inside
  // the digital twin.
  const proximityArrows3D = useMemo(() => {
    if (viewMode !== "3d") return [];
    if (!selectedSearchResultId) return [];
    const subjectFocus = placeHighlight.focusTarget?.position;
    if (!subjectFocus) return [];
    const coordRef = currentAsset.map_coordinate_ref;
    const out: Array<{
      id: string;
      points: Array<{ x: number; y: number; z: number }>;
      highlight?: boolean;
    }> = [];
    for (const { ref, hl } of resolvedRelatedRefs.slice(0, 2)) {
      const refIsHighlighted = highlightedRelatedObjectId === ref.objectId;

      if (isTopologyRelation(ref.relation)) {
        const path = ref.path;
        if (
          !path ||
          path.length < 2 ||
          !coordRef ||
          coordRef.origin_lon == null ||
          coordRef.origin_lat == null
        ) continue;
        const originLon = coordRef.origin_lon;
        const originLat = coordRef.origin_lat;
        const points: Array<{ x: number; y: number; z: number }> = [
          { x: subjectFocus.x, y: subjectFocus.y, z: subjectFocus.z },
        ];
        for (let i = 1; i < path.length; i += 1) {
          const c = path[i]!.centroid;
          if (!c) continue;
          const projected = lonLatToScene(c[0], c[1], originLon, originLat, 0);
          points.push(projected);
        }
        if (points.length < 2) continue;
        const stepIsHighlighted =
          !!highlightedRelatedObjectId &&
          path.some((s) => s.objectId === highlightedRelatedObjectId);
        out.push({
          id: ref.objectId,
          points,
          highlight: refIsHighlighted || stepIsHighlighted,
        });
      } else {
        const refPos = hl?.focusTarget?.position;
        if (!refPos) continue;
        out.push({
          id: ref.objectId,
          points: [
            { x: subjectFocus.x, y: subjectFocus.y, z: subjectFocus.z },
            { x: refPos.x, y: refPos.y, z: refPos.z },
          ],
          highlight: refIsHighlighted,
        });
      }
    }
    return out;
  }, [
    viewMode,
    selectedSearchResultId,
    placeHighlight.focusTarget,
    resolvedRelatedRefs,
    highlightedRelatedObjectId,
    currentAsset.map_coordinate_ref,
  ]);

  return { proximityArrowGeoJSON, topologyPathGeoJSON, proximityArrows3D, resolvedRelatedRefs, relatedHighlights };
}
