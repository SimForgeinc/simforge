import type { MapTopologyIndex } from "./types.js";

export const ROADWAY_CONSISTENCY_FORMAT: "simforge.roadway-consistency.v1";

export type RoadwayConsistencyCoreOptions = {
  sampleStepM?: number;
  spatialCellM?: number;
  maxCenterDistanceM?: number;
  maxHeadingDeltaDeg?: number;
  maxElevationDeltaM?: number;
  minIntervalLengthM?: number;
  laneElevationsM?: Readonly<Record<string, readonly number[]>>;
};

export function validateRoadwayConsistency(
  topology: Pick<MapTopologyIndex, "mapName" | "source" | "lanes">,
  options?: RoadwayConsistencyCoreOptions,
): unknown;
