import { Layer, Source } from "react-map-gl/maplibre";

export function SemanticSiteQueryLayers({ data }: { data: object }) {
  return (
    <Source id="semantic-site-query" type="geojson" data={data as never}>
      <Layer
        id="semantic-site-query-fill"
        source="semantic-site-query"
        type="fill"
        filter={["==", ["get", "feature_kind"], "semantic_site_candidate"] as never}
        paint={{ "fill-color": "#38bdf8", "fill-opacity": 0.2, "fill-outline-color": "#7dd3fc" }}
      />
      <Layer
        id="semantic-site-query-line"
        source="semantic-site-query"
        type="line"
        filter={["==", ["get", "feature_kind"], "semantic_site_candidate"] as never}
        paint={{ "line-color": "#38bdf8", "line-width": 3, "line-opacity": 0.85, "line-dasharray": [2, 1] }}
      />
      <Layer
        id="semantic-site-query-anchor"
        source="semantic-site-query"
        type="circle"
        filter={["==", ["get", "feature_kind"], "semantic_site_candidate_anchor"] as never}
        paint={{ "circle-color": "#0ea5e9", "circle-radius": 10, "circle-stroke-color": "#e0f2fe", "circle-stroke-width": 2 }}
      />
      <Layer
        id="semantic-site-query-label"
        source="semantic-site-query"
        type="symbol"
        filter={["==", ["get", "feature_kind"], "semantic_site_candidate_anchor"] as never}
        layout={{ "text-field": ["get", "rank_label"] as never, "text-size": 11, "text-allow-overlap": true }}
        paint={{ "text-color": "#ffffff" }}
      />
    </Source>
  );
}
