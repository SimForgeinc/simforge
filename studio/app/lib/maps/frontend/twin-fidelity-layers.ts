/**
 * Twin-fidelity scorecard layers — the map-facing model for the
 * `twin_eval_scorecard` artifact produced by services/digital-twin-eval
 * (schema: digital_twin_eval/scorecard.py; plan:
 * plans/twin-eval/2026-07-03-digital-twin-eval-plan.md).
 *
 * One H3-cell FeatureCollection drives four toggleable sub-layers: composite
 * fidelity, the ground/structure split, and coverage. Cells are keyed by H3
 * index (not twin tile id) so the artifact survives twin re-bakes.
 */

import type { FillLayerSpecification } from "maplibre-gl";

/** Per-cell properties of a twin_eval_scorecard feature (see scorecard.py). */
export type TwinFidelityCellProperties = {
  h3_index: string;
  coverage: "scored" | "none";
  geometric_fidelity: number | null;
  composite_fidelity: number | null;
  ground_fidelity: number | null;
  structure_fidelity: number | null;
  chamfer_m: number | null;
  inlier_frac_0p5m: number | null;
  inlier_frac_1m: number | null;
  n_ref: number;
  n_twin: number;
};

/** Top-level artifact metadata (FeatureCollection `properties`). */
export type TwinFidelityScorecardMeta = {
  artifact: "twin_eval_scorecard";
  schema_version: string;
  axis: string;
  twin_build_id: string;
  ref_version: string;
  region: string;
  h3_res: number;
  created_at: string;
};

export type TwinFidelityScorecard = {
  type: "FeatureCollection";
  properties: TwinFidelityScorecardMeta;
  features: Array<{
    type: "Feature";
    geometry: { type: "Polygon"; coordinates: number[][][] };
    properties: TwinFidelityCellProperties;
  }>;
};

export type TwinFidelitySubLayerId =
  | "composite"
  | "ground"
  | "structure"
  | "coverage";

export const TWIN_FIDELITY_SOURCE_ID = "twin-fidelity";

/** Selectable artifact resolutions (H3 res → approximate hex width). */
export const TWIN_FIDELITY_RESOLUTIONS: Array<{
  res: number;
  label: string;
}> = [
  { res: 11, label: "24 m" },
  { res: 12, label: "9 m" },
  { res: 13, label: "3.5 m" },
];

export function twinFidelityLayerId(id: TwinFidelitySubLayerId): string {
  return `${TWIN_FIDELITY_SOURCE_ID}-${id}-fill`;
}

/**
 * Shared fidelity ramp (0–100 → red→amber→green). Uses the standard
 * red/amber/emerald trio so the ramp reads against both basemap themes.
 */
function fidelityRamp(property: string): FillLayerSpecification["paint"] {
  return {
    "fill-color": [
      "case",
      ["==", ["get", "coverage"], "none"],
      "#64748b", // slate — no twin data (distinct from a low score)
      [
        "interpolate",
        ["linear"],
        ["coalesce", ["get", property], 0],
        0, "#ef4444",
        50, "#f59e0b",
        80, "#22c55e",
        100, "#15803d",
      ],
    ],
    "fill-opacity": 0.55,
    "fill-outline-color": "rgba(255,255,255,0.35)",
  } as FillLayerSpecification["paint"];
}

export const TWIN_FIDELITY_SUBLAYERS: Array<{
  id: TwinFidelitySubLayerId;
  label: string;
  description: string;
  /** Swatch colour for the Layers panel row. */
  dot: string;
  paint: FillLayerSpecification["paint"];
}> = [
  {
    id: "composite",
    label: "Composite fidelity",
    description: "0–100: fraction of real lidar within 1 m of the twin",
    dot: "#22c55e",
    paint: fidelityRamp("composite_fidelity"),
  },
  {
    id: "ground",
    label: "Road / ground fidelity",
    description: "Road-surface layer only",
    dot: "#38bdf8",
    paint: fidelityRamp("ground_fidelity"),
  },
  {
    id: "structure",
    label: "Structure fidelity",
    description: "Buildings / vertical structure only",
    dot: "#a78bfa",
    paint: fidelityRamp("structure_fidelity"),
  },
  {
    id: "coverage",
    label: "Coverage",
    description: "Where the twin models what the drives observed",
    dot: "#64748b",
    paint: {
      "fill-color": [
        "case",
        ["==", ["get", "coverage"], "scored"],
        "#22c55e",
        "#ef4444",
      ],
      "fill-opacity": 0.4,
      "fill-outline-color": "rgba(255,255,255,0.35)",
    } as FillLayerSpecification["paint"],
  },
];

/** Cell counts for the Layers panel rows. */
export function twinFidelityCounts(scorecard: TwinFidelityScorecard | null): {
  scored: number;
  total: number;
} {
  if (!scorecard) return { scored: 0, total: 0 };
  const total = scorecard.features.length;
  const scored = scorecard.features.filter(
    (f) => f.properties.coverage === "scored",
  ).length;
  return { scored, total };
}

/**
 * Fetch the scorecard artifact for a map asset via the existing presigned
 * 3d-asset route. Absence (404/403) simply means no evaluation has been
 * imported for this asset — callers hide the layer group.
 */
export async function fetchTwinFidelityScorecard(
  mapAssetId: string,
  h3Res = 11,
): Promise<TwinFidelityScorecard | null> {
  // Per-resolution artifacts live side by side; the un-suffixed name is the
  // legacy res-11 default, kept as a fallback for already-imported runs.
  const candidates =
    h3Res === 11
      ? [`scorecard_res11.geojson`, `scorecard.geojson`]
      : [`scorecard_res${h3Res}.geojson`];
  for (const name of candidates) {
    try {
      const res = await fetch(
        `/api/map-assets/${mapAssetId}/3d-asset/twin-eval/${name}?optional=1`,
      );
      if (!res.ok) continue;
      const parsed = (await res.json()) as TwinFidelityScorecard;
      if (parsed?.properties?.artifact !== "twin_eval_scorecard") continue;
      if (!Array.isArray(parsed.features)) continue;
      return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
