"use client";

import { useCallback } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import { getExistingLayerIds } from "@/app/lib/maps/frontend/map-assets-map-utils";
import {
  type SemanticFeatureKind,
  type SemanticFeatureSelection,
} from "@/app/lib/editor-map/semantic-overlay";
import {
  SEMANTIC_HIT_LAYER_IDS,
  SEMANTIC_INSPECTION_HIT_LAYER_IDS,
} from "../layers/SemanticOverlayLayers";
import { nearestPointOnLine } from "./useRuntimeLaneInteraction";

// Hit testing for the semantic authoring surface. Armed authoring only exposes
// authorable road features; browse inspection also exposes context and
// diagnostics through separately controlled hit layers. Semantic
// hits are resolved BEFORE any raw runtime lane query — the runtime overlay
// must never win hit testing while semantic authoring is active.

function parseJsonProperty(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseJsonProperty(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function parseCoordinatePairs(value: unknown): Array<[number, number]> | null {
  const parsed = parseJsonProperty(value);
  if (!Array.isArray(parsed) || parsed.length < 2) return null;
  return parsed as Array<[number, number]>;
}

function parseNumberArray(value: unknown): number[] | null {
  const parsed = parseJsonProperty(value);
  if (!Array.isArray(parsed)) return null;
  const numbers = parsed.filter(
    (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
  );
  return numbers.length === parsed.length ? numbers : null;
}

/**
 * Recover the corridor arc fraction in RUNTIME meters. The projected
 * centerline carries a cumulative runtime arc fraction per vertex
 * (`centerline_fractions`); interpolating within the matched segment keeps
 * stations exact even where lng/lat degree spans distort projected segment
 * lengths (long corridors, high latitudes, sharp turns). Falls back to the
 * degree-space fraction only when the fractions are missing or misaligned.
 */
function corridorRuntimeFraction(
  nearest: ReturnType<typeof nearestPointOnLine>,
  centerline: Array<[number, number]>,
  fractions: number[] | null,
): number {
  if (
    !fractions ||
    fractions.length !== centerline.length ||
    nearest.segmentIndex === null ||
    nearest.segmentIndex + 1 >= fractions.length
  ) {
    return nearest.fraction;
  }
  const start = fractions[nearest.segmentIndex]!;
  const end = fractions[nearest.segmentIndex + 1]!;
  const fraction = start + (end - start) * nearest.segmentT;
  return Math.min(1, Math.max(0, fraction));
}

/**
 * Build a semantic selection payload from a rendered map feature. Exported
 * for direct unit testing; MapLibre serializes non-scalar properties to JSON
 * strings when returned from queryRenderedFeatures, so both raw arrays and
 * JSON strings are accepted.
 */
export function semanticFeatureFromMapFeature(
  feature: {
    properties?: Record<string, unknown> | undefined;
  } | null | undefined,
  lngLat: [number, number],
  options: { allowNonAuthorable?: boolean; allowContext?: boolean } = {},
): SemanticFeatureSelection | null {
  const props = feature?.properties;
  if (!props) return null;
  const kind = props.semantic_kind;
  const id = props.semantic_id;
  const key = props.semantic_key;
  if (
    (kind !== "corridor" &&
      kind !== "movement" &&
      kind !== "conflict_zone" &&
      (kind !== "environment_feature" || !options.allowContext)) ||
    typeof id !== "string" ||
    id.length === 0 ||
    typeof key !== "string" ||
    key.length === 0
  ) {
    return null;
  }
  const authoringStatus =
    typeof props.authoring_status === "string"
      ? props.authoring_status
      : "unknown";
  if (authoringStatus !== "authorable" && !options.allowNonAuthorable) return null;
  let point: [number, number] = lngLat;
  let fraction: number | null = null;
  let lengthM: number | null = null;
  let stationM: number | null = null;
  let predecessorCorridorIds: string[] = [];
  let successorCorridorIds: string[] = [];
  if (kind === "corridor") {
    const centerline = parseCoordinatePairs(props.centerline);
    if (centerline) {
      const nearest = nearestPointOnLine(lngLat, centerline);
      point = nearest.point;
      fraction = corridorRuntimeFraction(
        nearest,
        centerline,
        parseNumberArray(props.centerline_fractions),
      );
    }
    // Station is the exact server corridor length scaled by the nearest-point
    // fraction; without a server length there is no station (never estimate
    // one from projected geometry).
    if (
      typeof props.length_m === "number" &&
      Number.isFinite(props.length_m) &&
      props.length_m >= 0
    ) {
      lengthM = props.length_m;
      if (fraction != null) {
        stationM = Math.min(1, Math.max(0, fraction)) * lengthM;
      }
    }
    predecessorCorridorIds = parseStringArray(props.predecessor_corridor_ids);
    successorCorridorIds = parseStringArray(props.successor_corridor_ids);
  }

  return {
    kind: kind as SemanticFeatureKind,
    id,
    key,
    label: typeof props.label === "string" ? props.label : `Semantic ${kind}`,
    authoringStatus,
    diagnosticCodes: parseStringArray(props.diagnostic_codes),
    variantId: typeof props.variant_id === "string" ? props.variant_id : null,
    turnRelation:
      typeof props.turn_relation === "string" ? props.turn_relation : null,
    junctionId:
      typeof props.junction_id === "string" ? props.junction_id : null,
    point,
    fraction,
    lengthM,
    stationM,
    predecessorCorridorIds,
    successorCorridorIds,
  };
}

function querySemanticFeature(
  evt: MapLayerMouseEvent,
  inspectionEnabled: boolean,
  selectableKinds?: readonly SemanticFeatureKind[],
): SemanticFeatureSelection | null {
  const map = evt.target;
  const layerIds = getExistingLayerIds(
    map,
    inspectionEnabled
      ? [...SEMANTIC_INSPECTION_HIT_LAYER_IDS, ...SEMANTIC_HIT_LAYER_IDS]
      : SEMANTIC_HIT_LAYER_IDS,
  );
  if (layerIds.length === 0) return null;
  try {
    const features = map.queryRenderedFeatures(evt.point, { layers: layerIds });
    for (const feature of features) {
      const selection = semanticFeatureFromMapFeature(feature, [
        evt.lngLat.lng,
        evt.lngLat.lat,
      ], {
        allowNonAuthorable: inspectionEnabled,
        allowContext: inspectionEnabled,
      });
      if (
        selection &&
        (!selectableKinds || selectableKinds.includes(selection.kind))
      ) {
        return selection;
      }
    }
  } catch {
    return null;
  }
  return null;
}

type UseSemanticFeatureHoverArgs = {
  semanticInteractionActive: boolean;
  semanticInspectionEnabled?: boolean;
  onHoverSemanticFeature?: (payload: SemanticFeatureSelection | null) => void;
  selectableKinds?: readonly SemanticFeatureKind[];
};

/** Returns the hover handler; the boolean result reports whether a hit won. */
export function useSemanticFeatureHover({
  semanticInteractionActive,
  semanticInspectionEnabled = false,
  onHoverSemanticFeature,
  selectableKinds,
}: UseSemanticFeatureHoverArgs) {
  return useCallback(
    (evt: MapLayerMouseEvent): boolean => {
      if (!semanticInteractionActive || !onHoverSemanticFeature) return false;
      const selection = querySemanticFeature(
        evt,
        semanticInspectionEnabled,
        selectableKinds,
      );
      onHoverSemanticFeature(selection);
      return selection !== null;
    },
    [onHoverSemanticFeature, selectableKinds, semanticInspectionEnabled, semanticInteractionActive],
  );
}

type UseSemanticFeatureSelectArgs = {
  semanticInteractionActive: boolean;
  semanticInspectionEnabled?: boolean;
  onSelectSemanticFeature?: (payload: SemanticFeatureSelection) => void;
  selectableKinds?: readonly SemanticFeatureKind[];
};

export function useSemanticFeatureSelect({
  semanticInteractionActive,
  semanticInspectionEnabled = false,
  onSelectSemanticFeature,
  selectableKinds,
}: UseSemanticFeatureSelectArgs) {
  return useCallback(
    (evt: MapLayerMouseEvent): boolean => {
      if (!semanticInteractionActive || !onSelectSemanticFeature) return false;
      const selection = querySemanticFeature(
        evt,
        semanticInspectionEnabled,
        selectableKinds,
      );
      if (!selection) return false;
      onSelectSemanticFeature(selection);
      return true;
    },
    [onSelectSemanticFeature, selectableKinds, semanticInspectionEnabled, semanticInteractionActive],
  );
}
