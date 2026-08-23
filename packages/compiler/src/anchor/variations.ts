/**
 * Portable scenario variations.
 *
 * A variation is not a copied set of world-space poses. It is a logical
 * anchor inferred from a concrete, accepted site, plus enough provenance to
 * explain why another site is (or is not) behaviorally equivalent. The actual
 * actor/routes/conflict binding remains the matcher's job and the resulting
 * `MatchedSite` remains the materializer boundary.
 */

import { adjacentKinds } from './cross-section.js';
import { sampleCorridor } from './clauses.js';
import { matchAnchorReport, type MatchOptions } from './matcher.js';
import { sha256Hex } from './sha256.js';
import type { AdjacentKind, Clause, JunctionControl, LogicalAnchor, Range } from './types/anchor.js';
import type { DerivedMapIndex } from './types/map-index.js';
import type { ClauseResult, FeatureBinding, MatchReport, MatchedSite } from './types/site.js';

export const VARIATION_CONTRACT_VERSION = 'variation-transfer.v1';

export type VariationIssueCode =
  | 'source_map_mismatch'
  | 'source_topology_stale'
  | 'source_lane_missing'
  | 'source_junction_missing'
  | 'source_corridor_unobservable'
  | 'capability_missing'
  | 'required_clause_failed'
  | 'required_role_unbound'
  | 'ambiguous_permutation'
  | 'below_equivalence_threshold'
  | 'materialization_required'
  | 'behavior_validation_required'
  | 'behavior_mismatch';

export type VariationIssueStage =
  | 'infer'
  | 'match'
  | 'bind'
  | 'materialize'
  | 'simulate'
  | 'review';

/** Machine-actionable failure used by Studio and by Codex repair loops. */
export interface VariationIssue {
  code: VariationIssueCode;
  stage: VariationIssueStage;
  severity: 'error' | 'warning' | 'info';
  path?: string;
  mapId?: string;
  siteId?: string;
  capability?: keyof DerivedMapIndex['capabilities'];
  /** Exact bounded dependency a specialist must implement or supply. */
  dependency?: string;
  message: string;
  retryable: boolean;
}

export interface SitePatternProvenance {
  sourceMapId: string;
  sourceTopologyDigest: string;
  sourceSiteId: string;
  sourceOriginFeatureId: string;
  sourceEntryLaneRsl: string;
  inferredAtContractVersion: string;
}

export interface PortableSitePattern {
  patternId: string;
  anchor: LogicalAnchor;
  provenance: SitePatternProvenance;
  /** Exact facts at the authored approach, checked after broad candidate discovery. */
  sourceSignature: SiteStructuralSignature;
  /** Paths inferred as semantic requirements rather than visual preferences. */
  requiredPaths: string[];
  /** Facts deliberately left soft so geometric variation remains possible. */
  preferredPaths: string[];
  issues: VariationIssue[];
  cacheKey: string;
}

export interface SiteStructuralSignature {
  approachThroughLanesSameDir: number;
  approachThroughLanesOpposing: number;
  handedness: 'right' | 'left';
  originKind: MatchedSite['frame']['origin']['kind'];
  egoTurn?: MatchedSite['frame']['egoTurn'];
  junctionArms?: number;
  junctionControl?: JunctionControl;
  conflictMovements: Array<{ relation: string; turn?: string }>;
}

export interface InferSitePatternOptions {
  patternId?: string;
  allowMirror?: boolean;
  maxSitesPerMap?: number;
  minScore?: number;
  /** Extent sampled on either side of the authored origin. */
  corridorExtentM?: number;
  /** Preserve these role bindings as hard transfer requirements. */
  requiredRoles?: string[];
  /** Portable authored clauses that must survive source-site inference. */
  authoredAnchor?: LogicalAnchor;
}

export interface SiteEquivalenceReport {
  verdict: 'equivalent' | 'review' | 'rejected';
  /** A structural match is never accepted before materialization + simulation. */
  acceptance: 'pending_validation' | 'rejected';
  eligibleForMaterialization: boolean;
  score: number;
  topologyScore: number;
  roleBindingScore: number;
  intentPreserved: boolean;
  requiredClauses: ClauseResult[];
  softClauses: ClauseResult[];
  issues: VariationIssue[];
  summary: string;
}

export interface VariationCandidate {
  mapId: string;
  site: MatchedSite;
  equivalence: SiteEquivalenceReport;
  permutationKey: string;
  rank: number;
}

export interface VariationSearchResult {
  pattern: PortableSitePattern;
  candidates: VariationCandidate[];
  reportsByMap: Record<string, MatchReport>;
  issues: VariationIssue[];
  /** Stable checkpoint: search can be resumed after missing map capabilities are built. */
  resumeToken: string;
}

export interface BehaviorSignature {
  durationS: number;
  actors: Record<string, {
    routeClass?: string;
    distanceM?: number;
    finalSpeedMps?: number;
    interactionOrder?: string[];
  }>;
  minTtcS?: number;
  minPetS?: number;
  collisions?: number;
  invariantFailures?: string[];
}

export interface BehaviorEquivalenceReport {
  verdict: 'equivalent' | 'review' | 'rejected';
  score: number;
  issues: VariationIssue[];
  deltas: Record<string, number | string[]>;
}

export interface VariationAcceptanceReport {
  status: 'pending_materialization' | 'pending_simulation' | 'accepted' | 'rejected';
  candidate: VariationCandidate;
  behavior?: BehaviorEquivalenceReport;
  requiredChecksPassed: boolean;
  issues: VariationIssue[];
  /** Stable token lets an outcome-owning agent resume after implementing a dependency. */
  resumeToken: string;
}

const required = <T>(value: T, tolerance?: number): Clause<T> => ({
  value,
  essentiality: 'required',
  ...(tolerance === undefined ? {} : { tolerance }),
});

const preferred = <T>(value: T, tolerance?: number): Clause<T> => ({
  value,
  essentiality: 'preferred',
  ...(tolerance === undefined ? {} : { tolerance }),
});

const round = (value: number, places = 2): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function junctionIdOf(site: MatchedSite): string | null {
  if (site.frame.origin.kind !== 'junction') return null;
  const raw = site.frame.origin.mapFeatureId;
  return raw.startsWith('junction:') ? raw.slice('junction:'.length) : raw;
}

function sourceIssue(
  code: VariationIssueCode,
  message: string,
  source: MatchedSite,
  dependency?: string,
): VariationIssue {
  return {
    code,
    stage: 'infer',
    severity: 'error',
    mapId: source.mapId,
    siteId: source.siteId,
    message,
    retryable: dependency !== undefined,
    ...(dependency ? { dependency } : {}),
  };
}

/**
 * Infer a conservative portable predicate from a site the author accepted.
 * Connectivity, lane direction/count and junction movement are hard; metric
 * geometry and speed are soft with tolerances. This prevents a two-lane
 * approach from silently becoming a three-lane approach while still allowing
 * the same interaction on differently surveyed geometry.
 */
export function inferPortableSitePattern(
  source: MatchedSite,
  index: DerivedMapIndex,
  options: InferSitePatternOptions = {},
): PortableSitePattern {
  const issues: VariationIssue[] = [];
  if (source.mapId !== index.mapId) {
    issues.push(sourceIssue('source_map_mismatch', `source site belongs to ${source.mapId}, not ${index.mapId}`, source));
  }
  if (source.topologyDigest !== index.topologyDigest) {
    issues.push(sourceIssue(
      'source_topology_stale',
      'source site was authored against a different topology digest',
      source,
      're-match the source location against the current map topology before inferring variations',
    ));
  }
  if (!index.lanes[source.frame.entryLaneRsl]) {
    issues.push(sourceIssue('source_lane_missing', `entry lane ${source.frame.entryLaneRsl} is absent`, source));
  }

  const extent = Math.max(10, options.corridorExtentM ?? 80);
  const samples = sampleCorridor(index, source.frame, -extent, extent);
  if (samples.length === 0) {
    issues.push(sourceIssue(
      'source_corridor_unobservable',
      'no drivable samples were available around the authored origin',
      source,
      'extend the derived reference path or rebuild the map topology index',
    ));
  }

  const sameCounts = samples.map((sample) => sample.cs.sameDirDriving.size);
  const opposingCounts = samples.map((sample) => sample.cs.opposingDriving.length);
  const widths = samples.map((sample) => sample.cs.laneWidthM);
  const speeds = samples.map((sample) => sample.cs.speedLimitKph);
  const curves = samples.map((sample) => sample.curvatureDegPer10m);
  const adjacent = new Set<AdjacentKind>();
  for (const sample of samples) {
    for (const kind of adjacentKinds(sample.cs)) {
      const normalized = kind === 'biking' ? 'biking' : kind;
      if (['parking', 'biking', 'sidewalk', 'shoulder', 'median', 'opposing'].includes(normalized)) {
        adjacent.add(normalized as AdjacentKind);
      }
    }
  }

  const rangeOf = (values: number[], fallback: number): Range => values.length === 0
    ? [fallback, fallback]
    : [Math.min(...values), Math.max(...values)].map((v) => round(v)) as Range;

  const corridor: NonNullable<LogicalAnchor['corridor']> = {
    throughLanesSameDir: required(rangeOf(sameCounts, Object.keys(source.frame.lateralLanes).length || 1), 0),
    throughLanesOpposing: required(rangeOf(opposingCounts, source.frame.opposingLanes.length), 0),
    laneWidthM: preferred(rangeOf(widths, 3.5), 0.5),
    speedLimitKph: preferred(rangeOf(speeds, 50), 10),
    runwayUpstreamM: required(round(Math.min(extent, source.frame.runwayUpstreamM)), 5),
    runwayDownstreamM: required(round(Math.min(extent, source.frame.runwayDownstreamM)), 5),
    curvatureDegPer10m: preferred(rangeOf(curves, 0), 4),
    ...(adjacent.size > 0 ? { requiresAdjacent: preferred([...adjacent].sort()) } : {}),
  };

  // Preserve the semantic feature id because role bindings and arrival
  // interactions refer to it. World/map feature ids remain excluded.
  const featureId = source.frame.origin.anchorFeatureId || 'origin';
  const features: LogicalAnchor['features'] = [];
  const junctionId = junctionIdOf(source);
  if (junctionId) {
    const descriptor = index.junctionDescriptors[junctionId];
    if (!descriptor) {
      issues.push(sourceIssue(
        'source_junction_missing',
        `junction descriptor ${junctionId} is absent`,
        source,
        'rebuild the derived junction descriptor and conflict-pair index',
      ));
    } else {
      const junction: NonNullable<NonNullable<LogicalAnchor['features'][number]>['junction']> = {
        arms: required([descriptor.arms, descriptor.arms], 0),
        ...(index.capabilities.junctionControl && descriptor.control !== 'unknown'
          ? { control: required([descriptor.control as JunctionControl]) }
          : {}),
        ...(source.frame.egoTurn ? { egoTurn: required(source.frame.egoTurn) } : {}),
        sizeM: preferred([round(descriptor.sizeM), round(descriptor.sizeM)], 8),
      };
      const conflict = source.bindings.find((binding) => binding.conflict)?.conflict;
      if (conflict) {
        const gate = index.gates.find((candidate) => candidate.id === conflict.gateId);
        if (gate) {
          junction.conflictingApproach = required({ from: conflict.relation, turn: gate.turnRelation });
        }
      }
      features.push({
        id: featureId,
        kind: 'junction',
        atM: required([0, 0], 2),
        junction,
      });
    }
  }

  if (!index.capabilities.junctionControl && junctionId) {
    issues.push({
      code: 'capability_missing',
      stage: 'infer',
      severity: 'warning',
      capability: 'junctionControl',
      mapId: source.mapId,
      siteId: source.siteId,
      dependency: 'derive junction control from signals/signs before requiring equivalent control classes',
      message: 'junction control was not inferred because the source index cannot answer it',
      retryable: true,
    });
  }

  const inferredAnchor: LogicalAnchor = {
    id: options.patternId ?? `variation-${sha256Hex(source.siteId).slice(0, 12)}`,
    corridor,
    features,
    ...(features.length > 0 ? { originFeatureId: featureId } : {}),
    policy: {
      allowMirror: options.allowMirror ?? false,
      maxSitesPerMap: options.maxSitesPerMap ?? 20,
      diversity: 'junction',
      minScore: options.minScore ?? 0.7,
    },
  };
  const authored = options.authoredAnchor;
  const inferredById = new Map(inferredAnchor.features.map((feature) => [feature.id, feature]));
  for (const feature of authored?.features ?? []) {
    const inferred = inferredById.get(feature.id);
    inferredById.set(feature.id, {
      ...inferred,
      ...feature,
      ...(inferred?.junction || feature.junction ? { junction: { ...inferred?.junction, ...feature.junction } } : {}),
      ...(inferred?.crossing || feature.crossing ? { crossing: { ...inferred?.crossing, ...feature.crossing } } : {}),
    });
  }
  const anchor: LogicalAnchor = authored ? {
    ...inferredAnchor,
    ...authored,
    corridor: { ...inferredAnchor.corridor, ...authored.corridor },
    features: [...inferredById.values()],
    policy: { ...inferredAnchor.policy, ...authored.policy },
    pin: undefined,
  } : inferredAnchor;
  const authoredRequiredPaths = anchor.features.flatMap((feature) => {
    const base = `features.${feature.id}`;
    const entries: Array<[string, Clause<unknown> | undefined]> = [
      [`${base}.atM`, feature.atM],
      [`${base}.lateralDistanceM`, feature.lateralDistanceM],
      [`${base}.sameRoad`, feature.sameRoad],
      [`${base}.side`, feature.side],
      ...Object.entries(feature.junction ?? {}).map(([key, clause]): [string, Clause<unknown>] => [`${base}.junction.${key}`, clause]),
      ...Object.entries(feature.crossing ?? {}).map(([key, clause]): [string, Clause<unknown>] => [`${base}.${key}`, clause]),
    ];
    return entries.filter(([, clause]) => clause?.essentiality === 'required').map(([path]) => path);
  });
  const requiredPaths = [
    'corridor.throughLanesSameDir',
    'corridor.throughLanesOpposing',
    'corridor.runwayUpstreamM',
    'corridor.runwayDownstreamM',
    ...(junctionId ? [`features.${featureId}.junction.arms`] : []),
    ...(source.frame.egoTurn ? [`features.${featureId}.junction.egoTurn`] : []),
    ...authoredRequiredPaths,
  ];
  const preferredPaths = ['corridor.laneWidthM', 'corridor.speedLimitKph', 'corridor.curvatureDegPer10m'];
  const provenance: SitePatternProvenance = {
    sourceMapId: source.mapId,
    sourceTopologyDigest: source.topologyDigest,
    sourceSiteId: source.siteId,
    sourceOriginFeatureId: source.frame.origin.mapFeatureId,
    sourceEntryLaneRsl: source.frame.entryLaneRsl,
    inferredAtContractVersion: VARIATION_CONTRACT_VERSION,
  };
  const sourceDescriptor = junctionId ? index.junctionDescriptors[junctionId] : undefined;
  const sourceSignature: SiteStructuralSignature = {
    approachThroughLanesSameDir: Object.keys(source.frame.lateralLanes).length || 1,
    approachThroughLanesOpposing: source.frame.opposingLanes.length,
    handedness: source.frame.handedness,
    originKind: source.frame.origin.kind,
    ...(source.frame.egoTurn ? { egoTurn: source.frame.egoTurn } : {}),
    ...(sourceDescriptor ? { junctionArms: sourceDescriptor.arms } : {}),
    ...(sourceDescriptor && sourceDescriptor.control !== 'unknown'
      ? { junctionControl: sourceDescriptor.control as JunctionControl }
      : {}),
    conflictMovements: source.bindings
      .flatMap((binding) => binding.conflict ? [{
        relation: binding.conflict.relation,
        turn: index.gates.find((gate) => gate.id === binding.conflict?.gateId)?.turnRelation,
      }] : [])
      .sort((a, b) => stable(a).localeCompare(stable(b))),
  };
  const patternId = anchor.id;
  return {
    patternId,
    anchor,
    provenance,
    sourceSignature,
    requiredPaths,
    preferredPaths,
    issues,
    cacheKey: sha256Hex(stable({ contract: VARIATION_CONTRACT_VERSION, anchor, provenance, sourceSignature })),
  };
}

function bindingScore(bindings: FeatureBinding[], requiredRoles: string[]): { score: number; issues: VariationIssue[] } {
  if (requiredRoles.length === 0) return { score: 1, issues: [] };
  const byRole = new Map(bindings.map((binding) => [binding.role, binding]));
  const issues: VariationIssue[] = [];
  let bound = 0;
  for (const role of requiredRoles) {
    const binding = byRole.get(role);
    if (binding?.status === 'bound' || binding?.status === 'clamped') {
      bound += 1;
      continue;
    }
    issues.push({
      code: 'required_role_unbound',
      stage: 'bind',
      severity: 'error',
      path: `roles.${role}`,
      dependency: `add or repair a portable structural binding for role "${role}"`,
      message: `required role "${role}" did not bind at this site`,
      retryable: true,
    });
  }
  return { score: bound / requiredRoles.length, issues };
}

export function reportSiteEquivalence(
  site: MatchedSite,
  requiredRoles: string[] = [],
  threshold = 0.75,
  expected?: SiteStructuralSignature,
): SiteEquivalenceReport {
  const requiredClauses = site.clauses.filter((clause) => clause.essentiality === 'required');
  const softClauses = site.clauses.filter((clause) => clause.essentiality !== 'required');
  const requiredFailures = requiredClauses.filter((clause) => !clause.supported || clause.score < 1);
  const issues: VariationIssue[] = requiredFailures.map((clause) => ({
    code: clause.supported ? 'required_clause_failed' : 'capability_missing',
    stage: 'match',
    severity: 'error',
    path: clause.path,
    mapId: site.mapId,
    siteId: site.siteId,
    dependency: clause.supported
      ? `find a site satisfying ${clause.path}, or explicitly soften that inferred requirement`
      : `add derived-map support for ${clause.path}`,
    message: clause.reason,
    retryable: true,
  }));
  const roles = bindingScore(site.bindings, requiredRoles);
  issues.push(...roles.issues.map((issue) => ({ ...issue, mapId: site.mapId, siteId: site.siteId })));
  if (expected) {
    const signatureChecks: Array<[string, unknown, unknown]> = [
      ['approachThroughLanesSameDir', expected.approachThroughLanesSameDir, Object.keys(site.frame.lateralLanes).length || 1],
      ['approachThroughLanesOpposing', expected.approachThroughLanesOpposing, site.frame.opposingLanes.length],
      ['originKind', expected.originKind, site.frame.origin.kind],
      ['egoTurn', expected.egoTurn, site.frame.egoTurn],
    ];
    for (const [path, wanted, actual] of signatureChecks) {
      if (wanted === undefined || wanted === actual) continue;
      issues.push({
        code: 'required_clause_failed',
        stage: 'match',
        severity: 'error',
        path: `sourceSignature.${path}`,
        mapId: site.mapId,
        siteId: site.siteId,
        dependency: `find an approach whose ${path} is ${String(wanted)}`,
        message: `candidate ${path} is ${String(actual)}; source requires ${String(wanted)}`,
        retryable: true,
      });
    }
  }
  if (site.alternateFrames > 0) {
    issues.push({
      code: 'ambiguous_permutation',
      stage: 'bind',
      severity: 'warning',
      mapId: site.mapId,
      siteId: site.siteId,
      message: `${site.alternateFrames + 1} frame permutations resolve to this site; preview the bound movements before acceptance`,
      retryable: false,
    });
  }
  const topologyScore = site.score;
  const score = round(topologyScore * 0.75 + roles.score * 0.25, 4);
  if (score < threshold) {
    issues.push({
      code: 'below_equivalence_threshold',
      stage: 'review',
      severity: 'error',
      mapId: site.mapId,
      siteId: site.siteId,
      message: `equivalence score ${score} is below ${threshold}`,
      retryable: false,
    });
  }
  issues.push({
    code: 'materialization_required',
    stage: 'materialize',
    severity: 'info',
    mapId: site.mapId,
    siteId: site.siteId,
    dependency: 'materialize this matched site and preserve the returned feature, role, route, signal, and conflict bindings',
    message: 'structural equivalence is provisional until materialization succeeds',
    retryable: true,
  });
  issues.push({
    code: 'behavior_validation_required',
    stage: 'simulate',
    severity: 'info',
    mapId: site.mapId,
    siteId: site.siteId,
    dependency: 'simulate the materialized candidate and compare its behavior signature with the source scenario',
    message: 'playback equivalence has not yet been measured',
    retryable: true,
  });
  const signatureFailed = issues.some((issue) => issue.path?.startsWith('sourceSignature.') && issue.severity === 'error');
  const hardFailure = requiredFailures.length > 0 || signatureFailed || roles.score < 1 || score < threshold || !site.degradation.intentPreserved;
  const verdict = hardFailure ? 'rejected' : issues.some((issue) => issue.code === 'ambiguous_permutation') ? 'review' : 'equivalent';
  return {
    verdict,
    acceptance: hardFailure ? 'rejected' : 'pending_validation',
    eligibleForMaterialization: !hardFailure,
    score,
    topologyScore,
    roleBindingScore: roles.score,
    intentPreserved: !hardFailure,
    requiredClauses,
    softClauses,
    issues,
    summary: hardFailure
      ? `Rejected: ${requiredFailures.length} required topology clause(s) and ${requiredRoles.length * (1 - roles.score)} required role binding(s) failed.`
      : verdict === 'review'
        ? 'Structure and roles match, but an ambiguous movement permutation needs visual review.'
        : 'Structure and required role bindings preserve the inferred scenario intent.',
  };
}

/** Search one or many map indexes, rank globally, and keep every rejected report for diagnostics. */
export function searchScenarioVariations(
  pattern: PortableSitePattern,
  indexes: DerivedMapIndex[],
  options: MatchOptions & { requiredRoles?: string[]; equivalenceThreshold?: number } = {},
): VariationSearchResult {
  const reportsByMap: Record<string, MatchReport> = {};
  const issues: VariationIssue[] = [...pattern.issues];
  const candidates: VariationCandidate[] = [];
  const sortedIndexes = [...indexes].sort((a, b) => a.mapId.localeCompare(b.mapId));
  for (const index of sortedIndexes) {
    const report = matchAnchorReport(pattern.anchor, index, options);
    reportsByMap[index.mapId] = report;
    for (const warning of report.warnings) {
      issues.push({
        code: 'capability_missing',
        stage: 'match',
        severity: 'warning',
        mapId: index.mapId,
        dependency: 'build the missing derived-map capability, then resume this variation search',
        message: warning,
        retryable: true,
      });
    }
    for (const site of report.sites) {
      const equivalence = reportSiteEquivalence(
        site,
        options.requiredRoles ?? [],
        options.equivalenceThreshold ?? 0.75,
        pattern.sourceSignature,
      );
      candidates.push({
        mapId: index.mapId,
        site,
        equivalence,
        permutationKey: `${site.frame.origin.mapFeatureId}:${site.frame.entryLaneRsl}:${site.frame.egoGateId ?? 'corridor'}:${site.frame.mirrored ? 'mirror' : 'direct'}`,
        rank: 0,
      });
    }
  }
  candidates.sort((a, b) =>
    (a.equivalence.verdict === 'rejected' ? 1 : 0) - (b.equivalence.verdict === 'rejected' ? 1 : 0)
    || b.equivalence.score - a.equivalence.score
    || a.mapId.localeCompare(b.mapId)
    || a.site.siteId.localeCompare(b.site.siteId));
  candidates.forEach((candidate, index) => { candidate.rank = index + 1; });
  const resumeToken = sha256Hex(stable({
    pattern: pattern.cacheKey,
    maps: sortedIndexes.map((index) => [index.mapId, index.topologyDigest]),
    issues: issues.filter((issue) => issue.retryable).map((issue) => [issue.code, issue.mapId, issue.path, issue.dependency]),
  }));
  return { pattern, candidates, reportsByMap, issues, resumeToken };
}

/**
 * Compare simulator-produced summaries without assuming identical coordinates.
 * Distances/speeds use relative tolerance; interaction order, collisions and
 * required invariant outcomes are semantic and therefore exact.
 */
export function compareBehaviorSignatures(
  source: BehaviorSignature,
  candidate: BehaviorSignature,
  tolerance: { durationS?: number; distanceFraction?: number; speedMps?: number; criticalityS?: number } = {},
): BehaviorEquivalenceReport {
  const issues: VariationIssue[] = [];
  const deltas: Record<string, number | string[]> = {};
  const durationTolerance = tolerance.durationS ?? 0.05;
  const distanceFraction = tolerance.distanceFraction ?? 0.1;
  const speedTolerance = tolerance.speedMps ?? 1;
  const criticalityTolerance = tolerance.criticalityS ?? 0.25;
  const mismatch = (path: string, message: string, severity: 'error' | 'warning' = 'error') => {
    issues.push({ code: 'behavior_mismatch', stage: 'review', severity, path, message, retryable: true,
      dependency: `repair the candidate binding/choreography responsible for ${path}, then re-materialize and re-simulate` });
  };
  const durationDelta = Math.abs(candidate.durationS - source.durationS);
  deltas.durationS = round(durationDelta, 4);
  if (durationDelta > durationTolerance) mismatch('durationS', `duration changed by ${round(durationDelta)} s`);
  for (const role of Object.keys(source.actors).sort()) {
    const a = source.actors[role]!;
    const b = candidate.actors[role];
    if (!b) { mismatch(`actors.${role}`, `actor ${role} is missing from candidate behavior`); continue; }
    if (a.routeClass !== undefined && b.routeClass !== a.routeClass) mismatch(`actors.${role}.routeClass`, `${b.routeClass ?? 'missing'} != ${a.routeClass}`);
    if (a.interactionOrder && stable(b.interactionOrder ?? []) !== stable(a.interactionOrder)) mismatch(`actors.${role}.interactionOrder`, 'interaction order changed');
    if (a.distanceM !== undefined && b.distanceM !== undefined) {
      const fraction = Math.abs(b.distanceM - a.distanceM) / Math.max(1, Math.abs(a.distanceM));
      deltas[`actors.${role}.distanceFraction`] = round(fraction, 4);
      if (fraction > distanceFraction) mismatch(`actors.${role}.distanceM`, `distance changed by ${round(fraction * 100)}%`, 'warning');
    }
    if (a.finalSpeedMps !== undefined && b.finalSpeedMps !== undefined) {
      const delta = Math.abs(b.finalSpeedMps - a.finalSpeedMps);
      deltas[`actors.${role}.finalSpeedMps`] = round(delta, 4);
      if (delta > speedTolerance) mismatch(`actors.${role}.finalSpeedMps`, `final speed changed by ${round(delta)} m/s`, 'warning');
    }
  }
  for (const metric of ['minTtcS', 'minPetS'] as const) {
    const a = source[metric]; const b = candidate[metric];
    if (a !== undefined && b !== undefined) {
      const delta = Math.abs(b - a); deltas[metric] = round(delta, 4);
      if (delta > criticalityTolerance) mismatch(metric, `${metric} changed by ${round(delta)} s`);
    }
  }
  if ((candidate.collisions ?? 0) !== (source.collisions ?? 0)) mismatch('collisions', 'collision outcome changed');
  const sourceFailures = [...(source.invariantFailures ?? [])].sort();
  const candidateFailures = [...(candidate.invariantFailures ?? [])].sort();
  if (stable(sourceFailures) !== stable(candidateFailures)) {
    deltas.invariantFailures = candidateFailures;
    mismatch('invariantFailures', 'required invariant outcomes changed');
  }
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const score = Math.max(0, round(1 - errors * 0.2 - warnings * 0.05, 4));
  return { verdict: errors > 0 ? 'rejected' : warnings > 0 ? 'review' : 'equivalent', score, issues, deltas };
}

/**
 * The only final acceptance gate. A site cannot be accepted merely because it
 * looks structurally similar: materialization must succeed, simulation must
 * visibly reproduce the source behavior, and all required checks must pass.
 */
export function finalizeVariationAcceptance(input: {
  candidate: VariationCandidate;
  materializationSucceeded: boolean;
  sourceBehavior?: BehaviorSignature;
  candidateBehavior?: BehaviorSignature;
  requiredChecksPassed?: boolean;
  materializationIssues?: VariationIssue[];
}): VariationAcceptanceReport {
  const issues = [...input.candidate.equivalence.issues, ...(input.materializationIssues ?? [])];
  let status: VariationAcceptanceReport['status'];
  let behavior: BehaviorEquivalenceReport | undefined;
  const requiredChecksPassed = input.requiredChecksPassed ?? false;
  if (!input.candidate.equivalence.eligibleForMaterialization || !input.materializationSucceeded) {
    status = 'rejected';
  } else if (!input.sourceBehavior || !input.candidateBehavior) {
    status = input.materializationSucceeded ? 'pending_simulation' : 'pending_materialization';
  } else {
    behavior = compareBehaviorSignatures(input.sourceBehavior, input.candidateBehavior);
    issues.push(...behavior.issues);
    status = behavior.verdict === 'equivalent' && requiredChecksPassed ? 'accepted' : 'rejected';
    if (!requiredChecksPassed) {
      issues.push({
        code: 'behavior_mismatch',
        stage: 'review',
        severity: 'error',
        path: 'requiredChecks',
        dependency: 'repair the scenario until every required event, metric, and invariant check passes, then re-simulate',
        message: 'one or more required scenario checks did not pass',
        retryable: true,
      });
    }
  }
  return {
    status,
    candidate: input.candidate,
    ...(behavior ? { behavior } : {}),
    requiredChecksPassed,
    issues,
    resumeToken: sha256Hex(stable({
      candidate: [input.candidate.mapId, input.candidate.site.siteId],
      materializationSucceeded: input.materializationSucceeded,
      hasSourceBehavior: input.sourceBehavior !== undefined,
      hasCandidateBehavior: input.candidateBehavior !== undefined,
      requiredChecksPassed,
      dependencies: issues.filter((issue) => issue.retryable).map((issue) => issue.dependency),
    })),
  };
}
