import { Layer, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";

type ProximityArrowLayersProps = {
  /**
   * FeatureCollection built by the caller (`MapDetailPageClient`). Three
   * features per arrow, discriminated by `properties.role`:
   *   - `shaft`: LineString from subject to the arrowhead base
   *   - `head`: Polygon triangle sitting at the neighbor's centroid
   *   - `landing`: Point at the neighbor's centroid, rendered as a small
   *     screen-space ring so the arrow always terminates on *something*
   *     visible — even when the related-highlight resolver can't find a
   *     GeoJSON feature or overlay to light up for this particular ref.
   *
   * Drawn in geo-space for head + shaft (scale with the map as the user
   * zooms) and in screen-space for the landing ring (always legible).
   */
  data: object;
};

/**
 * Dashed arrows from the focused spatial-search result to its matched
 * neighbors. Rendered faded so the selected subject and its bright highlight
 * remain the primary read; the arrows are secondary context that answers
 * "why did this result come back?" without requiring a hover interaction.
 *
 * Each feature carries `properties.highlight` (boolean). When the user
 * pins a specific related ref or topology path step from the search panel,
 * the corresponding arrow renders thicker and brighter, and its landing
 * ring grows — so the picked target is unambiguous against the default
 * faded arrows.
 */
export function ProximityArrowLayers({ data }: ProximityArrowLayersProps) {
  const isHighlighted = ["==", ["get", "highlight"], true] as never;
  return (
    <Source id="proximity-arrows" type="geojson" data={data as never}>
      <Layer
        id="proximity-arrows-shaft"
        type="line"
        filter={["==", ["get", "role"], "shaft"] as never}
        paint={{
          "line-color": C.related,
          "line-width": ["case", isHighlighted, 3.5, 1.5] as never,
          "line-opacity": ["case", isHighlighted, 0.95, 0.55] as never,
          "line-dasharray": [2, 2],
        }}
      />
      <Layer
        id="proximity-arrows-head"
        type="fill"
        filter={["==", ["get", "role"], "head"] as never}
        paint={{
          "fill-color": C.related,
          "fill-opacity": ["case", isHighlighted, 1, 0.85] as never,
        }}
      />
      <Layer
        id="proximity-arrows-head-outline"
        type="line"
        filter={["==", ["get", "role"], "head"] as never}
        paint={{
          "line-color": C.related,
          "line-width": ["case", isHighlighted, 2, 1] as never,
          "line-opacity": ["case", isHighlighted, 1, 0.9] as never,
        }}
      />
      <Layer
        id="proximity-arrows-landing"
        type="circle"
        filter={["==", ["get", "role"], "landing"] as never}
        paint={{
          "circle-radius": ["case", isHighlighted, 8, 4] as never,
          "circle-color": "transparent",
          "circle-stroke-color": C.related,
          "circle-stroke-width": ["case", isHighlighted, 2.5, 1.5] as never,
          "circle-stroke-opacity": ["case", isHighlighted, 1, 0.7] as never,
        }}
      />
    </Source>
  );
}
