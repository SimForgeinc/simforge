import { Layer, Source } from "react-map-gl/maplibre";

type BehaviorTriggerLayersProps = {
  /**
   * FeatureCollection from `buildBehaviorTriggerOverlay`, discriminated by
   * `properties.role`:
   *   - `reach-ring`: LineString ring of the trigger radius around its point
   *   - `reach-center`: Point at the trigger's target
   *   - `link-line`: LineString from the clip's actor to the actor it measures
   *   - `link-label`: Point at that line's midpoint carrying the threshold text
   *
   * Every feature carries `properties.color` — the owning actor's accent, so a
   * trigger reads as belonging to the lane it was authored on.
   */
  data: object;
};

/**
 * Trigger geometry for the selected behavior clip (plan 4.2).
 *
 * Deliberately quiet: dashed strokes at reduced opacity, no fills, no halos
 * beyond what keeps the threshold label legible. This is an explanation of a
 * clip the author already selected, not a thing to be found on the map — the
 * actors, routes and paths underneath must stay the primary read. Nothing
 * renders when no clip is selected, because the caller passes no data.
 */
export function BehaviorTriggerLayers({ data }: BehaviorTriggerLayersProps) {
  return (
    <Source id="behavior-triggers" type="geojson" data={data as never}>
      <Layer
        id="behavior-trigger-reach-ring"
        type="line"
        filter={["==", ["get", "role"], "reach-ring"] as never}
        paint={{
          "line-color": ["get", "color"] as never,
          "line-width": 1.5,
          "line-opacity": 0.55,
          "line-dasharray": [3, 3],
        }}
      />
      <Layer
        id="behavior-trigger-reach-center"
        type="circle"
        filter={["==", ["get", "role"], "reach-center"] as never}
        paint={{
          "circle-radius": 3,
          "circle-color": ["get", "color"] as never,
          "circle-opacity": 0.6,
          "circle-stroke-color": "#0a0a0a",
          "circle-stroke-width": 1,
          "circle-stroke-opacity": 0.7,
        }}
      />
      <Layer
        id="behavior-trigger-link-line"
        type="line"
        filter={["==", ["get", "role"], "link-line"] as never}
        layout={{ "line-cap": "round" }}
        paint={{
          "line-color": ["get", "color"] as never,
          "line-width": 1.5,
          "line-opacity": 0.5,
          "line-dasharray": [2, 3],
        }}
      />
      <Layer
        id="behavior-trigger-link-label"
        type="symbol"
        filter={["==", ["get", "role"], "link-label"] as never}
        layout={{
          "text-field": ["get", "label"],
          "text-size": 10,
          "text-anchor": "center",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        }}
        paint={{
          "text-color": ["get", "color"] as never,
          "text-halo-color": "#0a0a0a",
          "text-halo-width": 1.5,
          "text-opacity": 0.85,
        }}
      />
    </Source>
  );
}
