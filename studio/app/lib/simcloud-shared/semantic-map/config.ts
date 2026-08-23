import type { SemanticMapBuildConfig } from "./types";

export const DEFAULT_SEMANTIC_MAP_BUILD_CONFIG: SemanticMapBuildConfig = {
  maximumSeamGapM: 3,
  maximumSeamHeadingDeltaRad: Math.PI / 6,
  maximumSeamWidthRatio: 1.8,
  maximumSeamElevationDeltaM: 1.5,
  maximumApproachBoundaryDistanceM: 15,
  maximumApproachHeadingDeltaRad: (25 * Math.PI) / 180,
  maximumApproachElevationDeltaM: 1.5,
  maximumInternalFragments: 32,
  maximumVariantsPerGate: 8,
  minimumConflictAngleRad: Math.PI / 12,
  conflictEndpointExclusionM: 2,
  conflictClusterRadiusM: 6,
};
