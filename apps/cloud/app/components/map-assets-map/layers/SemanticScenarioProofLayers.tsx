import { Layer, Source } from "react-map-gl/maplibre";

export function SemanticScenarioProofLayers({ data }: { data: object }) {
  return (
    <Source id="semantic-scenario-proof" type="geojson" data={data as never}>
      <Layer
        id="semantic-proof-intent-member"
        source="semantic-scenario-proof"
        type="circle"
        filter={["==", ["get", "feature_kind"], "semantic_proof_intent_member"] as never}
        paint={{ "circle-color": "#a78bfa", "circle-radius": 7, "circle-opacity": 0.35, "circle-stroke-color": "#c4b5fd", "circle-stroke-width": 1 }}
      />
      <Layer
        id="semantic-proof-path"
        source="semantic-scenario-proof"
        type="line"
        filter={["==", ["get", "feature_kind"], "semantic_proof_path"] as never}
        paint={{ "line-color": "#22c55e", "line-width": 2.5, "line-opacity": 0.8 }}
      />
      <Layer
        id="semantic-proof-constraint"
        source="semantic-scenario-proof"
        type="line"
        filter={["==", ["get", "feature_kind"], "semantic_proof_constraint"] as never}
        paint={{
          "line-color": ["case", ["==", ["get", "passed"], true], "#facc15", "#ef4444"] as never,
          "line-width": ["case", ["==", ["get", "strength"], "hard"], 2.5, 1.5] as never,
          "line-dasharray": [2, 1],
        }}
      />
      <Layer
        id="semantic-proof-solved-member"
        source="semantic-scenario-proof"
        type="circle"
        filter={["==", ["get", "feature_kind"], "semantic_proof_solved_member"] as never}
        paint={{ "circle-color": "#22c55e", "circle-radius": 7, "circle-stroke-color": "#dcfce7", "circle-stroke-width": 2 }}
      />
      <Layer
        id="semantic-proof-anchor"
        source="semantic-scenario-proof"
        type="symbol"
        filter={["==", ["get", "feature_kind"], "semantic_proof_anchor"] as never}
        layout={{ "text-field": "◆", "text-size": 18, "text-allow-overlap": true }}
        paint={{ "text-color": "#facc15" }}
      />
    </Source>
  );
}
