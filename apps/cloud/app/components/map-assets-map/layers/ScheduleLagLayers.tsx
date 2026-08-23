import { Layer, Source } from "react-map-gl/maplibre";

type ScheduleLagLayersProps = {
  /**
   * FeatureCollection from `buildScheduleLagOverlay`: per drive-by-points actor
   * a `schedule-ghost` Point at the schedule's intended position and, when the
   * car is not there, a `schedule-tether` LineString joining the two. Both carry
   * `properties.color` and `properties.severity`.
   */
  data: object;
};

/**
 * Where the schedule says the car should be, versus where it is.
 *
 * The ghost is drawn SMALL, hollow and half-transparent on purpose: the car is
 * still the subject, and a ghost that competes with it would make every
 * drive-by-points scene read as two cars. The tether is the informative mark —
 * its length is the lateness, and its colour crosses from the actor's own hue
 * to amber and then red as the gap grows past what the schedule can absorb.
 *
 * Its own source rather than a property on the trajectory overlay: this changes
 * with the playhead (20 Hz) and that changes with the frame history (once per
 * re-sim), so sharing one would push a whole-scene rebuild through every frame.
 */
export function ScheduleLagLayers({ data }: ScheduleLagLayersProps) {
  return (
    <Source id="schedule-lag" type="geojson" data={data as never}>
      <Layer
        id="schedule-lag-tether"
        type="line"
        filter={["==", ["get", "kind"], "schedule-tether"] as never}
        layout={{ "line-cap": "round" }}
        paint={{
          "line-color": ["get", "color"] as never,
          "line-width": [
            "case",
            ["==", ["get", "severity"], "adrift"],
            2,
            1.25,
          ] as never,
          "line-opacity": 0.85,
          "line-dasharray": [1, 1.5],
        }}
      />
      <Layer
        id="schedule-lag-ghost"
        type="circle"
        filter={["==", ["get", "kind"], "schedule-ghost"] as never}
        paint={{
          "circle-radius": 4,
          "circle-color": ["get", "color"] as never,
          "circle-opacity": 0.28,
          "circle-stroke-width": 1,
          "circle-stroke-color": ["get", "color"] as never,
          "circle-stroke-opacity": 0.65,
        }}
      />
    </Source>
  );
}
