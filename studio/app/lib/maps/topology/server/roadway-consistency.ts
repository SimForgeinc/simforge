import {
  RoadwayConsistencyReportSchema,
  type RoadwayConsistencyIssue,
  type RoadwayConsistencyReport,
} from "@simforge/studio-shared";

export const ROADWAY_CONSISTENCY_ATTESTATION_SCHEMA_VERSION =
  "simforge.roadway-consistency-attestation.v1" as const;
export const BLOCKING_ROADWAY_CONSISTENCY_CONFIDENCE = 0.9;

export type RoadwayConsistencyVerdict = "pass" | "review" | "fail";

function issueConfidence(
  report: RoadwayConsistencyReport,
  issue: RoadwayConsistencyIssue,
): number {
  if (issue.intervalIndex == null) return 1;
  return report.intervals[issue.intervalIndex]?.confidence ?? 0;
}

export function blockingRoadwayConsistencyIssues(
  report: RoadwayConsistencyReport,
): RoadwayConsistencyIssue[] {
  return report.issues.filter(
    (issue) =>
      issue.severity === "error" &&
      issueConfidence(report, issue) >= BLOCKING_ROADWAY_CONSISTENCY_CONFIDENCE,
  );
}

export function roadwayConsistencyVerdict(
  report: RoadwayConsistencyReport,
): RoadwayConsistencyVerdict {
  if (blockingRoadwayConsistencyIssues(report).length > 0) return "fail";
  return report.issues.length > 0 ? "review" : "pass";
}

/** Parse at the trust boundary and bind the report to this exact runtime. */
export function parseRoadwayConsistencyReport(
  value: unknown,
  expected: {
    topologyMapName: string;
    xodrSha256: string;
  },
): RoadwayConsistencyReport {
  const report = RoadwayConsistencyReportSchema.parse(value);
  for (const issue of report.issues) {
    if (
      issue.intervalIndex != null &&
      issue.intervalIndex >= report.intervals.length
    ) {
      throw new Error(
        `Roadway consistency issue ${issue.id} references a missing interval.`,
      );
    }
  }
  if (report.mapName !== expected.topologyMapName) {
    throw new Error("Roadway consistency report belongs to another topology map.");
  }
  if (report.sourceXodrSha256 !== expected.xodrSha256) {
    throw new Error(
      "Roadway consistency report was computed from another OpenDRIVE source.",
    );
  }
  return report;
}
