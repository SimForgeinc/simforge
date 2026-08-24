"use client";

import { useCallback } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import { getExistingLayerIds } from "@/app/lib/maps/frontend/map-assets-map-utils";
import type { RuntimeLaneSelection } from "@/app/lib/editor-map/types";

export const RUNTIME_LANE_LAYER_IDS = [
  "runtime-lane-hit-area",
  "runtime-lane-line-hit-area",
  "runtime-lane-driving",
  "runtime-lane-bidirectional",
  "runtime-lane-biking",
  "runtime-lane-sidewalk",
  "runtime-lane-parking",
  "runtime-lane-shoulder",
  "runtime-lane-other",
  "runtime-road-overlay-highlighted-roads",
  "runtime-road-overlay-selected",
] as const;

export const RUNTIME_ACTOR_LAYER_IDS = [
  "runtime-actors-circle",
  "runtime-actors-label",
] as const;

export function nearestPointOnLine(
  point: [number, number],
  coordinates: Array<[number, number]>,
): {
  point: [number, number];
  fraction: number;
  /** Index of the matched segment's start vertex; null for degenerate lines. */
  segmentIndex: number | null;
  /** Parametric position within the matched segment, in [0, 1]. */
  segmentT: number;
} {
  if (coordinates.length === 0) {
    return { point, fraction: 0.5, segmentIndex: null, segmentT: 0 };
  }
  if (coordinates.length === 1) {
    return {
      point: coordinates[0]!,
      fraction: 0.5,
      segmentIndex: null,
      segmentT: 0,
    };
  }

  let bestPoint = coordinates[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestFraction = 0.5;
  let bestSegmentIndex: number | null = null;
  let bestSegmentT = 0;
  let traversed = 0;
  const segmentLengths: number[] = [];
  let totalLength = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    const [x1, y1] = coordinates[index - 1]!;
    const [x2, y2] = coordinates[index]!;
    const length = Math.hypot(x2 - x1, y2 - y1);
    segmentLengths.push(length);
    totalLength += length;
  }

  if (totalLength <= Number.EPSILON) {
    return { point: bestPoint, fraction: 0.5, segmentIndex: null, segmentT: 0 };
  }

  for (let index = 1; index < coordinates.length; index += 1) {
    const [x1, y1] = coordinates[index - 1]!;
    const [x2, y2] = coordinates[index]!;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const denom = dx * dx + dy * dy;
    const t =
      denom <= Number.EPSILON
        ? 0
        : Math.max(
            0,
            Math.min(1, ((point[0] - x1) * dx + (point[1] - y1) * dy) / denom),
          );
    const projected: [number, number] = [x1 + t * dx, y1 + t * dy];
    const distance = Math.hypot(point[0] - projected[0], point[1] - projected[1]);
    if (distance < bestDistance) {
      const segmentLength = segmentLengths[index - 1] ?? 0;
      bestDistance = distance;
      bestPoint = projected;
      bestFraction = (traversed + segmentLength * t) / totalLength;
      bestSegmentIndex = index - 1;
      bestSegmentT = t;
    }
    traversed += segmentLengths[index - 1] ?? 0;
  }

  return {
    point: bestPoint,
    fraction: Math.min(1, Math.max(0, bestFraction)),
    segmentIndex: bestSegmentIndex,
    segmentT: bestSegmentT,
  };
}

/**
 * Recover a lane centerline ([lng, lat] pairs) from a feature property value
 * that may be an array (raw GeoJSON feature) or a JSON string (MapLibre
 * serializes non-scalar properties when returned from queryRenderedFeatures).
 */
function parseCenterline(value: unknown): Array<[number, number]> | null {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw) || raw.length < 2) return null;
  return raw as Array<[number, number]>;
}

export function runtimeLaneSelectionFromFeature(
  feature: {
    geometry?: { type?: string; coordinates?: unknown };
    properties?: Record<string, unknown> | undefined;
  } | null | undefined,
  lngLat: [number, number],
): RuntimeLaneSelection | null {
  const props = feature?.properties;
  const geometry = feature?.geometry;
  if (!props) return null;

  // Lanes render as filled Polygons whose properties carry the centerline;
  // older LineString features expose it directly as geometry. Prefer the
  // centerline (true lane axis) so nearest-point + fraction stay accurate.
  // MapLibre serializes non-scalar GeoJSON properties to JSON strings when
  // returned from queryRenderedFeatures, so accept both array and string.
  const centerline = parseCenterline(props.centerline);
  let coordinates: Array<[number, number]>;
  if (centerline) {
    coordinates = centerline;
  } else if (geometry?.type === "LineString" && Array.isArray(geometry.coordinates)) {
    coordinates = geometry.coordinates as Array<[number, number]>;
  } else {
    return null;
  }
  if (coordinates.length < 2) return null;
  const selection = nearestPointOnLine(lngLat, coordinates);

  return {
    road_id: String(props.road_id ?? ""),
    section_id:
      typeof props.section_id === "number"
        ? props.section_id
        : props.section_id == null
          ? null
          : Number(props.section_id),
    lane_id:
      typeof props.lane_id === "number"
        ? props.lane_id
        : props.lane_id == null
          ? null
          : Number(props.lane_id),
    lane_type: props.lane_type == null ? null : String(props.lane_type),
    label: String(props.label ?? "Runtime lane"),
    is_junction: Boolean(props.is_junction),
    coordinates,
    selected_point: selection.point,
    selected_fraction: selection.fraction,
  };
}

export type RuntimeLaneMapFeature = Parameters<typeof runtimeLaneSelectionFromFeature>[0];

export function nearestRuntimeLaneSelectionFromFeatures(
  features: RuntimeLaneMapFeature[],
  lngLat: [number, number],
): RuntimeLaneSelection | null {
  let nearest: RuntimeLaneSelection | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const feature of features) {
    if (feature?.properties?.feature_kind !== "lane_centerline") continue;
    // Scenery is not a spawn target. The overlay now carries the sidewalk,
    // shoulder, parking and bike lanes that make a road look like a road, and
    // without this the nearest lane to a kerbside click is the pavement — so a
    // car dropped by the kerb would snap onto it and the author would have no
    // way to tell, because the snapped point looks perfectly reasonable.
    if (feature.properties.runtime_bound === false) continue;
    const selection = runtimeLaneSelectionFromFeature(feature, lngLat);
    if (!selection) continue;
    const distance = Math.hypot(
      selection.selected_point[0] - lngLat[0],
      selection.selected_point[1] - lngLat[1],
    );
    if (distance < nearestDistance) {
      nearest = selection;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function runtimeLaneHitLayerIds(
  map: Parameters<typeof getExistingLayerIds>[0],
): string[] {
  const hitLayers = getExistingLayerIds(map, [
    "runtime-lane-hit-area",
    "runtime-lane-line-hit-area",
  ]);
  return hitLayers.length > 0
    ? hitLayers
    : getExistingLayerIds(map, RUNTIME_LANE_LAYER_IDS);
}

type UseRuntimeLaneHoverArgs = {
  preferRuntimeSelection: boolean;
  onHoverRuntimeLane?: (payload: RuntimeLaneSelection | null) => void;
};

export function useRuntimeLaneHover({
  preferRuntimeSelection,
  onHoverRuntimeLane,
}: UseRuntimeLaneHoverArgs) {
  return useCallback(
    (evt: MapLayerMouseEvent) => {
      if (!preferRuntimeSelection || !onHoverRuntimeLane) return;
      const map = evt.target;
      const runtimeLaneIds = runtimeLaneHitLayerIds(map);
      let hoveredLane: RuntimeLaneSelection | null = null;

      try {
        if (runtimeLaneIds.length > 0) {
          const features = map.queryRenderedFeatures(evt.point, {
            layers: runtimeLaneIds,
          });
          hoveredLane = nearestRuntimeLaneSelectionFromFeatures(
            features,
            [evt.lngLat.lng, evt.lngLat.lat],
          );
        }
      } catch {
        hoveredLane = null;
      }

      onHoverRuntimeLane(hoveredLane);
    },
    [onHoverRuntimeLane, preferRuntimeSelection],
  );
}

type UseRuntimeLaneSelectArgs = {
  preferRuntimeSelection: boolean;
  onSelectRuntimeLane?: (payload: RuntimeLaneSelection) => void;
};

export function useRuntimeLaneSelect({
  preferRuntimeSelection,
  onSelectRuntimeLane,
}: UseRuntimeLaneSelectArgs) {
  return useCallback(
    (evt: MapLayerMouseEvent) => {
      if (!preferRuntimeSelection || !onSelectRuntimeLane) return false;
      const map = evt.target;
      const runtimeLaneIds = runtimeLaneHitLayerIds(map);

      try {
        if (runtimeLaneIds.length > 0) {
          const features = map.queryRenderedFeatures(evt.point, { layers: runtimeLaneIds });
          const laneSelection = nearestRuntimeLaneSelectionFromFeatures(
            features,
            [evt.lngLat.lng, evt.lngLat.lat],
          );
          if (laneSelection) {
            onSelectRuntimeLane(laneSelection);
            return true;
          }
        }
      } catch {
        return false;
      }

      return false;
    },
    [onSelectRuntimeLane, preferRuntimeSelection],
  );
}

type RuntimeActorPayload = {
  actorId: string;
  clientX: number;
  clientY: number;
};

/**
 * The actor under a map event, or null.
 *
 * In 3D the cars are drawn by a GL layer rather than DOM markers, so a pointer
 * event on them arrives as a plain map event and the only way back to an actor
 * id is a hit-test against the (invisible) actor layers.
 */
function runtimeActorPayloadAt(evt: MapLayerMouseEvent): RuntimeActorPayload | null {
  const map = evt.target;
  const actorLayerIds = getExistingLayerIds(map, RUNTIME_ACTOR_LAYER_IDS);
  if (actorLayerIds.length === 0) return null;

  try {
    const features = map.queryRenderedFeatures(evt.point, {
      layers: actorLayerIds,
    });
    const feature = features.find((entry) =>
      entry.layer.id.startsWith("runtime-actors-"),
    );
    const actorId = feature?.properties?.id;
    if (typeof actorId !== "string" || actorId.length === 0) return null;
    return {
      actorId,
      clientX: evt.originalEvent.clientX,
      clientY: evt.originalEvent.clientY,
    };
  } catch {
    // ignore actor hit-test failures and allow normal map interaction
    return null;
  }
}

type UseRuntimeActorMouseDownArgs = {
  onMouseDownRuntimeActor?: (payload: RuntimeActorPayload) => void;
};

export function useRuntimeActorMouseDown({
  onMouseDownRuntimeActor,
}: UseRuntimeActorMouseDownArgs) {
  return useCallback(
    (evt: MapLayerMouseEvent) => {
      if (!onMouseDownRuntimeActor) return;
      // Left button only. The right button opens the actor's details and must
      // not also arm hold-to-move, or a right-click that lingers would pick the
      // car up while the panel opens.
      if (evt.originalEvent.button !== 0) return;
      const payload = runtimeActorPayloadAt(evt);
      if (!payload) return;
      evt.originalEvent.preventDefault();
      onMouseDownRuntimeActor(payload);
    },
    [onMouseDownRuntimeActor],
  );
}

type UseRuntimeActorContextMenuArgs = {
  onContextMenuRuntimeActor?: (payload: RuntimeActorPayload) => void;
};

/** Right-click an actor to open its details. Returns true when one was hit. */
export function useRuntimeActorContextMenu({
  onContextMenuRuntimeActor,
}: UseRuntimeActorContextMenuArgs) {
  return useCallback(
    (evt: MapLayerMouseEvent) => {
      if (!onContextMenuRuntimeActor) return false;
      const payload = runtimeActorPayloadAt(evt);
      if (!payload) return false;
      onContextMenuRuntimeActor(payload);
      return true;
    },
    [onContextMenuRuntimeActor],
  );
}


/** The placement-anchor layers a drive-by-points gesture hit-tests against. */
const TIMED_POINT_LAYER_IDS = ["placement-anchor-circle"] as const;
const TIMED_PATH_SEGMENT_LAYER_IDS = ["placement-anchor-line"] as const;

type UseTimedPointMouseDownArgs = {
  onMouseDownTimedPoint?: (payload: {
    actorId: string;
    index: number;
    clientX: number;
    clientY: number;
  }) => boolean | void;
};

/**
 * Pick up an authored drive-by-points marker (plan 2026-07-25 §6.3).
 *
 * Hit-tests the same way `useRuntimeActorMouseDown` does, and for the same
 * reason: the markers are a GeoJSON layer rather than React markers, so there
 * is no element to attach a handler to. The spawn marker (`waypoint_index: -1`)
 * is deliberately not draggable here — it is the actor's spawn, which the
 * existing actor drag already moves.
 */
export function useTimedPointMouseDown({
  onMouseDownTimedPoint,
}: UseTimedPointMouseDownArgs) {
  return useCallback(
    (evt: MapLayerMouseEvent) => {
      if (!onMouseDownTimedPoint) return false;
      const map = evt.target;
      const layerIds = getExistingLayerIds(map, [...TIMED_POINT_LAYER_IDS]);
      if (layerIds.length === 0) return false;
      try {
        const feature = map
          .queryRenderedFeatures(evt.point, { layers: layerIds })
          .find((entry) => entry.properties?.kind === "timed-path-point");
        const actorId = feature?.properties?.actor_id;
        const index = Number(feature?.properties?.waypoint_index);
        if (typeof actorId !== "string" || !Number.isInteger(index) || index < 0) {
          return false;
        }
        const claimed = onMouseDownTimedPoint({
          actorId,
          index,
          clientX: evt.originalEvent.clientX,
          clientY: evt.originalEvent.clientY,
        });
        if (claimed) evt.originalEvent.preventDefault();
        return Boolean(claimed);
      } catch {
        // A failed hit-test must never block normal map interaction.
        return false;
      }
    },
    [onMouseDownTimedPoint],
  );
}

type UseTimedPathSegmentClickArgs = {
  onClickTimedPathSegment?: (payload: {
    actorId: string;
    /** Index of the point the clicked segment ARRIVES at — where the inserted
     *  point lands, pushing this one and everything after it a slot later. */
    waypointIndex: number;
    lng: number;
    lat: number;
  }) => boolean | void;
};

/** Click a segment of a drive-by-points path to insert a point into it. */
export function useTimedPathSegmentClick({
  onClickTimedPathSegment,
}: UseTimedPathSegmentClickArgs) {
  return useCallback(
    (evt: MapLayerMouseEvent) => {
      if (!onClickTimedPathSegment) return false;
      const map = evt.target;
      const layerIds = getExistingLayerIds(map, [...TIMED_PATH_SEGMENT_LAYER_IDS]);
      if (layerIds.length === 0) return false;
      try {
        const feature = map
          .queryRenderedFeatures(evt.point, { layers: layerIds })
          .find((entry) => entry.properties?.kind === "timed-path-line");
        const actorId = feature?.properties?.actor_id;
        const waypointIndex = Number(feature?.properties?.waypoint_index);
        if (
          typeof actorId !== "string" ||
          !Number.isInteger(waypointIndex) ||
          waypointIndex < 0
        ) {
          return false;
        }
        return Boolean(
          onClickTimedPathSegment({
            actorId,
            waypointIndex,
            lng: evt.lngLat.lng,
            lat: evt.lngLat.lat,
          }),
        );
      } catch {
        return false;
      }
    },
    [onClickTimedPathSegment],
  );
}
