import { Layer, Source } from "react-map-gl/maplibre";

type PlacementBandLayersProps = {
  /**
   * FeatureCollection from `buildPlacementBandOverlay`: one ring Polygon whose
   * hole is the inner edge, carrying `properties.color`.
   */
  data: object;
};

/**
 * Where the next authored point can land and still be drivable.
 *
 * ONE shaded region and no outlines, by Michael's direct feedback on the live
 * build: the first cut drew the reachable set's two boundaries as dashed
 * circles, and what that read as was "two circles" — geometry to decode rather
 * than a place to click. A single translucent area says the only thing the
 * author needs, which is *click in here*.
 *
 * The unreachable middle stays a hole in that region rather than a second mark:
 * a car doing 20 m/s cannot put its next second's point two metres ahead, and
 * the shading has to stop where that becomes true.
 */
export function PlacementBandLayers({ data }: PlacementBandLayersProps) {
  return (
    <Source id="placement-band" type="geojson" data={data as never}>
      <Layer
        id="placement-band-fill"
        type="fill"
        paint={{
          // Slightly stronger than the outlined version carried, because the
          // fill is now the whole signal rather than backing for an edge.
          "fill-color": ["get", "color"] as never,
          "fill-opacity": 0.13,
        }}
      />
    </Source>
  );
}
