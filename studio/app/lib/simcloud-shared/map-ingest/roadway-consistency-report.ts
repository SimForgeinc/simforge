import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import type { RoadwayConsistencyCoreOptions } from "../map-topology/roadway-consistency-core.mjs";

export const ROADWAY_CONSISTENCY_SCHEMA_VERSION = "simforge.roadway-consistency.v1";
export const ROADWAY_CONSISTENCY_VALIDATOR_VERSION = "simforge-roadway-consistency/1.0.0";
const SHA256 = /^[a-f0-9]{64}$/;
const VERDICTS = new Set(["pass", "review", "fail"] as const);
const SOURCE_DIGEST_NAMES = Object.freeze([
  "xodrSha256",
  "topologySha256",
  "sourceRoadGeometrySha256",
  "finalRoadSha256",
  "roadAuditSha256",
] as const);

type SourceDigestName = (typeof SOURCE_DIGEST_NAMES)[number];
export type RoadwayConsistencySourceDigests = Record<SourceDigestName, string>;

export type RoadwayConsistencyInterval = {
  laneARsl?: string;
  laneBRsl?: string;
  confidence?: number;
  [key: string]: unknown;
};

export type RoadwayConsistencyIssue = {
  id?: string;
  code?: string;
  severity?: string;
  intervalIndex?: number | null;
  laneARsl?: string;
  laneBRsl?: string;
  [key: string]: unknown;
};

export type RoadwayConsistencyStats = {
  candidatePairCount: number;
  inferredIntervalCount: number;
  issueCount: number;
  [key: string]: unknown;
};

export type RoadwayConsistencyCoreReport = {
  format: string;
  sourceXodrSha256?: string | null;
  stats: RoadwayConsistencyStats;
  intervals: RoadwayConsistencyInterval[];
  issues: RoadwayConsistencyIssue[];
  [key: string]: unknown;
};

export type RoadwayConsistencyReport = RoadwayConsistencyCoreReport & {
  mapId: string;
  validatorVersion: string;
  sourceDigests: RoadwayConsistencySourceDigests;
  verdict: "pass" | "review" | "fail";
  visualEvidence: {
    status: "available" | "unavailable";
    reason?: string;
    markingPrimitiveCount?: number;
    auditSha256?: string;
  };
  runtimeEvidence: { status: "available" | "not-probed" };
};

export type RoadwayConsistencyValidator<Topology> = (
  topology: Topology,
  options?: RoadwayConsistencyCoreOptions,
) => unknown;

export type BuildRoadwayConsistencyReportInput<Topology> = {
  mapId: string;
  topology: Topology;
  roadAudit?: { keptMarkingPrimitives?: unknown } | null;
  sourceDigests: RoadwayConsistencySourceDigests;
  validate: RoadwayConsistencyValidator<Topology>;
};

function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

/**
 * The report binds complete canonical-validator output to immutable build
 * inputs; material counts alone cannot spatially prove lane-boundary coverage.
 */
export function buildRoadwayConsistencyReport<Topology>({
  mapId,
  topology,
  roadAudit,
  sourceDigests,
  validate,
}: BuildRoadwayConsistencyReportInput<Topology>): RoadwayConsistencyReport {
  if (!mapId || !topology || typeof validate !== "function" || !sourceDigests
    || Object.keys(sourceDigests).sort().join("\0") !== [...SOURCE_DIGEST_NAMES].sort().join("\0")
    || SOURCE_DIGEST_NAMES.some((name) => !SHA256.test(sourceDigests[name]))) {
    throw new Error("roadway_consistency_invalid_inputs");
  }
  const core = validate(topology) as RoadwayConsistencyCoreReport | null | undefined;
  if (core?.format !== ROADWAY_CONSISTENCY_SCHEMA_VERSION || !core.stats
    || !Array.isArray(core.intervals) || !Array.isArray(core.issues)) {
    throw new Error("roadway_consistency_invalid_core_report");
  }
  if (core.sourceXodrSha256 !== sourceDigests.xodrSha256) {
    throw new Error("roadway_consistency_core_source_mismatch");
  }
  const visualEvidence: RoadwayConsistencyReport["visualEvidence"] = {
    status: "unavailable",
    reason: "road-material audit does not spatially bind marking primitives to lane-boundary intervals",
    markingPrimitiveCount: Number(roadAudit?.keptMarkingPrimitives ?? 0),
    auditSha256: sourceDigests.roadAuditSha256,
  };
  const runtimeEvidence: RoadwayConsistencyReport["runtimeEvidence"] = { status: "not-probed" };
  const blockingError = core.issues.some((issue) => {
    if (issue.severity !== "error") return false;
    if (!Number.isSafeInteger(issue.intervalIndex) || (issue.intervalIndex ?? -1) < 0
      || (issue.intervalIndex ?? core.intervals.length) >= core.intervals.length) return true;
    const confidence = core.intervals[issue.intervalIndex as number]?.confidence;
    return !Number.isFinite(confidence) || (confidence as number) >= 0.9;
  });
  const verdict = blockingError
    ? "fail"
    : core.issues.length > 0 || visualEvidence.status !== "available" || runtimeEvidence.status !== "available"
      ? "review"
      : "pass";
  const report: RoadwayConsistencyReport = {
    ...core,
    mapId,
    validatorVersion: ROADWAY_CONSISTENCY_VALIDATOR_VERSION,
    sourceDigests,
    verdict,
    visualEvidence,
    runtimeEvidence,
  };
  return validateRoadwayConsistencyReport(report, { mapId, sourceDigests });
}

export type ExpectedRoadwayConsistencyReport = {
  mapId?: string;
  sourceDigests?: Partial<RoadwayConsistencySourceDigests>;
};

export function validateRoadwayConsistencyReport(
  candidate: unknown,
  expected: ExpectedRoadwayConsistencyReport = {},
): RoadwayConsistencyReport {
  const report = candidate as RoadwayConsistencyReport;
  if (report?.format !== ROADWAY_CONSISTENCY_SCHEMA_VERSION
    || typeof report.mapId !== "string" || report.mapId.length === 0
    || typeof report.validatorVersion !== "string" || report.validatorVersion.length === 0
    || !VERDICTS.has(report.verdict) || !Array.isArray(report.intervals) || !Array.isArray(report.issues)
    || !report.stats || !Number.isSafeInteger(report.stats.candidatePairCount)
    || !Number.isSafeInteger(report.stats.inferredIntervalCount) || !Number.isSafeInteger(report.stats.issueCount)
    || report.stats.inferredIntervalCount !== report.intervals.length || report.stats.issueCount !== report.issues.length
    || !report.sourceDigests
    || Object.keys(report.sourceDigests).sort().join("\0") !== [...SOURCE_DIGEST_NAMES].sort().join("\0")
    || SOURCE_DIGEST_NAMES.some((name) => !SHA256.test(report.sourceDigests[name]))
    || report.sourceXodrSha256 !== report.sourceDigests.xodrSha256
    || !["available", "unavailable"].includes(report.visualEvidence?.status)
    || !["available", "not-probed"].includes(report.runtimeEvidence?.status)) {
    throw new Error("roadway_consistency_invalid_report");
  }
  if (expected.mapId && report.mapId !== expected.mapId) throw new Error("roadway_consistency_map_mismatch");
  for (const [name, digest] of Object.entries(expected.sourceDigests ?? {})) {
    if (report.sourceDigests[name as SourceDigestName] !== digest) {
      throw new Error(`roadway_consistency_source_mismatch:${name}`);
    }
  }
  const ids = new Set<string>();
  for (const issue of report.issues) {
    if (typeof issue?.id !== "string" || ids.has(issue.id) || typeof issue.code !== "string"
      || !["warning", "error"].includes(issue.severity ?? "")) throw new Error("roadway_consistency_invalid_issue");
    ids.add(issue.id);
    if (issue.intervalIndex !== null) {
      if (!Number.isSafeInteger(issue.intervalIndex) || (issue.intervalIndex ?? -1) < 0
        || (issue.intervalIndex ?? report.intervals.length) >= report.intervals.length) {
        throw new Error("roadway_consistency_invalid_issue");
      }
      const interval = report.intervals[issue.intervalIndex as number];
      if (interval?.laneARsl !== issue.laneARsl || interval?.laneBRsl !== issue.laneBRsl) {
        throw new Error("roadway_consistency_invalid_issue");
      }
    }
  }
  const blockingError = report.issues.some((issue) => issue.severity === "error"
    && (!Number.isSafeInteger(issue.intervalIndex) || (issue.intervalIndex ?? -1) < 0
      || (issue.intervalIndex ?? report.intervals.length) >= report.intervals.length
      || !Number.isFinite(report.intervals[issue.intervalIndex as number]?.confidence)
      || (report.intervals[issue.intervalIndex as number]?.confidence ?? Number.NEGATIVE_INFINITY) >= 0.9));
  if ((report.verdict === "fail") !== blockingError) {
    throw new Error("roadway_consistency_verdict_issue_mismatch");
  }
  if (report.verdict === "pass" && (report.issues.length > 0
    || report.visualEvidence.status !== "available" || report.runtimeEvidence.status !== "available")) {
    throw new Error("roadway_consistency_verdict_issue_mismatch");
  }
  return report;
}

export function serializeRoadwayConsistencyReport(report: RoadwayConsistencyReport): Buffer {
  validateRoadwayConsistencyReport(report);
  return gzipSync(
    Buffer.from(`${canonicalJson(report)}\n`),
    { level: 9, mtime: 0 } as Parameters<typeof gzipSync>[1] & { mtime: number },
  );
}

export function parseRoadwayConsistencyReport(
  bytes: Uint8Array,
  expected?: ExpectedRoadwayConsistencyReport,
): RoadwayConsistencyReport {
  let report: unknown;
  try {
    report = JSON.parse(gunzipSync(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("roadway_consistency_invalid_gzip");
  }
  return validateRoadwayConsistencyReport(report, expected);
}

export function roadwayConsistencyDigest(bytes: Uint8Array): string {
  return sha256(bytes);
}

export function assertRoadwayConsistencyPreparation(
  report: RoadwayConsistencyReport,
  mapId = report?.mapId,
): RoadwayConsistencyReport {
  validateRoadwayConsistencyReport(report, mapId ? { mapId } : {});
  if (report.verdict === "fail") throw new Error(`roadway_consistency_failed:${mapId}`);
  return report;
}
