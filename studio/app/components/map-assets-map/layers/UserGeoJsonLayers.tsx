import { Layer, Source } from "react-map-gl/maplibre";
import type { UserGeoJsonLayer } from "@/app/lib/maps/frontend/user-geojson-layers";
import { userGeoJsonSizes, userGeoJsonSourceId } from "@/app/lib/maps/frontend/user-geojson-layers";
import { C } from "../map-layer-constants";

/** Props for the UserGeoJsonLayers component. */
type UserGeoJsonLayersProps = {
  layers: UserGeoJsonLayer[];
};

// Features carry mixed geometry types, so — like the enrichment "GeoJSON"
// branch — stack four filtered layers on one source: Polygon → fill+outline,
// LineString → line, Point → circle. Each `match` covers the multi-variant too.
const POLYGON_FILTER: ["match", ["geometry-type"], string[], boolean, boolean] = [
  "match",
  ["geometry-type"],
  ["Polygon", "MultiPolygon"],
  true,
  false,
];
const LINE_FILTER: ["match", ["geometry-type"], string[], boolean, boolean] = [
  "match",
  ["geometry-type"],
  ["LineString", "MultiLineString"],
  true,
  false,
];
const POINT_FILTER: ["match", ["geometry-type"], string[], boolean, boolean] = [
  "match",
  ["geometry-type"],
  ["Point", "MultiPoint"],
  true,
  false,
];

/**
 * Render user-uploaded GeoJSON layers, each with its own color + opacity and a
 * per-layer visibility toggle. Promotes `__mapId` so per-feature querying (and
 * therefore the aggregate-click selection) resolves individual features.
 */
export function UserGeoJsonLayers({ layers }: UserGeoJsonLayersProps) {
  return (
    <>
      {layers.map((layer) => {
        const sourceId = userGeoJsonSourceId(layer.id);
        const visibility = layer.visible ? "visible" : "none";
        const outlineOpacity = Math.min(layer.opacity + 0.25, 1);
        const { pointRadius, lineWidth, polygonOutlineWidth } = userGeoJsonSizes(layer.thickness);
        return (
          <Source
            key={sourceId}
            id={sourceId}
            type="geojson"
            data={layer.data as never}
            promoteId="__mapId"
          >
            <Layer
              id={`${sourceId}-fill`}
              type="fill"
              filter={POLYGON_FILTER}
              layout={{ visibility }}
              paint={{ "fill-color": layer.color, "fill-opacity": layer.opacity * 0.6 }}
            />
            <Layer
              id={`${sourceId}-polygon-outline`}
              type="line"
              filter={POLYGON_FILTER}
              layout={{ visibility }}
              paint={{
                "line-color": layer.color,
                "line-width": polygonOutlineWidth,
                "line-opacity": outlineOpacity,
              }}
            />
            <Layer
              id={`${sourceId}-line`}
              type="line"
              filter={LINE_FILTER}
              layout={{ visibility }}
              paint={{ "line-color": layer.color, "line-width": lineWidth, "line-opacity": layer.opacity }}
            />
            <Layer
              id={`${sourceId}-circle`}
              type="circle"
              filter={POINT_FILTER}
              layout={{ visibility }}
              paint={{
                "circle-radius": pointRadius,
                "circle-color": layer.color,
                "circle-opacity": layer.opacity,
                "circle-stroke-width": 1,
                "circle-stroke-color": C.bg,
              }}
            />
          </Source>
        );
      })}
    </>
  );
}
