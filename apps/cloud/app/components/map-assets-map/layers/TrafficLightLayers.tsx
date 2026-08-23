import { Layer, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";
import type { SignalLayerStyle } from "@/app/lib/scenario-editor/layer-styles";

/** Props for the TrafficLightLayers component. */
type TrafficLightLayersProps = {
  data: object;
  sourceId?: string;
  layerPrefix?: string;
  styleOverride?: SignalLayerStyle;
  visible?: boolean;
  emphasized?: boolean;
};

/** Render clustered and individual traffic light point markers. */
export function TrafficLightLayers({
  data,
  sourceId = "signal-traffic-lights",
  layerPrefix = "signal-traffic-light",
  styleOverride,
  visible = true,
  emphasized = false,
}: TrafficLightLayersProps) {
  const style = styleOverride ?? {
    color: "#facc15",
    radius: 6,
    opacity: 0.9,
    strokeColor: C.bg,
    strokeWidth: 2,
    textColor: C.bg,
    textHaloColor: "#facc15",
  };
  return (
    <Source
      id={sourceId}
      type="geojson"
      data={data as never}
      cluster
      clusterRadius={12}
      clusterMaxZoom={16}
    >
      <Layer
        id={`${layerPrefix}-cluster`}
        type="circle"
        filter={["has", "point_count"]}
        layout={{ visibility: visible ? "visible" : "none" }}
        paint={{
          "circle-radius": [
            "step",
            ["get", "point_count"],
            style.radius * 2,
            5,
            style.radius * 2.5,
            10,
            style.radius * 3,
            20,
            style.radius * 3.6,
          ],
          "circle-color": style.color,
          "circle-opacity": style.opacity,
          "circle-stroke-width": style.strokeWidth,
          "circle-stroke-color": style.strokeColor,
        }}
      />
      <Layer
        id={`${layerPrefix}-cluster-count`}
        type="symbol"
        filter={["has", "point_count"]}
        layout={{
          visibility: visible ? "visible" : "none",
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 11,
          "text-font": ["Open Sans Bold"],
          "text-allow-overlap": true,
        }}
        paint={{
          "text-color": style.textColor,
        }}
      />
      {emphasized && (
        <Layer
          id={`${layerPrefix}-glow`}
          type="circle"
          filter={["!", ["has", "point_count"]]}
          layout={{ visibility: visible ? "visible" : "none" }}
          paint={{
            "circle-radius": style.radius * 2.5,
            "circle-color": "#E8E044",
            "circle-opacity": 0.25,
            "circle-blur": 1,
            "circle-stroke-width": 0,
            "circle-stroke-color": "transparent",
          }}
        />
      )}
      <Layer
        id={`${layerPrefix}-single`}
        type="circle"
        filter={["!", ["has", "point_count"]]}
        layout={{ visibility: visible ? "visible" : "none" }}
        paint={{
          "circle-radius": style.radius,
          "circle-color": style.color,
          "circle-opacity": style.opacity,
          "circle-stroke-width": Math.max(1, style.strokeWidth - 1),
          "circle-stroke-color": style.strokeColor,
        }}
      />
    </Source>
  );
}
