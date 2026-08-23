import { Layer, Source } from "react-map-gl/maplibre";

/**
 * Exact CARLA runtime geometry rendered as a neutral, display-only road shell.
 *
 * The source is the already-loaded, content-pinned runtime bundle. It includes
 * every runtime lane polygon (including junction connectors) but deliberately
 * exposes no hit layer: semantic features own authoring interaction and compile
 * back to the exact runtime lane/station identities represented here.
 */
export function RuntimeGeometryShellLayers({
  data,
  visible = true,
}: {
  data: object;
  visible?: boolean;
}) {
  const visibility = visible ? "visible" : "none";
  const laneFilter = [
    "==",
    ["get", "feature_kind"],
    "lane_centerline",
  ] as never;
  const junctionFilter = [
    "all",
    ["==", ["get", "feature_kind"], "lane_centerline"],
    ["==", ["get", "is_junction"], true],
  ] as never;

  return (
    <Source id="runtime-geometry-shell" type="geojson" data={data as never}>
      <Layer
        id="runtime-geometry-shell-surface"
        source="runtime-geometry-shell"
        type="fill"
        filter={laneFilter}
        paint={{
          "fill-color": [
            "match",
            ["get", "lane_type"],
            "sidewalk",
            "#202b3a",
            "parking",
            "#263244",
            "biking",
            "#203b3a",
            "#172033",
          ] as never,
          "fill-opacity": 0.78,
        }}
        layout={{ visibility }}
      />
      <Layer
        id="runtime-geometry-shell-junctions"
        source="runtime-geometry-shell"
        type="fill"
        filter={junctionFilter}
        paint={{
          "fill-color": "#334155",
          "fill-opacity": 0.5,
        }}
        layout={{ visibility }}
      />
      <Layer
        id="runtime-geometry-shell-outline"
        source="runtime-geometry-shell"
        type="line"
        filter={laneFilter}
        paint={{
          "line-color": "#cbd5e1",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            0.35,
            17,
            0.8,
            20,
            1.2,
          ] as never,
          "line-opacity": 0.28,
        }}
        layout={{ visibility }}
      />
    </Source>
  );
}
