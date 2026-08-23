import { Layer, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";

type TopologyPathLayersProps = {
  /**
   * FeatureCollection built by the caller. Two feature roles:
   *   - `path`: LineString tracing subject → step1 → step2 → … → endpoint
   *     for one topology relation. One feature per visualized ref.
   *   - `step-landing`: Point at a path step the user has pinned for
   *     emphasis (debug-mode UI). Rendered as a screen-space ring so it
   *     stays legible at any zoom.
   *
   * Every feature carries `properties.highlight: boolean`. The line
   * thickens / brightens when true; the landing ring grows.
   */
  data: object;
};

/**
 * On-map visualization for `leads_to` / `connected_to` / `upstream_of` /
 * `downstream_of` results. Draws the actual graph route as a line and drops
 * ▶ markers along it at fixed pixel spacing so the direction of travel is
 * unambiguous. Sits above the dashed proximity arrows used by spatial
 * relations — those handle the "subject → neighbor" straight-shot case;
 * this layer is for multi-hop topology where the geometry of the route
 * itself is the explanation.
 */
export function TopologyPathLayers({ data }: TopologyPathLayersProps) {
  const isHighlighted = ["==", ["get", "highlight"], true] as never;
  return (
    <Source id="topology-paths" type="geojson" data={data as never}>
      <Layer
        id="topology-paths-line"
        type="line"
        filter={["==", ["get", "role"], "path"] as never}
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": C.related,
          "line-width": ["case", isHighlighted, 4, 2.25] as never,
          "line-opacity": ["case", isHighlighted, 0.95, 0.7] as never,
        }}
      />
      <Layer
        id="topology-paths-arrows"
        type="symbol"
        filter={["==", ["get", "role"], "path"] as never}
        layout={{
          "symbol-placement": "line",
          "symbol-spacing": 60,
          "text-field": "▶",
          "text-size": ["case", isHighlighted, 16, 12] as never,
          "text-keep-upright": false,
          "text-rotation-alignment": "map",
          "text-pitch-alignment": "viewport",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        }}
        paint={{
          "text-color": C.related,
          "text-opacity": ["case", isHighlighted, 1, 0.85] as never,
          "text-halo-color": "#0b1220",
          "text-halo-width": 1.2,
        }}
      />
      <Layer
        id="topology-paths-terminal-head"
        type="fill"
        filter={["==", ["get", "role"], "terminal-head"] as never}
        paint={{
          "fill-color": C.related,
          "fill-opacity": ["case", isHighlighted, 1, 0.9] as never,
        }}
      />
      <Layer
        id="topology-paths-terminal-head-outline"
        type="line"
        filter={["==", ["get", "role"], "terminal-head"] as never}
        paint={{
          "line-color": C.related,
          "line-width": ["case", isHighlighted, 1.5, 1] as never,
          "line-opacity": 1,
        }}
      />
      <Layer
        id="topology-paths-step-landing"
        type="circle"
        filter={["==", ["get", "role"], "step-landing"] as never}
        paint={{
          "circle-radius": 8,
          "circle-color": "transparent",
          "circle-stroke-color": C.related,
          "circle-stroke-width": 2.5,
          "circle-stroke-opacity": 1,
        }}
      />
    </Source>
  );
}
