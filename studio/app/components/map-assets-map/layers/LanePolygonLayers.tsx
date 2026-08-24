import { Layer, Source } from "react-map-gl/maplibre";
import {
  ROAD_NETWORK_FEATURE_TYPES,
  type RoadNetworkFeatureTypeId,
} from "@/app/lib/maps/frontend/road-network-feature-types";
import { LANE_POLYGON_ID_PROP } from "@/app/lib/maps/frontend/lane-polygon-correlation";
import { C } from "../map-layer-constants";
import {
  getDefaultLayerStyle,
  type RoadNetworkLayerStyle,
} from "@/app/lib/scenario-editor/layer-styles";

/**
 * Fill color/opacity react to selection feature-state (mirrored onto the
 * `lane-polygons` source by `useGeoJsonFeatureState`) so clicking a filled lane
 * lights the whole area gold — matching the centerline's gold selection
 * highlight underneath.
 */
function fillColorExpr(base: string) {
  return [
    "case",
    ["boolean", ["feature-state", "selected"], false],
    C.selected,
    ["boolean", ["feature-state", "highlighted"], false],
    C.highlighted,
    base,
  ] as never;
}
function fillOpacityExpr(base: number) {
  return [
    "case",
    ["boolean", ["feature-state", "selected"], false],
    0.55,
    ["boolean", ["feature-state", "highlighted"], false],
    0.5,
    base,
  ] as never;
}

type RoadNetworkFeatureType = (typeof ROAD_NETWORK_FEATURE_TYPES)[number];

/**
 * Lane feature types rendered as filled areas. These are exactly the
 * `lanes_*` road-network types (driving, sidewalk, biking, …); lane
 * boundaries and gates keep their line rendering and are excluded here.
 */
const LANE_FEATURE_TYPES: RoadNetworkFeatureType[] = ROAD_NETWORK_FEATURE_TYPES.filter(
  (ft) => ft.geometryRendering === "line" && ft.id.startsWith("lanes_"),
);

function defaultRoadNetworkLayerStyle(
  ft: RoadNetworkFeatureType,
): RoadNetworkLayerStyle {
  return getDefaultLayerStyle({
    kind: "road-network",
    id: ft.id,
    label: ft.label,
  }) as RoadNetworkLayerStyle;
}

type LanePolygonLayersProps = {
  /** Lane-polygon sidecar FeatureCollection (filled lane areas from XODR widths). */
  data: object;
  enabledFeatureTypeIds: RoadNetworkFeatureTypeId[];
  styleOverrides?: Partial<Record<RoadNetworkFeatureTypeId, RoadNetworkLayerStyle>>;
  visible?: boolean;
};

/**
 * Render lanes as filled polygons reconstructed from the XODR `<width>`
 * polynomials (served as the `lane_polygons_geojson` sidecar). Replaces the
 * thin polyline centerline as the primary lane visualization in both the map
 * view and the scenario editor. Each lane type gets a fill keyed off the same
 * colour/opacity the polyline rendering used, plus a faint outline for edge
 * definition. Selection/hover/direction-arrow handling stays on the authored
 * road-network source (`GeoJsonFeatureLayers`).
 */
export function LanePolygonLayers({
  data,
  enabledFeatureTypeIds,
  styleOverrides = {},
  visible = true,
}: LanePolygonLayersProps) {
  return (
    <Source
      id="lane-polygons"
      type="geojson"
      data={data as never}
      promoteId={LANE_POLYGON_ID_PROP}
    >
      {LANE_FEATURE_TYPES.filter((ft) =>
        enabledFeatureTypeIds.includes(ft.id),
      ).flatMap((ft) => {
        const style = styleOverrides[ft.id] ?? defaultRoadNetworkLayerStyle(ft);
        return [
          <Layer
            key={`lane-poly-fill-${ft.id}`}
            id={`lane-polygon-fill-${ft.id}`}
            source="lane-polygons"
            type="fill"
            filter={ft.filter as never}
            layout={{ visibility: visible ? "visible" : "none" }}
            paint={{
              "fill-color": fillColorExpr(style.color),
              // Lane areas read best as a translucent wash; fall back to a
              // sensible default when the style has no explicit fill opacity.
              "fill-opacity": fillOpacityExpr(
                style.fillOpacity > 0 ? style.fillOpacity : 0.45,
              ),
            }}
          />,
          <Layer
            key={`lane-poly-outline-${ft.id}`}
            id={`lane-polygon-outline-${ft.id}`}
            source="lane-polygons"
            type="line"
            filter={ft.filter as never}
            layout={{ visibility: visible ? "visible" : "none" }}
            paint={{
              "line-color": style.color,
              "line-width": 1,
              "line-opacity": Math.min(style.lineOpacity, 0.6),
            }}
          />,
        ];
      })}
    </Source>
  );
}
