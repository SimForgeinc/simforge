import { Layer, Source } from "react-map-gl/maplibre";

type TimedPointHighlightLayersProps = {
  /**
   * FeatureCollection from `buildTimedPointHighlightOverlay`: at most one Point
   * per drive-by-points actor, carrying `properties.color`.
   */
  data: object;
};

/**
 * The authored point the schedule is currently driving toward.
 *
 * Its own source rather than a property on the placement anchors, because it
 * changes with the playhead and the placement anchors change with the draft —
 * sharing a source would push a 20 Hz update through a collection sized by the
 * whole scene (plan 2026-07-25 §6.7).
 *
 * A ring rather than a fill: the authored marker underneath keeps its own
 * colour and stack rings, and this has to read as "the car is heading here"
 * without hiding any of that.
 */
export function TimedPointHighlightLayers({ data }: TimedPointHighlightLayersProps) {
  return (
    <Source id="timed-point-highlight" type="geojson" data={data as never}>
      <Layer
        id="timed-point-highlight-ring"
        type="circle"
        paint={{
          "circle-radius": 11,
          "circle-color": "transparent",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": ["coalesce", ["get", "color"], "#f8fafc"] as never,
          "circle-stroke-opacity": 0.95,
        }}
      />
    </Source>
  );
}
