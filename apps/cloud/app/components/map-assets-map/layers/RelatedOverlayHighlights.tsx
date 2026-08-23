import { Layer, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";

type RelatedOverlayHighlightsProps = {
  data: object;
};

/**
 * Render a subtle dashed ring at every overlay-backed related POI. Used when a
 * spatial-search result is focused and the user should see which neighbors
 * matched the relation — without stealing attention from the primary subject.
 */
export function RelatedOverlayHighlights({ data }: RelatedOverlayHighlightsProps) {
  return (
    <Source id="related-overlay-highlights" type="geojson" data={data as never}>
      <Layer
        id="related-overlay-highlights-ring"
        type="circle"
        paint={{
          "circle-radius": 11,
          "circle-color": "transparent",
          "circle-stroke-width": 2,
          "circle-stroke-color": C.related,
          "circle-stroke-opacity": 0.65,
        }}
      />
    </Source>
  );
}
