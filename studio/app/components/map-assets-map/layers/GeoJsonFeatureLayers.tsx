import { Layer, Source } from "react-map-gl/maplibre";
import {
  ROAD_NETWORK_FEATURE_TYPES,
  type RoadNetworkFeatureTypeId,
} from "@/app/lib/maps/frontend/road-network-feature-types";
import { GEOJSON_FEATURE_ID_PROP } from "@/app/lib/maps/frontend/feature-inspection-types";
import { C } from "../map-layer-constants";
import {
  LANE_CHIP_ICON,
  LANE_DIR_ARROW_ICON,
  LANE_DIR_ARROW_BI_ICON,
} from "../map-icons";
import {
  getDefaultLayerStyle,
  type RoadNetworkLayerStyle,
} from "@/app/lib/scenario-editor/layer-styles";

type RoadNetworkFeatureType = (typeof ROAD_NETWORK_FEATURE_TYPES)[number];

// Polyline chips: a round P / bike / pedestrian glyph stamped along a lane so a
// user can tell a parking, bike, or sidewalk lane apart at a glance. They fade
// in once the user has zoomed in enough to read individual lanes, and a wide
// spacing + `icon-allow-overlap: false` keeps long runs sparse and uncluttered.
const CHIP_SIZE = ["interpolate", ["linear"], ["zoom"], 13, 0.5, 17, 0.8];
const CHIP_OPACITY = ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 0.95];
const CHIP_SPACING = ["interpolate", ["linear"], ["zoom"], 13, 220, 17, 440];

// ---------------------------------------------------------------------------
// Paint expression helpers — four-tier: selected > highlighted > related > default
// ---------------------------------------------------------------------------

/** Color expression: selected → gold, highlighted → sky-blue, related → muted blue, default → given. */
function colorExpr(defaultColor: string) {
  return [
    "case",
    ["boolean", ["feature-state", "selected"], false],
    C.selected,
    ["boolean", ["feature-state", "highlighted"], false],
    C.highlighted,
    ["boolean", ["feature-state", "related"], false],
    C.related,
    defaultColor,
  ] as never;
}

/** Numeric expression with four tiers. `related` inherits the default value. */
function numExpr(selected: number, highlighted: number, defaultVal: number) {
  return [
    "case",
    ["boolean", ["feature-state", "selected"], false],
    selected,
    ["boolean", ["feature-state", "highlighted"], false],
    highlighted,
    ["boolean", ["feature-state", "related"], false],
    defaultVal,
    defaultVal,
  ] as never;
}

function defaultRoadNetworkLayerStyle(
  ft: RoadNetworkFeatureType,
): RoadNetworkLayerStyle {
  return getDefaultLayerStyle({
    kind: "road-network",
    id: ft.id,
    label: ft.label,
  }) as RoadNetworkLayerStyle;
}

/**
 * Opacity expression for lane centerlines when lanes are rendered as filled
 * polygons instead: the stripe is hidden (opacity 0) but the layer stays on the
 * map as a hit-target. The `selected` tier is deliberately NOT shown — a click
 * is highlighted on the filled polygon itself (one lane `__mapId` can span
 * several polygons, so a centerline highlight would draw a stray stub at a
 * junction). The `highlighted` tier stays visible so search/locate still draws
 * a gold line over the fill.
 */
const SUPPRESSED_LANE_LINE_OPACITY = [
  "case",
  ["boolean", ["feature-state", "highlighted"], false],
  1,
  0,
] as never;

/** Props for the GeoJsonFeatureLayers component. */
type GeoJsonFeatureLayersProps = {
  data: object;
  enabledFeatureTypeIds: RoadNetworkFeatureTypeId[];
  showLineChips?: boolean;
  styleOverrides?: Partial<Record<RoadNetworkFeatureTypeId, RoadNetworkLayerStyle>>;
  visible?: boolean;
  /**
   * When true, lane centerlines (the `lanes_*` types) are not drawn as visible
   * stripes — `LanePolygonLayers` renders the filled lane areas instead. The
   * line layer is kept (transparent) for click/hover hit-testing and selection
   * highlighting. Lane boundaries and gates are unaffected.
   */
  renderLanesAsPolygons?: boolean;
};

/** Render road network feature layers with selection/highlight styling and direction arrows. */
export function GeoJsonFeatureLayers({
  data,
  enabledFeatureTypeIds,
  showLineChips = false,
  styleOverrides = {},
  visible = true,
  renderLanesAsPolygons = false,
}: GeoJsonFeatureLayersProps) {
  return (
    <Source
      id="selected-geojson"
      type="geojson"
      data={data as never}
      promoteId={GEOJSON_FEATURE_ID_PROP}
    >
      {ROAD_NETWORK_FEATURE_TYPES.filter((ft) =>
        enabledFeatureTypeIds.includes(ft.id),
      ).flatMap((ft) => {
        const style = styleOverrides[ft.id] ?? defaultRoadNetworkLayerStyle(ft);
        return ft.geometryRendering === "fill"
          ? [
              <Layer
                key={`fill-${ft.id}`}
                id={`geojson-fill-${ft.id}`}
                source="selected-geojson"
                type="fill"
                filter={ft.filter as never}
                layout={{ visibility: visible ? "visible" : "none" }}
                paint={{
                  "fill-color": colorExpr(style.color),
                  "fill-opacity": numExpr(0.5, 0.45, style.fillOpacity),
                }}
              />,
              <Layer
                key={`outline-${ft.id}`}
                id={`geojson-outline-${ft.id}`}
                source="selected-geojson"
                type="line"
                filter={ft.filter as never}
                layout={{ visibility: visible ? "visible" : "none" }}
                paint={{
                  "line-color": colorExpr(style.color),
                  "line-width": numExpr(5, 5, style.lineWidth),
                  "line-opacity": numExpr(1, 1, style.lineOpacity),
                }}
              />,
            ]
          : [
              <Layer
                key={ft.id}
                id={`geojson-line-${ft.id}`}
                source="selected-geojson"
                type="line"
                filter={ft.filter as never}
                layout={{ visibility: visible ? "visible" : "none" }}
                paint={{
                  "line-color": colorExpr(style.color),
                  "line-width": numExpr(
                    ft.id === "lane_boundaries" ? 4 : 7,
                    ft.id === "lane_boundaries" ? 4 : 6,
                    style.lineWidth,
                  ),
                  // When lanes render as polygons, hide the stripe (keep the
                  // layer for hit-testing + selection highlight). Lane
                  // boundaries are not lanes_* so they stay visible.
                  "line-opacity":
                    renderLanesAsPolygons && ft.id.startsWith("lanes_")
                      ? SUPPRESSED_LANE_LINE_OPACITY
                      : numExpr(1, 1, style.lineOpacity),
                }}
              />,
            ];
      })}
      {/* Direction arrows for lane types — TravelDir drives the glyph */}
      {ROAD_NETWORK_FEATURE_TYPES.filter(
        (ft) =>
          ft.geometryRendering === "line" &&
          ft.id !== "lane_boundaries" &&
          enabledFeatureTypeIds.includes(ft.id),
      ).map((ft) => {
        const baseFilter = ft.filter as unknown[];
        const conditions = baseFilter[0] === "all" ? baseFilter.slice(1) : [baseFilter];
        return (
          <Layer
            key={`arrows-${ft.id}`}
            id={`geojson-arrows-${ft.id}`}
            source="selected-geojson"
            type="symbol"
            filter={[
              "all",
              ...conditions,
              ["in", ["get", "TravelDir"], ["literal", ["Forward", "Backward", "Bidirectional"]]],
            ] as never}
            layout={{
              "symbol-placement": "line",
              "symbol-spacing": 110,
              visibility: visible ? "visible" : "none",
              // Small white triangle (dark outline) stamped along the lane.
              // Forward = the line-aligned right-pointing triangle, Backward
              // rotates it 180°, Bidirectional uses the double-headed variant.
              "icon-image": [
                "match",
                ["get", "TravelDir"],
                "Bidirectional", LANE_DIR_ARROW_BI_ICON,
                LANE_DIR_ARROW_ICON,
              ],
              "icon-rotate": ["match", ["get", "TravelDir"], "Backward", 180, 0],
              "icon-rotation-alignment": "map",
              "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.34, 17, 0.52, 19, 0.62],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            } as never}
            paint={{
              "icon-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 0.85, 16, 0.95] as never,
            }}
          />
        );
      })}
      {/* Polyline asset chips — round glyph markers placed along parking, bike,
          and sidewalk lanes so users can identify them without a label. */}
      {showLineChips
        ? ROAD_NETWORK_FEATURE_TYPES.filter(
            (ft) =>
              LANE_CHIP_ICON[ft.id] !== undefined &&
              enabledFeatureTypeIds.includes(ft.id),
          ).map((ft) => (
            <Layer
              key={`chip-${ft.id}`}
              id={`geojson-chip-${ft.id}`}
              source="selected-geojson"
              type="symbol"
              minzoom={13}
              filter={ft.filter as never}
              layout={{
                "symbol-placement": "line",
                "symbol-spacing": CHIP_SPACING as never,
                visibility: visible ? "visible" : "none",
                "icon-image": LANE_CHIP_ICON[ft.id]!,
                "icon-size": CHIP_SIZE as never,
                "icon-rotation-alignment": "viewport",
                "icon-allow-overlap": false,
                "icon-ignore-placement": false,
                "icon-optional": true,
              }}
              paint={{ "icon-opacity": CHIP_OPACITY as never }}
            />
          ))
        : null}
      {/* Turn relation symbols on Gate features */}
      {enabledFeatureTypeIds.includes("gates") && (
        <Layer
          id="geojson-turn-symbols-gates"
          source="selected-geojson"
          type="symbol"
          filter={["==", ["get", "Type"], "Gate"] as never}
          layout={{
            "symbol-placement": "line-center",
            visibility: visible ? "visible" : "none",
            "text-field": [
              "match",
              ["get", "TurnRelation"],
              "Straight", "^",
              "Left", "<",
              "Right", ">",
              "UTurnLeft", "<<",
              "UTurnRight", ">>",
              "",
            ],
            "text-size": ["interpolate", ["linear"], ["zoom"], 14, 6, 16, 8, 18, 10],
            "text-keep-upright": false,
            "text-rotation-alignment": "map",
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          }}
          paint={{
            "text-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              "#000000",
              ["boolean", ["feature-state", "highlighted"], false],
              "#000000",
              "#ffffff",
            ],
            "text-halo-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              C.selected,
              ["boolean", ["feature-state", "highlighted"], false],
              C.highlighted,
              "#cab2d6",
            ],
            "text-halo-width": 2,
            "text-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 0.5, 16, 0.9],
          }}
        />
      )}
    </Source>
  );
}
