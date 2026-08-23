import { Layer, Source } from "react-map-gl/maplibre";
import type { SemanticLayerVisibility } from "@/app/lib/editor-map/semantic-overlay";

// Semantic authoring surface: corridor ribbons, movement previews, and
// conflict zones. These layers are the default editor hit target — the raw
// runtime lane overlay renders beneath them as non-interactive debug only.

export const SEMANTIC_OVERLAY_SOURCE_ID = "semantic-overlay";

/** Hit-test layers. queryRenderedFeatures orders results by RENDER z-order
 *  (topmost first): the movement hit line sits above the corridor hit fill,
 *  and both sit above the conflict fill, so movements win over corridors and
 *  conflict zones never shadow either authoring target. */
export const SEMANTIC_HIT_LAYER_IDS = [
  "semantic-conflict-fill",
  "semantic-movement-hit",
  "semantic-corridor-hit",
] as const;

export const SEMANTIC_INSPECTION_HIT_LAYER_IDS = [
  "semantic-context-point-hit",
  "semantic-context-line-hit",
  "semantic-context-fill-hit",
  "semantic-conflict-diagnostic-hit",
  "semantic-movement-diagnostic-hit",
  "semantic-corridor-diagnostic-hit",
] as const;

type SemanticOverlayLayersProps = {
  data: object;
  visibility: SemanticLayerVisibility;
  selectedFeatureKey?: string | null;
  hoveredFeatureKey?: string | null;
  inspectionEnabled?: boolean;
  visible?: boolean;
};

function authorableFilter(featureKind: string) {
  return [
    "all",
    ["==", ["get", "feature_kind"], featureKind],
    ["==", ["get", "diagnostic"], false],
  ] as never;
}

function diagnosticFilter(featureKind: string) {
  return [
    "all",
    ["==", ["get", "feature_kind"], featureKind],
    ["==", ["get", "diagnostic"], true],
  ] as never;
}

function keyFilter(key: string | null | undefined, missingKey: string) {
  if (!key) return ["==", ["get", missingKey], true] as never;
  return [
    "all",
    ["==", ["get", "semantic_key"], key],
    ["==", ["get", "diagnostic"], false],
  ] as never;
}

function lineKeyFilter(key: string | null | undefined, missingKey: string) {
  if (!key) return ["==", ["get", missingKey], true] as never;
  return [
    "all",
    ["==", ["get", "feature_kind"], "semantic_movement"],
    ["==", ["get", "semantic_key"], key],
    ["==", ["get", "diagnostic"], false],
  ] as never;
}

function diagnosticKeyFilter(key: string | null | undefined, missingKey: string) {
  if (!key) return ["==", ["get", missingKey], true] as never;
  return [
    "all",
    ["==", ["get", "semantic_key"], key],
    ["==", ["get", "diagnostic"], true],
  ] as never;
}

export function SemanticOverlayLayers({
  data,
  visibility,
  selectedFeatureKey = null,
  hoveredFeatureKey = null,
  inspectionEnabled = false,
  visible = true,
}: SemanticOverlayLayersProps) {
  const corridorVisibility =
    visible && visibility.corridors ? "visible" : "none";
  const movementVisibility =
    visible && visibility.movements ? "visible" : "none";
  const conflictVisibility =
    visible && visibility.conflicts ? "visible" : "none";
  const contextVisibility =
    visible && visibility.context ? "visible" : "none";
  const diagnosticVisibility =
    visible && visibility.diagnostics ? "visible" : "none";
  const contextDiagnosticVisibility =
    visible && visibility.context && visibility.diagnostics ? "visible" : "none";
  const contextInspectionVisibility =
    inspectionEnabled && contextVisibility === "visible" ? "visible" : "none";
  const diagnosticInspectionVisibility =
    inspectionEnabled && diagnosticVisibility === "visible" ? "visible" : "none";
  const contextColor = [
    "match",
    ["get", "context_kind"],
    ["parking_lane", "parking_space", "parking_area"], "#60a5fa",
    ["walking_corridor", "sidewalk_surface", "crosswalk"], "#facc15",
    ["occlusion_zone", "building", "vegetation"], "#fb923c",
    ["bicycle_corridor"], "#34d399",
    "#94a3b8",
  ] as never;

  return (
    <Source id={SEMANTIC_OVERLAY_SOURCE_ID} type="geojson" data={data as never}>
      {/* Cohesive semantic road surface. Corridors are separate semantic
          objects by design, but the authoring canvas must read as one road
          network. Round-capped corridor axes and movement variants form a
          continuous asphalt casing underneath the exact corridor ribbons. */}
      <Layer
        id="semantic-road-corridor-edge"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={authorableFilter("semantic_corridor_axis")}
        paint={{
          "line-color": "#94a3b8",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            6,
            16,
            17,
            19,
            30,
          ] as never,
          "line-opacity": 0.62,
        }}
        layout={{
          visibility: corridorVisibility,
          "line-cap": "round",
          "line-join": "round",
        }}
      />
      <Layer
        id="semantic-road-movement-edge"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={authorableFilter("semantic_movement")}
        paint={{
          "line-color": "#94a3b8",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            6,
            16,
            17,
            19,
            30,
          ] as never,
          "line-opacity": 0.62,
        }}
        layout={{
          visibility: movementVisibility,
          "line-cap": "round",
          "line-join": "round",
        }}
      />
      <Layer
        id="semantic-road-corridor-surface"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={authorableFilter("semantic_corridor_axis")}
        paint={{
          "line-color": "#1f2937",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            4,
            16,
            14,
            19,
            26,
          ] as never,
          "line-opacity": 0.98,
        }}
        layout={{
          visibility: corridorVisibility,
          "line-cap": "round",
          "line-join": "round",
        }}
      />
      <Layer
        id="semantic-road-movement-surface"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={authorableFilter("semantic_movement")}
        paint={{
          "line-color": "#1f2937",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            4,
            16,
            14,
            19,
            26,
          ] as never,
          "line-opacity": 0.98,
        }}
        layout={{
          visibility: movementVisibility,
          "line-cap": "round",
          "line-join": "round",
        }}
      />
      <Layer
        id="semantic-road-corridor-centerline"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={authorableFilter("semantic_corridor_axis")}
        paint={{
          "line-color": "#5eead4",
          "line-width": 1.25,
          "line-opacity": 0.9,
          "line-dasharray": [1.2, 1.8],
        }}
        layout={{
          visibility: corridorVisibility,
          "line-cap": "round",
          "line-join": "round",
        }}
      />

      {/* Corridor ribbons (authorable) */}
      <Layer
        id="semantic-corridor-ribbon"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="fill"
        filter={authorableFilter("semantic_corridor")}
        paint={{
          "fill-color": "#2dd4bf",
          "fill-opacity": 0.3,
        }}
        layout={{ visibility: corridorVisibility }}
      />
      <Layer
        id="semantic-corridor-outline"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={authorableFilter("semantic_corridor")}
        paint={{
          "line-color": "#2dd4bf",
          "line-width": 1.1,
          "line-opacity": 0.55,
        }}
        layout={{ visibility: corridorVisibility }}
      />
      {/* Diagnostic corridors: display-only, dashed amber, never hit-tested. */}
      <Layer
        id="semantic-corridor-diagnostic"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={diagnosticFilter("semantic_corridor")}
        paint={{
          "line-color": "#f59e0b",
          "line-width": 1.4,
          "line-opacity": 0.75,
          "line-dasharray": [1.5, 1.5],
        }}
        layout={{ visibility: diagnosticVisibility }}
      />

      {/* Movement previews (representative variants emphasized) */}
      <Layer
        id="semantic-movement-line"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={authorableFilter("semantic_movement")}
        paint={{
          "line-color": "#c084fc",
          "line-width": [
            "case",
            ["==", ["get", "is_representative"], true],
            2.2,
            1.1,
          ] as never,
          "line-opacity": [
            "case",
            ["==", ["get", "is_representative"], true],
            0.95,
            0.5,
          ] as never,
        }}
        layout={{
          visibility: movementVisibility,
          "line-cap": "round",
          "line-join": "round",
        }}
      />
      <Layer
        id="semantic-movement-diagnostic"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={diagnosticFilter("semantic_movement")}
        paint={{
          "line-color": "#f59e0b",
          "line-width": 1.4,
          "line-opacity": 0.7,
          "line-dasharray": [1.2, 1.8],
        }}
        layout={{ visibility: diagnosticVisibility }}
      />

      {/* Conflict zones */}
      <Layer
        id="semantic-conflict-fill"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="fill"
        filter={authorableFilter("semantic_conflict")}
        paint={{
          "fill-color": "#fb7185",
          "fill-opacity": 0.18,
        }}
        layout={{ visibility: conflictVisibility }}
      />
      <Layer
        id="semantic-conflict-outline"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={authorableFilter("semantic_conflict")}
        paint={{
          "line-color": "#fb7185",
          "line-width": 1.5,
          "line-opacity": 0.85,
        }}
        layout={{ visibility: conflictVisibility }}
      />
      <Layer
        id="semantic-conflict-diagnostic"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={diagnosticFilter("semantic_conflict")}
        paint={{
          "line-color": "#f59e0b",
          "line-width": 1.3,
          "line-opacity": 0.7,
          "line-dasharray": [1, 1.6],
        }}
        layout={{ visibility: diagnosticVisibility }}
      />

      {/* Unified source-fused context: OpenDRIVE lane types plus projected
          GeoJSON / Overture / detector features. Display-only until a
          feature-specific placement compiler owns its interaction. */}
      <Layer
        id="semantic-context-fill"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="fill"
        filter={authorableFilter("semantic_context")}
        paint={{ "fill-color": contextColor, "fill-opacity": 0.18 }}
        layout={{ visibility: contextVisibility }}
      />
      <Layer
        id="semantic-context-line"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={authorableFilter("semantic_context")}
        paint={{ "line-color": contextColor, "line-width": 2, "line-opacity": 0.8 }}
        layout={{ visibility: contextVisibility }}
      />
      <Layer
        id="semantic-context-point"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="circle"
        filter={authorableFilter("semantic_context")}
        paint={{ "circle-color": contextColor, "circle-radius": 4, "circle-opacity": 0.8 }}
        layout={{ visibility: contextVisibility }}
      />
      <Layer
        id="semantic-context-diagnostic-line"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={diagnosticFilter("semantic_context")}
        paint={{
          "line-color": contextColor,
          "line-width": 1.4,
          "line-opacity": 0.65,
          "line-dasharray": [1.2, 1.8],
        }}
        layout={{ visibility: contextDiagnosticVisibility }}
      />
      <Layer
        id="semantic-context-diagnostic-point"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="circle"
        filter={diagnosticFilter("semantic_context")}
        paint={{ "circle-color": contextColor, "circle-radius": 3, "circle-opacity": 0.55 }}
        layout={{ visibility: contextDiagnosticVisibility }}
      />

      {/* Invisible hit-area layers (authorable features only). Order matters:
          queryRenderedFeatures returns topmost first, so conflicts win over
          movements, movements over corridors. */}
      <Layer
        id="semantic-corridor-hit"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="fill"
        filter={authorableFilter("semantic_corridor")}
        paint={{ "fill-color": "#2dd4bf", "fill-opacity": 0.01 }}
        layout={{ visibility: corridorVisibility }}
      />
      <Layer
        id="semantic-movement-hit"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={authorableFilter("semantic_movement")}
        paint={{ "line-color": "#c084fc", "line-width": 12, "line-opacity": 0.01 }}
        layout={{ visibility: movementVisibility }}
      />
      <Layer
        id="semantic-corridor-diagnostic-hit"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="fill"
        filter={diagnosticFilter("semantic_corridor")}
        paint={{ "fill-color": "#f59e0b", "fill-opacity": 0.01 }}
        layout={{ visibility: diagnosticInspectionVisibility }}
      />
      <Layer
        id="semantic-movement-diagnostic-hit"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={diagnosticFilter("semantic_movement")}
        paint={{ "line-color": "#f59e0b", "line-width": 12, "line-opacity": 0.01 }}
        layout={{ visibility: diagnosticInspectionVisibility }}
      />
      <Layer
        id="semantic-conflict-diagnostic-hit"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="fill"
        filter={diagnosticFilter("semantic_conflict")}
        paint={{ "fill-color": "#f59e0b", "fill-opacity": 0.01 }}
        layout={{ visibility: diagnosticInspectionVisibility }}
      />
      <Layer
        id="semantic-context-fill-hit"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="fill"
        filter={["==", ["get", "feature_kind"], "semantic_context"] as never}
        paint={{ "fill-color": "#94a3b8", "fill-opacity": 0.01 }}
        layout={{ visibility: contextInspectionVisibility }}
      />
      <Layer
        id="semantic-context-line-hit"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={["==", ["get", "feature_kind"], "semantic_context"] as never}
        paint={{ "line-color": "#94a3b8", "line-width": 12, "line-opacity": 0.01 }}
        layout={{ visibility: contextInspectionVisibility }}
      />
      <Layer
        id="semantic-context-point-hit"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="circle"
        filter={["==", ["get", "feature_kind"], "semantic_context"] as never}
        paint={{ "circle-color": "#94a3b8", "circle-radius": 10, "circle-opacity": 0.01 }}
        layout={{ visibility: contextInspectionVisibility }}
      />

      {/* Hover + selection feedback */}
      <Layer
        id="semantic-hovered-fill"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="fill"
        filter={keyFilter(hoveredFeatureKey, "__semantic_hover_missing__")}
        paint={{
          "fill-color": "#5eead4",
          "fill-opacity": 0.3,
        }}
        layout={{ visibility: visible ? "visible" : "none" }}
      />
      <Layer
        id="semantic-hovered-line"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={lineKeyFilter(hoveredFeatureKey, "__semantic_hover_missing__")}
        paint={{
          "line-color": "#5eead4",
          "line-width": 3.2,
          "line-opacity": 0.95,
        }}
        layout={{ visibility: visible ? "visible" : "none" }}
      />
      <Layer
        id="semantic-selected-fill"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="fill"
        filter={keyFilter(selectedFeatureKey, "__semantic_selected_missing__")}
        paint={{
          "fill-color": "#facc15",
          "fill-opacity": 0.35,
        }}
        layout={{ visibility: visible ? "visible" : "none" }}
      />
      <Layer
        id="semantic-selected-line"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={lineKeyFilter(selectedFeatureKey, "__semantic_selected_missing__")}
        paint={{
          "line-color": "#facc15",
          "line-width": 3.6,
          "line-opacity": 1,
        }}
        layout={{ visibility: visible ? "visible" : "none" }}
      />
      <Layer
        id="semantic-selected-context-line"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={[
          "all",
          ["==", ["get", "feature_kind"], "semantic_context"],
          ["==", ["get", "semantic_key"], selectedFeatureKey ?? "__semantic_selected_missing__"],
        ] as never}
        paint={{ "line-color": "#facc15", "line-width": 4, "line-opacity": 1 }}
        layout={{ visibility: visible ? "visible" : "none" }}
      />
      <Layer
        id="semantic-selected-context-point"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="circle"
        filter={[
          "all",
          ["==", ["get", "feature_kind"], "semantic_context"],
          ["==", ["get", "semantic_key"], selectedFeatureKey ?? "__semantic_selected_missing__"],
        ] as never}
        paint={{ "circle-color": "#facc15", "circle-radius": 7, "circle-opacity": 1 }}
        layout={{ visibility: visible ? "visible" : "none" }}
      />
      <Layer
        id="semantic-selected-diagnostic-fill"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="fill"
        filter={diagnosticKeyFilter(selectedFeatureKey, "__semantic_selected_diagnostic_missing__")}
        paint={{ "fill-color": "#f59e0b", "fill-opacity": 0.35 }}
        layout={{ visibility: diagnosticInspectionVisibility }}
      />
      <Layer
        id="semantic-selected-diagnostic-line"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="line"
        filter={diagnosticKeyFilter(selectedFeatureKey, "__semantic_selected_diagnostic_missing__")}
        paint={{ "line-color": "#f59e0b", "line-width": 4, "line-opacity": 1 }}
        layout={{ visibility: diagnosticInspectionVisibility }}
      />
      <Layer
        id="semantic-selected-diagnostic-point"
        source={SEMANTIC_OVERLAY_SOURCE_ID}
        type="circle"
        filter={diagnosticKeyFilter(selectedFeatureKey, "__semantic_selected_diagnostic_missing__")}
        paint={{ "circle-color": "#f59e0b", "circle-radius": 7, "circle-opacity": 1 }}
        layout={{ visibility: diagnosticInspectionVisibility }}
      />
    </Source>
  );
}
