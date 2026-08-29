import type { MapAsset } from "@simforge-oss/studio-shared";
import {
  laneTravelIncreasesSFromCenterline,
} from "@simforge-oss/maps/topology";
import type { RuntimeMapResponse } from "@/app/lib/runtime/runtime-types";
import { lngLatToRuntimePoint, runtimePointToLngLat } from "./coordinates";
import { normalizeRuntimeLaneType } from "./runtime-layer-visibility";
import type {
  EditorRuntimeRoadOverlay,
  MapLocation,
  RuntimeRoadOverlayCollection,
  RuntimeRoadOverlayFeature,
} from "./types";

/**
 * Decimal places kept on projected lane coordinates.
 *
 * 7 dp is ~1.1 cm of longitude. The unrounded values carried 17 significant
 * figures — sub-nanometre precision for a lane 2.4-3.5 m wide — and coordinate
 * digits were 82% of a 1.19 MB payload. Rounding cuts that payload by 32% raw
 * and 57% gzipped (measured, Munich, 389 lanes / 25,093 vertices).
 *
 * Applied here rather than at the call sites so the centerline and the ribbon
 * ring offset from it are rounded by the same rule and cannot disagree.
 */
const COORDINATE_DECIMALS = 7;

function roundCoordinate(value: number): number {
  return Number(value.toFixed(COORDINATE_DECIMALS));
}

const MAX_WIDTH_AWARE_LANES = 1_000;
const MAX_WIDTH_AWARE_CENTERLINE_POINTS = 25_000;

export function shouldUseCompactCenterlines(
  matchingLaneCount: number,
  centerlinePointCount: number,
): boolean {
  return (
    matchingLaneCount > MAX_WIDTH_AWARE_LANES ||
    centerlinePointCount > MAX_WIDTH_AWARE_CENTERLINE_POINTS
  );
}

// y-up CARLA-native runtime frame (raw `runtime.road_segments` from CARLA).
function runtimeToLonLat(
  x: number,
  y: number,
  asset: Pick<MapAsset, "map_coordinate_ref">,
): [number, number] | null {
  const projected = runtimePointToLngLat({ x, y }, asset);
  if (!projected) return null;
  return [roundCoordinate(projected[0]), roundCoordinate(projected[1])];
}

// Fallback half-widths (m) by normalized lane type, used when the runtime
// segment carries no `lane_width`. Keeps lanes visible as polygons rather than
// collapsing to a zero-area sliver.
const DEFAULT_LANE_WIDTH_M: Record<string, number> = {
  driving: 3.5,
  bidirectional: 3.5,
  biking: 1.5,
  sidewalk: 1.8,
  parking: 2.5,
  shoulder: 2.0,
  other: 3.0,
};

function waypointRsl(
  waypoint: NonNullable<
    NonNullable<RuntimeMapResponse["road_segments"]>[number]["successors"]
  >[number] | null | undefined,
): string | null {
  if (!waypoint) return null;
  if (waypoint.rsl) return waypoint.rsl;
  if (
    waypoint.road_id == null ||
    waypoint.section_id == null ||
    waypoint.lane_id == null
  ) {
    return null;
  }
  return `${waypoint.road_id}:${waypoint.section_id}:${waypoint.lane_id}`;
}

/**
 * Offset a runtime-frame centerline into its closed ribbon ring, in lng/lat.
 *
 * Each vertex is pushed ±half the lane width along the local normal. Shared by
 * the server's width-aware build and the browser's reconstruction of it, so
 * the two cannot describe the lane differently — the ribbon is the map's click
 * target, and a ribbon that disagreed with the centerline would move where a
 * lane can be selected.
 */
function ribbonRingFromRuntimeCenterline(
  points: readonly { x: number; y: number; lane_width?: number | null }[],
  laneWidthM: number | null | undefined,
  laneType: string,
  asset: Pick<MapAsset, "map_coordinate_ref">,
): [number, number][] | null {
  if (points.length < 2) return null;

  const fallbackHalf =
    ((laneWidthM ?? DEFAULT_LANE_WIDTH_M[laneType] ?? 3.0) || 3.0) / 2;

  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < points.length; i += 1) {
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(points.length - 1, i + 1)]!;
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty);
    if (len < 1e-9) continue;
    tx /= len;
    ty /= len;
    // Left normal of tangent (tx,ty) is (-ty, tx).
    const nx = -ty;
    const ny = tx;
    const half = (points[i]!.lane_width ?? laneWidthM ?? fallbackHalf * 2) / 2;
    const lp = runtimeToLonLat(points[i]!.x + nx * half, points[i]!.y + ny * half, asset);
    const rp = runtimeToLonLat(points[i]!.x - nx * half, points[i]!.y - ny * half, asset);
    if (lp) left.push(lp);
    if (rp) right.push(rp);
  }

  if (left.length < 2 || right.length < 2) return null;
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]!);
  return ring;
}

function runtimeSegmentRing(
  segment: NonNullable<RuntimeMapResponse["road_segments"]>[number],
  asset: MapAsset,
  laneType: string,
): [number, number][] | null {
  return ribbonRingFromRuntimeCenterline(
    segment.centerline,
    segment.lane_width,
    laneType,
    asset,
  );
}

/**
 * Rebuild the width-aware ribbons the compact wire format leaves out.
 *
 * The route ships lanes as bare centerline LineStrings plus a `lane_width`,
 * because the ribbon is two vertices per centerline vertex and was being sent
 * ALONGSIDE the centerline it is derived from — two thirds of a 3.15 MB
 * payload (Munich, 389 lanes) reconstructible from the other third.
 *
 * This returns the exact shape the server used to send, so nothing downstream
 * can tell the difference: Polygon geometry for the fill and hit target, the
 * centerline back in properties for placement and lane selection. Features
 * that already carry a Polygon are passed through untouched.
 */
export function expandRuntimeRoadOverlayRibbons(
  collection: RuntimeRoadOverlayCollection,
  asset: Pick<MapAsset, "map_coordinate_ref">,
): RuntimeRoadOverlayCollection {
  return {
    ...collection,
    features: collection.features.map((feature) => {
      if (feature.geometry?.type !== "LineString") return feature;
      const centerline = feature.geometry.coordinates as [number, number][];
      if (!Array.isArray(centerline) || centerline.length < 2) return feature;

      const runtimePoints = centerline
        .map(([lng, lat]) => lngLatToRuntimePoint(lng, lat, asset))
        .filter((point): point is { x: number; y: number } => point !== null);
      const laneType = normalizeRuntimeLaneType(feature.properties?.lane_type);
      const ring = ribbonRingFromRuntimeCenterline(
        runtimePoints,
        feature.properties?.lane_width ?? null,
        laneType,
        asset,
      );
      if (!ring) return feature;

      return {
        ...feature,
        geometry: { type: "Polygon" as const, coordinates: [ring] },
        properties: { ...feature.properties, centerline },
      };
    }),
  };
}

/**
 * Does this lane's TRAVEL direction run with increasing `s`?
 *
 * The centerline is always emitted in +s order, but a lane may be driven in
 * either direction along it, and the overlay is the only description of the
 * road network the browser gets. Without this, anything deriving a heading
 * from the projected centerline gets the +s tangent — which is backwards on
 * every lane that travels against +s, and shows up as cars facing the wrong
 * way in their lane.
 *
 * Read from the per-point `yaw`, which is the direction CARLA itself resolved
 * from the OpenDRIVE and drives waypoints along: travel runs with +s exactly
 * when the +s tangent points the same way as that yaw. This is the test
 * `batch-scenario-generator/routing.ts::forwardIsIncreasingS` already applies
 * to the runtime bundle, so the two paths now answer identically.
 *
 * It was NOT usable here until recently, because the runtime-geometry route
 * synthesized `yaw` from the polyline tangent — making the comparison
 * tautological and answering "with +s" for all 1999 lanes on San Ramon P1. The
 * route now emits CARLA's real travel heading (see
 * `maps/topology/server/lane-travel-direction.ts`), so the comparison is real.
 *
 * The fallback is the OpenDRIVE sign convention — negative lane ids run with
 * +s — which holds on every lane of every map published today (San Ramon P1:
 * 1999/1999; Munich: 389/389) but is a convention the standard does not
 * guarantee. It applies only to segments carrying no usable yaw at all.
 */
function travelIncreasesS(
  segment: NonNullable<RuntimeMapResponse["road_segments"]>[number],
): boolean {
  return laneTravelIncreasesSFromCenterline(
    segment.centerline ?? [],
    segment.lane_id,
  );
}

function runtimeSegmentToFeature(
  segment: NonNullable<RuntimeMapResponse["road_segments"]>[number],
  asset: MapAsset,
  selected: boolean,
): RuntimeRoadOverlayFeature | null {
  const laneType = normalizeRuntimeLaneType(segment.lane_type);
  const ring = runtimeSegmentRing(segment, asset, laneType);
  if (!ring) return null;

  // Keep the width-aware Polygon as the hover/click target. Carry the exact
  // projected CARLA centerline in properties so the renderer can show a
  // connected path and `runtimeLaneSelectionFromFeature` can recover the
  // nearest point and spawn fraction from the same feature.
  const centerline = segment.centerline
    .map((point) => runtimeToLonLat(point.x, point.y, asset))
    .filter((coordinate): coordinate is [number, number] => coordinate !== null);
  const successorRsls = (segment.successors ?? [])
    .map(waypointRsl)
    .filter((rsl): rsl is string => rsl !== null);

  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [ring],
    },
    properties: {
      road_id: String(segment.road_id),
      label: `Road ${segment.road_id} lane ${segment.lane_id}`,
      feature_kind: "lane_centerline",
      lane_type: laneType,
      section_id: segment.section_id,
      lane_id: segment.lane_id,
      boundary_kind: null,
      runtime_bound: segment.runtime_bound !== false,
      is_junction: segment.is_junction,
      travel_increases_s: travelIncreasesS(segment),
      lane_change: segment.lane_change ?? null,
      lane_width: segment.lane_width ?? null,
      has_successor: successorRsls.length > 0,
      successor_count: successorRsls.length,
      predecessor_count: segment.predecessors?.length ?? 0,
      successor_rsls: successorRsls,
      left_lane_rsl: waypointRsl(segment.left_lane),
      right_lane_rsl: waypointRsl(segment.right_lane),
      turn_relations: (segment.turn_options ?? []).map((option) => option.relation),
      source: "runtime",
      dashed: false,
      is_selected: selected,
      centerline,
    },
  };
}

export function buildRuntimeRoadOverlay(
  asset: MapAsset,
  runtime: RuntimeMapResponse | null,
  selectedLocation: MapLocation | null,
): EditorRuntimeRoadOverlay | null {
  if (!runtime?.road_segments?.length) return null;

  const selectedIds = new Set(selectedLocation?.road_ids ?? []);
  const features: RuntimeRoadOverlayFeature[] = [];

  for (const segment of runtime.road_segments) {
    const roadId = String(segment.road_id);
    const feature = runtimeSegmentToFeature(segment, asset, selectedIds.has(roadId));
    if (feature) features.push(feature);
  }

  if (features.length === 0) return null;

  return {
    data: {
      type: "FeatureCollection",
      features,
    },
    selected_road_ids: [...selectedIds],
    current_location_id: selectedLocation?.id ?? null,
  };
}

/**
 * Build a compact exact-centerline overlay for large runtime viewports.
 *
 * A width ribbon repeats every centerline point three times (left edge, right
 * edge, and the centerline property). LineStrings retain the exact CARLA lane
 * identity and spawn fraction while keeping the complete road network small
 * enough to load at whole-map zoom.
 */
export function buildRuntimeRoadCenterlineOnlyOverlay(
  asset: MapAsset,
  runtime: RuntimeMapResponse | null,
  selectedLocation: MapLocation | null,
): EditorRuntimeRoadOverlay | null {
  if (!runtime?.road_segments?.length) return null;

  const selectedIds = new Set(selectedLocation?.road_ids ?? []);
  const features = runtime.road_segments.flatMap(
    (segment): RuntimeRoadOverlayFeature[] => {
      const feature = runtimeSegmentToFeature(
        segment,
        asset,
        selectedIds.has(String(segment.road_id)),
      );
      const centerline = feature?.properties.centerline;
      if (!feature || !centerline || centerline.length < 2) return [];
      const properties = { ...feature.properties };
      delete properties.centerline;
      // Whole-map centerline responses can contain millions of coordinate
      // scalars. Seven decimal places retain centimetre-scale geographic
      // precision while preventing harmless projection noise from dominating
      // the authoring payload.
      const compactCenterline = centerline.map(
        ([longitude, latitude]): [number, number] => [
          Number(longitude.toFixed(7)),
          Number(latitude.toFixed(7)),
        ],
      );
      return [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: compactCenterline },
          properties,
        },
      ];
    },
  );
  if (features.length === 0) return null;

  return {
    data: { type: "FeatureCollection", features },
    selected_road_ids: [...selectedIds],
    current_location_id: selectedLocation?.id ?? null,
  };
}

/** Build the visible connected lane paths from width-aware runtime polygons. */
export function buildRuntimeRoadCenterlineOverlay(
  data: RuntimeRoadOverlayCollection,
): RuntimeRoadOverlayCollection {
  return {
    type: "FeatureCollection",
    features: data.features.flatMap((feature): RuntimeRoadOverlayFeature[] => {
      if (feature.properties.feature_kind !== "lane_centerline") return [];
      const coordinates = feature.geometry.type === "LineString"
        ? feature.geometry.coordinates
        : feature.properties.centerline;
      if (
        !coordinates ||
        coordinates.length < 2 ||
        coordinates.some(
          (coordinate) =>
            coordinate.length < 2 ||
            !Number.isFinite(coordinate[0]) ||
            !Number.isFinite(coordinate[1]),
        )
      ) {
        return [];
      }
      return [{
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: feature.properties,
      }];
    }),
  };
}
