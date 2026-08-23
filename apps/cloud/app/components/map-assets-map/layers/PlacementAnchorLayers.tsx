import { Layer, Source } from "react-map-gl/maplibre";

type PlacementAnchorLayersProps = {
  data: object;
};

export function PlacementAnchorLayers({ data }: PlacementAnchorLayersProps) {
  return (
    <Source id="placement-anchors" type="geojson" data={data as never}>
      <Layer
        id="placement-anchor-fill"
        type="fill"
        filter={["==", ["geometry-type"], "Polygon"] as never}
        paint={{
          "fill-color": ["coalesce", ["get", "color"], "#facc15"] as never,
          "fill-opacity": ["coalesce", ["get", "opacity"], 0.18] as never,
        }}
      />
      <Layer
        id="placement-anchor-route-casing"
        type="line"
        filter={
          [
            "all",
            ["==", ["geometry-type"], "LineString"],
            ["==", ["get", "kind"], "route-line"],
          ] as never
        }
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": "#050607",
          "line-width": 9,
          "line-opacity": ["coalesce", ["get", "opacity"], 0.88] as never,
        }}
      />
      <Layer
        id="placement-anchor-line"
        type="line"
        filter={
          [
            "all",
            ["==", ["geometry-type"], "LineString"],
            ["!=", ["coalesce", ["get", "lane_resolution"], "chord"], "unresolved"],
          ] as never
        }
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": ["coalesce", ["get", "color"], "#facc15"] as never,
          "line-width": 5,
          "line-opacity": ["coalesce", ["get", "opacity"], 1] as never,
          "line-dasharray": [1.6, 1],
        }}
      />
      {/* An `unresolved` segment is lane-locked at both ends and got no lane
          path, so it is drawn as the straight chord it will actually be driven
          as. Its own layer because `line-dasharray` is not data-driven in
          MapLibre — the sparser dash is the only way the author can tell a line
          that follows the road from one that only claims to. */}
      <Layer
        id="placement-anchor-line-unresolved"
        type="line"
        filter={
          [
            "all",
            ["==", ["geometry-type"], "LineString"],
            ["==", ["get", "lane_resolution"], "unresolved"],
          ] as never
        }
        layout={{ "line-cap": "butt", "line-join": "round" }}
        paint={{
          "line-color": ["coalesce", ["get", "color"], "#facc15"] as never,
          "line-width": 5,
          "line-opacity": ["*", 0.75, ["coalesce", ["get", "opacity"], 1]] as never,
          "line-dasharray": [0.6, 1.4],
        }}
      />
      {/* Stack ring: one halo per extra point stacked on this marker, so a
          hold reads as width at a glance (plan 2026-07-25 §6.4). Drawn under
          the marker so the marker itself stays the same size. */}
      <Layer
        id="placement-anchor-stack-ring"
        type="circle"
        filter={
          [
            "all",
            ["==", ["geometry-type"], "Point"],
            [">", ["coalesce", ["get", "stack_count"], 1], 1],
          ] as never
        }
        paint={{
          "circle-radius": [
            "+",
            8,
            ["*", 3, ["-", ["coalesce", ["get", "stack_count"], 1], 1]],
          ] as never,
          "circle-color": ["coalesce", ["get", "color"], "#facc15"] as never,
          "circle-opacity": 0.18,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": ["coalesce", ["get", "color"], "#facc15"] as never,
          "circle-stroke-opacity": 0.7,
        }}
      />
      <Layer
        id="placement-anchor-circle"
        type="circle"
        filter={
          [
            "all",
            ["==", ["geometry-type"], "Point"],
            // Mid-segment implied-speed readouts are labels, not markers.
            ["!=", ["get", "kind"], "timed-path-speed"],
          ] as never
        }
        paint={{
          "circle-radius": 6,
          "circle-color": ["coalesce", ["get", "color"], "#facc15"] as never,
          // Freeform points are hollow, lane-locked ones filled (plan §6.5).
          "circle-opacity": [
            "case",
            ["==", ["get", "snap"], "free"],
            0.15,
            ["coalesce", ["get", "opacity"], 0.95],
          ] as never,
          "circle-stroke-width": 2,
          "circle-stroke-color": [
            "match",
            ["get", "route_resolution"],
            "unresolved",
            "#f59e0b",
            "resolving",
            "#38bdf8",
            "unavailable",
            "#94a3b8",
            "#111827",
          ] as never,
        }}
      />
      <Layer
        id="placement-anchor-label"
        type="symbol"
        filter={["==", ["geometry-type"], "Point"] as never}
        layout={{
          // `detail` carries the drive-by-points schedule badge (`t=3s`, plus
          // `hold 2s` on a stack) and the implied-speed readout's tooltip. It
          // was computed and thrown away until 2026-07-25; it now renders as a
          // second line under the point number.
          "text-field": [
            "case",
            ["==", ["get", "route_resolution"], "resolving"],
            ["concat", ["get", "label"], " · finding route…"],
            ["==", ["get", "route_resolution"], "unavailable"],
            ["concat", ["get", "label"], " · preview unavailable"],
            ["==", ["get", "route_resolution"], "unresolved"],
            ["concat", ["get", "label"], " · reselect this point"],
            ["all", ["has", "detail"], ["!=", ["get", "detail"], ""]],
            ["concat", ["get", "label"], "\n", ["get", "detail"]],
            ["get", "label"],
          ],
          "text-size": 10,
          "text-offset": [0, 1.3],
          "text-anchor": "top",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        }}
        paint={{
          "text-opacity": ["coalesce", ["get", "opacity"], 1] as never,
          // The mid-segment implied-speed readout is drawn in its segment's
          // feasibility colour, so "this spacing is impossible" and "this
          // spacing means 90 km/h" are the same glance (plan §6.2, §6.6).
          "text-color": [
            "case",
            ["==", ["get", "kind"], "timed-path-speed"],
            ["coalesce", ["get", "color"], "#f8fafc"],
            "#f8fafc",
          ] as never,
          "text-halo-color": "#111827",
          "text-halo-width": 1.5,
        }}
      />
    </Source>
  );
}
