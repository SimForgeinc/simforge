import { Layer, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";
import { SIGNAL_SIGN_ICON, CROSSWALK_CHIP_ICON } from "../map-icons";
import type { SignalLayerStyle } from "@/app/lib/scenario-editor/layer-styles";
import { SIGNAL_CATEGORY_CONFIG } from "@/app/lib/maps/frontend/signal-overlay";

// Authentic sign icons (stop octagon, yield triangle, warning diamond, speed
// roundel) carry their own shape and color, so they grow with zoom rather than
// reading as a flat dot.
const SIGN_SIZE = ["interpolate", ["linear"], ["zoom"], 12, 0.55, 16, 0.9];

// Crosswalk polygons are compact, so a single zebra-stripe chip at the feature's
// center (the default point placement) marks each one without cluttering the map.
const CROSSWALK_CHIP_SIZE = ["interpolate", ["linear"], ["zoom"], 14, 0.5, 18, 0.8];
const CROSSWALK_CHIP_OPACITY = ["interpolate", ["linear"], ["zoom"], 14, 0, 15.5, 0.95];

/** Props for the SignalOverlayLayers component. */
type SignalOverlayLayersProps = {
  data: object;
  enabledSignalCategories: Set<string>;
  showLineChips?: boolean;
  styleOverrides?: Record<string, SignalLayerStyle>;
  visible?: boolean;
};

/** Render signal overlay circles and speed limit labels by category. */
export function SignalOverlayLayers({
  data,
  enabledSignalCategories,
  showLineChips = false,
  styleOverrides = {},
  visible = true,
}: SignalOverlayLayersProps) {
  return (
    <Source id="signal-overlay" type="geojson" data={data as never}>
      {enabledSignalCategories.has("crosswalk") && (
        <Layer
          id="signal-overlay-crosswalk-fill"
          type="fill"
          filter={["==", ["get", "feature_kind"], "crosswalk"] as never}
          layout={{ visibility: visible ? "visible" : "none" }}
          paint={{
            "fill-color": "#06d6a0",
            "fill-opacity": 0.45,
          }}
        />
      )}
      {enabledSignalCategories.has("crosswalk") && (
        <Layer
          id="signal-overlay-crosswalk-outline"
          type="line"
          filter={["==", ["get", "feature_kind"], "crosswalk"] as never}
          layout={{ visibility: visible ? "visible" : "none" }}
          paint={{
            "line-color": "#06d6a0",
            "line-width": 1.5,
            "line-opacity": 0.8,
          }}
        />
      )}
      {showLineChips && enabledSignalCategories.has("crosswalk") && (
        <Layer
          id="signal-overlay-crosswalk-chip"
          type="symbol"
          minzoom={14}
          filter={["==", ["get", "feature_kind"], "crosswalk"] as never}
          layout={{
            visibility: visible ? "visible" : "none",
            "icon-image": CROSSWALK_CHIP_ICON,
            "icon-size": CROSSWALK_CHIP_SIZE as never,
            "icon-allow-overlap": false,
            "icon-optional": true,
          }}
          paint={{ "icon-opacity": CROSSWALK_CHIP_OPACITY as never }}
        />
      )}
      {SIGNAL_CATEGORY_CONFIG.filter(
        (category) =>
          category.id !== "traffic_light" &&
          category.id !== "crosswalk" &&
          enabledSignalCategories.has(category.id),
      ).map((category) => {
        const style = styleOverrides[category.id] ?? {
          color: category.color,
          radius:
            category.id === "parking_sign" || category.id === "bus_stop"
              ? 4
              : category.id === "stop_line" || category.id === "street_name_sign"
                ? 3
                : 5,
          opacity: 0.9,
          strokeColor: C.bg,
          strokeWidth: 1,
          textColor: "#ffffff",
          textHaloColor: category.id === "speed_limit_sign" ? "#7c3aed" : category.color,
        };
        const signIcon = SIGNAL_SIGN_ICON[category.id];
        if (signIcon) {
          // Authentic signs carry their own shape and colors, so per-category
          // color/stroke overrides don't apply; opacity is the one style field
          // that still maps onto a baked icon.
          return (
            <Layer
              key={`signal-overlay-sign-${category.id}`}
              id={`signal-overlay-sign-${category.id}`}
              type="symbol"
              filter={["==", ["get", "signal_category"], category.id] as never}
              layout={{
                visibility: visible ? "visible" : "none",
                "icon-image": signIcon,
                "icon-size": SIGN_SIZE as never,
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              }}
              paint={{ "icon-opacity": style.opacity }}
            />
          );
        }
        return (
          <Layer
            key={`signal-overlay-circle-${category.id}`}
            id={`signal-overlay-circle-${category.id}`}
            type="circle"
            filter={["==", ["get", "signal_category"], category.id] as never}
            layout={{ visibility: visible ? "visible" : "none" }}
            paint={{
              "circle-radius": style.radius,
              "circle-color": style.color,
              "circle-opacity": style.opacity,
              "circle-stroke-width": style.strokeWidth,
              "circle-stroke-color": style.strokeColor,
            }}
          />
        );
      })}
      {enabledSignalCategories.has("speed_limit_sign") && (
        <Layer
          id="signal-overlay-speed-label"
          type="symbol"
          filter={["==", ["get", "signal_category"], "speed_limit_sign"]}
          layout={{
            visibility: visible ? "visible" : "none",
            "text-field": ["to-string", ["get", "speed_limit_mph"]],
            "text-size": 10,
            "text-font": ["Open Sans Bold"],
            "text-allow-overlap": true,
            "text-ignore-placement": true,
            "text-offset": [0, 0],
            "text-anchor": "center",
          }}
          paint={{
            // The number sits inside the white speed roundel, so it is always
            // rendered dark-on-white for legibility rather than from the
            // (legacy, white-by-default) per-category text color override.
            "text-color": "#1a1a1a",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1,
            "text-opacity": styleOverrides.speed_limit_sign?.opacity ?? 0.9,
          }}
        />
      )}
    </Source>
  );
}
