import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { DerivedMapIndex, MatchedSite } from '@uniscenarios/anchor-matcher';

import { hardEligibilityFailureCodes, hardInvariantFailures, runCell, type CellResult } from '../batch-cell.js';
import type { CatalogExecutionSlot } from '../commands/catalog-batch.js';
import {
  catalogAttemptSeed,
  catalogTopologyProvenanceCloses,
  deriveCatalogExecutionCounts,
  hasResumableAcceptedEligibility,
  invalidateStaleResume,
  promoteAttempt,
  reconcileInterruptedExecutionSlot,
  resolvePersistedCatalogSite,
  runBounded,
} from '../commands/catalog-batch.js';
import {
  matcherSiteClosesLocation,
  refreshScenarioCatalog,
  validateScenarioCatalog,
  type ScenarioCatalogManifest,
} from '../catalog.js';
import { REPO_ROOT } from '@uniscenarios/scenario-materializer';
import { readTemplate } from '@uniscenarios/scenario-materializer';
import { localMapAssetRequirement } from './asset-test-utils.js';

const temporary: string[] = [];
const catalogMapAssets = localMapAssetRequirement(['yale-street']);

async function waitForChild(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { code, stdout, stderr };
}

async function waitForLedgerState(
  file: string,
  predicate: (ledger: { status: string; slots: CatalogExecutionSlot[] }) => boolean,
  timeoutMs = 240_000,
): Promise<{ status: string; slots: CatalogExecutionSlot[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ledger = JSON.parse(await readFile(file, 'utf8')) as { status: string; slots: CatalogExecutionSlot[] };
      if (predicate(ledger)) return ledger;
    } catch {
      // Atomic creation may not have reached its first rename yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ledger state at ${file}`);
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function executionSlot(overrides: Partial<CatalogExecutionSlot> = {}): CatalogExecutionSlot {
  return {
    identity: 'slot-1', mapId: 'map', incidentId: 'incident', templateId: 'template',
    state: 'pending', attempts: [], resumed: false, ...overrides,
  };
}

function currentContractCatalog(catalog: ScenarioCatalogManifest): ScenarioCatalogManifest {
  return refreshScenarioCatalog(catalog, catalog.slots.map((slot) => ({
    ...slot,
    implementation: slot.implementation.state === 'template-backed'
      ? { ...slot.implementation, materializedVariantId: slot.variant.id }
      : slot.implementation,
  })));
}

describe('catalog batch ledger', () => {
  it.skipIf(!catalogMapAssets.available).each([
    ['adult-midblock', 'examples/mechanisms/junction-vru/adult-midblock-crossing.template.json', 'yale-street', '74807eaab0cafa84'],
    ['lead-hard-brake', 'examples/mechanisms/corridor/lead-hard-brake.template.json', 'yale-street', 'c68b36f5280f929e'],
    ['driveway-emergence', 'examples/mechanisms/parking-transit/driveway-emergence.template.json', 'yale-street', '9d1fc997d6b5ab83'],
    ['animal-crossing', 'examples/mechanisms/obstacle/animal-crossing.template.json', 'yale-street', '337ecc44df9470ed'],
  ] as const)(`carries the catalog exact-site policy through the worker cell path for %s${catalogMapAssets.missingReason}`, async (_name, source, mapId, siteId) => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-catalog-worker-'));
    temporary.push(outDir);
    const template = await readTemplate(path.join(REPO_ROOT, source));
    const result = await runCell(template, {
      mapId,
      siteId,
      drawIndex: 0,
      outDir,
      writeTrace: false,
      filter: 'critical',
      exactCatalogSiteResolution: true,
      collisionPolicy: 'reject',
    });
    expect(result.siteId).toBe(siteId);
    expect(result.error?.code).not.toBe('unknown_site');
  }, 180_000);

  it.skipIf(!catalogMapAssets.available)(`replays every persisted catalog site under the same lossless exact-site policy used by authoring${catalogMapAssets.missingReason}`, async () => {
    const catalog = JSON.parse(await readFile(
      path.join(REPO_ROOT, 'catalog', 'uniscenarios-five-map-v2.catalog.json'),
      'utf8',
    )) as ScenarioCatalogManifest;
    const templates = new Map<string, Awaited<ReturnType<typeof readTemplate>>>();
    for (const slot of catalog.slots) {
      const source = slot.implementation.templateSource;
      expect(source, slot.identity).toBeTruthy();
      let template = templates.get(source!);
      if (!template) {
        template = await readTemplate(path.join(REPO_ROOT, source!));
        templates.set(source!, template);
      }
      const resolved = await resolvePersistedCatalogSite(slot, template);
      expect(resolved.site.siteId, slot.identity).toBe(slot.implementation.matcherSiteId);
    }
  }, 3_600_000);

  it.skipIf(!catalogMapAssets.available)(`fails closed when an exact persisted matcher site no longer exists${catalogMapAssets.missingReason}`, async () => {
    const catalog = JSON.parse(await readFile(
      path.join(REPO_ROOT, 'catalog', 'uniscenarios-five-map-v2.catalog.json'),
      'utf8',
    )) as ScenarioCatalogManifest;
    const original = catalog.slots.find((slot) => slot.implementation.state === 'template-backed')!;
    const template = await readTemplate(path.join(REPO_ROOT, original.implementation.templateSource!));
    const drifted = {
      ...original,
      implementation: { ...original.implementation, matcherSiteId: '0000000000000000' },
    };
    await expect(resolvePersistedCatalogSite(drifted, template)).rejects.toMatchObject({
      code: 'catalog_site_not_matchable',
      path: original.identity,
    });
  }, 180_000);

  it.skipIf(!catalogMapAssets.available)(`fails closed when the persisted matcher-site and catalog location no longer close${catalogMapAssets.missingReason}`, async () => {
    const catalog = JSON.parse(await readFile(
      path.join(REPO_ROOT, 'catalog', 'uniscenarios-five-map-v2.catalog.json'),
      'utf8',
    )) as ScenarioCatalogManifest;
    const original = catalog.slots.find((slot) => slot.implementation.state === 'template-backed')!;
    const template = await readTemplate(path.join(REPO_ROOT, original.implementation.templateSource!));
    const drifted = {
      ...original,
      site: { ...original.site, locationId: 'loc_mismatched_reservation' },
    };
    await expect(resolvePersistedCatalogSite(drifted, template)).rejects.toMatchObject({
      code: 'unsupported_catalog_site_binding',
      path: original.identity,
    });
  }, 180_000);

  it('does not bind a nearby location from a different segment on the same road section', () => {
    const site = {
      frame: {
        origin: { mapFeatureId: 'seg_actual' },
        referencePath: [{ laneRsl: '10:0:-1' }],
      },
      featureMatches: {},
    } as unknown as MatchedSite;
    const location = {
      id: 'loc-nearby',
      anchor: {
        road: { rsl: '10:0:-2', s: 5, offsetM: 0, headingRad: 0 },
        scene: { x: 5, z: 0 },
      },
    };
    const index = {
      lanes: {
        '10:0:-2': { polyline: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      },
      pointFeatures: [],
      factIndex: { segmentIdsByLane: { '10:0:-2': 'seg_nearby' } },
    } as unknown as DerivedMapIndex;
    expect(matcherSiteClosesLocation(site, location, index)).toBe(false);
  });

  it('closes an exact point feature even when its anchor lane is perpendicular to the vehicle path', () => {
    const site = {
      frame: {
        origin: { mapFeatureId: 'vehicle-segment' },
        referencePath: [{ laneRsl: '10:0:-1' }],
      },
      featureMatches: { crossing: { mapFeatureId: 'crosswalk-1' } },
    } as unknown as MatchedSite;
    const location = {
      id: 'crosswalk-1',
      anchor: {
        road: { rsl: '20:0:-1', s: 5, offsetM: 0, headingRad: Math.PI / 2 },
        scene: { x: 5, z: 0 },
      },
    };
    const index = {
      lanes: {
        '10:0:-1': { polyline: [{ x: 5, y: -10 }, { x: 5, y: 10 }] },
        '20:0:-1': { polyline: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      },
      pointFeatures: [{ id: 'crosswalk-1', kind: 'crossing' }],
      factIndex: { segmentIdsByLane: { '10:0:-1': 'vehicle-segment', '20:0:-1': 'crossing-segment' } },
    } as unknown as DerivedMapIndex;
    expect(matcherSiteClosesLocation(site, location, index)).toBe(true);
    expect(matcherSiteClosesLocation({
      ...site,
      featureMatches: { crossing: { mapFeatureId: 'different-crosswalk' } },
    } as unknown as MatchedSite, location, index)).toBe(false);
  });

  it('closes a derived work-zone corridor by exact segment and path without weakening point-feature identity', () => {
    const site = {
      frame: {
        origin: { mapFeatureId: 'work-zone-segment' },
        referencePath: [{ laneRsl: '10:0:-1' }, { laneRsl: '10:0:-2' }],
      },
      featureMatches: {},
    } as unknown as MatchedSite;
    const location = {
      id: 'work-zone-corridor',
      anchor: {
        road: { rsl: '10:0:-2', s: 5, offsetM: 0, headingRad: 0 },
        scene: { x: 5, z: 0 },
      },
    };
    const index = {
      lanes: {
        '10:0:-2': { polyline: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      },
      pointFeatures: [{ id: 'work-zone-corridor', kind: 'work_zone_suitable' }],
      factIndex: { segmentIdsByLane: { '10:0:-2': 'work-zone-segment' } },
    } as unknown as DerivedMapIndex;
    expect(matcherSiteClosesLocation(site, location, index)).toBe(true);
    expect(matcherSiteClosesLocation({
      ...site,
      featureMatches: {
        reservation: {
          mapFeatureId: 'work-zone-corridor',
          kind: 'work_zone_suitable',
          s: 5,
        },
      },
    } as unknown as MatchedSite, location, index)).toBe(true);
    expect(matcherSiteClosesLocation({
      ...site,
      frame: { ...site.frame, origin: { mapFeatureId: 'nearby-segment' } },
    } as unknown as MatchedSite, location, index)).toBe(false);
    expect(matcherSiteClosesLocation({
      ...site,
      featureMatches: {
        reservation: {
          mapFeatureId: 'different-work-zone-reservation',
          kind: 'work_zone_suitable',
          s: 5,
        },
      },
    } as unknown as MatchedSite, location, index)).toBe(false);
  });

  it('keeps a child reveal occlusion zone strictly feature-bound', () => {
    const location = {
      id: 'child-reveal-zone',
      anchor: {
        road: { rsl: '10:0:-1', s: 5, offsetM: 0, headingRad: 0 },
        scene: { x: 5, z: 0 },
      },
    };
    const index = {
      lanes: { '10:0:-1': { polyline: [{ x: 0, y: 0 }, { x: 10, y: 0 }] } },
      pointFeatures: [{ id: 'child-reveal-zone', kind: 'occlusion_zone' }],
      factIndex: { segmentIdsByLane: { '10:0:-1': 'child-zone-segment' } },
    } as unknown as DerivedMapIndex;
    const exact = {
      frame: {
        origin: { mapFeatureId: 'unrelated-vehicle-segment' },
        referencePath: [{ laneRsl: '20:0:-1' }],
      },
      featureMatches: { reveal: { mapFeatureId: 'child-reveal-zone' } },
    } as unknown as MatchedSite;
    expect(matcherSiteClosesLocation(exact, location, index)).toBe(true);
    expect(matcherSiteClosesLocation({ ...exact, featureMatches: {} } as MatchedSite, location, index)).toBe(false);
  });

  it('treats unchecked required invariants as hard failures', () => {
    const residual = (status: 'held' | 'violated' | 'unchecked', essentiality: string) => ({
      id: `${status}-${essentiality}`, kind: 'ttc', status, essentiality,
      range: null, achieved: null, residual: 0, method: 'test', reason: 'test',
    });
    expect(hardInvariantFailures([
      residual('held', 'required'),
      residual('violated', 'preferred'),
      residual('violated', 'required'),
      residual('unchecked', 'required'),
    ]).map((entry) => entry.status)).toEqual(['violated', 'unchecked']);
  });

  it('keeps accepted negative-control findings informational and resumable', () => {
    const hardFailureCodes = hardEligibilityFailureCodes({
      feasible: true,
      evidenceIssues: [],
      invariantFailures: [],
      evaluationVerdict: 'accept',
      evaluationFindings: [{ code: 'trivially_safe' }],
    });
    expect(hardFailureCodes).toEqual([]);
    expect(hasResumableAcceptedEligibility({
      status: 'ok', feasible: true, verdict: 'accept',
      eligibility: { collisionPolicy: 'reject', eligible: true, hardFailureCodes },
    }, 'reject', 0)).toBe(true);
    expect(hardEligibilityFailureCodes({
      feasible: true,
      evidenceIssues: [],
      invariantFailures: [],
      evaluationVerdict: 'reject',
      evaluationFindings: [{ code: 'collision' }],
    })).toEqual(['collision']);
    expect(hasResumableAcceptedEligibility({
      status: 'ok', feasible: true, verdict: 'accept',
      eligibility: { collisionPolicy: 'reject', eligible: false, hardFailureCodes: ['invariant_unchecked'] },
    }, 'reject', 0)).toBe(false);
  });

  it('uses the reservation seed first and deterministic replacement seeds thereafter', () => {
    const seed = 'ab'.repeat(32);
    expect(catalogAttemptSeed(seed, 0)).toBe(seed);
    expect(catalogAttemptSeed(seed, 1)).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogAttemptSeed(seed, 1)).toBe(catalogAttemptSeed(seed, 1));
    expect(catalogAttemptSeed(seed, 2)).not.toBe(catalogAttemptSeed(seed, 1));
  });

  it('rejects stale catalog topology before an attempt is dispatched', () => {
    expect(catalogTopologyProvenanceCloses(
      { matcherIndexDigest: 'matcher-current', engineGraphDigest: 'engine-current' },
      { matcherIndexDigest: 'matcher-current', engineGraphDigest: 'engine-current' },
    )).toBe(true);
    expect(catalogTopologyProvenanceCloses(
      { matcherIndexDigest: 'matcher-file-bytes', engineGraphDigest: 'engine-file-bytes' },
      { matcherIndexDigest: 'matcher-current', engineGraphDigest: 'engine-current' },
    )).toBe(false);
  });

  it('derives stage counts from recorded evidence instead of final-state optimism', () => {
    const slots = [
      executionSlot({
        state: 'rejected',
        attempts: [{
          attempt: 0, seed: 'a', siteId: 's', siteBinding: 'catalog-site',
          status: 'ok', feasible: true, verdict: 'reject', generated: true, simulated: true,
          inputHash: 'i', traceDigest: 't',
        }],
      }),
      executionSlot({ identity: 'slot-2', templateId: null, state: 'unsupported' }),
      executionSlot({ identity: 'slot-3', state: 'failed', resumed: true }),
    ];
    expect(deriveCatalogExecutionCounts(slots)).toEqual({
      total: 3, templateBacked: 2, supported: 2, unsupported: 1, pending: 0, running: 0,
      attempted: 1, generated: 1, simulated: 1, accepted: 0, rejected: 1,
      failed: 1, resumed: 1,
    });
  });

  it('stops dispatching after cancellation and never exceeds the bound', async () => {
    const controller = new AbortController();
    let active = 0;
    let peak = 0;
    let started = 0;
    await runBounded([0, 1, 2, 3, 4], 2, controller.signal, async () => {
      active += 1;
      started += 1;
      peak = Math.max(peak, active);
      if (started === 2) controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(started).toBe(2);
  });

  it('recovers a stale running record without consuming its next attempt or seed', () => {
    const seed = 'ab'.repeat(32);
    const prior = executionSlot({
      state: 'running',
      attempts: [{
        attempt: 0,
        seed,
        siteId: 'site',
        siteBinding: 'catalog-site',
        status: 'ok',
        feasible: true,
        verdict: 'reject',
        generated: true,
        simulated: true,
        inputHash: 'input',
        traceDigest: 'trace',
      }],
      error: { code: 'transient', reason: 'must not survive recovery' },
    });
    const recovered = reconcileInterruptedExecutionSlot(prior);
    expect(recovered).toMatchObject({ state: 'pending', resumed: true });
    expect(recovered.attempts).toEqual(prior.attempts);
    expect(recovered.error).toBeUndefined();
    expect(catalogAttemptSeed(seed, recovered.attempts.length)).toBe(catalogAttemptSeed(seed, 1));
  });

  it('preserves committed rejection evidence when promoted resume artifacts are stale', () => {
    const record = executionSlot({
      state: 'rejected',
      attempts: [{
        attempt: 0,
        seed: 'seed-0',
        siteId: 'site',
        siteBinding: 'catalog-site',
        status: 'ok',
        feasible: true,
        verdict: 'reject',
        generated: true,
        simulated: true,
        inputHash: 'input',
        traceDigest: 'trace',
      }],
    });
    invalidateStaleResume(record, { code: 'stale_resume_artifact', reason: 'missing promoted result' });
    expect(record).toMatchObject({
      state: 'pending',
      resumed: true,
      error: { code: 'stale_resume_artifact' },
    });
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]).toMatchObject({ attempt: 0, seed: 'seed-0', verdict: 'reject' });
  });

  it.skipIf(!catalogMapAssets.available)(`cancels and resumes through the direct CLI without consuming the interrupted attempt${catalogMapAssets.missingReason}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-catalog-cancel-resume-'));
    temporary.push(dir);
    const source = path.join(REPO_ROOT, 'catalog', 'uniscenarios-five-map-v2.catalog.json');
    const catalogFile = path.join(dir, 'catalog.json');
    const ledgerFile = path.join(dir, 'ledger.json');
    const catalog = JSON.parse(await readFile(source, 'utf8')) as ScenarioCatalogManifest;
    const slot = catalog.slots.find((candidate) => candidate.implementation.state === 'template-backed')!;
    await writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);

    const args = [
      path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'uniscenarios.js'),
      'catalog', 'batch', catalogFile,
      '--ledger', ledgerFile,
      '--slots', slot.identity,
      '--attempts', '1',
      '--concurrency', '1',
      '--filter', 'all',
    ];
    const first = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      // Cancel immediately after the first atomic checkpoint. This covers the
      // planning boundary as well as preventing an attempt from being spent.
      await waitForLedgerState(ledgerFile, (ledger) => ledger.status === 'running' && ledger.slots.length === 1);
      expect(first.kill('SIGINT')).toBe(true);
      const cancelledRun = await waitForChild(first);
      expect(cancelledRun.code, `${cancelledRun.stdout}\n${cancelledRun.stderr}`).toBe(2);
    } finally {
      if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL');
    }

    const cancelled = await waitForLedgerState(ledgerFile, (ledger) => ledger.status === 'cancelled');
    expect(cancelled.slots[0]).toMatchObject({ state: 'pending', attempts: [] });

    const resumed = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const resumedRun = await waitForChild(resumed);
    expect([0, 2], `${resumedRun.stdout}\n${resumedRun.stderr}`).toContain(resumedRun.code);
    const completed = await waitForLedgerState(ledgerFile, (ledger) => ledger.status === 'completed');
    expect(completed.slots[0]!.attempts).toHaveLength(1);
    expect(completed.slots[0]!.attempts[0]).toMatchObject({ attempt: 0, seed: slot.seed });
  }, 600_000);

  it('records hashes of the promoted target bytes in the result commit marker', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-catalog-promote-'));
    temporary.push(dir);
    const source = {
      instance: path.join(dir, 'work', 'instance.json'),
      trace: path.join(dir, 'work', 'trace.json.gz'),
      result: path.join(dir, 'work', 'result.json'),
    };
    const target = {
      instance: path.join(dir, 'evidence', 'instance.json'),
      trace: path.join(dir, 'evidence', 'trace.json.gz'),
      result: path.join(dir, 'evidence', 'result.json'),
    };
    await mkdir(path.dirname(source.instance), { recursive: true });
    await writeFile(source.instance, 'instance-target-bytes');
    await writeFile(source.trace, 'trace-target-bytes');
    await promoteAttempt(source, target, {
      status: 'ok',
      catalogSlot: { identity: 'slot-1' } as CellResult['catalogSlot'],
      eligibility: { collisionPolicy: 'reject', eligible: true, hardFailureCodes: [] },
    } as unknown as CellResult);
    const promoted = JSON.parse(await readFile(target.result, 'utf8')) as {
      artifactHashes: { instanceSha256: string; traceSha256: string };
      catalogSlot: { identity: string };
      eligibility: { collisionPolicy: string; eligible: boolean; hardFailureCodes: string[] };
    };
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(promoted.artifactHashes).toEqual({
      instanceSha256: digest('instance-target-bytes'),
      traceSha256: digest('trace-target-bytes'),
    });
    expect(promoted.catalogSlot.identity).toBe('slot-1');
    expect(promoted.eligibility).toEqual({
      collisionPolicy: 'reject', eligible: true, hardFailureCodes: [],
    });
  });

  it('removes stale promoted artifacts that the committed attempt did not produce', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-catalog-promote-clean-'));
    temporary.push(dir);
    const source = {
      instance: path.join(dir, 'work', 'instance.json'),
      trace: path.join(dir, 'work', 'trace.json.gz'),
      result: path.join(dir, 'work', 'result.json'),
    };
    const target = {
      instance: path.join(dir, 'evidence', 'instance.json'),
      trace: path.join(dir, 'evidence', 'trace.json.gz'),
      result: path.join(dir, 'evidence', 'result.json'),
    };
    await mkdir(path.dirname(source.instance), { recursive: true });
    await mkdir(path.dirname(target.trace), { recursive: true });
    await writeFile(source.instance, 'new-instance');
    await writeFile(target.trace, 'stale-trace');
    await promoteAttempt(source, target, {
      status: 'error',
      catalogSlot: { identity: 'slot-1' } as CellResult['catalogSlot'],
      eligibility: { collisionPolicy: 'reject', eligible: false, hardFailureCodes: ['simulation_failed'] },
    } as unknown as CellResult);

    const promoted = JSON.parse(await readFile(target.result, 'utf8')) as {
      artifactHashes: { instanceSha256: string; traceSha256: string | null };
    };
    await expect(readFile(target.trace)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(promoted.artifactHashes.traceSha256).toBeNull();
  });

  it('keeps authored design identity stable while recomputing lifecycle/catalog state', async () => {
    const source = path.join(REPO_ROOT, 'catalog', 'uniscenarios-five-map-v2.catalog.json');
    const catalog = currentContractCatalog(JSON.parse(await readFile(source, 'utf8')) as ScenarioCatalogManifest);
    const first = catalog.slots[0]!;
    const refreshed = refreshScenarioCatalog(catalog, [
      { ...first, status: 'generated' },
      ...catalog.slots.slice(1).map((slot) => ({ ...slot, status: 'authored' as const })),
    ]);
    expect(refreshed.progress.generated).toBe(1);
    expect(refreshed.progress.simulated).toBe(0);
    expect(refreshed.slots[0]!.designDigest).toBe(first.designDigest);
    expect(refreshed.catalogDigest).not.toBe(catalog.catalogDigest);
  });

  it('rejects an authored-only slot before execution instead of claiming support', async () => {
    const source = path.join(REPO_ROOT, 'catalog', 'uniscenarios-five-map-v2.catalog.json');
    const catalog = currentContractCatalog(JSON.parse(await readFile(source, 'utf8')) as ScenarioCatalogManifest);
    const first = catalog.slots[0]!;
    const broken = refreshScenarioCatalog(catalog, [
      { ...first, implementation: { state: 'authored-design' } },
      ...catalog.slots.slice(1),
    ]);
    const report = validateScenarioCatalog(broken, { manifestFile: source });
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'invalid_provenance' && issue.path === 'slots')).toBe(true);
  });

  it('rejects template provenance that lacks an exact catalog-location matcher binding', async () => {
    const source = path.join(REPO_ROOT, 'catalog', 'uniscenarios-five-map-v2.catalog.json');
    const catalog = currentContractCatalog(JSON.parse(await readFile(source, 'utf8')) as ScenarioCatalogManifest);
    const bound = catalog.slots.find((slot) => slot.implementation.state === 'template-backed')!;
    const broken = refreshScenarioCatalog(catalog, catalog.slots.map((slot) => slot.identity === bound.identity
      ? { ...slot, implementation: { ...slot.implementation, matcherSiteId: undefined, matchedLocationId: undefined } }
      : slot));
    const report = validateScenarioCatalog(broken, { manifestFile: source });
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'invalid_site_binding' && issue.path.endsWith('.implementation'))).toBe(true);
  });
});
