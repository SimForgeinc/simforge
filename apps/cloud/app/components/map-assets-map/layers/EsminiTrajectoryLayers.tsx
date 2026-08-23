import { Layer, Source } from "react-map-gl/maplibre";

type EsminiTrajectoryLayersProps = {
  data: object;
};

/**
 * Actual (esmini-simulated) actor trajectories for the map-assets AI panel —
 * the ground-truth paths esmini drove when it ran the compiled OpenSCENARIO,
 * plus a marker at each reported collision. Distinct from the *planned*
 * `ActorTrajectoryLayers`: a dark casing under each colored line reads as
 * "measured", and collisions get a red dot so the reviewer can see where the
 * intended impact actually fired. Built by `buildEsminiTrajectoryGeoJSON`.
 */
export function EsminiTrajectoryLayers({ data }: EsminiTrajectoryLayersProps) {
  return (
    <Source id="esmini-trajectories" type="geojson" data={data as never}>
      <Layer
        id="esmini-trajectory-casing"
        type="line"
        filter={["==", ["get", "kind"], "esmini-line"] as never}
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{ "line-color": "#0b1120", "line-width": 6, "line-opacity": 0.85 }}
      />
      <Layer
        id="esmini-trajectory-line"
        type="line"
        filter={["==", ["get", "kind"], "esmini-line"] as never}
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": ["coalesce", ["get", "color"], "#f8fafc"] as never,
          "line-width": 3,
          "line-opacity": 0.95,
        }}
      />
      <Layer
        id="esmini-trajectory-start"
        type="circle"
        filter={["==", ["get", "kind"], "esmini-start"] as never}
        paint={{
          "circle-radius": 4,
          "circle-color": ["coalesce", ["get", "color"], "#f8fafc"] as never,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#0b1120",
        }}
      />
      <Layer
        id="esmini-trajectory-collision"
        type="circle"
        filter={["==", ["get", "kind"], "esmini-collision"] as never}
        paint={{
          "circle-radius": 7,
          "circle-color": "#ef4444",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#f8fafc",
        }}
      />
      <Layer
        id="esmini-trajectory-collision-label"
        type="symbol"
        filter={["==", ["get", "kind"], "esmini-collision"] as never}
        layout={{
          "text-field": ["get", "label"],
          "text-size": 11,
          "text-offset": [0, -1.3],
          "text-anchor": "bottom",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        }}
        paint={{
          "text-color": "#fecaca",
          "text-halo-color": "#0b1120",
          "text-halo-width": 1.5,
        }}
      />
    </Source>
  );
}
