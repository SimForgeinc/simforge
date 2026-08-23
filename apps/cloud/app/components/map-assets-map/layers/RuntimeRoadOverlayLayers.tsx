import { useMemo } from "react";
import { Layer, Source } from "react-map-gl/maplibre";
import type { RuntimeLaneSelection, RuntimeRoadOverlayCollection } from "@/app/lib/editor-map/types";
import { buildRuntimeRoadCenterlineOverlay } from "@/app/lib/editor-map/runtime-road-overlay";
import {
  ALL_RUNTIME_LANE_TYPE_IDS,
  normalizeRuntimeLaneType,
  type RuntimeLaneTypeId,
} from "@/app/lib/editor-map/runtime-layer-visibility";
import type { RuntimeLaneLayerStyle } from "@/app/lib/scenario-editor/layer-styles";

type RuntimeRoadOverlayLayersProps = {
  data: object;
  selectedRuntimeLane?: RuntimeLaneSelection | null;
  hoveredRuntimeLane?: RuntimeLaneSelection | null;
  highlightedRoadIds?: string[];
  showCenterlines?: boolean;
  showBoundaries?: boolean;
  showSurfaces?: boolean;
  enabledLaneTypeIds?: RuntimeLaneTypeId[];
  styleOverrides?: Partial<Record<RuntimeLaneTypeId, RuntimeLaneLayerStyle>>;
  visible?: boolean;
};

const BOUNDARY_LAYER_CONFIG = [
  {
    id: "runtime-boundary-edge-solid",
    kind: "edge" as const,
    dashed: false,
    color: "#cbd5e1",
    width: { base: 1.6, selected: 2.4 },
    opacity: { base: 0.6, selected: 0.95 },
  },
  {
    id: "runtime-boundary-edge-dashed",
    kind: "edge" as const,
    dashed: true,
    color: "#cbd5e1",
    width: { base: 1.6, selected: 2.4 },
    opacity: { base: 0.6, selected: 0.95 },
    dasharray: [1.2, 1.2] as [number, number],
  },
  {
    id: "runtime-boundary-divider-solid",
    kind: "divider" as const,
    dashed: false,
    color: "#f8fafc",
    width: { base: 1.3, selected: 2.1 },
    opacity: { base: 0.62, selected: 0.95 },
  },
  {
    id: "runtime-boundary-divider-dashed",
    kind: "divider" as const,
    dashed: true,
    color: "#f8fafc",
    width: { base: 1.3, selected: 2.1 },
    opacity: { base: 0.62, selected: 0.95 },
    dasharray: [1.3, 1.7] as [number, number],
  },
  {
    id: "runtime-boundary-center-solid",
    kind: "center" as const,
    dashed: false,
    color: "#fef08a",
    width: { base: 1.6, selected: 2.4 },
    opacity: { base: 0.72, selected: 1 },
  },
  {
    id: "runtime-boundary-center-dashed",
    kind: "center" as const,
    dashed: true,
    color: "#fef08a",
    width: { base: 1.6, selected: 2.4 },
    opacity: { base: 0.72, selected: 1 },
    dasharray: [1.1, 1.5] as [number, number],
  },
];

const CENTERLINE_LAYER_CONFIG = [
  {
    id: "runtime-lane-driving",
    laneType: "driving",
    color: "#38bdf8",
    opacity: { base: 0.96, selected: 1 },
  },
  {
    id: "runtime-lane-bidirectional",
    laneType: "bidirectional",
    color: "#f59e0b",
    opacity: { base: 0.96, selected: 1 },
  },
  {
    id: "runtime-lane-biking",
    laneType: "biking",
    color: "#22c55e",
    opacity: { base: 0.94, selected: 1 },
  },
  {
    id: "runtime-lane-sidewalk",
    laneType: "sidewalk",
    color: "#f8fafc",
    opacity: { base: 0.88, selected: 1 },
  },
  {
    id: "runtime-lane-parking",
    laneType: "parking",
    color: "#a78bfa",
    opacity: { base: 0.92, selected: 1 },
  },
  {
    id: "runtime-lane-shoulder",
    laneType: "shoulder",
    color: "#cbd5e1",
    opacity: { base: 0.82, selected: 0.95 },
  },
  {
    id: "runtime-lane-other",
    laneType: "other",
    color: "#f97316",
    opacity: { base: 0.9, selected: 1 },
  },
];

function selectedColor(defaultColor: string, selectedColorHex = "#facc15") {
  return [
    "case",
    ["==", ["get", "is_selected"], true],
    selectedColorHex,
    defaultColor,
  ] as never;
}

function selectedOpacity(defaultOpacity: number, selectedOpacityValue: number) {
  return [
    "case",
    ["==", ["get", "is_selected"], true],
    selectedOpacityValue,
    defaultOpacity,
  ] as never;
}

function selectedWidth(defaultWidth: number, highlightedWidth: number) {
  return [
    "case",
    ["==", ["get", "is_selected"], true],
    highlightedWidth,
    defaultWidth,
  ] as never;
}

function boundaryFilter(kind: "center" | "divider" | "edge", dashed: boolean) {
  return [
    "all",
    ["==", ["get", "feature_kind"], "lane_boundary"],
    ["==", ["get", "boundary_kind"], kind],
    ["==", ["get", "dashed"], dashed],
  ] as never;
}

function laneCenterlineFilter(laneType: string) {
  return [
    "all",
    ["==", ["get", "feature_kind"], "lane_centerline"],
    ["==", ["get", "lane_type"], laneType],
  ] as never;
}

function anyLaneCenterlineFilter(enabledLaneTypeIds: RuntimeLaneTypeId[]) {
  if (enabledLaneTypeIds.length === 0) {
    return ["==", ["get", "__lane_type_disabled__"], true] as never;
  }

  return [
    "all",
    ["==", ["get", "feature_kind"], "lane_centerline"],
    ["in", ["get", "lane_type"], ["literal", enabledLaneTypeIds]],
  ] as never;
}

function lineStringLaneFilter(enabledLaneTypeIds: RuntimeLaneTypeId[]) {
  return [
    "all",
    anyLaneCenterlineFilter(enabledLaneTypeIds),
    ["==", ["geometry-type"], "LineString"],
  ] as never;
}

function hoveredLaneFilter(
  hoveredRuntimeLane: RuntimeLaneSelection | null | undefined,
  enabledLaneTypeIds: RuntimeLaneTypeId[],
) {
  return laneSelectionFilter(hoveredRuntimeLane, enabledLaneTypeIds, "__hover_missing__");
}

function selectedLaneFilter(
  selectedRuntimeLane: RuntimeLaneSelection | null | undefined,
  enabledLaneTypeIds: RuntimeLaneTypeId[],
) {
  return laneSelectionFilter(selectedRuntimeLane, enabledLaneTypeIds, "__selected_missing__");
}

function highlightedRoadsFilter(highlightedRoadIds: string[], enabledLaneTypeIds: RuntimeLaneTypeId[]) {
  if (highlightedRoadIds.length === 0 || enabledLaneTypeIds.length === 0) {
    return ["==", ["get", "__highlight_missing__"], true] as never;
  }

  return [
    "all",
    ["==", ["get", "feature_kind"], "lane_centerline"],
    ["in", ["get", "road_id"], ["literal", highlightedRoadIds]],
    ["in", ["get", "lane_type"], ["literal", enabledLaneTypeIds]],
  ] as never;
}

function laneSelectionFilter(
  lane: RuntimeLaneSelection | null | undefined,
  enabledLaneTypeIds: RuntimeLaneTypeId[],
  missingKey: string,
) {
  if (!lane) {
    return ["==", ["get", missingKey], true] as never;
  }

  if (!enabledLaneTypeIds.includes(normalizeRuntimeLaneType(lane.lane_type))) {
    return ["==", ["get", missingKey], true] as never;
  }

  const filters: unknown[] = [
    "all",
    ["==", ["get", "feature_kind"], "lane_centerline"],
    ["==", ["get", "road_id"], lane.road_id],
  ];

  if (lane.section_id != null) {
    filters.push([
      "==",
      ["to-number", ["coalesce", ["get", "section_id"], -999999]],
      lane.section_id,
    ]);
  }

  if (lane.lane_id != null) {
    filters.push([
      "==",
      ["to-number", ["coalesce", ["get", "lane_id"], -999999]],
      lane.lane_id,
    ]);
  }

  return filters as never;
}

export function RuntimeRoadOverlayLayers({
  data,
  selectedRuntimeLane = null,
  hoveredRuntimeLane = null,
  highlightedRoadIds = [],
  showCenterlines = true,
  showBoundaries = true,
  showSurfaces = true,
  enabledLaneTypeIds = ALL_RUNTIME_LANE_TYPE_IDS,
  styleOverrides = {},
  visible = true,
}: RuntimeRoadOverlayLayersProps) {
  const centerlineData = useMemo(
    () => buildRuntimeRoadCenterlineOverlay(data as RuntimeRoadOverlayCollection),
    [data],
  );

  return (
    <>
      <Source id="runtime-road-overlay" type="geojson" data={data as never}>
        {showSurfaces ? (
          <Layer
            id="runtime-road-driving-surface"
            source="runtime-road-overlay"
            type="fill"
            filter={anyLaneCenterlineFilter(enabledLaneTypeIds)}
            paint={{
              "fill-color": selectedColor("#475569", "#78350f"),
              "fill-opacity": selectedOpacity(0.18, 0.3),
            }}
            layout={{ visibility: visible ? "visible" : "none" }}
          />
        ) : null}

        {showBoundaries
          ? BOUNDARY_LAYER_CONFIG.map((config) => (
              <Layer
                key={config.id}
                id={config.id}
                source="runtime-road-overlay"
                type="line"
                filter={boundaryFilter(config.kind, config.dashed)}
                paint={{
                  "line-color": selectedColor(config.color),
                  "line-width": selectedWidth(config.width.base, config.width.selected),
                  "line-opacity": selectedOpacity(config.opacity.base, config.opacity.selected),
                  ...(config.dasharray ? { "line-dasharray": config.dasharray } : {}),
                }}
                layout={{ visibility: visible ? "visible" : "none" }}
              />
            ))
          : null}

        {/* The CARLA-width ribbon is always retained as the interaction hit
            target, while the visible centerline is rendered from the exact
            topology polyline below. */}
        <Layer
          id="runtime-lane-hit-area"
          source="runtime-road-overlay"
          type="fill"
          filter={anyLaneCenterlineFilter(enabledLaneTypeIds)}
          paint={{ "fill-color": "#38bdf8", "fill-opacity": 0.01 }}
          layout={{ visibility: visible ? "visible" : "none" }}
        />

        <Layer
          id="runtime-lane-line-hit-area"
          source="runtime-road-overlay"
          type="line"
          filter={lineStringLaneFilter(enabledLaneTypeIds)}
          paint={{
            "line-color": "#38bdf8",
            "line-opacity": 0.01,
            "line-width": 14,
          }}
          layout={{ visibility: visible ? "visible" : "none" }}
        />

        <Layer
          id="runtime-road-overlay-highlighted-roads"
          source="runtime-road-overlay"
          type="fill"
          filter={highlightedRoadsFilter(highlightedRoadIds, enabledLaneTypeIds)}
          paint={{ "fill-color": "#facc15", "fill-opacity": 0.5 }}
          layout={{ visibility: visible ? "visible" : "none" }}
        />

        <Layer
          id="runtime-road-overlay-selected"
          source="runtime-road-overlay"
          type="fill"
          filter={selectedLaneFilter(selectedRuntimeLane, enabledLaneTypeIds)}
          paint={{ "fill-color": "#f59e0b", "fill-opacity": 0.6 }}
          layout={{ visibility: visible ? "visible" : "none" }}
        />

        <Layer
          id="runtime-road-overlay-hovered"
          source="runtime-road-overlay"
          type="fill"
          filter={hoveredLaneFilter(hoveredRuntimeLane, enabledLaneTypeIds)}
          paint={{ "fill-color": "#38bdf8", "fill-opacity": 0.5 }}
          layout={{ visibility: visible ? "visible" : "none" }}
        />

        <Layer
          id="runtime-road-overlay-line-selected"
          source="runtime-road-overlay"
          type="line"
          filter={[
            "all",
            selectedLaneFilter(selectedRuntimeLane, enabledLaneTypeIds),
            ["==", ["geometry-type"], "LineString"],
          ] as never}
          paint={{
            "line-color": "#f59e0b",
            "line-opacity": 1,
            "line-width": 6,
          }}
          layout={{ visibility: visible ? "visible" : "none" }}
        />

        <Layer
          id="runtime-road-overlay-line-hovered"
          source="runtime-road-overlay"
          type="line"
          filter={[
            "all",
            hoveredLaneFilter(hoveredRuntimeLane, enabledLaneTypeIds),
            ["==", ["geometry-type"], "LineString"],
          ] as never}
          paint={{
            "line-color": "#38bdf8",
            "line-opacity": 1,
            "line-width": 5,
          }}
          layout={{ visibility: visible ? "visible" : "none" }}
        />
      </Source>

      {showCenterlines && centerlineData.features.length > 0 ? (
        <Source
          id="runtime-road-centerlines"
          type="geojson"
          data={centerlineData as never}
        >
          {CENTERLINE_LAYER_CONFIG
            .filter((config) =>
              enabledLaneTypeIds.includes(config.laneType as RuntimeLaneTypeId),
            )
            .map((config) => (
              <Layer
                key={config.id}
                id={config.id}
                source="runtime-road-centerlines"
                type="line"
                filter={laneCenterlineFilter(config.laneType)}
                paint={{
                  "line-color": selectedColor(
                    styleOverrides[config.laneType as RuntimeLaneTypeId]?.color ?? config.color,
                  ),
                  "line-opacity": selectedOpacity(
                    styleOverrides[config.laneType as RuntimeLaneTypeId]?.opacity ??
                      config.opacity.base,
                    config.opacity.selected,
                  ),
                  "line-width": selectedWidth(2.2, 3.4),
                }}
                layout={{ visibility: visible ? "visible" : "none" }}
              />
            ))}
        </Source>
      ) : null}
    </>
  );
}
