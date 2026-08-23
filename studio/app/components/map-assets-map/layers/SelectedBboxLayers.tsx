import { Layer, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";

/** Props for the SelectedBboxLayers component. */
type SelectedBboxLayersProps = {
  data: object;
  geojsonLoading: boolean;
};

/** Render a dashed bounding box overlay for the selected map asset. */
export function SelectedBboxLayers({ data, geojsonLoading }: SelectedBboxLayersProps) {
  return (
    <Source id="selected-bbox" type="geojson" data={data}>
      <Layer
        id="selected-bbox-fill"
        type="fill"
        paint={{ "fill-color": C.selected, "fill-opacity": 0.1 }}
      />
      <Layer
        id="selected-bbox-line"
        type="line"
        paint={{
          "line-color": C.selected,
          "line-width": 1.5,
          "line-dasharray": [4, 3],
          "line-opacity": geojsonLoading ? 0.5 : 0.7,
        }}
      />
    </Source>
  );
}
