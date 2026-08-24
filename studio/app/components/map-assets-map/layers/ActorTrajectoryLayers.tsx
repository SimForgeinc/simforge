import { Layer, Source } from "react-map-gl/maplibre";

type ActorTrajectoryLayersProps = {
  data: object;
};

/**
 * Planned actor trajectories for an AI-proposed scenario draft, shown on the
 * map-assets panel. Solid per-actor LineStrings (distinct from the dashed
 * placement-anchor / proximity overlays) with a start dot, so the user can
 * see where each actor will go before opening the editor or running a sim.
 */
export function ActorTrajectoryLayers({ data }: ActorTrajectoryLayersProps) {
  return (
    <Source id="actor-trajectories" type="geojson" data={data as never}>
      <Layer
        id="actor-trajectory-line"
        type="line"
        filter={["==", ["geometry-type"], "LineString"] as never}
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": ["coalesce", ["get", "color"], "#22d3ee"] as never,
          "line-width": 3,
          "line-opacity": ["coalesce", ["get", "opacity"], 0.9] as never,
        }}
      />
      <Layer
        id="actor-trajectory-start"
        type="circle"
        filter={["==", ["geometry-type"], "Point"] as never}
        paint={{
          "circle-radius": 5,
          "circle-color": ["coalesce", ["get", "color"], "#22d3ee"] as never,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#0b1120",
          "circle-opacity": ["coalesce", ["get", "opacity"], 0.95] as never,
        }}
      />
      <Layer
        id="actor-trajectory-heading"
        type="fill"
        filter={["==", ["geometry-type"], "Polygon"] as never}
        paint={{
          // Filled arrowhead (geometry, not a glyph — self-hosted fonts
          // lack arrow codepoints) showing the spawn heading.
          "fill-color": ["coalesce", ["get", "color"], "#22d3ee"] as never,
          "fill-opacity": ["coalesce", ["get", "opacity"], 0.95] as never,
        }}
      />
      <Layer
        id="actor-trajectory-heading-outline"
        type="line"
        filter={["==", ["geometry-type"], "Polygon"] as never}
        paint={{
          "line-color": "#0b1120",
          "line-width": 1,
          "line-opacity": ["coalesce", ["get", "opacity"], 0.9] as never,
        }}
      />
      <Layer
        id="actor-trajectory-label"
        type="symbol"
        filter={["==", ["geometry-type"], "Point"] as never}
        layout={{
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [0, -1.3],
          "text-anchor": "bottom",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        }}
        paint={{
          "text-color": "#f8fafc",
          "text-halo-color": "#0b1120",
          "text-halo-width": 1.5,
          "text-opacity": ["coalesce", ["get", "opacity"], 1] as never,
        }}
      />
    </Source>
  );
}
