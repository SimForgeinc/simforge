import { Layer, Source } from "react-map-gl/maplibre";

type DerivedRunwayLayersProps = {
  /**
   * FeatureCollection from `buildDerivedRunwayOverlay`: one `derived-runway`
   * LineString and one `derived-runway-end` Point carrying the stop reason.
   */
  data: object;
};

/**
 * Where a placed car will go, drawn as the faint continuation of its lane.
 *
 * Deliberately quiet — thin, dashed, half-transparent, no hit target. Nobody
 * clicked this line and nothing about the draft changes if the map is recooked
 * and it moves; drawing it as boldly as an authored path would invite the author
 * to adjust it point by point, which is the habit the one-motion model exists to
 * remove.
 *
 * The end cap is the loud part, and only when it has something to say: the label
 * is empty for a runway that simply ran its distance budget, so the mark appears
 * exactly when the runway stopped for a reason the author might want to act on.
 */
export function DerivedRunwayLayers({ data }: DerivedRunwayLayersProps) {
  return (
    <Source id="derived-runway" type="geojson" data={data as never}>
      <Layer
        id="derived-runway-line"
        type="line"
        filter={["==", ["get", "kind"], "derived-runway"] as never}
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": ["get", "color"] as never,
          "line-width": 2,
          "line-opacity": 0.35,
          "line-dasharray": [2, 2],
        }}
      />
      <Layer
        id="derived-runway-end"
        type="circle"
        filter={
          [
            "all",
            ["==", ["get", "kind"], "derived-runway-end"],
            ["!=", ["get", "label"], ""],
          ] as never
        }
        paint={{
          "circle-radius": 4,
          "circle-color": ["get", "color"] as never,
          "circle-opacity": 0.2,
          "circle-stroke-width": 1,
          "circle-stroke-color": [
            "case",
            [">", ["get", "unmetTurnCount"], 0],
            "#ff4d4d",
            ["get", "color"],
          ] as never,
          "circle-stroke-opacity": 0.8,
        }}
      />
      <Layer
        id="derived-runway-end-label"
        type="symbol"
        filter={
          [
            "all",
            ["==", ["get", "kind"], "derived-runway-end"],
            ["!=", ["get", "label"], ""],
          ] as never
        }
        layout={{
          "text-field": ["get", "label"] as never,
          "text-size": 10,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-allow-overlap": false,
        }}
        paint={{
          "text-color": "#ffffff",
          "text-opacity": 0.6,
          "text-halo-color": "#000000",
          "text-halo-width": 1,
        }}
      />
    </Source>
  );
}
