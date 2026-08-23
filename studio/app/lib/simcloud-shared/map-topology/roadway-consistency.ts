import { z } from "zod";
import type { MapTopologyIndex } from "./types";
import {
  ROADWAY_CONSISTENCY_FORMAT as CORE_FORMAT,
  validateRoadwayConsistency as validateCore,
} from "./roadway-consistency-core.mjs";

export const ROADWAY_CONSISTENCY_FORMAT = CORE_FORMAT;

export const RoadwayConsistencyIssueCodeSchema = z.enum([
  "GEOMETRIC_ADJACENCY_SEMANTIC_MISSING",
  "JUNCTION_ADJACENCY_DROPPED",
  "SEMANTIC_ADJACENCY_NOT_GEOMETRIC",
]);
export type RoadwayConsistencyIssueCode = z.infer<typeof RoadwayConsistencyIssueCodeSchema>;

export const RoadwayConsistencyIntervalSchema = z.object({
  laneARsl: z.string(),
  laneBRsl: z.string(),
  sideFromA: z.enum(["left", "right"]),
  startDistanceA: z.number().nonnegative(),
  endDistanceA: z.number().nonnegative(),
  startFractionA: z.number().min(0).max(1),
  endFractionA: z.number().min(0).max(1),
  lengthM: z.number().nonnegative(),
  meanCenterDistanceM: z.number().nonnegative(),
  maxHeadingDeltaDeg: z.number().nonnegative(),
  sampleCount: z.number().int().positive(),
  junctionContinuity: z.boolean(),
  semanticAdjacent: z.boolean(),
  semanticLaneChangeAllowed: z.boolean(),
  confidence: z.number().min(0).max(1),
}).strict();
export type RoadwayConsistencyInterval = z.infer<typeof RoadwayConsistencyIntervalSchema>;

export const RoadwayConsistencyIssueSchema = z.object({
  id: z.string().min(1),
  code: RoadwayConsistencyIssueCodeSchema,
  severity: z.enum(["warning", "error"]),
  laneARsl: z.string(),
  laneBRsl: z.string(),
  intervalIndex: z.number().int().nonnegative().nullable(),
  message: z.string().min(1),
}).strict();
export type RoadwayConsistencyIssue = z.infer<typeof RoadwayConsistencyIssueSchema>;

export const RoadwayConsistencyReportSchema = z.object({
  format: z.literal(ROADWAY_CONSISTENCY_FORMAT),
  mapName: z.string().min(1),
  sourceXodrSha256: z.string().nullable(),
  config: z.object({
    sampleStepM: z.number().positive(),
    spatialCellM: z.number().positive(),
    maxCenterDistanceM: z.number().positive(),
    maxHeadingDeltaDeg: z.number().positive(),
    maxElevationDeltaM: z.number().positive(),
    minIntervalLengthM: z.number().nonnegative(),
  }).strict(),
  stats: z.object({
    eligibleLaneCount: z.number().int().nonnegative(),
    candidatePairCount: z.number().int().nonnegative(),
    inferredIntervalCount: z.number().int().nonnegative(),
    issueCount: z.number().int().nonnegative(),
  }).strict(),
  intervals: z.array(RoadwayConsistencyIntervalSchema),
  issues: z.array(RoadwayConsistencyIssueSchema),
}).strict().superRefine((report, context) => {
  if (report.stats.inferredIntervalCount !== report.intervals.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "inferredIntervalCount"],
      message: "inferredIntervalCount must equal intervals.length",
    });
  }
  if (report.stats.issueCount !== report.issues.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "issueCount"],
      message: "issueCount must equal issues.length",
    });
  }
  const issueIds = new Set<string>();
  report.issues.forEach((issue, issueIndex) => {
    if (issueIds.has(issue.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issues", issueIndex, "id"],
        message: "issue IDs must be unique",
      });
    }
    issueIds.add(issue.id);
    if (issue.intervalIndex === null) return;
    const interval = report.intervals[issue.intervalIndex];
    if (!interval) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issues", issueIndex, "intervalIndex"],
        message: "intervalIndex must reference an existing interval",
      });
      return;
    }
    if (interval.laneARsl !== issue.laneARsl || interval.laneBRsl !== issue.laneBRsl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issues", issueIndex, "intervalIndex"],
        message: "referenced interval must match the issue lane pair",
      });
    }
  });
});
export type RoadwayConsistencyReport = z.infer<typeof RoadwayConsistencyReportSchema>;

export type RoadwayConsistencyOptions = {
  sampleStepM?: number;
  spatialCellM?: number;
  maxCenterDistanceM?: number;
  maxHeadingDeltaDeg?: number;
  maxElevationDeltaM?: number;
  minIntervalLengthM?: number;
  /** Optional elevations aligned to each lane's source polyline. */
  laneElevationsM?: Readonly<Record<string, readonly number[]>>;
};

/**
 * Typed/schema-checked facade over the canonical dependency-free `.mjs` core.
 * The plain-Node derivative pipeline imports that core directly; TypeScript
 * callers use this facade and therefore share the exact numerical algorithm.
 */
export function validateRoadwayConsistency(
  topology: Pick<MapTopologyIndex, "mapName" | "source" | "lanes">,
  options: RoadwayConsistencyOptions = {},
): RoadwayConsistencyReport {
  return RoadwayConsistencyReportSchema.parse(validateCore(topology, options));
}
