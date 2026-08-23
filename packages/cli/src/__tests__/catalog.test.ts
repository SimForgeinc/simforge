import { gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CATALOG_SLOTS_PER_MAP,
  CATALOG_MIN_INCIDENT_TYPES_PER_MAP,
  INCIDENT_DOMAINS,
  INCIDENT_TAXONOMY,
  OPERATIONAL_VARIANTS,
  matcherSiteClosesLocation,
  validateScenarioCatalog,
  type ScenarioCatalogManifest,
} from '../catalog.js';
import { DEV_ASSETS, KNOWN_MAPS, REPO_ROOT } from '@simforge/compiler';
import { templateId as canonicalTemplateId } from '../materialize.js';
import { matchOnMap } from '@simforge/compiler';
import { readTemplate } from '@simforge/compiler';
import { validateCatalogLiveClosure } from '../commands/catalog.js';
import { localMapAssetRequirement } from './asset-test-utils.js';

let tmp: string;
let manifestFile: string;
let catalog: ScenarioCatalogManifest;
const catalogMapAssets = localMapAssetRequirement(KNOWN_MAPS);

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-catalog-'));
  manifestFile = path.join(tmp, 'catalog.json');
  // Catalog creation itself is exercised by the checked regeneration command;
  // focused structural tests consume the exact artifact it committed.
  catalog = JSON.parse(await readFile(
    path.join(REPO_ROOT, 'catalog', 'uniscenarios-five-map-v2.catalog.json'),
    'utf8',
  )) as ScenarioCatalogManifest;
  await writeFile(manifestFile, `${JSON.stringify(catalog, null, 2)}\n`);
}, 180_000);

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
}, 60_000);

function clone(): ScenarioCatalogManifest {
  return JSON.parse(JSON.stringify(catalog)) as ScenarioCatalogManifest;
}

function refreshSlotDigest(slot: Record<string, unknown>): void {
  // Deliberately not exposed by production code: mutation tests generally want
  // both the local design digest and catalog digest to fail.
  delete slot['designDigest'];
}

describe('UniScenarios authored scenario catalog', () => {
  it.skipIf(!catalogMapAssets.available)(`contains exactly 100 deterministic, map-grounded occurrences per supported map${catalogMapAssets.missingReason}`, async () => {
    expect(catalog.slots).toHaveLength(KNOWN_MAPS.length * CATALOG_SLOTS_PER_MAP);
    expect(new Set(catalog.slots.map((slot) => slot.identity)).size).toBe(catalog.slots.length);
    expect(new Set(catalog.slots.map((slot) => slot.seed)).size).toBe(catalog.slots.length);

    for (const mapId of KNOWN_MAPS) {
      const slots = catalog.slots.filter((slot) => slot.mapId === mapId);
      expect(slots).toHaveLength(100);
      expect(slots.map((slot) => slot.ordinal)).toEqual(Array.from({ length: 100 }, (_, i) => i));
      expect(new Set(slots.map((slot) => slot.scenario.incidentId)).size).toBeGreaterThanOrEqual(CATALOG_MIN_INCIDENT_TYPES_PER_MAP);
      expect(slots.every((slot) => slot.status === 'authored')).toBe(true);
      expect(slots.every((slot) => slot.brief.eventSequence.length >= 3)).toBe(true);
      expect(slots.every((slot) => slot.acceptance.checks.length === 6)).toBe(true);
      expect(slots.every((slot) => slot.evidencePaths.video.startsWith(`evidence/${mapId}/`))).toBe(true);
      expect(slots.every((slot) =>
        slot.implementation.state === 'template-backed' &&
        typeof slot.implementation.matcherSiteId === 'string' &&
        slot.implementation.matchedLocationId === slot.site.locationId &&
        slot.implementation.materializedVariantId === slot.variant.id
      )).toBe(true);

      const locationBytes = await readFile(path.join(DEV_ASSETS, mapId, 'derived', 'locations.json.gz'));
      const source = JSON.parse(gunzipSync(locationBytes).toString('utf8')) as { locations: Array<{ id: string }> };
      const sourceIds = new Set(source.locations.map((location) => location.id));
      expect(slots.every((slot) => sourceIds.has(slot.site.locationId))).toBe(true);
    }

    expect(catalog.taxonomy.length).toBeGreaterThanOrEqual(30);
    expect(new Set(catalog.taxonomy.map((entry) => entry.domain))).toEqual(new Set(INCIDENT_DOMAINS));
    expect(new Set(catalog.slots.map((slot) => slot.scenario.incidentId))).toEqual(
      new Set(INCIDENT_TAXONOMY.map((incident) => incident.id)),
    );
    expect(catalog.slots.every((slot) => slot.variant.id === OPERATIONAL_VARIANTS[0]!.id)).toBe(true);
    expect(catalog.progress).toEqual({
      target: 500,
      planned: 0,
      authored: 500,
      generated: 0,
      simulated: 0,
      rendered: 0,
      visuallyAccepted: 0,
      rejected: 0,
    });

    const report = validateScenarioCatalog(catalog, { manifestFile });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.maps).toEqual(Object.fromEntries(KNOWN_MAPS.map((mapId) => [mapId, 100])));
  }, 3_600_000);

  it('keeps matcher, engine, and location provenance as distinct digest domains', () => {
    for (const map of catalog.maps) {
      expect(map.matcherIndexDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(map.engineGraphDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(map.locationCatalogDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(new Set([map.matcherIndexDigest, map.engineGraphDigest, map.locationCatalogDigest]).size).toBe(3);
    }
    for (const slot of catalog.slots) {
      const map = catalog.maps.find((entry) => entry.mapId === slot.mapId)!;
      expect(slot.provenance.matcherIndexDigest).toBe(map.matcherIndexDigest);
      expect(slot.provenance.engineGraphDigest).toBe(map.engineGraphDigest);
      expect(slot.provenance.locationCatalogDigest).toBe(map.locationCatalogDigest);
    }
  });

  it('closes every registry template id to its canonical replay-key identity', async () => {
    for (const registered of catalog.templates) {
      const template = await readTemplate(path.join(REPO_ROOT, registered.source));
      expect(registered.runtimeTemplateId).toBe(canonicalTemplateId(template));
      const slots = catalog.slots.filter((slot) => slot.implementation.templateSource === registered.source);
      expect(slots.length, registered.id).toBeGreaterThan(0);
      expect(slots.every((slot) => slot.implementation.templateId === registered.runtimeTemplateId)).toBe(true);
    }
  });

  it.skipIf(!catalogMapAssets.available)(`persists only matcher sites that close against the selected catalog location${catalogMapAssets.missingReason}`, async () => {
    const executable = catalog.slots.filter((slot) => slot.implementation.state === 'template-backed');
    const matchCache = new Map<string, ReturnType<typeof matchOnMap>>();
    expect(executable.length).toBeGreaterThan(0);
    for (const slot of executable) {
      expect(slot.implementation.matchedLocationId).toBe(slot.site.locationId);
      expect(slot.implementation.matcherSiteId).toMatch(/^[0-9a-f]{16}$/);
      expect(slot.implementation.materializedVariantId).toBe(slot.variant.id);
      const matchKey = `${slot.implementation.templateSource}\0${slot.mapId}`;
      let pendingMatch = matchCache.get(matchKey);
      if (!pendingMatch) {
        const template = await readTemplate(path.join(REPO_ROOT, slot.implementation.templateSource!));
        const qualityFirstTemplate = {
          ...template,
          anchor: {
            ...template.anchor,
            policy: {
              ...template.anchor.policy,
              diversity: 'off' as const,
              maxSitesPerMap: 1_000,
            },
          },
        };
        pendingMatch = matchOnMap(qualityFirstTemplate, slot.mapId);
        matchCache.set(matchKey, pendingMatch);
      }
      const match = await pendingMatch;
      const matcherSite = match.report.sites.find((site) => site.siteId === slot.implementation.matcherSiteId);
      const location = match.bundle.catalog.locations.find((entry) => entry.id === slot.site.locationId);
      expect(matcherSite, slot.identity).toBeDefined();
      expect(location, slot.identity).toBeDefined();
      expect(matcherSiteClosesLocation(matcherSite!, location, match.bundle.index), slot.identity).toBe(true);
      expect(slot.provenance.matcherIndexDigest).toBe(match.bundle.index.topologyDigest);
      expect(slot.provenance.engineGraphDigest).toBe(match.bundle.graph.topologyDigest);
    }
  }, 3_600_000);

  it('is a broad incident catalog rather than repeated parameter samples of five templates', () => {
    expect(INCIDENT_TAXONOMY.length).toBeGreaterThanOrEqual(30);
    const implemented = catalog.slots.filter((slot) => slot.implementation.state === 'template-backed');
    const authoredDesigns = catalog.slots.filter((slot) => slot.implementation.state === 'authored-design');
    expect(implemented).toHaveLength(500);
    expect(authoredDesigns).toHaveLength(0);
    expect(new Set(catalog.slots.map((slot) => slot.scenario.incidentId)).size).toBeGreaterThanOrEqual(30);
    expect(catalog.researchSources.every((source) => source.url.startsWith('https://'))).toBe(true);
  });

  it.skipIf(!catalogMapAssets.available)(`verifies the authoritative 500-occurrence manifest through the real CLI${catalogMapAssets.missingReason}`, async () => {
    const verified = await execa('node', [
      path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'uniscenarios.js'),
      'catalog', 'verify', manifestFile,
    ], { reject: false, timeout: 300_000 });
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      slots: 500,
      statuses: { authored: 500 },
      progress: { authored: 500, rendered: 0, visuallyAccepted: 0 },
    });
  }, 600_000);

  it.skipIf(!catalogMapAssets.available)(`makes verification execute live matcher closure instead of trusting a self-consistent stale id${catalogMapAssets.missingReason}`, async () => {
    const original = catalog.slots.find((slot) => slot.implementation.state === 'template-backed')!;
    const stale = {
      ...catalog,
      slots: [{
        ...original,
        implementation: { ...original.implementation, matcherSiteId: '0000000000000000' },
      }],
    } as ScenarioCatalogManifest;
    const issues = await validateCatalogLiveClosure(stale);
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'invalid_site_binding',
        path: 'slots[0].implementation.matcherSiteId',
      }),
    ]);
  }, 180_000);

  it('rejects duplicate occurrence identities', () => {
    const broken = clone() as unknown as { slots: Array<Record<string, unknown>> };
    broken.slots[1] = { ...broken.slots[0], ordinal: 1 };
    refreshSlotDigest(broken.slots[1]!);
    const report = validateScenarioCatalog(broken, { manifestFile });
    expect(report.ok).toBe(false);
    expect(report.issues.map((entry) => entry.code)).toContain('duplicate_identity');
  });

  it('rejects a site whose type or affordances do not fit its incident', () => {
    const broken = clone() as unknown as { slots: Array<Record<string, unknown>> };
    const target = broken.slots.find((slot) => (slot['scenario'] as { incidentId: string }).incidentId === 'vru.multiple-threat-crosswalk')!;
    (target['site'] as Record<string, unknown>)['type'] = 'parking_space';
    (target['site'] as Record<string, unknown>)['affordances'] = [];
    refreshSlotDigest(target);
    const report = validateScenarioCatalog(broken, { manifestFile });
    expect(report.issues.map((entry) => entry.code)).toContain('invalid_site_binding');
  });

  it('rejects a template-backed slot whose persisted matcher/location pair is mismatched', () => {
    const broken = clone() as unknown as { slots: Array<Record<string, unknown>> };
    const target = broken.slots.find((slot) =>
      (slot['implementation'] as { state: string }).state === 'template-backed',
    )!;
    (target['implementation'] as Record<string, unknown>)['matchedLocationId'] = 'loc_not_the_selected_location';
    refreshSlotDigest(target);
    const report = validateScenarioCatalog(broken, { manifestFile });
    expect(report.issues.some((entry) =>
      entry.code === 'invalid_site_binding' && entry.path.endsWith('.implementation'),
    )).toBe(true);
  });

  it('rejects a template-backed slot that claims a different operational variant', () => {
    const broken = clone() as unknown as { slots: Array<Record<string, unknown>> };
    const target = broken.slots.find((slot) =>
      (slot['implementation'] as { state: string }).state === 'template-backed',
    )!;
    (target['implementation'] as Record<string, unknown>)['materializedVariantId'] = 'not-the-reserved-variant';
    refreshSlotDigest(target);
    const report = validateScenarioCatalog(broken, { manifestFile });
    expect(report.issues.some((entry) =>
      entry.path.endsWith('.implementation.materializedVariantId'),
    )).toBe(true);
  });

  it('rejects collapsed provenance domains', () => {
    const broken = clone() as unknown as {
      maps: Array<Record<string, unknown>>;
      slots: Array<Record<string, unknown>>;
    };
    broken.maps[0]!['engineGraphDigest'] = broken.maps[0]!['matcherIndexDigest'];
    const report = validateScenarioCatalog(broken, { manifestFile });
    expect(report.issues.some((entry) => entry.code === 'invalid_provenance' && entry.path.startsWith('maps('))).toBe(true);
  });

  it('rejects missing evidence as soon as status advances past authored', () => {
    const broken = clone() as unknown as { slots: Array<Record<string, unknown>> };
    broken.slots[0]!['status'] = 'simulated';
    refreshSlotDigest(broken.slots[0]!);
    const report = validateScenarioCatalog(broken, { manifestFile, evidenceExists: () => false });
    expect(report.ok).toBe(false);
    const missing = report.issues.filter((entry) => entry.code === 'missing_evidence');
    expect(missing.map((entry) => entry.path)).toEqual([
      'slots[0].evidencePaths.instance',
      'slots[0].evidencePaths.trace',
      'slots[0].evidencePaths.result',
    ]);
  });

  it('never accepts visual status without six passed gates and a reviewer', () => {
    const broken = clone() as unknown as { slots: Array<Record<string, unknown>> };
    broken.slots[0]!['status'] = 'visually-accepted';
    refreshSlotDigest(broken.slots[0]!);
    const report = validateScenarioCatalog(broken, {
      manifestFile,
      evidenceExists: () => true,
    });
    expect(report.issues.map((entry) => entry.code)).toContain('invalid_acceptance_manifest');
  });

  it('can enforce complete evidence bundles without claiming authored designs are accepted', () => {
    const report = validateScenarioCatalog(catalog, {
      manifestFile,
      requireEvidence: true,
      evidenceExists: (file) => file.endsWith('/instance.json'),
    });
    expect(report.ok).toBe(false);
    expect(report.evidenceChecked).toBe(true);
    expect(report.issues.some((entry) => entry.code === 'missing_evidence' && entry.path.endsWith('.video'))).toBe(true);
  });
});
