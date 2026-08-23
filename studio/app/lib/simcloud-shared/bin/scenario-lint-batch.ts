#!/usr/bin/env node
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import {
  compactLintReport,
  fromCarlaActorTrack,
  lintActorTracks,
  type LintReport,
  type LintViolation,
} from "../scenario-lint/index";

interface CliArgs {
  root: string;
  strict: boolean;
}

interface BatchFinding extends LintViolation {
  explained: boolean;
  annotation?: "declared-violating";
}

interface RunReport {
  schema_version: "simforge.scenario-lint-run.v1";
  scene: string;
  actor_track: string;
  verdict: "pass" | "warn" | "fail";
  lint: ReturnType<typeof compactLintReport>;
  declared_violation_count: number;
  unexplained_violation_count: number;
  findings: BatchFinding[];
}

interface BatchError {
  actor_track: string;
  error: string;
}

function usage(): string {
  return [
    "Usage: scenario-lint-batch <render-root> [--strict]",
    "",
    "Recursively lints every actor_track.json, writes lint.json beside the",
    "corresponding summary.json, and writes LINT_REPORT.json/.md at the root.",
    "--strict exits non-zero when any violation lacks a declared actor behavior.",
  ].join("\n");
}

export function parseScenarioLintBatchArgs(argv: string[]): CliArgs {
  let root = "";
  let strict = false;
  for (const arg of argv) {
    if (arg === "--strict") {
      strict = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    } else if (!root) {
      root = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}\n\n${usage()}`);
    }
  }
  if (!root) throw new Error(usage());
  return { root: resolve(root), strict };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findActorTracks(root: string): Promise<string[]> {
  const matches: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "actor_track.json") {
        matches.push(path);
      }
    }
  }
  await walk(root);
  return matches.sort((a, b) => a.localeCompare(b));
}

function actorId(actor: Record<string, unknown>): string | null {
  for (const field of ["actor_spec_id", "authored_actor_id", "id", "label"]) {
    const value = actor[field];
    if (
      (typeof value === "string" && value.trim()) ||
      typeof value === "number"
    ) {
      return String(value);
    }
  }
  return null;
}

function isDeclaredBehavior(actor: Record<string, unknown>): boolean {
  const metadata = actor.behaviorMetadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  const behaviorClass = (metadata as Record<string, unknown>).behavior_class;
  if (typeof behaviorClass !== "string") return false;
  const normalized = behaviorClass.trim().toLowerCase();
  return normalized === "violating" || normalized === "adversarial";
}

function declaredActors(track: unknown): Set<string> {
  const declared = new Set<string>();
  if (typeof track !== "object" || track === null) return declared;
  const frames = (track as Record<string, unknown>).frames;
  if (!Array.isArray(frames)) return declared;
  for (const frame of frames) {
    if (typeof frame !== "object" || frame === null) continue;
    const actors = (frame as Record<string, unknown>).actors;
    if (!Array.isArray(actors)) continue;
    for (const actor of actors) {
      if (
        typeof actor !== "object" ||
        actor === null ||
        !isDeclaredBehavior(actor as Record<string, unknown>)
      ) {
        continue;
      }
      const id = actorId(actor as Record<string, unknown>);
      if (id) declared.add(id);
    }
  }
  return declared;
}

function findingsFor(
  report: LintReport,
  declared: Set<string>,
): BatchFinding[] {
  return report.violations.map((finding) => {
    const explained =
      finding.severity === "violation" && declared.has(finding.actorId);
    return explained
      ? { ...finding, explained, annotation: "declared-violating" }
      : { ...finding, explained };
  });
}

function certificationVerdict(
  findings: BatchFinding[],
): RunReport["verdict"] {
  if (
    findings.some(
      (finding) => finding.severity === "violation" && !finding.explained,
    )
  ) {
    return "fail";
  }
  return findings.some((finding) => finding.severity === "warning")
    ? "warn"
    : "pass";
}

async function outputDirectoryForTrack(trackPath: string): Promise<string> {
  const runDirectory = dirname(trackPath);
  for (const candidate of [
    resolve(runDirectory, "summary.json"),
    resolve(runDirectory, "..", "summary.json"),
  ]) {
    if (await exists(candidate)) return dirname(candidate);
  }
  return runDirectory;
}

async function lintRun(root: string, trackPath: string): Promise<RunReport> {
  const raw = JSON.parse(await readFile(trackPath, "utf8")) as unknown;
  const report = lintActorTracks(fromCarlaActorTrack(raw));
  const findings = findingsFor(report, declaredActors(raw));
  const outputDirectory = await outputDirectoryForTrack(trackPath);
  const scene = relative(root, outputDirectory) || ".";
  const runReport: RunReport = {
    schema_version: "simforge.scenario-lint-run.v1",
    scene,
    actor_track: relative(root, trackPath),
    verdict: certificationVerdict(findings),
    lint: compactLintReport(report),
    declared_violation_count: findings.filter(
      (finding) => finding.severity === "violation" && finding.explained,
    ).length,
    unexplained_violation_count: findings.filter(
      (finding) => finding.severity === "violation" && !finding.explained,
    ).length,
    findings,
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, "lint.json"),
    `${JSON.stringify(runReport, null, 2)}\n`,
  );
  return runReport;
}

function peakFinding(run: RunReport): BatchFinding | null {
  return (
    [...run.findings]
      .filter((finding) => finding.severity === "violation")
      .sort(
        (a, b) =>
          b.peakValue / b.threshold - a.peakValue / a.threshold ||
          b.peakValue - a.peakValue,
      )[0] ?? null
  );
}

function buildAggregate(root: string, runs: RunReport[], errors: BatchError[]) {
  const kinds = new Map<
    string,
    {
      violation_count: number;
      scene_ids: Set<string>;
      unexplained_violation_count: number;
      unexplained_scene_ids: Set<string>;
    }
  >();
  for (const run of runs) {
    for (const finding of run.findings) {
      if (finding.severity !== "violation") continue;
      const row = kinds.get(finding.kind) ?? {
        violation_count: 0,
        scene_ids: new Set<string>(),
        unexplained_violation_count: 0,
        unexplained_scene_ids: new Set<string>(),
      };
      row.violation_count += 1;
      row.scene_ids.add(run.scene);
      if (!finding.explained) {
        row.unexplained_violation_count += 1;
        row.unexplained_scene_ids.add(run.scene);
      }
      kinds.set(finding.kind, row);
    }
  }
  const denominator = runs.length;
  const violationRateByKind = Object.fromEntries(
    [...kinds.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, row]) => [
        kind,
        {
          violation_count: row.violation_count,
          scene_count: row.scene_ids.size,
          scene_rate: denominator === 0 ? 0 : row.scene_ids.size / denominator,
          unexplained_violation_count: row.unexplained_violation_count,
          unexplained_scene_count: row.unexplained_scene_ids.size,
          unexplained_scene_rate:
            denominator === 0
              ? 0
              : row.unexplained_scene_ids.size / denominator,
        },
      ]),
  );
  const topOffendingScenes = runs
    .map((run) => ({ run, peak: peakFinding(run) }))
    .filter(
      (entry): entry is { run: RunReport; peak: BatchFinding } =>
        entry.peak !== null,
    )
    .sort(
      (a, b) =>
        b.run.unexplained_violation_count -
          a.run.unexplained_violation_count ||
        b.peak.peakValue / b.peak.threshold -
          a.peak.peakValue / a.peak.threshold ||
        a.run.scene.localeCompare(b.run.scene),
    )
    .slice(0, 20)
    .map(({ run, peak }) => ({
      scene: run.scene,
      verdict: run.verdict,
      unexplained_violation_count: run.unexplained_violation_count,
      actor_id: peak.actorId,
      kind: peak.kind,
      peak_value: peak.peakValue,
      threshold: peak.threshold,
      peak_ratio: peak.peakValue / peak.threshold,
    }));

  return {
    schema_version: "simforge.scenario-lint-batch.v1" as const,
    render_root: root,
    totals: {
      run_count: runs.length,
      pass_count: runs.filter((run) => run.verdict === "pass").length,
      warning_scene_count: runs.filter((run) => run.verdict === "warn").length,
      failing_scene_count: runs.filter((run) => run.verdict === "fail").length,
      violation_count: runs.reduce(
        (sum, run) => sum + run.lint.violation_count,
        0,
      ),
      warning_count: runs.reduce(
        (sum, run) => sum + run.lint.warning_count,
        0,
      ),
      declared_violation_count: runs.reduce(
        (sum, run) => sum + run.declared_violation_count,
        0,
      ),
      unexplained_violation_count: runs.reduce(
        (sum, run) => sum + run.unexplained_violation_count,
        0,
      ),
      error_count: errors.length,
    },
    violation_rate_by_kind: violationRateByKind,
    top_offending_scenes: topOffendingScenes,
    runs: runs.map((run) => ({
      scene: run.scene,
      actor_track: run.actor_track,
      lint_json: `${run.scene === "." ? "" : `${run.scene}/`}lint.json`,
      verdict: run.verdict,
      violation_count: run.lint.violation_count,
      warning_count: run.lint.warning_count,
      unexplained_violation_count: run.unexplained_violation_count,
    })),
    errors,
  };
}

function markdownReport(
  aggregate: ReturnType<typeof buildAggregate>,
): string {
  const lines = [
    "# Scenario lint batch report",
    "",
    `Render root: \`${aggregate.render_root}\``,
    "",
    "## Totals",
    "",
    "| Runs | Pass | Warn | Fail | Violations | Unexplained | Warnings | Errors |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${aggregate.totals.run_count} | ${aggregate.totals.pass_count} | ${aggregate.totals.warning_scene_count} | ${aggregate.totals.failing_scene_count} | ${aggregate.totals.violation_count} | ${aggregate.totals.unexplained_violation_count} | ${aggregate.totals.warning_count} | ${aggregate.totals.error_count} |`,
    "",
    "## Violation rate by kind",
    "",
    "| Kind | Scenes | Scene rate | Violations | Unexplained scenes |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [kind, row] of Object.entries(
    aggregate.violation_rate_by_kind,
  )) {
    lines.push(
      `| ${kind} | ${row.scene_count} | ${(row.scene_rate * 100).toFixed(1)}% | ${row.violation_count} | ${row.unexplained_scene_count} |`,
    );
  }
  if (Object.keys(aggregate.violation_rate_by_kind).length === 0) {
    lines.push("| _none_ | 0 | 0.0% | 0 | 0 |");
  }
  lines.push(
    "",
    "## Top offending scenes",
    "",
    "| Scene | Actor | Kind | Peak | Threshold | Ratio |",
    "| --- | --- | --- | ---: | ---: | ---: |",
  );
  for (const scene of aggregate.top_offending_scenes) {
    lines.push(
      `| ${scene.scene.split("|").join("\\|")} | ${scene.actor_id.split("|").join("\\|")} | ${scene.kind} | ${scene.peak_value.toFixed(3)} | ${scene.threshold.toFixed(3)} | ${scene.peak_ratio.toFixed(2)}× |`,
    );
  }
  if (aggregate.top_offending_scenes.length === 0) {
    lines.push("| _none_ | — | — | — | — | — |");
  }
  return `${lines.join("\n")}\n`;
}

export async function runScenarioLintBatch(args: CliArgs): Promise<{
  exitCode: number;
  report: ReturnType<typeof buildAggregate>;
}> {
  const tracks = await findActorTracks(args.root);
  const runs: RunReport[] = [];
  const errors: BatchError[] = [];
  for (const trackPath of tracks) {
    try {
      runs.push(await lintRun(args.root, trackPath));
    } catch (error) {
      errors.push({
        actor_track: relative(args.root, trackPath),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const report = buildAggregate(args.root, runs, errors);
  await writeFile(
    resolve(args.root, "LINT_REPORT.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    resolve(args.root, "LINT_REPORT.md"),
    markdownReport(report),
  );
  const exitCode =
    errors.length > 0
      ? 1
      : args.strict && report.totals.unexplained_violation_count > 0
        ? 2
        : 0;
  return { exitCode, report };
}

async function main(): Promise<void> {
  try {
    const args = parseScenarioLintBatchArgs(process.argv.slice(2));
    const result = await runScenarioLintBatch(args);
    console.log(
      `scenario lint: ${result.report.totals.run_count} runs, ${result.report.totals.unexplained_violation_count} unexplained violations; reports in ${args.root}`,
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 64;
  }
}

if (require.main === module) {
  void main();
}
