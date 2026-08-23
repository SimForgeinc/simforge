import { Layer, Source } from "react-map-gl/maplibre";
import { SPEED_SIGN_XODR_ICON } from "../map-icons";

/**
 * Label each driving lane with its posted speed limit, drawn as a white sign
 * plate (black number in the display unit) placed at the lane centerline. Off by
 * default; toggled from the Layers panel. Clicking a sign selects the lane
 * beneath it through the normal feature-selection flow (inspector + highlight),
 * so no per-sign interactivity lives here. `icon-text-fit` grows the plate to
 * the number so 1- and 2-digit signs keep even padding.
 */
type SpeedLimitLayersProps = {
  data: object;
  /** Unique source/layer id prefix — lets two overlays (Overture + in-house) coexist. */
  idPrefix: string;
  /** Sign-plate icon id (black = in-house/XODR, grey = Overture). */
  iconId?: string;
  visible?: boolean;
};

const SIGN_SIZE = ["interpolate", ["linear"], ["zoom"], 13, 0.62, 18, 1.0];
const NUMBER_SIZE = ["interpolate", ["linear"], ["zoom"], 13, 8.5, 18, 14];

export function SpeedLimitLayers({
  data,
  idPrefix,
  iconId = SPEED_SIGN_XODR_ICON,
  visible = true,
}: SpeedLimitLayersProps) {
  return (
    <Source id={`${idPrefix}-source`} type="geojson" data={data as never}>
      <Layer
        id={`${idPrefix}-signs`}
        type="symbol"
        minzoom={13}
        layout={{
          visibility: visible ? "visible" : "none",
          // One upright sign centered on each lane; collision culling thins out
          // parallel lanes so the map stays readable.
          "symbol-placement": "line-center",
          "icon-image": iconId,
          "icon-size": SIGN_SIZE as never,
          "icon-rotation-alignment": "viewport",
          "icon-pitch-alignment": "viewport",
          "icon-allow-overlap": false,
          // Grow the plate around the number with even padding (the icon carries
          // stretch metadata so corners stay crisp).
          "icon-text-fit": "both",
          "icon-text-fit-padding": [3.5, 6.5, 3.5, 6.5],
          "text-field": ["to-string", ["get", "speed"]] as never,
          "text-font": ["Open Sans Bold"],
          "text-size": NUMBER_SIZE as never,
          "text-rotation-alignment": "viewport",
          "text-pitch-alignment": "viewport",
          "text-allow-overlap": false,
          "text-optional": false,
        }}
        paint={{
          "text-color": "#111111",
        }}
      />
    </Source>
  );
}
