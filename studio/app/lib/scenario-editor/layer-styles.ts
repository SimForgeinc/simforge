"use client";

import type { MapOverlayLayerId } from "@simforge/studio-shared";
import { OVERLAY_STYLES } from "@/app/components/map-assets-map/map-layer-constants";
import {
  RUNTIME_LANE_TYPES,
  type RuntimeLaneTypeId,
} from "@/app/lib/editor-map/runtime-layer-visibility";
import {
  ROAD_NETWORK_FEATURE_TYPES,
  type RoadNetworkFeatureTypeId,
} from "@/app/lib/maps/frontend/road-network-feature-types";
import { SIGNAL_CATEGORY_CONFIG } from "@/app/lib/maps/frontend/signal-overlay";

export type StylableLayerSelection =
  | {
      kind: "enrichment";
      id: MapOverlayLayerId;
      label: string;
      description?: string;
    }
  | {
      kind: "road-network";
      id: RoadNetworkFeatureTypeId;
      label: string;
      description?: string;
    }
  | {
      kind: "signal";
      id: string;
      label: string;
      description?: string;
    }
  | {
      kind: "runtime-lane";
      id: RuntimeLaneTypeId;
      label: string;
      description?: string;
    };

export type EnrichmentLayerStyle = {
  color: string;
  fill: string;
  radius: number;
  opacity: number;
  lineWidth: number;
};

export type RoadNetworkLayerStyle = {
  color: string;
  fillOpacity: number;
  lineWidth: number;
  lineOpacity: number;
  arrowTextColor: string;
  arrowHaloColor: string;
};

export type SignalLayerStyle = {
  color: string;
  radius: number;
  opacity: number;
  strokeColor: string;
  strokeWidth: number;
  textColor: string;
  textHaloColor: string;
};

export type RuntimeLaneLayerStyle = {
  color: string;
  opacity: number;
};

export type StylableLayerStyle =
  | EnrichmentLayerStyle
  | RoadNetworkLayerStyle
  | SignalLayerStyle
  | RuntimeLaneLayerStyle;

export type LayerStyleOverrides = {
  enrichment: Partial<Record<MapOverlayLayerId, EnrichmentLayerStyle>>;
  roadNetwork: Partial<Record<RoadNetworkFeatureTypeId, RoadNetworkLayerStyle>>;
  signal: Record<string, SignalLayerStyle>;
  runtimeLane: Partial<Record<RuntimeLaneTypeId, RuntimeLaneLayerStyle>>;
};

export const EMPTY_LAYER_STYLE_OVERRIDES: LayerStyleOverrides = {
  enrichment: {},
  roadNetwork: {},
  signal: {},
  runtimeLane: {},
};

const DEFAULT_ENRICHMENT_LAYER_STYLES: Record<
  MapOverlayLayerId,
  EnrichmentLayerStyle
> = Object.fromEntries(
  Object.entries(OVERLAY_STYLES).map(([layerId, style]) => [
    layerId,
    {
      color: style.color,
      fill: style.fill,
      radius: style.radius,
      opacity: style.opacity,
      lineWidth: 3,
    },
  ]),
) as Record<MapOverlayLayerId, EnrichmentLayerStyle>;

const DEFAULT_ROAD_NETWORK_LAYER_STYLES: Record<
  RoadNetworkFeatureTypeId,
  RoadNetworkLayerStyle
> = Object.fromEntries(
  ROAD_NETWORK_FEATURE_TYPES.map((featureType) => {
    const isDrivingLanes = featureType.id === "lanes_driving";
    const isBikeLanes = featureType.id === "lanes_biking";
    const isParkingSpaces = featureType.id === "parking_spaces";
    const color = isDrivingLanes
      ? "#646a6d"
      : isParkingSpaces
        ? "#604324"
        : featureType.color;
    const lineWidth =
      featureType.geometryRendering === "fill"
        ? 2
        : isDrivingLanes || featureType.id === "lane_boundaries"
          ? 1
          : isBikeLanes
            ? 1.5
            : 3;
    const lineOpacity =
      featureType.geometryRendering === "fill"
        ? 0.8
        : isDrivingLanes
          ? 0.3
          : isBikeLanes
            ? 0.45
            : featureType.id === "lane_boundaries"
              ? 0.4
              : 0.85;
    return [
      featureType.id,
      {
        color,
        fillOpacity: featureType.geometryRendering === "fill" ? 0.35 : 0.35,
        lineWidth,
        lineOpacity,
        arrowTextColor: isDrivingLanes
          ? "#4d4c4c"
          : isBikeLanes
            ? color
            : "#ffffff",
        arrowHaloColor: isParkingSpaces
          ? "#ff7f00"
          : isDrivingLanes
            ? color
            : featureType.id === "gates"
              ? "#cab2d6"
              : color,
      },
    ];
  }),
) as Record<RoadNetworkFeatureTypeId, RoadNetworkLayerStyle>;

function defaultSignalRadius(categoryId: string) {
  switch (categoryId) {
    case "parking_sign":
    case "bus_stop":
      return 4;
    case "stop_line":
    case "street_name_sign":
      return 3;
    case "traffic_light":
      return 6;
    default:
      return 5;
  }
}

function defaultSignalTextColor(categoryId: string) {
  // Speed-limit numbers render inside the white roundel, so they default to
  // dark; traffic-light labels sit on a light chip; everything else is white.
  if (categoryId === "speed_limit_sign") return "#1a1a1a";
  if (categoryId === "traffic_light") return "#0a0a0a";
  return "#ffffff";
}

function defaultSignalTextHalo(categoryId: string, color: string) {
  return categoryId === "speed_limit_sign" ? "#ffffff" : color;
}

const DEFAULT_SIGNAL_LAYER_STYLES: Record<string, SignalLayerStyle> =
  Object.fromEntries(
    SIGNAL_CATEGORY_CONFIG.map((category) => [
      category.id,
      {
        color: category.color,
        radius: defaultSignalRadius(category.id),
        opacity: 0.9,
        strokeColor: "#0a0a0a",
        strokeWidth: category.id === "traffic_light" ? 2 : 1,
        textColor: defaultSignalTextColor(category.id),
        textHaloColor: defaultSignalTextHalo(category.id, category.color),
      },
    ]),
  );

function defaultRuntimeLaneOpacity(laneTypeId: RuntimeLaneTypeId) {
  switch (laneTypeId) {
    case "biking":
      return 0.94;
    case "sidewalk":
      return 0.88;
    case "parking":
      return 0.92;
    case "shoulder":
      return 0.82;
    case "other":
      return 0.9;
    default:
      return 0.96;
  }
}

const DEFAULT_RUNTIME_LANE_STYLES: Record<
  RuntimeLaneTypeId,
  RuntimeLaneLayerStyle
> = Object.fromEntries(
  RUNTIME_LANE_TYPES.map((laneType) => [
    laneType.id,
    {
      color: laneType.color,
      opacity: defaultRuntimeLaneOpacity(laneType.id),
    },
  ]),
) as Record<RuntimeLaneTypeId, RuntimeLaneLayerStyle>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateString(value: unknown, key: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${key}" must be a non-empty string.`);
  }
  return value;
}

function validateNumber(
  value: unknown,
  key: string,
  {
    min = Number.NEGATIVE_INFINITY,
    max = Number.POSITIVE_INFINITY,
  }: { min?: number; max?: number } = {},
) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`"${key}" must be a number.`);
  }
  if (value < min || value > max) {
    throw new Error(`"${key}" must be between ${min} and ${max}.`);
  }
  return value;
}

function ensureOnlyKnownKeys(input: Record<string, unknown>, allowedKeys: string[]) {
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`"${key}" is not a valid style property here.`);
    }
  }
}

function validateEnrichmentLayerStyle(input: unknown): EnrichmentLayerStyle {
  if (!isPlainObject(input)) throw new Error("Style JSON must be an object.");
  ensureOnlyKnownKeys(input, ["color", "fill", "radius", "opacity", "lineWidth"]);
  return {
    color: validateString(input.color, "color"),
    fill: validateString(input.fill, "fill"),
    radius: validateNumber(input.radius, "radius", { min: 0.1 }),
    opacity: validateNumber(input.opacity, "opacity", { min: 0, max: 1 }),
    lineWidth: validateNumber(input.lineWidth, "lineWidth", { min: 0.1 }),
  };
}

function validateRoadNetworkLayerStyle(input: unknown): RoadNetworkLayerStyle {
  if (!isPlainObject(input)) throw new Error("Style JSON must be an object.");
  ensureOnlyKnownKeys(input, [
    "color",
    "fillOpacity",
    "lineWidth",
    "lineOpacity",
    "arrowTextColor",
    "arrowHaloColor",
  ]);
  return {
    color: validateString(input.color, "color"),
    fillOpacity: validateNumber(input.fillOpacity, "fillOpacity", { min: 0, max: 1 }),
    lineWidth: validateNumber(input.lineWidth, "lineWidth", { min: 0.1 }),
    lineOpacity: validateNumber(input.lineOpacity, "lineOpacity", { min: 0, max: 1 }),
    arrowTextColor: validateString(input.arrowTextColor, "arrowTextColor"),
    arrowHaloColor: validateString(input.arrowHaloColor, "arrowHaloColor"),
  };
}

function validateSignalLayerStyle(input: unknown): SignalLayerStyle {
  if (!isPlainObject(input)) throw new Error("Style JSON must be an object.");
  ensureOnlyKnownKeys(input, [
    "color",
    "radius",
    "opacity",
    "strokeColor",
    "strokeWidth",
    "textColor",
    "textHaloColor",
  ]);
  return {
    color: validateString(input.color, "color"),
    radius: validateNumber(input.radius, "radius", { min: 0.1 }),
    opacity: validateNumber(input.opacity, "opacity", { min: 0, max: 1 }),
    strokeColor: validateString(input.strokeColor, "strokeColor"),
    strokeWidth: validateNumber(input.strokeWidth, "strokeWidth", { min: 0 }),
    textColor: validateString(input.textColor, "textColor"),
    textHaloColor: validateString(input.textHaloColor, "textHaloColor"),
  };
}

function validateRuntimeLaneLayerStyle(input: unknown): RuntimeLaneLayerStyle {
  if (!isPlainObject(input)) throw new Error("Style JSON must be an object.");
  ensureOnlyKnownKeys(input, ["color", "opacity"]);
  return {
    color: validateString(input.color, "color"),
    opacity: validateNumber(input.opacity, "opacity", { min: 0, max: 1 }),
  };
}

export function stylableLayerKey(selection: StylableLayerSelection) {
  return `${selection.kind}:${selection.id}`;
}

export function getDefaultLayerStyle(
  selection: StylableLayerSelection,
): StylableLayerStyle {
  switch (selection.kind) {
    case "enrichment":
      return DEFAULT_ENRICHMENT_LAYER_STYLES[selection.id];
    case "road-network":
      return DEFAULT_ROAD_NETWORK_LAYER_STYLES[selection.id];
    case "signal":
      return (
        DEFAULT_SIGNAL_LAYER_STYLES[selection.id] ?? {
          color: "#737373",
          radius: 4,
          opacity: 0.9,
          strokeColor: "#0a0a0a",
          strokeWidth: 1,
          textColor: "#ffffff",
          textHaloColor: "#737373",
        }
      );
    case "runtime-lane":
      return DEFAULT_RUNTIME_LANE_STYLES[selection.id];
  }
}

export function getLayerStyle(
  overrides: LayerStyleOverrides,
  selection: StylableLayerSelection,
): StylableLayerStyle {
  switch (selection.kind) {
    case "enrichment":
      return overrides.enrichment[selection.id] ?? getDefaultLayerStyle(selection);
    case "road-network":
      return overrides.roadNetwork[selection.id] ?? getDefaultLayerStyle(selection);
    case "signal":
      return overrides.signal[selection.id] ?? getDefaultLayerStyle(selection);
    case "runtime-lane":
      return overrides.runtimeLane[selection.id] ?? getDefaultLayerStyle(selection);
  }
}

function coerceLayerStyleObject(
  selection: StylableLayerSelection,
  value: unknown,
): StylableLayerStyle {
  const baseStyle = getDefaultLayerStyle(selection);
  if (!isPlainObject(value)) throw new Error("Style JSON must be an object.");
  const mergedValue = {
    ...baseStyle,
    ...value,
  };

  switch (selection.kind) {
    case "enrichment":
      return validateEnrichmentLayerStyle(mergedValue);
    case "road-network":
      return validateRoadNetworkLayerStyle(mergedValue);
    case "signal":
      return validateSignalLayerStyle(mergedValue);
    case "runtime-lane":
      return validateRuntimeLaneLayerStyle(mergedValue);
  }
}

export function parseLayerStyleJson(
  selection: StylableLayerSelection,
  raw: string,
): { ok: true; value: StylableLayerStyle } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return {
      ok: true,
      value: coerceLayerStyleObject(selection, parsed),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON.",
    };
  }
}

export function serializeLayerStyle(style: StylableLayerStyle) {
  return JSON.stringify(style, null, 2);
}

export function setLayerStyleOverride(
  overrides: LayerStyleOverrides,
  selection: StylableLayerSelection,
  style: StylableLayerStyle,
): LayerStyleOverrides {
  switch (selection.kind) {
    case "enrichment":
      return {
        ...overrides,
        enrichment: { ...overrides.enrichment, [selection.id]: style as EnrichmentLayerStyle },
      };
    case "road-network":
      return {
        ...overrides,
        roadNetwork: {
          ...overrides.roadNetwork,
          [selection.id]: style as RoadNetworkLayerStyle,
        },
      };
    case "signal":
      return {
        ...overrides,
        signal: { ...overrides.signal, [selection.id]: style as SignalLayerStyle },
      };
    case "runtime-lane":
      return {
        ...overrides,
        runtimeLane: {
          ...overrides.runtimeLane,
          [selection.id]: style as RuntimeLaneLayerStyle,
        },
      };
  }
}

export function clearLayerStyleOverride(
  overrides: LayerStyleOverrides,
  selection: StylableLayerSelection,
): LayerStyleOverrides {
  switch (selection.kind) {
    case "enrichment": {
      const next = { ...overrides.enrichment };
      delete next[selection.id];
      return { ...overrides, enrichment: next };
    }
    case "road-network": {
      const next = { ...overrides.roadNetwork };
      delete next[selection.id];
      return { ...overrides, roadNetwork: next };
    }
    case "signal": {
      const next = { ...overrides.signal };
      delete next[selection.id];
      return { ...overrides, signal: next };
    }
    case "runtime-lane": {
      const next = { ...overrides.runtimeLane };
      delete next[selection.id];
      return { ...overrides, runtimeLane: next };
    }
  }
}

export function normalizeLayerStyleOverrides(value: unknown): LayerStyleOverrides {
  if (!isPlainObject(value)) return EMPTY_LAYER_STYLE_OVERRIDES;

  const normalized: LayerStyleOverrides = {
    enrichment: {},
    roadNetwork: {},
    signal: {},
    runtimeLane: {},
  };

  const enrichment = isPlainObject(value.enrichment) ? value.enrichment : {};
  for (const [layerId, style] of Object.entries(enrichment)) {
    if (!(layerId in DEFAULT_ENRICHMENT_LAYER_STYLES)) continue;
    try {
      normalized.enrichment[layerId as MapOverlayLayerId] = coerceLayerStyleObject(
        {
          kind: "enrichment",
          id: layerId as MapOverlayLayerId,
          label: layerId,
        },
        style,
      ) as EnrichmentLayerStyle;
    } catch {
      // Ignore invalid persisted overrides.
    }
  }

  const roadNetwork = isPlainObject(value.roadNetwork) ? value.roadNetwork : {};
  for (const [layerId, style] of Object.entries(roadNetwork)) {
    if (!(layerId in DEFAULT_ROAD_NETWORK_LAYER_STYLES)) continue;
    try {
      normalized.roadNetwork[layerId as RoadNetworkFeatureTypeId] = coerceLayerStyleObject(
        {
          kind: "road-network",
          id: layerId as RoadNetworkFeatureTypeId,
          label: layerId,
        },
        style,
      ) as RoadNetworkLayerStyle;
    } catch {
      // Ignore invalid persisted overrides.
    }
  }

  const signal = isPlainObject(value.signal) ? value.signal : {};
  for (const [layerId, style] of Object.entries(signal)) {
    try {
      normalized.signal[layerId] = coerceLayerStyleObject(
        {
          kind: "signal",
          id: layerId,
          label: layerId,
        },
        style,
      ) as SignalLayerStyle;
    } catch {
      // Ignore invalid persisted overrides.
    }
  }

  const runtimeLane = isPlainObject(value.runtimeLane) ? value.runtimeLane : {};
  for (const [layerId, style] of Object.entries(runtimeLane)) {
    if (!(layerId in DEFAULT_RUNTIME_LANE_STYLES)) continue;
    try {
      normalized.runtimeLane[layerId as RuntimeLaneTypeId] = coerceLayerStyleObject(
        {
          kind: "runtime-lane",
          id: layerId as RuntimeLaneTypeId,
          label: layerId,
        },
        style,
      ) as RuntimeLaneLayerStyle;
    } catch {
      // Ignore invalid persisted overrides.
    }
  }

  return normalized;
}
