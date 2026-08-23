import { Layer, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";

/** Props for the AssetClusterLayers component. */
type AssetClusterLayersProps = {
  data: object;
  selectedAssetId: string | null;
};

/** Render clustered and unclustered map asset point markers. */
export function AssetClusterLayers({ data, selectedAssetId }: AssetClusterLayersProps) {
  return (
    <Source
      id="map-assets-points"
      type="geojson"
      data={data}
      cluster={true}
      clusterRadius={50}
      clusterMaxZoom={14}
    >
      <Layer
        id="map-assets-clusters"
        type="circle"
        filter={["has", "point_count"]}
        paint={{
          "circle-radius": ["step", ["get", "point_count"], 12, 2, 16, 5, 20, 10, 24],
          "circle-color": C.fg,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": C.card,
          "circle-opacity": 0.92,
        }}
      />
      <Layer
        id="map-assets-cluster-count"
        type="symbol"
        filter={["has", "point_count"]}
        layout={{
          "text-field": ["to-string", ["get", "point_count"]],
          "text-size": 12,
          "text-anchor": "center",
          "text-justify": "center",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        }}
        paint={{
          "text-color": C.bg,
          "text-halo-color": C.fg,
          "text-halo-width": 0,
        }}
      />
      <Layer
        id="map-assets-unclustered"
        type="circle"
        filter={
          selectedAssetId
            ? ["all", ["!", ["has", "point_count"]], ["!=", ["get", "map_asset_id"], selectedAssetId]]
            : ["!", ["has", "point_count"]]
        }
        paint={{
          "circle-radius": 9,
          "circle-color": C.fg,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": C.card,
          "circle-opacity": 0.92,
        }}
      />
    </Source>
  );
}
