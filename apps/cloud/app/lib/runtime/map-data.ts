import type { FeatureId } from "./feature-catalog";

/** Axis-aligned bounding box with computed width and height. */
export type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

/** SVG viewBox dimensions for map rendering. */
export type ViewBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** An object placed on a road (e.g. sign, signal) with Frenet coordinates. */
export type RoadObject = {
  id: string;
  name: string;
  s: number;
  t: number;
  tags: FeatureId[];
};

/** Summary of a lane section within a road, including lane counts and tags. */
export type LaneSectionRecord = {
  index: number;
  label: string;
  s: number;
  drivingLeft: number;
  drivingRight: number;
  parkingLeft: number;
  parkingRight: number;
  totalDriving: number;
  totalWidth: number;
  laneTypes: string[];
  tags: FeatureId[];
};

/** A rendered lane-marking line with SVG path and dash style. */
export type LaneLine = {
  path: string;
  dashed: boolean;
  type: "center" | "divider" | "edge";
};

/** Full record for a single road including geometry, lane sections, and objects. */
export type RoadRecord = {
  id: string;
  name: string;
  junctionId: string;
  isIntersection: boolean;
  length: number;
  path: string;
  surface: string;
  drivingSurface: string;
  laneLines: LaneLine[];
  bounds: Bounds;
  tags: FeatureId[];
  sections: LaneSectionRecord[];
  objects: RoadObject[];
};

/** SVG path data for a crosswalk polygon. */
export type CrosswalkRecord = {
  path: string;
};

/** Position of a stop-line marker in local map coordinates. */
export type StopMarkerRecord = {
  x: number;
  y: number;
};

/** Complete processed record for a single map file with roads, crosswalks, and stats. */
export type MapRecord = {
  name: string;
  fileName: string;
  optimized: boolean;
  bounds: Bounds;
  stats: {
    roads: number;
    junctionDefinitions: number;
    laneTypes: Record<string, number>;
    featureCounts: Record<FeatureId, number>;
  };
  roads: RoadRecord[];
  crosswalks: CrosswalkRecord[];
  stopMarkers: StopMarkerRecord[];
};

/** Top-level dataset containing all processed maps and aggregate statistics. */
export type MapDataset = {
  generatedAt: string;
  sourceDir: string;
  summary: {
    maps: number;
    roads: number;
    junctions: number;
    roadsWithParking: number;
  };
  maps: MapRecord[];
};
