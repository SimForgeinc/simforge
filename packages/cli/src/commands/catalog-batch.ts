/**
 * Deterministic execution of the authored catalog.
 *
 * The catalog is the lifecycle manifest; this module also writes a separate
 * attempt ledger. That separation matters: a failed simulation is evidence of
 * an attempt, but it is not evidence that a slot reached `simulated`.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { MATCH_SEMANTICS_VERSION, type MatchedSite } from '@uniscenarios/anchor-matcher';
import { ENGINE_VERSION, traceDigest } from '@uniscenarios/sim-engine';

import type { CatalogArtifactProvenance, CellOptions, CellResult } from '../batch-cell.js';
import {
  matcherSiteClosesLocation,
  catalogDesignDigest,
  refreshScenarioCatalog,
  validateScenarioCatalog,
  type CatalogSlotStatus,
  type ScenarioCatalogManifest,
  type ScenarioCatalogSlot,
} from '../catalog.js';
import { CliError, EXIT, toStructuredError, type StructuredError } from '../errors.js';
import { verifyEvidenceHashes } from '../evidence.js';
import { emit, emitLines } from '../output.js';
import { CATALOG_EXACT_SITE_OPTIONS, matchOnMap } from '@uniscenarios/scenario-materializer';
import { REPO_ROOT } from '@uniscenarios/scenario-materializer';
import { readTemplate, readTraceFile, type InstanceFile } from '@uniscenarios/scenario-materializer';
import type { EvaluateFilterMode } from './evaluate.js';

export const CATALOG_EXECUTOR_VERSION = '1.0.1' as const;

export type CatalogExecutionState =
  | 'pending'
  | 'running'
  | 'unsupported'
  | 'simulated'
  | 'rejected'
  | 'failed';

export interface CatalogAttemptRecord {
  readonly attempt: number;
  readonly seed: string;
  readonly siteId: string;
  readonly siteBinding: 'catalog-site';
  readonly status: CellResult['status'];
  readonly feasible: boolean;
  readonly verdict: CellResult['verdict'];
  readonly generated: boolean;
  readonly simulated: boolean;
  readonly inputHash: string | null;
  readonly traceDigest: string | null;
  readonly error?: CellResult['error'];
}

export interface CatalogExecutionSlot {
  readonly identity: string;
  readonly mapId: string;
  readonly incidentId: string;
  readonly templateId: string | null;
  state: CatalogExecutionState;
  attempts: CatalogAttemptRecord[];
  resumed: boolean;
  error?: StructuredError;
}

export interface CatalogExecutionCounts {
  readonly total: number;
  readonly templateBacked: number;
  readonly supported: number;
  readonly unsupported: number;
  readonly pending: number;
  readonly running: number;
  readonly attempted: number;
  readonly generated: number;
  readonly simulated: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly failed: number;
  readonly resumed: number;
}

export interface CatalogExecutionLedger {
  readonly kind: 'uniscenarios-catalog-execution-ledger';
  readonly version: 1;
  readonly catalog: string;
  readonly namespace: string;
  readonly planDigest: string;
  readonly executorVersion: typeof CATALOG_EXECUTOR_VERSION;
  readonly matcherVersion: string;
  readonly solverVersion: string;
  readonly options: { maxAttempts: number; concurrency: number; filter: EvaluateFilterMode; collisionPolicy: 'reject' | 'allow' };
  status: 'running' | 'completed' | 'cancelled';
  counts: CatalogExecutionCounts;
  slots: CatalogExecutionSlot[];
}

export interface CatalogBatchOptions {
  readonly file: string;
  readonly ledger?: string | undefined;
  readonly slotIds?: readonly string[] | undefined;
  readonly mapIds?: readonly string[] | undefined;
  readonly mechanismIds?: readonly string[] | undefined;
  readonly maxAttempts: number;
  readonly concurrency?: number | undefined;
  readonly force: boolean;
  readonly filter: EvaluateFilterMode;
  readonly trivialTtcS?: number | undefined;
  readonly collisionPolicy?: 'reject' | 'allow' | undefined;
  readonly pretty: boolean;
  readonly signal?: AbortSignal | undefined;
}

interface PlannedSlot {
  readonly slot: ScenarioCatalogSlot;
  readonly templateFile: string | null;
  readonly candidates: readonly RankedSite[];
  readonly planningError?: StructuredError;
  readonly unsupportedError?: StructuredError;
}

interface RankedSite {
  readonly site: MatchedSite;
  readonly binding: 'catalog-site';
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function executionDesignDigest(slot: ScenarioCatalogSlot): string {
  return catalogDesignDigest(slot);
}

export function catalogAttemptSeed(seed: string, attempt: number): string {
  return attempt === 0 ? seed : hash(`${seed}\0replacement\0${attempt}`);
}

export function catalogTopologyProvenanceCloses(
  provenance: Pick<ScenarioCatalogSlot['provenance'], 'matcherIndexDigest' | 'engineGraphDigest'>,
  runtime: { readonly matcherIndexDigest: string; readonly engineGraphDigest: string },
): boolean {
  return provenance.matcherIndexDigest === runtime.matcherIndexDigest &&
    provenance.engineGraphDigest === runtime.engineGraphDigest;
}

function artifactProvenance(
  slot: ScenarioCatalogSlot,
  attemptSeed: string,
  matcherSiteId: string,
): CatalogArtifactProvenance {
  return {
    identity: slot.identity,
    seed: slot.seed,
    attemptSeed,
    designDigest: executionDesignDigest(slot),
    mapId: slot.mapId,
    incidentId: slot.scenario.incidentId,
    selectedLocationId: slot.site.locationId,
    selectedMatcherSiteId: matcherSiteId,
    variant: slot.variant,
    provenance: {
      ...slot.provenance,
      templateDigest: slot.provenance.templateDigest!,
    },
    templateId: slot.implementation.templateId!,
  };
}

export function deriveCatalogExecutionCounts(
  slots: readonly CatalogExecutionSlot[],
): CatalogExecutionCounts {
  const attempts = slots.flatMap((slot) => slot.attempts);
  return {
    total: slots.length,
    templateBacked: slots.filter((slot) => slot.templateId !== null).length,
    supported: slots.filter((slot) => slot.templateId !== null && slot.state !== 'unsupported').length,
    unsupported: slots.filter((slot) => slot.state === 'unsupported').length,
    pending: slots.filter((slot) => slot.state === 'pending').length,
    running: slots.filter((slot) => slot.state === 'running').length,
    attempted: slots.filter((slot) => slot.attempts.length > 0).length,
    generated: slots.filter((slot) => slot.attempts.some((attempt) => attempt.generated)).length,
    simulated: slots.filter((slot) => slot.attempts.some((attempt) => attempt.simulated)).length,
    accepted: slots.filter((slot) => slot.state === 'simulated').length,
    rejected: slots.filter((slot) => slot.state === 'rejected').length,
    failed: slots.filter((slot) => slot.state === 'failed').length,
    resumed: slots.filter((slot) => slot.resumed).length,
  };
}

export function hasResumableAcceptedEligibility(
  result: Pick<CellResult, 'status' | 'feasible' | 'verdict' | 'eligibility'>,
  collisionPolicy: 'reject' | 'allow',
  collisions: number,
): boolean {
  return result.status === 'ok' &&
    result.feasible &&
    result.verdict === 'accept' &&
    result.eligibility?.eligible === true &&
    result.eligibility.collisionPolicy === collisionPolicy &&
    result.eligibility.hardFailureCodes.length === 0 &&
    (collisionPolicy === 'allow' || collisions === 0);
}

export async function catalogBatch(options: CatalogBatchOptions): Promise<number> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 100) {
    throw new CliError('bad_value', '--attempts must be an integer from 1 to 100', { path: '--attempts' });
  }
  if (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32)) {
    throw new CliError('bad_value', '--concurrency must be an integer from 1 to 32', { path: '--concurrency' });
  }
  const catalogFile = path.resolve(options.file);
  const catalog = await readCatalog(catalogFile);
  const validation = validateScenarioCatalog(catalog, { manifestFile: catalogFile });
  if (!validation.ok && validation.issues.some((issue) => issue.code !== 'missing_evidence')) {
    throw new CliError('invalid_catalog', 'catalog verification failed before execution', {
      path: options.file,
      detail: { issues: validation.issues },
      exitCode: EXIT.validationFindings,
    });
  }

  const selected = selectSlots(catalog.slots, options);
  if (selected.length === 0) {
    throw new CliError('empty_selection', 'catalog filters selected no slots', {
      path: options.file,
      exitCode: EXIT.validationFindings,
    });
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? Math.min(4, os.cpus().length), 32, selected.length));
  const planDigest = executionPlanDigest(catalog, selected, options);
  const ledgerFile = path.resolve(options.ledger ?? path.join(path.dirname(catalogFile), 'catalog-execution-ledger.json'));
  const workRoot = `${ledgerFile}.work`;
  const existing = options.force ? null : await readLedger(ledgerFile);
  let ledger = createLedger(catalogFile, catalog, selected, planDigest, concurrency, options, existing);
  let mutableCatalog = catalog;
  let checkpointChain: Promise<void> = Promise.resolve();
  const checkpoint = (): Promise<void> => {
    ledger.counts = deriveCatalogExecutionCounts(ledger.slots);
    const ledgerBytes = `${JSON.stringify(ledger, null, 2)}\n`;
    const catalogBytes = `${JSON.stringify(mutableCatalog, null, 2)}\n`;
    checkpointChain = checkpointChain.then(async () => {
      await atomicWrite(ledgerFile, ledgerBytes);
      await atomicWrite(catalogFile, catalogBytes);
    });
    return checkpointChain;
  };

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await checkpoint();
    const planned = await planSupportedSlots(selected, catalogFile, controller.signal);
    const ledgerById = new Map(ledger.slots.map((slot) => [slot.identity, slot]));

    for (const slot of selected) {
      const record = ledgerById.get(slot.identity)!;
      if (record.state === 'simulated') {
        if (await validSimulatedResume(record, slot, catalogFile, options.collisionPolicy ?? 'reject')) {
          if (slot.status !== 'simulated') mutableCatalog = setCatalogStatus(mutableCatalog, slot.identity, 'simulated');
        } else {
          invalidateStaleResume(record, {
            code: 'stale_resume_artifact',
            path: slot.identity,
            reason: 'recorded simulation artifacts are missing or no longer match their ledger hashes',
          });
          mutableCatalog = setCatalogStatus(mutableCatalog, slot.identity, 'authored');
        }
      } else if (record.state === 'rejected') {
        if (await validRejectedResume(record, slot, catalogFile, options.collisionPolicy ?? 'reject')) {
          if (slot.status !== 'rejected') mutableCatalog = setCatalogStatus(mutableCatalog, slot.identity, 'rejected');
        } else {
          invalidateStaleResume(record, {
            code: 'stale_resume_artifact',
            path: slot.identity,
            reason: 'recorded rejection artifacts are missing',
          });
          mutableCatalog = setCatalogStatus(mutableCatalog, slot.identity, 'authored');
        }
      }
    }

    // An abort during exact-site planning is not a planning failure. Preserve
    // the pre-dispatch pending state so the same attempt number and seed are
    // available on resume.
    if (!controller.signal.aborted) {
      for (const plan of planned) {
        const record = ledgerById.get(plan.slot.identity)!;
        if (plan.unsupportedError) {
          record.state = 'unsupported';
          record.error = plan.unsupportedError;
        } else if (plan.planningError) {
          record.state = 'failed';
          record.error = plan.planningError;
        }
      }
    }
    await checkpoint();

    const runnable = planned.filter((plan) => {
      const record = ledgerById.get(plan.slot.identity)!;
      if (record.state === 'unsupported' || plan.planningError) return false;
      if (record.state === 'simulated') return false;
      if ((record.state === 'rejected' || record.state === 'failed') && record.attempts.length >= options.maxAttempts) {
        record.resumed = true;
        return false;
      }
      if (record.state === 'pending' && record.attempts.length >= options.maxAttempts) {
        record.state = 'failed';
        record.error ??= {
          code: 'attempts_exhausted',
          path: record.identity,
          reason: 'preserved attempt history already exhausts the configured retry budget',
        };
        return false;
      }
      record.state = 'pending';
      return true;
    });

    await runBounded(runnable, concurrency, controller.signal, async (plan) => {
      const record = ledgerById.get(plan.slot.identity)!;
      record.state = 'running';
      delete record.error;
      await checkpoint();
      await executeSlot(plan, record, options, ledgerFile, workRoot, controller.signal, checkpoint, async (status) => {
        mutableCatalog = setCatalogStatus(mutableCatalog, plan.slot.identity, status);
        await checkpoint();
      });
    });

    if (controller.signal.aborted) {
      for (const record of ledger.slots) if (record.state === 'running') record.state = 'pending';
      ledger.status = 'cancelled';
    } else {
      ledger.status = 'completed';
    }
    await checkpoint();
  } finally {
    options.signal?.removeEventListener('abort', abort);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  const payload = { ...ledger, ledger: ledgerFile, catalog: catalogFile };
  if (options.pretty) {
    emitLines([
      `${ledger.status.toUpperCase()} — ${ledger.counts.total} catalog slot(s)`,
      `template-backed=${ledger.counts.templateBacked} executable=${ledger.counts.supported} unsupported=${ledger.counts.unsupported} resumed=${ledger.counts.resumed}`,
      `attempted=${ledger.counts.attempted} generated=${ledger.counts.generated} simulated=${ledger.counts.simulated}`,
      `accepted=${ledger.counts.accepted} rejected=${ledger.counts.rejected} failed=${ledger.counts.failed} pending=${ledger.counts.pending}`,
      `ledger: ${ledgerFile}`,
      `catalog: ${catalogFile}`,
    ]);
  } else emit(payload, options);

  return ledger.status === 'completed' && ledger.counts.unsupported === 0 && ledger.counts.failed === 0 && ledger.counts.rejected === 0
    ? EXIT.ok
    : EXIT.validationFindings;
}

function selectSlots(slots: readonly ScenarioCatalogSlot[], options: CatalogBatchOptions): ScenarioCatalogSlot[] {
  const ids = options.slotIds?.length ? new Set(options.slotIds) : null;
  const maps = options.mapIds?.length ? new Set(options.mapIds) : null;
  const mechanisms = options.mechanismIds?.length ? new Set(options.mechanismIds) : null;
  return slots.filter((slot) =>
    (!ids || ids.has(slot.identity)) &&
    (!maps || maps.has(slot.mapId)) &&
    (!mechanisms || mechanisms.has(slot.scenario.incidentId)),
  );
}

function executionPlanDigest(
  catalog: ScenarioCatalogManifest,
  slots: readonly ScenarioCatalogSlot[],
  options: Pick<CatalogBatchOptions, 'filter' | 'trivialTtcS' | 'collisionPolicy'>,
): string {
  return hash(JSON.stringify({
    namespace: catalog.provenance.namespace,
    taxonomyDigest: catalog.provenance.taxonomyDigest,
    executorVersion: CATALOG_EXECUTOR_VERSION,
    matcherVersion: MATCH_SEMANTICS_VERSION,
    solverVersion: ENGINE_VERSION,
    filter: options.filter,
    collisionPolicy: options.collisionPolicy ?? 'reject',
    trivialTtcS: options.trivialTtcS ?? null,
    slots: slots.map((slot) => ({
      identity: slot.identity,
      seed: slot.seed,
      mapId: slot.mapId,
      incidentId: slot.scenario.incidentId,
      implementation: slot.implementation,
      provenance: slot.provenance,
      site: slot.site,
      variant: slot.variant,
      evidencePaths: slot.evidencePaths,
    })),
  }));
}

function createLedger(
  catalogFile: string,
  catalog: ScenarioCatalogManifest,
  slots: readonly ScenarioCatalogSlot[],
  planDigest: string,
  concurrency: number,
  options: CatalogBatchOptions,
  existing: CatalogExecutionLedger | null,
): CatalogExecutionLedger {
  const reusable = existing?.kind === 'uniscenarios-catalog-execution-ledger' && existing.planDigest === planDigest;
  const previous = new Map((reusable ? existing.slots : []).map((slot) => [slot.identity, slot]));
  const records = slots.map((slot): CatalogExecutionSlot => {
    const prior = previous.get(slot.identity);
    if (prior) return reconcileInterruptedExecutionSlot(prior);
    return {
      identity: slot.identity,
      mapId: slot.mapId,
      incidentId: slot.scenario.incidentId,
      templateId: slot.implementation.templateId ?? null,
      state: 'pending',
      attempts: [],
      resumed: false,
    };
  });
  return {
    kind: 'uniscenarios-catalog-execution-ledger',
    version: 1,
    catalog: catalogFile,
    namespace: catalog.provenance.namespace,
    planDigest,
    executorVersion: CATALOG_EXECUTOR_VERSION,
    matcherVersion: MATCH_SEMANTICS_VERSION,
    solverVersion: ENGINE_VERSION,
    options: {
      maxAttempts: options.maxAttempts,
      concurrency,
      filter: options.filter,
      collisionPolicy: options.collisionPolicy ?? 'reject',
    },
    status: 'running',
    counts: deriveCatalogExecutionCounts(records),
    slots: records,
  };
}

/**
 * Reconcile a durable record after either graceful cancellation or abrupt
 * process loss. A `running` state has no committed attempt by definition: the
 * attempt record is appended only after worker completion. Preserve the exact
 * attempt history and move only that transient state back to `pending`.
 */
export function reconcileInterruptedExecutionSlot(prior: CatalogExecutionSlot): CatalogExecutionSlot {
  const interrupted = prior.state === 'running';
  const reconciled: CatalogExecutionSlot = {
    ...prior,
    state: interrupted ? 'pending' : prior.state,
    resumed: interrupted || ['unsupported', 'simulated', 'rejected', 'failed'].includes(prior.state),
  };
  if (interrupted) delete reconciled.error;
  return reconciled;
}

/** Preserve committed attempt evidence when a promoted resume artifact is stale. */
export function invalidateStaleResume(record: CatalogExecutionSlot, error: StructuredError): void {
  record.state = 'pending';
  record.resumed = true;
  record.error = error;
}

/**
 * Resolve the one site that a catalog slot reserved.  This is deliberately
 * not a fallback picker: any missing id, matcher drift, or location closure
 * drift is a hard planning error and must be recorded as such.
 */
export async function resolvePersistedCatalogSite(
  slot: ScenarioCatalogSlot,
  template: Awaited<ReturnType<typeof readTemplate>>,
): Promise<{ site: MatchedSite; match: Awaited<ReturnType<typeof matchOnMap>> }> {
  const matcherSiteId = slot.implementation.matcherSiteId;
  if (!matcherSiteId || slot.implementation.matchedLocationId !== slot.site.locationId) {
    throw new CliError('unsupported_catalog_site_binding', 'catalog slot lacks a closed persisted matcher-site/catalog-location binding', {
      path: slot.identity,
      exitCode: EXIT.validationFindings,
    });
  }
  const match = await matchOnMap(template, slot.mapId, CATALOG_EXACT_SITE_OPTIONS);
  const site = match.report.sites.find((candidate) => candidate.siteId === matcherSiteId);
  if (!site) {
    throw new CliError('catalog_site_not_matchable', `persisted matcher site ${matcherSiteId} is not executable under the current exact catalog matcher`, {
      path: slot.identity,
      exitCode: EXIT.validationFindings,
    });
  }
  const location = match.bundle.catalog.locations.find((candidate) => candidate.id === slot.site.locationId);
  if (!location || !matcherSiteClosesLocation(site, location, match.bundle.index)) {
    throw new CliError('catalog_site_binding_mismatch', `persisted matcher site ${site.siteId} does not close against catalog location ${slot.site.locationId}`, {
      path: slot.identity,
      exitCode: EXIT.validationFindings,
    });
  }
  return { site, match };
}

async function planSupportedSlots(
  slots: readonly ScenarioCatalogSlot[],
  catalogFile: string,
  signal: AbortSignal,
): Promise<PlannedSlot[]> {
  const grouped = new Map<string, ScenarioCatalogSlot[]>();
  const plans = new Map<string, PlannedSlot>();
  for (const slot of slots) {
    if (slot.implementation.state !== 'template-backed' || !slot.implementation.templateSource) {
      plans.set(slot.identity, {
        slot,
        templateFile: null,
        candidates: [],
        unsupportedError: {
          code: 'unsupported_catalog_mechanism',
          path: slot.identity,
          reason: `incident ${slot.scenario.incidentId} has no executable template`,
        },
      });
      continue;
    }
    if (
      !slot.implementation.matcherSiteId ||
      slot.implementation.matchedLocationId !== slot.site.locationId
    ) {
      plans.set(slot.identity, {
        slot,
        templateFile: null,
        candidates: [],
        unsupportedError: {
          code: 'unsupported_catalog_site_binding',
          path: slot.identity,
          reason: 'template provenance exists, but the reserved catalog location has no persisted exact matcher site binding',
        },
      });
      continue;
    }
    if (slot.implementation.materializedVariantId !== slot.variant.id) {
      plans.set(slot.identity, {
        slot,
        templateFile: null,
        candidates: [],
        unsupportedError: {
          code: 'unsupported_catalog_variant',
          path: slot.identity,
          reason: `operational variant ${slot.variant.id} is catalog metadata but is not applied by the materializer/engine`,
        },
      });
      continue;
    }
    const templateFile = path.resolve(REPO_ROOT, slot.implementation.templateSource);
    const key = `${templateFile}\0${slot.mapId}`;
    const group = grouped.get(key) ?? [];
    group.push(slot);
    grouped.set(key, group);
  }

  for (const [key, group] of grouped) {
    if (signal.aborted) break;
    const separator = key.lastIndexOf('\0');
    const templateFile = key.slice(0, separator);
    const mapId = key.slice(separator + 1);
    try {
      const bytes = await readFile(templateFile);
      const expectedDigest = group[0]!.provenance.templateDigest;
      if (expectedDigest !== hash(bytes)) {
        throw new CliError('template_digest_mismatch', 'catalog template provenance does not match the executable file', {
          path: templateFile,
          exitCode: EXIT.validationFindings,
        });
      }
      const template = await readTemplate(templateFile);
      // Replay the exact, persisted matcher-site contract used by catalog
      // authoring.  The normal interactive matcher may intentionally retain
      // only a diverse prefix, which is not allowed to hide an authored slot.
      const match = await matchOnMap(template, mapId, CATALOG_EXACT_SITE_OPTIONS);
      for (const slot of group) {
        if (!catalogTopologyProvenanceCloses(slot.provenance, {
          matcherIndexDigest: match.bundle.index.topologyDigest,
          engineGraphDigest: match.bundle.graph.topologyDigest,
        })) {
          plans.set(slot.identity, {
            slot,
            templateFile,
            candidates: [],
            planningError: {
              code: 'stale_catalog_topology_provenance',
              path: slot.identity,
              reason: 'catalog matcher/engine digests do not match the concrete runtime map bundle; regenerate the catalog before execution',
            },
          });
        }
      }
      if (match.report.sites.length === 0) {
        throw new CliError('no_matching_site', `template has no executable site on ${mapId}`, {
          path: mapId,
          detail: { failureSummary: match.report.failureSummary },
          exitCode: EXIT.validationFindings,
        });
      }
      for (const slot of group) {
        if (plans.has(slot.identity)) continue;
        try {
          const resolved = await resolvePersistedCatalogSite(slot, template);
          plans.set(slot.identity, {
            slot,
            templateFile,
            candidates: [{ site: resolved.site, binding: 'catalog-site' }],
          });
        } catch (error) {
          plans.set(slot.identity, {
            slot,
            templateFile,
            candidates: [],
            planningError: toStructuredError(error),
          });
        }
      }
    } catch (error) {
      for (const slot of group) plans.set(slot.identity, {
        slot,
        templateFile,
        candidates: [],
        planningError: toStructuredError(error),
      });
    }
  }
  return slots.map((slot) => plans.get(slot.identity) ?? {
    slot,
    templateFile: slot.implementation.templateSource ?? null,
    candidates: [],
    planningError: { code: 'cancelled', reason: 'planning cancelled before this slot was reached' },
  });
}

async function executeSlot(
  plan: PlannedSlot,
  record: CatalogExecutionSlot,
  options: CatalogBatchOptions,
  ledgerFile: string,
  workRoot: string,
  signal: AbortSignal,
  attemptCheckpoint: () => Promise<void>,
  finish: (status: CatalogSlotStatus) => Promise<void>,
): Promise<void> {
  const slot = plan.slot;
  const templateFile = plan.templateFile!;
  let finalResult: CellResult | null = null;
  let finalPaths: ReturnType<typeof attemptPaths> | null = null;
  let lastGenerated: { result: CellResult; paths: ReturnType<typeof attemptPaths> } | null = null;
  for (let attempt = record.attempts.length; attempt < options.maxAttempts; attempt += 1) {
    const candidate = plan.candidates[attempt % plan.candidates.length]!;
    const paths = attemptPaths(workRoot, slot.identity, attempt);
    await clearAttempt(paths);
    const seed = catalogAttemptSeed(slot.seed, attempt);
    const cellOptions: CellOptions = {
      mapId: slot.mapId,
      siteId: candidate.site.siteId,
      drawIndex: attempt,
      outDir: path.dirname(ledgerFile),
      writeTrace: true,
      filter: options.filter,
      trivialTtcS: options.trivialTtcS,
      seed,
      artifactPaths: paths,
      instanceId: slot.identity,
      catalogSlot: artifactProvenance(slot, seed, candidate.site.siteId),
      // The parent already proved this exact tuple. Worker replay must use the
      // same lossless matcher policy, never the interactive diverse prefix.
      exactCatalogSiteResolution: true,
      collisionPolicy: options.collisionPolicy ?? 'reject',
    };
    const result = await runWorker(templateFile, cellOptions, signal);
    // Cancellation does not consume a deterministic attempt.  Its work files
    // are deliberately non-evidence and the next invocation retries the same
    // attempt number and seed.
    if (signal.aborted) {
      await clearAttempt(paths);
      record.state = 'pending';
      await attemptCheckpoint();
      return;
    }
    const generated = existsSync(paths.instance);
    const simulated = existsSync(paths.trace) && result.traceDigest !== null;
    record.attempts.push({
      attempt,
      seed,
      siteId: candidate.site.siteId,
      siteBinding: candidate.binding,
      status: result.status,
      feasible: result.feasible,
      verdict: result.verdict,
      generated,
      simulated,
      inputHash: result.inputHash,
      traceDigest: result.traceDigest,
      ...(result.error === undefined ? {} : { error: result.error }),
    });
    await attemptCheckpoint();
    finalResult = result;
    finalPaths = paths;
    if (generated) lastGenerated = { result, paths };
    if (hardEligibleCellResult(result, options.collisionPolicy ?? 'reject')) break;
    if (signal.aborted) break;
  }

  if (!finalResult || !finalPaths) {
    record.state = 'failed';
    record.error = { code: 'attempts_exhausted', reason: 'no catalog attempt was executed' };
    await finish(slot.status);
    return;
  }
  if (signal.aborted) {
    const recorded = record.attempts.at(-1);
    if (recorded?.attempt === finalResult.drawIndex) record.attempts.pop();
    await clearAttempt(finalPaths);
    record.state = 'pending';
    await attemptCheckpoint();
    return;
  }
  const evidence = resolveEvidencePaths(path.dirname(path.resolve(options.file)), slot);
  if (hardEligibleCellResult(finalResult, options.collisionPolicy ?? 'reject')) {
    await promoteAttempt(finalPaths, evidence, finalResult);
    record.state = 'simulated';
    await finish('simulated');
  } else if (lastGenerated) {
    await promoteAttempt(lastGenerated.paths, evidence, lastGenerated.result);
    record.state = 'rejected';
    record.error = finalResult.error;
    await finish('rejected');
  } else {
    record.state = 'failed';
    record.error = finalResult.error ?? { code: 'generation_failed', reason: 'all bounded attempts failed before materialization' };
    await finish(slot.status);
  }
}

function hardEligibleCellResult(result: CellResult, collisionPolicy: 'reject' | 'allow'): boolean {
  const collisions = result.metrics?.['collisions'];
  return hasResumableAcceptedEligibility(
    result,
    collisionPolicy,
    Array.isArray(collisions) ? collisions.length : 0,
  );
}

function attemptPaths(workRoot: string, identity: string, attempt: number): { instance: string; trace: string; result: string } {
  const dir = path.join(workRoot, identity, `attempt-${String(attempt).padStart(3, '0')}`);
  return { instance: path.join(dir, 'instance.json'), trace: path.join(dir, 'trace.json.gz'), result: path.join(dir, 'result.json') };
}

async function clearAttempt(paths: { instance: string; trace: string; result: string }): Promise<void> {
  await Promise.all([
    unlink(paths.instance).catch(() => undefined),
    unlink(paths.trace).catch(() => undefined),
    unlink(paths.result).catch(() => undefined),
  ]);
}

function resolveEvidencePaths(root: string, slot: ScenarioCatalogSlot): { instance: string; trace: string; result: string } {
  return {
    instance: path.join(root, slot.evidencePaths.instance),
    trace: path.join(root, slot.evidencePaths.trace),
    result: path.join(root, slot.evidencePaths.result),
  };
}

export async function promoteAttempt(
  source: { instance: string; trace: string; result: string },
  target: { instance: string; trace: string; result: string },
  result: CellResult,
): Promise<void> {
  const hasInstance = existsSync(source.instance);
  const hasTrace = existsSync(source.trace);
  if (hasInstance) await atomicCopy(source.instance, target.instance);
  else await unlink(target.instance).catch(() => undefined);
  if (hasTrace) await atomicCopy(source.trace, target.trace);
  else await unlink(target.trace).catch(() => undefined);
  const instanceSha256 = hasInstance ? hash(await readFile(target.instance)) : null;
  const traceSha256 = hasTrace ? hash(await readFile(target.trace)) : null;
  await atomicWrite(target.result, `${JSON.stringify({
    ...result,
    instanceFile: hasInstance ? target.instance : null,
    traceFile: hasTrace ? target.trace : null,
    artifactHashes: { instanceSha256, traceSha256 },
  }, null, 2)}\n`);
}

function setCatalogStatus(
  catalog: ScenarioCatalogManifest,
  identity: string,
  status: CatalogSlotStatus,
): ScenarioCatalogManifest {
  const slots = catalog.slots.map((slot) => slot.identity === identity ? { ...slot, status } : slot);
  return refreshScenarioCatalog(catalog, slots);
}

async function runWorker(templateFile: string, options: CellOptions, signal: AbortSignal): Promise<CellResult> {
  const workerUrl = new URL('../catalog-batch-worker.mjs', import.meta.url);
  return new Promise<CellResult>((resolve) => {
    const worker = new Worker(workerUrl, { workerData: { templateFile, options } });
    let settled = false;
    const finish = (result: CellResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => {
      void worker.terminate();
      finish(workerFailure(options, new CliError('cancelled', 'catalog attempt cancelled')));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (result: CellResult) => {
      finish(result);
      void worker.terminate();
    });
    const failed = (error: unknown): void => {
      if (settled) return;
      finish(workerFailure(options, error));
    };
    worker.once('error', failed);
    worker.once('exit', (code) => {
      if (code !== 0) failed(new Error(`catalog worker exited with code ${code}`));
    });
  });
}

function workerFailure(options: CellOptions, error: unknown): CellResult {
  return {
    mapId: options.mapId,
    siteId: options.siteId,
    drawIndex: options.drawIndex,
    instanceId: options.instanceId ?? `${options.siteId}#${options.drawIndex}`,
    status: 'error', feasible: false, verdict: null, band: 'infeasible', tags: [], findings: [], invariants: [],
    evidence: {
      ok: false, recomputedInputHash: '', manifestInputHash: null, traceInputHash: null,
      inputActorIds: [], traceActorIds: [], traceTrackActorIds: [], actorIds: [], actorCount: 0,
      inputMapId: options.mapId, manifestMapId: null, traceMapId: null, matcherIndexDigest: null,
      manifestEngineGraphDigest: null, traceEngineGraphDigest: null, issues: [],
    },
    metrics: null, siteScore: 0, siteVerdict: 'infeasible', paramSeed: options.seed ?? '', params: {},
    inputHash: null, traceDigest: null, instanceFile: null, traceFile: null, issues: [],
    error: toStructuredError(error),
    eligibility: {
      collisionPolicy: options.collisionPolicy ?? 'reject',
      eligible: false,
      hardFailureCodes: [toStructuredError(error).code],
    },
    ...(options.catalogSlot === undefined ? {} : { catalogSlot: options.catalogSlot }),
  };
}

export async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const next = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value === undefined) return;
      await run(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, next));
}

async function validSimulatedResume(
  record: CatalogExecutionSlot,
  slot: ScenarioCatalogSlot,
  catalogFile: string,
  collisionPolicy: 'reject' | 'allow',
): Promise<boolean> {
  const final = [...record.attempts].reverse().find((attempt) => attempt.verdict === 'accept');
  if (!final?.inputHash || !final.traceDigest) return false;
  const paths = resolveEvidencePaths(path.dirname(catalogFile), slot);
  if (!existsSync(paths.instance) || !existsSync(paths.trace) || !existsSync(paths.result)) return false;
  try {
    const instance = JSON.parse(await readFile(paths.instance, 'utf8')) as {
      catalogSlot?: CatalogArtifactProvenance;
      manifest?: { inputHash?: string; replayKey?: { paramSeed?: string } };
    };
    const result = JSON.parse(await readFile(paths.result, 'utf8')) as CellResult;
    const trace = await readTraceFile(paths.trace);
    const traceHeader = trace.header as typeof trace.header & { catalogSlot?: CatalogArtifactProvenance };
    const expectedCatalogSlot = artifactProvenance(slot, final.seed, final.siteId);
    const expectedCatalogSlotJson = JSON.stringify(expectedCatalogSlot);
    const evidence = verifyEvidenceHashes(instance as unknown as InstanceFile, trace);
    const collisions = trace.metrics?.collisions?.length ?? 0;
    return evidence.ok &&
      JSON.stringify(instance.catalogSlot) === expectedCatalogSlotJson &&
      instance.manifest?.inputHash === final.inputHash &&
      instance.manifest.replayKey?.paramSeed === final.seed &&
      JSON.stringify(traceHeader.catalogSlot) === expectedCatalogSlotJson &&
      JSON.stringify(result.catalogSlot) === expectedCatalogSlotJson &&
      hasResumableAcceptedEligibility(result, collisionPolicy, collisions) &&
      result.inputHash === final.inputHash &&
      result.traceDigest === final.traceDigest &&
      result.artifactHashes?.instanceSha256 === hash(await readFile(paths.instance)) &&
      result.artifactHashes.traceSha256 === hash(await readFile(paths.trace)) &&
      trace.header.inputHash === final.inputHash &&
      traceDigest(trace) === final.traceDigest;
  } catch {
    return false;
  }
}

async function validRejectedResume(
  record: CatalogExecutionSlot,
  slot: ScenarioCatalogSlot,
  catalogFile: string,
  collisionPolicy: 'reject' | 'allow',
): Promise<boolean> {
  const final = [...record.attempts].reverse().find((attempt) => attempt.generated);
  if (!final) return false;
  const paths = resolveEvidencePaths(path.dirname(catalogFile), slot);
  if (!existsSync(paths.instance) || !existsSync(paths.result)) return false;
  try {
    const instance = JSON.parse(await readFile(paths.instance, 'utf8')) as {
      catalogSlot?: CatalogArtifactProvenance;
      manifest?: { inputHash?: string; replayKey?: { paramSeed?: string } };
    };
    const result = JSON.parse(await readFile(paths.result, 'utf8')) as CellResult;
    const expected = JSON.stringify(artifactProvenance(slot, final.seed, final.siteId));
    const instanceHash = hash(await readFile(paths.instance));
    const hasTrace = existsSync(paths.trace);
    const traceHash = hasTrace ? hash(await readFile(paths.trace)) : null;
    const traceClosesAttempt = hasTrace
      ? await rejectedTraceClosesAttempt(paths.trace, expected, final)
      : !final.simulated && final.traceDigest === null;
    return JSON.stringify(instance.catalogSlot) === expected &&
      JSON.stringify(result.catalogSlot) === expected &&
      instance.manifest?.inputHash === final.inputHash &&
      instance.manifest.replayKey?.paramSeed === final.seed &&
      result.status === final.status &&
      result.feasible === final.feasible &&
      result.verdict === final.verdict &&
      result.siteId === final.siteId &&
      result.drawIndex === final.attempt &&
      result.inputHash === final.inputHash &&
      result.traceDigest === final.traceDigest &&
      result.verdict !== 'accept' &&
      result.eligibility?.eligible === false &&
      result.eligibility.collisionPolicy === collisionPolicy &&
      result.artifactHashes?.instanceSha256 === instanceHash &&
      result.artifactHashes.traceSha256 === traceHash &&
      traceClosesAttempt;
  } catch {
    return false;
  }
}

async function rejectedTraceClosesAttempt(
  traceFile: string,
  expectedCatalogSlot: string,
  attempt: CatalogAttemptRecord,
): Promise<boolean> {
  const trace = await readTraceFile(traceFile);
  const header = trace.header as typeof trace.header & { catalogSlot?: CatalogArtifactProvenance };
  return attempt.simulated &&
    attempt.traceDigest !== null &&
    JSON.stringify(header.catalogSlot) === expectedCatalogSlot &&
    traceDigest(trace) === attempt.traceDigest;
}

async function readCatalog(file: string): Promise<ScenarioCatalogManifest> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ScenarioCatalogManifest;
  } catch (error) {
    throw new CliError('invalid_catalog', error instanceof Error ? error.message : String(error), { path: file });
  }
}

async function readLedger(file: string): Promise<CatalogExecutionLedger | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CatalogExecutionLedger;
  } catch {
    return null;
  }
}

async function atomicCopy(source: string, target: string): Promise<void> {
  await atomicWrite(target, await readFile(source));
}

async function atomicWrite(file: string, value: string | Uint8Array): Promise<void> {
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${hash(`${absolute}\0${Date.now()}\0${Math.random()}`).slice(0, 12)}.tmp`;
  try {
    await writeFile(temporary, value);
    await rename(temporary, absolute);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
