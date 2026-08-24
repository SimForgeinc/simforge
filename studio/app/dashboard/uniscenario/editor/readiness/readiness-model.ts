import {
  solutionForSimulationIssue,
  type SimulationIssue,
} from "../simulation-issues";

export const READINESS_SECTIONS = ["realism", "behavior", "export"] as const;

export type ReadinessSection = (typeof READINESS_SECTIONS)[number];
export type ReadinessStatus = "ready" | "needs-attention";

export type ReadinessItem = {
  readonly issue: SimulationIssue;
  readonly section: ReadinessSection;
  readonly title: string;
  readonly detail: string;
  readonly solution: string;
};

export type ReadinessSummary = {
  readonly status: ReadinessStatus;
  readonly issueCount: number;
  readonly errorCount: number;
  readonly groups: Readonly<Record<ReadinessSection, readonly ReadinessItem[]>>;
};

const EXPORT_TERMS = [
  "approximated",
  "could not be represented",
  "export",
  "materialization",
  "not included",
  "omitted",
  "openscenario",
  "unsupported",
  "xosc",
];

const REALISM_TERMS = [
  "acceleration",
  "braking",
  "clearance",
  "collision",
  "deceleration",
  "friction",
  "gap",
  "headway",
  "jerk",
  "off road",
  "off-road",
  "overlap",
  "post-encroachment",
  "road departure",
  "speed",
  "time-to-collision",
  "ttc",
  "wrong way",
  "wrong-way",
];

export function buildReadinessSummary(
  issues: readonly SimulationIssue[],
): ReadinessSummary {
  const groups: Record<ReadinessSection, ReadinessItem[]> = {
    behavior: [],
    realism: [],
    export: [],
  };

  for (const issue of issues) {
    const section = readinessSectionForIssue(issue);
    groups[section].push({
      issue,
      section,
      title: explainTechnicalMetrics(issue.title),
      detail: explainTechnicalMetrics(issue.detail),
      solution: explainTechnicalMetrics(solutionForSimulationIssue(issue)),
    });
  }

  return {
    status: issues.length === 0 ? "ready" : "needs-attention",
    issueCount: issues.length,
    errorCount: issues.filter((issue) => issue.severity === "error").length,
    groups,
  };
}

export function readinessSectionForIssue(issue: SimulationIssue): ReadinessSection {
  if (issue.readinessSection) return issue.readinessSection;
  const searchable = `${issue.id} ${issue.title} ${issue.detail}`.toLowerCase();
  if (EXPORT_TERMS.some((term) => searchable.includes(term))) return "export";
  if (REALISM_TERMS.some((term) => searchable.includes(term))) return "realism";
  return "behavior";
}

export function explainTechnicalMetrics(value: string): string {
  return value
    .replace(/\bTTC\b/gi, "time until a collision")
    .replace(/\btime[- ]to[- ]collision\b/gi, "time until a collision")
    .replace(/\bPET\b/gi, "time between actors reaching the same point")
    .replace(
      /\bpost[- ]encroachment time\b/gi,
      "time between actors reaching the same point",
    );
}
