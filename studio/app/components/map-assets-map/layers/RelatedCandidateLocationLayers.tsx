import { Layer, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";

type RelatedCandidateLocationLayersProps = {
  data: object;
};

/**
 * Render dashed polygon outlines for candidate-backed related objects when a
 * spatial-search result is focused. Uses the same muted blue as the rest of
 * the "related" tier so the primary selected candidate (bright orange) stays
 * visually dominant.
 */
export function RelatedCandidateLocationLayers({
  data,
}: RelatedCandidateLocationLayersProps) {
  return (
    <Source id="related-candidate-locations" type="geojson" data={data as never}>
      <Layer
        id="related-candidate-locations-fill"
        type="fill"
        paint={{
          "fill-color": C.related,
          "fill-opacity": 0.08,
        }}
      />
      <Layer
        id="related-candidate-locations-line"
        type="line"
        paint={{
          "line-color": C.related,
          "line-width": 1.5,
          "line-opacity": 0.7,
          "line-dasharray": [2, 2],
        }}
      />
    </Source>
  );
}
