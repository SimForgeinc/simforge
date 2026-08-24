/**
 * One batch cell, start to finish: materialize → simulate → evaluate.
 *
 * Lives in its own module because it runs in two places — inline in the parent
 * process (`--concurrency 1`, and every test) and inside a worker thread — and
 * those two paths must be the same code or the batch stops being reproducible.
 */

import path from 'node:path';

import { runSimulation, traceDigest, type AmbientTrafficProfile, type SimTrace } from '@simforge/engine';
import type { ScenarioTemplateV2 } from '@simforge/scenario';
import type { InstanceManifest } from '@simforge/compiler';

import { criticalityBand, filtersFor, type EvaluateFilterMode } from './commands/evaluate.js';
import { metricsSummary } from './commands/simulate.js';
import { evaluateTrace } from '@simforge/engine';
import { loadMap } from '@simforge/compiler';
import { verifyEvidenceHashes, type EvidenceHashReport } from './evidence.js';
import { checkInvariants, type InvariantResidualReport } from './invariants.js';
import { materialize } from './materialize.js';
import { findSite } from '@simforge/compiler';
import { writeJsonFile, writeTraceFile } from '@simforge/compiler';
import { toStructuredError } from './errors.js';

export type { CatalogArtifactProvenance } from '@simforge/compiler';
import type { CatalogArtifactProvenance } from '@simforge/compiler';

export interface CellCoords {
  readonly mapId: string;
  readonly siteId: string;
  readonly drawIndex: number;
}

export interface CellOptions extends CellCoords {
  readonly outDir: string;
  readonly writeTrace: boolean;
  readonly filter: EvaluateFilterMode;
  readonly trivialTtcS?: number | undefined;
  /** Override the coordinate-derived seed (used by catalog reservations). */
  readonly seed?: string | undefined;
  /** Write to reserved catalog paths instead of the template-batch layout. */
  readonly artifactPaths?: ReturnType<typeof cellPaths> | undefined;
  /** Stable external identity for a catalog slot. */
  readonly instanceId?: string | undefined;
  /** Provenance closure carried by both the instance and result artifacts. */
  readonly catalogSlot?: CatalogArtifactProvenance | undefined;
  /** Replay the catalog's exact persisted-site matcher contract in workers. */
  readonly exactCatalogSiteResolution?: boolean | undefined;
  /** Explicit catalog eligibility rule. Catalog execution defaults to reject. */
  readonly collisionPolicy?: 'reject' | 'allow' | undefined;
  /**
   * Generated background road users. Structured-clone-safe plain data, because
   * this object crosses a `worker_threads` boundary.
   */
  readonly ambient?: AmbientTrafficProfile | undefined;
  /** Seconds of ambient-ONLY warm-up applied before `t = 0`. */
  readonly ambientSettleSeconds?: number | undefined;
}

export interface CellResult extends CellCoords {
  readonly instanceId: string;
  readonly status: 'ok' | 'error';
  readonly feasible: boolean;
  readonly verdict: 'accept' | 'reject' | null;
  readonly band: string | null;
  readonly tags: string[];
  readonly findings: Array<{ code: string; reason: string }>;
  readonly invariants: InvariantResidualReport[];
  readonly evidence: EvidenceHashReport;
  readonly metrics: Record<string, unknown> | null;
  readonly siteScore: number;
  readonly siteVerdict: string;
  readonly paramSeed: string;
  readonly params: Record<string, number>;
  readonly inputHash: string | null;
  readonly traceDigest: string | null;
  readonly instanceFile: string | null;
  readonly traceFile: string | null;
  readonly issues: Array<{ code: string; severity: string; reason: string }>;
  readonly error?: { code: string; reason: string; path?: string };
  readonly catalogSlot?: CellOptions['catalogSlot'];
  readonly artifactHashes?: {
    readonly instanceSha256: string | null;
    readonly traceSha256: string | null;
  };
  readonly eligibility?: {
    readonly collisionPolicy: 'reject' | 'allow';
    readonly eligible: boolean;
    readonly hardFailureCodes: readonly string[];
  };
  /**
   * Generated background traffic actually placed in this cell. Absent when no
   * ambient profile was requested, so an empty-road result file is unchanged.
   */
  readonly ambient?: {
    readonly actorCount: number;
    readonly profileHash: string;
    readonly eligibleLaneKm: number;
    readonly rejectedSpawnCount: number;
    readonly authoredCorridorRejects: number;
    /** Ambient vehicles inside 60 m of the metric subject at t = 0. */
    readonly nearSubjectAtT0: number;
    /** Ambient road users at a standstill (< 0.5 m/s) at t = 0. */
    readonly stoppedAtT0: number;
    readonly warnings: readonly string[];
  };
}

export function cellPaths(outDir: string, coords: CellCoords): {
  instance: string;
  trace: string;
  result: string;
} {
  const dir = path.join(outDir, coords.mapId, coords.siteId);
  const stem = `draw-${String(coords.drawIndex).padStart(3, '0')}`;
  return {
    instance: path.join(dir, `${stem}.instance.json`),
    trace: path.join(dir, `${stem}.trace.json.gz`),
    result: path.join(dir, `${stem}.result.json`),
  };
}

export function hardInvariantFailures(
  invariants: readonly InvariantResidualReport[],
): InvariantResidualReport[] {
  return invariants.filter((entry) => entry.essentiality === 'required' && entry.status !== 'held');
}

export function hardEligibilityFailureCodes(options: {
  readonly feasible: boolean;
  readonly evidenceIssues: readonly { code: string }[];
  readonly invariantFailures: readonly InvariantResidualReport[];
  readonly evaluationVerdict: 'accept' | 'reject';
  readonly evaluationFindings: readonly { code: string }[];
}): string[] {
  return [
    ...options.evidenceIssues.map((entry) => entry.code),
    ...options.invariantFailures.map((entry) => entry.status === 'unchecked' ? 'invariant_unchecked' : 'invariant_violated'),
    // Negative-control evaluation may accept with an informational
    // `trivially_safe` finding. Only findings that actually made evaluation
    // reject are hard eligibility failures.
    ...(options.evaluationVerdict === 'reject' ? options.evaluationFindings.map((entry) => entry.code) : []),
    ...(!options.feasible ? ['materialization_infeasible'] : []),
  ];
}

/** Run one cell. Never throws: a failure is a recorded cell, not a dead batch. */
export async function runCell(
  template: ScenarioTemplateV2,
  options: CellOptions,
): Promise<CellResult> {
  const paths = options.artifactPaths ?? cellPaths(options.outDir, options);
  const base = {
    mapId: options.mapId,
    siteId: options.siteId,
    drawIndex: options.drawIndex,
    instanceId: options.instanceId ?? `${options.siteId}#${options.drawIndex}`,
    ...(options.catalogSlot === undefined ? {} : { catalogSlot: options.catalogSlot }),
  };
  try {
    const { bundle, site } = await findSite(template, options.mapId, options.siteId,
      options.exactCatalogSiteResolution ? { exactCatalogSiteResolution: true } : {});
    const { input, manifest } = materialize(template, bundle, site, {
      drawIndex: options.drawIndex,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.catalogSlot === undefined ? {} : { variant: options.catalogSlot.variant }),
      ...(options.ambient === undefined ? {} : { ambient: options.ambient }),
      ...(options.ambientSettleSeconds === undefined
        ? {}
        : { ambientSettleSeconds: options.ambientSettleSeconds }),
    });
    const instance = {
      kind: 'scenario-instance' as const,
      version: 1 as const,
      ...(options.catalogSlot === undefined ? {} : { catalogSlot: options.catalogSlot }),
      manifest,
      input,
    };
    await writeJsonFile(paths.instance, instance);

    const run = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    const trace = options.catalogSlot === undefined
      ? run.trace
      : { ...run.trace, header: { ...run.trace.header, catalogSlot: options.catalogSlot } };
    if (options.writeTrace) await writeTraceFile(paths.trace, trace);

    const evaluation = evaluateTrace(
      trace,
      filtersFor(
        template.meta.negativeControl ? 'negative-control' : options.filter,
        {
          trivialTtcS: options.trivialTtcS,
          rejectCollisions: options.collisionPolicy === 'reject',
        },
      ),
    );
    const speedLimitKph = bundle.index.lanes[site.frame.entryLaneRsl]?.speedLimitKph ?? null;
    const invariants = checkInvariants({
      template,
      trace,
      scope: {
        params: manifest.params.values,
        clip: { seconds: trace.header.clipSeconds },
        ...(speedLimitKph === null ? {} : { lane: { speedLimitKph } }),
      },
      arrival: manifest.arrival,
      speedLimitKph,
    });
    const requiredInvariantFailures = hardInvariantFailures(invariants);
    const evidence = verifyEvidenceHashes(instance, trace);
    const findings: Array<{ code: string; reason: string }> = evaluation.findings.map((f) => ({ code: f.code, reason: f.reason }));
    if (!evidence.ok) {
      findings.push(...evidence.issues.map((i) => ({ code: i.code, reason: i.reason })));
    }
    if (requiredInvariantFailures.length > 0) {
      findings.push(
        ...requiredInvariantFailures.map((r) => ({
          code: r.status === 'unchecked' ? 'invariant_unchecked' : 'invariant_violated',
          reason: `${r.id}: ${r.reason}`,
        })),
      );
    }
    if (!manifest.feasible) {
      findings.push({
        code: 'materialization_infeasible',
        reason: 'materializer could not satisfy the concrete scenario constraints',
      });
    }
    const verdict = !manifest.feasible || requiredInvariantFailures.length > 0 || !evidence.ok
      ? 'reject'
      : evaluation.verdict;
    const hardFailureCodes = hardEligibilityFailureCodes({
      feasible: manifest.feasible,
      evidenceIssues: evidence.issues,
      invariantFailures: requiredInvariantFailures,
      evaluationVerdict: evaluation.verdict,
      evaluationFindings: evaluation.findings,
    });

    const result: CellResult = {
      ...base,
      status: 'ok',
      feasible: manifest.feasible,
      verdict,
      band: !evidence.ok
        ? 'evidence-mismatch'
        : !manifest.feasible
          ? 'infeasible'
        : requiredInvariantFailures.length > 0
          ? 'invariant'
          : criticalityBand(evaluation.verdict, evaluation.findings),
      tags: [
        ...evaluation.tags,
        ...(!evidence.ok ? ['evidence_mismatch'] : []),
        ...(requiredInvariantFailures.some((entry) => entry.status === 'violated') ? ['invariant_violated'] : []),
        ...(requiredInvariantFailures.some((entry) => entry.status === 'unchecked') ? ['invariant_unchecked'] : []),
      ],
      findings,
      invariants,
      evidence,
      metrics: metricsSummary(trace),
      siteScore: site.score,
      siteVerdict: site.degradation.verdict,
      paramSeed: manifest.replayKey.paramSeed,
      params: manifest.params.values,
      inputHash: manifest.inputHash,
      traceDigest: traceDigest(trace),
      instanceFile: paths.instance,
      traceFile: options.writeTrace ? paths.trace : null,
      issues: [...manifest.issues, ...run.issues].map((i) => ({
        code: i.code,
        severity: i.severity,
        reason: i.reason,
      })),
      eligibility: {
        collisionPolicy: options.collisionPolicy ?? 'allow',
        eligible: verdict === 'accept',
        hardFailureCodes,
      },
      ...(manifest.ambient === undefined ? {} : { ambient: ambientCellReport(manifest.ambient, trace) }),
    };
    await writeJsonFile(paths.result, result);
    return result;
  } catch (error) {
    const structured = toStructuredError(error);
    const result: CellResult = {
      ...base,
      status: 'error',
      feasible: false,
      verdict: null,
      band: 'infeasible',
      tags: [],
      findings: [],
      invariants: [],
      evidence: {
        ok: false,
        recomputedInputHash: '',
        manifestInputHash: null,
        traceInputHash: null,
        inputActorIds: [],
        traceActorIds: [],
        traceTrackActorIds: [],
        actorIds: [],
        actorCount: 0,
        inputMapId: options.mapId,
        manifestMapId: null,
        traceMapId: null,
        matcherIndexDigest: null,
        manifestEngineGraphDigest: null,
        traceEngineGraphDigest: null,
        issues: [],
      },
      metrics: null,
      siteScore: 0,
      siteVerdict: 'infeasible',
      paramSeed: '',
      params: {},
      inputHash: null,
      traceDigest: null,
      instanceFile: null,
      traceFile: null,
      issues: [],
      error: structured,
      eligibility: {
        collisionPolicy: options.collisionPolicy ?? 'allow',
        eligible: false,
        hardFailureCodes: [structured.code],
      },
    };
    await writeJsonFile(paths.result, result).catch(() => undefined);
    return result;
  }
}

/**
 * Measure the delivered background population from the TRACE, not from the
 * request. "We asked for 8" is not evidence that 8 cars are on the road at
 * t = 0 within sight of the ego; this reads the recorded tick.
 */
export const AMBIENT_NEAR_SUBJECT_RADIUS_M = 60;
const AMBIENT_STANDSTILL_MPS = 0.5;

function ambientCellReport(
  provenance: NonNullable<InstanceManifest['ambient']>,
  trace: SimTrace,
): NonNullable<CellResult['ambient']> {
  const ambientIds = trace.header.ambientActorIds ?? [];
  const t0 = trace.ticks.t.findIndex((value) => value >= 0);
  const subjectId = trace.header.metricSubject ?? 'ego';
  const subject = trace.ticks.actors[subjectId];
  let nearSubjectAtT0 = 0;
  let stoppedAtT0 = 0;
  if (t0 >= 0) {
    for (const id of ambientIds) {
      const track = trace.ticks.actors[id];
      if (!track || !track.present[t0]) continue;
      const kind = trace.header.actorMetadata?.[id]?.kind;
      const isVehicle = kind !== 'pedestrian' && kind !== 'bicycle' && kind !== 'animal';
      if ((track.speedMps[t0] ?? 0) < AMBIENT_STANDSTILL_MPS) stoppedAtT0 += 1;
      if (!subject || !subject.present[t0] || !isVehicle) continue;
      const gap = Math.hypot(
        (track.x[t0] ?? 0) - (subject.x[t0] ?? 0),
        (track.y[t0] ?? 0) - (subject.y[t0] ?? 0),
      );
      if (gap <= AMBIENT_NEAR_SUBJECT_RADIUS_M) nearSubjectAtT0 += 1;
    }
  }
  return {
    actorCount: ambientIds.length,
    profileHash: provenance.profileHash,
    eligibleLaneKm: provenance.eligibleLaneKm,
    rejectedSpawnCount: provenance.rejectedSpawnCount,
    authoredCorridorRejects: provenance.authoredCorridorRejects,
    nearSubjectAtT0,
    stoppedAtT0,
    warnings: [...provenance.warnings],
  };
}

export { loadMap };
