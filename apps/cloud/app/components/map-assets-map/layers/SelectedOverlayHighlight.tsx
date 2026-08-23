import { Layer, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";

/** Props for the SelectedOverlayHighlight component. */
type SelectedOverlayHighlightProps = {
  data: object;
};

// Selected-feature highlight emitted on the same source for any geometry type:
// circle ring for Points (legacy POI behavior), line outline for LineStrings,
// fill+outline for Polygons (crosswalks, junctions, Overture polygons). All
// three layers coexist — MapLibre filters out the geometries that don't match.
export function SelectedOverlayHighlight({ data }: SelectedOverlayHighlightProps) {
  return (
    <Source id="selected-overlay-highlight" type="geojson" data={data as never}>
      <Layer
        id="selected-overlay-highlight-ring"
        type="circle"
        filter={["==", ["geometry-type"], "Point"] as never}
        paint={{
          "circle-radius": 14,
          "circle-color": "transparent",
          "circle-stroke-width": 3,
          "circle-stroke-color": C.selected,
          "circle-stroke-opacity": 0.9,
        }}
      />
      <Layer
        id="selected-overlay-highlight-line"
        type="line"
        filter={["==", ["geometry-type"], "LineString"] as never}
        paint={{
          "line-color": C.selected,
          "line-width": 4,
          "line-opacity": 0.9,
        }}
      />
      <Layer
        id="selected-overlay-highlight-polygon-fill"
        type="fill"
        filter={[
          "any",
          ["==", ["geometry-type"], "Polygon"],
          ["==", ["geometry-type"], "MultiPolygon"],
        ] as never}
        paint={{
          "fill-color": C.selected,
          "fill-opacity": 0.2,
        }}
      />
      <Layer
        id="selected-overlay-highlight-polygon-outline"
        type="line"
        filter={[
          "any",
          ["==", ["geometry-type"], "Polygon"],
          ["==", ["geometry-type"], "MultiPolygon"],
        ] as never}
        paint={{
          "line-color": C.selected,
          "line-width": 3,
          "line-opacity": 0.95,
        }}
      />
    </Source>
  );
}
