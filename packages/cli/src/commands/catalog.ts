import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createScenarioCatalog,
  matcherSiteClosesLocation,
  validateScenarioCatalog,
  type CatalogIssue,
  type ScenarioCatalogManifest,
} from '../catalog.js';
import { CliError, EXIT } from '../errors.js';
import { REPO_ROOT } from '@simforge/compiler';
import { emit, emitLines } from '../output.js';
import { CATALOG_EXACT_SITE_OPTIONS, clearSiteMatchCache, matchOnMap } from '@simforge/compiler';
import { readTemplate } from '@simforge/compiler';
import { writeJsonFile } from '@simforge/compiler';

export interface CatalogCreateOptions {
  readonly out: string;
  readonly namespace?: string | undefined;
  readonly evidenceRoot?: string | undefined;
  readonly pretty: boolean;
}

export async function catalogCreate(options: CatalogCreateOptions): Promise<number> {
  const catalog = await createScenarioCatalog({
    namespace: options.namespace,
    evidenceRoot: options.evidenceRoot,
  });
  await writeJsonFile(options.out, catalog);
  const payload = catalogSummary(catalog, path.resolve(options.out));
  if (options.pretty) {
    emitLines([
      `UniScenarios catalog ${catalog.catalogDigest}`,
      `${catalog.slots.length} deterministic authored designs: ${catalog.contract.slotsPerMap} × ${catalog.contract.supportedMaps.length} maps`,
      `progress: authored=${catalog.progress.authored}, generated=${catalog.progress.generated}, simulated=${catalog.progress.simulated}, rendered=${catalog.progress.rendered}, visually-accepted=${catalog.progress.visuallyAccepted}`,
      `manifest: ${path.resolve(options.out)}`,
    ]);
  } else {
    emit(payload, options);
  }
  return EXIT.ok;
}

export interface CatalogVerifyOptions {
  readonly file: string;
  readonly evidenceRoot?: string | undefined;
  readonly requireEvidence: boolean;
  readonly pretty: boolean;
}

/**
 * Prove that every persisted catalog reservation still exists under the live
 * exact matcher. Static hashes only prove that the manifest is internally
 * self-consistent; they cannot detect a matcher-semantics change that makes a
 * formerly persisted site unreachable.
 */
export async function validateCatalogLiveClosure(
  manifest: ScenarioCatalogManifest,
): Promise<readonly CatalogIssue[]> {
  const issues: CatalogIssue[] = [];
  const groups = new Map<string, Array<{ index: number; slot: ScenarioCatalogManifest['slots'][number] }>>();

  for (const [index, slot] of manifest.slots.entries()) {
    const source = slot.implementation.templateSource;
    const matcherSiteId = slot.implementation.matcherSiteId;
    if (slot.implementation.state !== 'template-backed' || !source || !matcherSiteId) continue;
    const key = `${source}\0${slot.mapId}`;
    const group = groups.get(key) ?? [];
    group.push({ index, slot });
    groups.set(key, group);
  }

  for (const [key, group] of groups) {
    const separator = key.lastIndexOf('\0');
    const source = key.slice(0, separator);
    const mapId = key.slice(separator + 1);
    try {
      const templateFile = path.resolve(REPO_ROOT, source);
      const templateBytes = await readFile(templateFile);
      const templateDigest = createHash('sha256').update(templateBytes).digest('hex');
      for (const { index, slot } of group) {
        if (slot.provenance.templateDigest !== templateDigest) {
          issues.push({
            code: 'invalid_provenance',
            path: `slots[${index}].provenance.templateDigest`,
            reason: `catalog template digest does not match the live executable ${source}`,
            expected: templateDigest,
            actual: slot.provenance.templateDigest,
          });
        }
      }
      const template = await readTemplate(templateFile);
      const match = await matchOnMap(template, mapId, CATALOG_EXACT_SITE_OPTIONS);
      for (const { index, slot } of group) {
        const matcherSiteId = slot.implementation.matcherSiteId!;
        const site = match.report.sites.find((candidate) => candidate.siteId === matcherSiteId);
        const location = match.bundle.catalog.locations.find((candidate) => candidate.id === slot.site.locationId);
        if (!site || !location || !matcherSiteClosesLocation(site, location, match.bundle.index)) {
          issues.push({
            code: 'invalid_site_binding',
            path: `slots[${index}].implementation.matcherSiteId`,
            reason: `persisted matcher site ${matcherSiteId} no longer closes against catalog location ${slot.site.locationId} under the live exact matcher`,
          });
        }
      }
    } catch (error) {
      for (const { index } of group) {
        issues.push({
          code: 'invalid_site_binding',
          path: `slots[${index}].implementation.matcherSiteId`,
          reason: `could not execute the live exact matcher: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      clearSiteMatchCache();
    }
  }

  return issues;
}

export async function catalogVerify(options: CatalogVerifyOptions): Promise<number> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(options.file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError('file_not_found', `cannot read ${options.file}`, { path: options.file });
    }
    throw new CliError('invalid_json', error instanceof Error ? error.message : String(error), {
      path: options.file,
    });
  }
  const staticReport = validateScenarioCatalog(value, {
    manifestFile: options.file,
    evidenceRootOverride: options.evidenceRoot,
    requireEvidence: options.requireEvidence,
  });
  const liveIssues = staticReport.ok
    ? await validateCatalogLiveClosure(value as ScenarioCatalogManifest)
    : [];
  const report = liveIssues.length === 0
    ? staticReport
    : { ...staticReport, ok: false, issues: [...staticReport.issues, ...liveIssues] };
  const payload = { manifest: path.resolve(options.file), ...report };
  if (options.pretty) {
    const lines = [
      `${report.ok ? 'OK' : 'INVALID'} — ${report.slots} catalog slots`,
      `digest: ${report.catalogDigest ?? '—'}`,
      `maps: ${Object.entries(report.maps).map(([map, count]) => `${map}=${count}`).join(', ') || '—'}`,
      `statuses: ${Object.entries(report.statuses).map(([status, count]) => `${status}=${count}`).join(', ') || '—'}`,
      `incident breadth: ${Object.entries(report.incidentTypesByMap).map(([map, count]) => `${map}=${count}`).join(', ') || '—'}`,
      `domain breadth: ${Object.entries(report.domainsByMap).map(([map, count]) => `${map}=${count}`).join(', ') || '—'}`,
      `progress: authored=${report.progress.authored}, generated=${report.progress.generated}, simulated=${report.progress.simulated}, rendered=${report.progress.rendered}, visually-accepted=${report.progress.visuallyAccepted}`,
      `evidence checked: ${report.evidenceChecked ? 'yes' : 'no (authored designs have no claimed runtime evidence)'}`,
    ];
    if (report.issues.length > 0) {
      lines.push('', ...report.issues.map((entry) => `${entry.code} at ${entry.path}: ${entry.reason}`));
    }
    emitLines(lines);
  } else {
    emit(payload, options);
  }
  return report.ok ? EXIT.ok : EXIT.validationFindings;
}

function catalogSummary(catalog: ScenarioCatalogManifest, manifest: string): Record<string, unknown> {
  const perMap = Object.fromEntries(catalog.contract.supportedMaps.map((mapId) => [
    mapId,
    catalog.slots.filter((slot) => slot.mapId === mapId).length,
  ]));
  return {
    kind: catalog.kind,
    version: catalog.version,
    catalogDigest: catalog.catalogDigest,
    namespace: catalog.provenance.namespace,
    slotsPerMap: catalog.contract.slotsPerMap,
    totalSlots: catalog.contract.totalSlots,
    maps: perMap,
    templates: catalog.templates,
    taxonomy: {
      incidentTypes: catalog.taxonomy.length,
      domains: new Set(catalog.taxonomy.map((entry) => entry.domain)).size,
      incidentTypesByMap: Object.fromEntries(catalog.contract.supportedMaps.map((mapId) => [
        mapId,
        new Set(catalog.slots.filter((slot) => slot.mapId === mapId).map((slot) => slot.scenario.incidentId)).size,
      ])),
    },
    progress: catalog.progress,
    status: { authored: catalog.slots.length },
    manifest,
  };
}
