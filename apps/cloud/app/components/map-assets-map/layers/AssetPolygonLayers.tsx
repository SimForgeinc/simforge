import { Layer, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";

/** Props for the AssetPolygonLayers component. */
type AssetPolygonLayersProps = {
  data: object;
  selectedAssetId: string | null;
  hasSelectedGeoJSON: boolean;
};

/** Render fill and outline layers for map asset polygon geometries. */
export function AssetPolygonLayers({ data, selectedAssetId, hasSelectedGeoJSON }: AssetPolygonLayersProps) {
  return (
    <Source id="map-assets-polygons" type="geojson" data={data}>
      <Layer
        id="map-assets-fill"
        type="fill"
        filter={selectedAssetId ? ["!=", ["get", "map_asset_id"], selectedAssetId] : ["all"]}
        paint={{ "fill-color": C.fg, "fill-opacity": hasSelectedGeoJSON ? 0 : 0.07 }}
      />
      <Layer
        id="map-assets-line"
        type="line"
        filter={selectedAssetId ? ["!=", ["get", "map_asset_id"], selectedAssetId] : ["all"]}
        paint={{ "line-color": C.fg, "line-width": 1.5, "line-opacity": hasSelectedGeoJSON ? 0 : 0.5 }}
      />
    </Source>
  );
}
