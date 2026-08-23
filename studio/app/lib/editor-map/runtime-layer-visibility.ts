import type { RuntimeMapResponse } from "@/app/lib/runtime/runtime-types";
import type { RuntimeRoadOverlayCollection } from "./types";

export const RUNTIME_LANE_TYPES = [
  {
    id: "driving",
    label: "Driving",
    color: "#38bdf8",
  },
  {
    id: "bidirectional",
    label: "Bidirectional",
    color: "#f59e0b",
  },
  {
    id: "biking",
    label: "Bike",
    color: "#22c55e",
  },
  {
    id: "sidewalk",
    label: "Sidewalk",
    color: "#f8fafc",
  },
  {
    id: "parking",
    label: "Parking",
    color: "#a78bfa",
  },
  {
    id: "shoulder",
    label: "Shoulder",
    color: "#cbd5e1",
  },
  {
    id: "other",
    label: "Other",
    color: "#f97316",
  },
] as const;

export type RuntimeLaneTypeId = (typeof RUNTIME_LANE_TYPES)[number]["id"];

export type RuntimeLaneTypeVisibility = Record<RuntimeLaneTypeId, boolean>;

export const ALL_RUNTIME_LANE_TYPE_IDS: RuntimeLaneTypeId[] = [
  ...RUNTIME_LANE_TYPES.map((entry) => entry.id),
];

export const DEFAULT_RUNTIME_LANE_TYPE_VISIBILITY: RuntimeLaneTypeVisibility = {
  driving: true,
  bidirectional: true,
  biking: true,
  sidewalk: true,
  parking: true,
  shoulder: true,
  other: true,
};

function emptyRuntimeLaneTypeCounts(): Record<RuntimeLaneTypeId, number> {
  return {
    driving: 0,
    bidirectional: 0,
    biking: 0,
    sidewalk: 0,
    parking: 0,
    shoulder: 0,
    other: 0,
  };
}

export function normalizeRuntimeLaneType(
  laneType: string | null | undefined,
): RuntimeLaneTypeId {
  const normalized = (laneType ?? "other").trim().toLowerCase() as RuntimeLaneTypeId;
  return normalized in DEFAULT_RUNTIME_LANE_TYPE_VISIBILITY ? normalized : "other";
}

export function isRuntimeLaneTypeVisible(
  visibility: RuntimeLaneTypeVisibility,
  laneType: string | null | undefined,
) {
  return visibility[normalizeRuntimeLaneType(laneType)] ?? visibility.other;
}

export function computeRuntimeLaneTypeCountsFromRuntime(
  runtime: RuntimeMapResponse | null | undefined,
): Record<RuntimeLaneTypeId, number> {
  const counts = emptyRuntimeLaneTypeCounts();

  if (runtime?.lane_type_counts) {
    for (const [laneType, count] of Object.entries(runtime.lane_type_counts)) {
      counts[normalizeRuntimeLaneType(laneType)] += count;
    }
    return counts;
  }

  for (const segment of runtime?.road_segments ?? []) {
    counts[normalizeRuntimeLaneType(segment.lane_type)] += 1;
  }

  return counts;
}

export function computeRuntimeLaneTypeCounts(
  overlay: { data?: RuntimeRoadOverlayCollection | null } | null | undefined,
): Record<RuntimeLaneTypeId, number> {
  const counts = emptyRuntimeLaneTypeCounts();

  const features = overlay?.data?.features;
  if (!features) return counts;

  for (const feature of features) {
    if (feature.properties.feature_kind !== "lane_centerline") continue;
    counts[normalizeRuntimeLaneType(feature.properties.lane_type)] += 1;
  }

  return counts;
}
