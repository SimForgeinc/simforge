import { Layer, Source } from "react-map-gl/maplibre";
import type { ScenarioCandidateFamilyLayer } from "@/app/lib/maps/frontend/scenario-candidate-layers";

/** Props for the ScenarioCandidateLayers component. */
type ScenarioCandidateLayersProps = {
  /** Family layers to render — callers pass only the enabled families. */
  layers: ScenarioCandidateFamilyLayer[];
  /** Master visibility gate (mirrors the other authored overlays). */
  visible?: boolean;
};

/** Source/layer id prefix for a family's candidate layer. */
export function scenarioCandidateSourceId(familyId: string): string {
  return `scenario-candidate-${familyId}`;
}

/**
 * Render scenario-candidate family layers on the map. Every family uses the
 * same Insights-orange symbology (dashed outline + faint fill) — families are
 * distinguished by the panel toggles, not colour. Each candidate carries its
 * full payload as feature properties, so a click routes through the standard
 * feature-inspection path (property panel + copy GeoJSON) and the generic
 * selected-feature highlight emphasises the clicked one.
 */
export function ScenarioCandidateLayers({
  layers,
  visible = true,
}: ScenarioCandidateLayersProps) {
  const visibility = visible ? "visible" : "none";
  return (
    <>
      {layers.map((layer) => {
        const sourceId = scenarioCandidateSourceId(layer.familyId);
        return (
          <Source key={sourceId} id={sourceId} type="geojson" data={layer.data as never}>
            <Layer
              id={`${sourceId}-fill`}
              type="fill"
              layout={{ visibility }}
              paint={{
                "fill-color": "#f97316",
                "fill-opacity": 0.12,
              }}
            />
            <Layer
              id={`${sourceId}-line`}
              type="line"
              layout={{ visibility }}
              paint={{
                "line-color": "#f97316",
                "line-width": 2,
                "line-dasharray": [2, 2],
              }}
            />
          </Source>
        );
      })}
    </>
  );
}
