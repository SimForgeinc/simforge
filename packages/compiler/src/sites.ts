/**
 * Site matching: `template × map → ranked MatchedSite[]`.
 *
 * Thin on purpose — the matcher is a pure function and the only thing the CLI
 * adds is the vocabulary translation in `adapt.ts` and a memo, because
 * `simforge batch` matches the same template against the same map once per run and
 * would otherwise redo a few thousand frame evaluations per cell.
 */

import { matchAnchorReport, type MatchReport, type MatchedSite } from './anchor/index.js';
import { assertMaterializableMapControls } from './materialize.js';
import { buildSiteRoadControls, buildSiteSignalPlan } from './map-signals.js';
import type { ScenarioTemplateV2 } from '@simforge/scenario';

import { adaptTemplate, unmatchableNotes, type AdaptNote } from './adapt.js';
import { CliError } from './errors.js';
import { loadMap, type MapBundle } from './maps.js';

/**
 * Refuse to match an anchor whose author stated a requirement the matcher threw
 * away.
 *
 * This is the same rule as `lane_offset_unavailable` one level up: there, a
 * lane the site does not have is a site that cannot render the scenario; here,
 * a clause the matcher cannot express is a *requirement nobody will ever
 * check*. Matching anyway is worse than not matching, because it returns sites
 * at score 1.00 / `exact` that were scored against a strictly smaller predicate
 * than the one the author wrote — which is exactly how four parking archetypes
 * came to bind arterials and a freeway, and how a blind-crest scenario came to
 * bind five sites 142-272 m from the nearest crest, two of them on a map with
 * no crest at all.
 *
 * The escape hatch is the one the schema already has: mark the clause
 * `essentiality: "cosmetic"` and the adapter records a note instead.
 */
export function assertMatchableAnchor(notes: readonly AdaptNote[]): void {
  const fatal = unmatchableNotes(notes);
  if (fatal.length === 0) return;
  const first = fatal[0];
  throw new CliError(
    'clause_unmatchable',
    fatal.length === 1
      ? (first?.reason ?? 'an authored clause is unmatchable')
      : `${fatal.length} authored clauses are unmatchable; the first is at ${first?.path}: ${first?.reason}`,
    {
      path: first?.path ?? 'anchor',
      detail: {
        clauses: fatal.map((n) => ({ path: n.path, reason: n.reason })),
        hint: 'express the requirement with a clause the matcher supports, or mark it essentiality: "cosmetic" to state on the record that it is not a requirement',
      },
      exitCode: 2,
    },
  );
}

export interface SiteMatch {
  readonly mapId: string;
  readonly bundle: MapBundle;
  readonly report: MatchReport;
  readonly notes: AdaptNote[];
}

/**
 * The catalog persists a concrete matcher-site id, rather than an instruction
 * to pick the best currently-visible site.  Both catalog authoring and replay
 * therefore use this one policy: retain every otherwise-eligible exact site
 * (up to the schema's full cap) and never discard it for presentation
 * diversity.  Required clauses and the template's minimum score remain
 * untouched.
 */
export const CATALOG_EXACT_SITE_OPTIONS = {
  exactCatalogSiteResolution: true,
} as const;

/** Apply the catalog's exact-site policy to an already adapted matcher policy. */
export function catalogExactMatcherPolicy<T extends object>(policy: T): T & {
  diversity: 'none';
  maxSitesPerMap: number;
} {
  return { ...policy, diversity: 'none', maxSitesPerMap: 1_000 };
}

export interface SiteMatchOptions {
  readonly minScore?: number | undefined;
  readonly maxSites?: number | undefined;
  /** Use the catalog's lossless persisted-site replay policy. */
  readonly exactCatalogSiteResolution?: boolean | undefined;
}

const cache = new Map<string, SiteMatch>();

/** Release retained matcher reports after bounded bulk verification work. */
export function clearSiteMatchCache(): void {
  cache.clear();
}

/**
 * Required map controls are part of site feasibility, not a later best-effort
 * materialization detail. Keep sites with incomplete physical signal/stop
 * bindings out of the public ranked result so the first reported site is
 * always executable. Explicit stale site ids still resolve from `rejected`
 * and fail closed in the materializer with the precise control error.
 */
function filterExecutableMapControlSites(
  template: ScenarioTemplateV2,
  bundle: MapBundle,
  report: MatchReport,
): MatchReport {
  const sites: MatchedSite[] = [];
  const rejected = [...report.rejected];
  for (const site of report.sites) {
    try {
      const signalPlan = buildSiteSignalPlan(bundle, site);
      const roadControls = buildSiteRoadControls(bundle, site);
      assertMaterializableMapControls(template, bundle, site, signalPlan, roadControls);
      sites.push(site);
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'map_control_missing') throw error;
      rejected.push(site);
    }
  }
  if (sites.length === report.sites.length) return report;
  return {
    ...report,
    sites,
    rejected,
    failureSummary: sites.length === 0
      ? 'candidate geometry matched, but every site lacked an executable required map-control binding'
      : report.failureSummary,
    warnings: [
      ...report.warnings,
      `${report.sites.length - sites.length} site(s) were rejected because required map controls lacked executable physical bindings.`,
    ],
  };
}

function cacheKey(template: ScenarioTemplateV2, mapId: string): string {
  // Matching geometry alone is insufficient for cache identity: executable
  // map-control filtering also depends on the template's required controls
  // and roles. Templates that share an anchor/roles must not inherit another
  // template's filtered site set during catalog replay.
  return `${mapId}|${JSON.stringify(template)}`;
}

/** Match one template against one map. */
export async function matchOnMap(
  template: ScenarioTemplateV2,
  mapId: string,
  options: SiteMatchOptions = {},
): Promise<SiteMatch> {
  const key = `${cacheKey(template, mapId)}|${options.minScore ?? ''}|${options.maxSites ?? ''}|${options.exactCatalogSiteResolution ? 'catalog-exact' : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const bundle = await loadMap(mapId);
  const { anchor, roles, notes } = adaptTemplate(template);
  assertMatchableAnchor(notes);
  const policy = { ...(anchor.policy ?? {}) };
  if (options.minScore !== undefined) policy.minScore = options.minScore;
  if (options.maxSites !== undefined) policy.maxSitesPerMap = options.maxSites;
  if (options.exactCatalogSiteResolution) {
    // 1,000 is the validated model maximum, and is intentionally the same
    // cap used when the catalog reserves a matcher site.
    Object.assign(policy, catalogExactMatcherPolicy(policy));
  }

  const report = filterExecutableMapControlSites(
    template,
    bundle,
    matchAnchorReport({ ...anchor, policy }, bundle.index, { roles }),
  );
  const result: SiteMatch = { mapId, bundle, report, notes };
  cache.set(key, result);
  return result;
}

/** Match across several maps, in the given order. */
export async function matchOnMaps(
  template: ScenarioTemplateV2,
  mapIds: readonly string[],
  options: SiteMatchOptions = {},
): Promise<SiteMatch[]> {
  const out: SiteMatch[] = [];
  for (const mapId of mapIds) out.push(await matchOnMap(template, mapId, options));
  return out;
}

/** Find one site by id across a set of maps. */
export async function findSite(
  template: ScenarioTemplateV2,
  mapId: string,
  siteId: string,
  options: SiteMatchOptions = {},
): Promise<{ bundle: MapBundle; site: MatchedSite }> {
  const match = await matchOnMap(template, mapId, options);
  const site =
    match.report.sites.find((s) => s.siteId === siteId) ??
    match.report.rejected.find((s) => s.siteId === siteId);
  if (!site) {
    throw new CliError('unknown_site', `site "${siteId}" was not produced on ${mapId}`, {
      path: '--site',
      detail: {
        available: match.report.sites.slice(0, 10).map((s) => s.siteId),
        failureSummary: match.report.failureSummary,
      },
    });
  }
  return { bundle: match.bundle, site };
}

/** The compact site view the CLI prints. */
export function siteSummary(site: MatchedSite): Record<string, unknown> {
  return {
    siteId: site.siteId,
    mapId: site.mapId,
    score: round3(site.score),
    verdict: site.degradation.verdict,
    intentPreserved: site.degradation.intentPreserved,
    origin: site.frame.origin.mapFeatureId,
    entryLaneRsl: site.frame.entryLaneRsl,
    egoTurn: site.frame.egoTurn ?? null,
    runwayUpstreamM: round3(site.frame.runwayUpstreamM),
    runwayDownstreamM: round3(site.frame.runwayDownstreamM),
    mirrored: site.frame.mirrored,
    alternateFrames: site.alternateFrames,
    degradation: {
      summary: site.degradation.summary,
      repairs: site.degradation.repairs.map((r) => ({
        kind: r.kind,
        touchesRequired: r.touchesRequired,
        note: r.note,
      })),
      failedRequiredClauses: site.degradation.failedRequiredClauses,
    },
    bindings: site.bindings.map((b) => ({
      role: b.role,
      kind: b.kind,
      status: b.status,
      laneRsl: b.laneRsl ?? null,
      routeLanes: b.routeLaneChain?.length ?? 0,
      conflict: b.conflict
        ? {
            gateId: b.conflict.gateId,
            crossingAngleDeg: round3(b.conflict.crossingAngleDeg),
            relation: b.conflict.relation,
            sOnEgo: round3(b.conflict.sOnEgo),
            sOnActor: round3(b.conflict.sOnActor),
          }
        : null,
      notes: b.notes,
    })),
    clauses: site.clauses.map((c) => ({
      path: c.path,
      essentiality: c.essentiality,
      score: round3(c.score),
      slack: round3(c.slack),
      supported: c.supported,
      required: c.required,
      actual: c.actual,
      reason: c.reason,
    })),
    matchedReasons: site.matchedReasons,
  };
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
