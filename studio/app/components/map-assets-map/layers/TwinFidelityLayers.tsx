import { Layer, Source } from "react-map-gl/maplibre";
import {
  TWIN_FIDELITY_SOURCE_ID,
  TWIN_FIDELITY_SUBLAYERS,
  twinFidelityLayerId,
  type TwinFidelityScorecard,
  type TwinFidelitySubLayerId,
} from "@/app/lib/maps/frontend/twin-fidelity-layers";

/** Props for the TwinFidelityLayers component. */
type TwinFidelityLayersProps = {
  /** The twin_eval_scorecard FeatureCollection (H3 cells). */
  scorecard: TwinFidelityScorecard;
  /** Sub-layers the user toggled on in the Layers panel. */
  enabledLayerIds: TwinFidelitySubLayerId[];
  /** Master visibility gate (mirrors the other authored overlays). */
  visible?: boolean;
};

/**
 * Twin-fidelity heatmap layers. One GeoJSON source (the scorecard artifact)
 * feeds a fill layer per enabled sub-layer — composite / ground / structure
 * ramps plus the categorical coverage layer. Every cell carries its full
 * scorecard payload as feature properties, so clicks route through the
 * standard feature-inspection path (see useGeoJsonSelection).
 */
export function TwinFidelityLayers({
  scorecard,
  enabledLayerIds,
  visible = true,
}: TwinFidelityLayersProps) {
  return (
    <Source
      id={TWIN_FIDELITY_SOURCE_ID}
      type="geojson"
      data={scorecard as never}
    >
      {TWIN_FIDELITY_SUBLAYERS.map((sub) => (
        <Layer
          key={sub.id}
          id={twinFidelityLayerId(sub.id)}
          type="fill"
          layout={{
            visibility:
              visible && enabledLayerIds.includes(sub.id) ? "visible" : "none",
          }}
          paint={sub.paint}
        />
      ))}
    </Source>
  );
}
