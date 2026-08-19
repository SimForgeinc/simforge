/// <reference lib="webworker" />

import {
  finalizeVariationAcceptance,
  inferPortableSitePattern,
  matchAnchorReport,
  normalizeDerivedMapIndex,
  searchScenarioVariations,
  type BehaviorSignature,
  type MatchedSite,
  type VariationCandidate,
  type VariationIssue,
} from '@uniscenarios/anchor-matcher';
import { adaptTemplate, bindPortableVariation, materialize, parseMapSignalCatalog, type MapBundle } from '@uniscenarios/scenario-materializer';
import { buildLaneGraph, runSimulation, type TopologyIndex } from '@uniscenarios/sim-engine';
import { AuthoredActorLimitError, MAX_AUTHORED_ACTORS, type ScenarioTemplateV2 } from '@uniscenarios/scenario-model';
import { behaviorSignature, requiredBehaviorChecksPassed, variationPreview } from './behavior';
import type {
  EligibilityReasonCode,
  EligibilityReport,
  PortableVariationBinding,
  VariationCandidateResult,
  VariationMapSource,
  VariationRequirement,
} from './model';

interface BaseRequest { id: number; sourceRevision: string; template: ScenarioTemplateV2; sourceMap: VariationMapSource; portableBinding?: PortableVariationBinding }
export type VariationWorkerRequest =
  | (BaseRequest & { kind: 'analyze'; axisCombinations: number; drawsPerLocation: number; candidateBudget: number })
  | (BaseRequest & { kind: 'baseline' })
  | (BaseRequest & { kind: 'verify'; candidate: VariationCandidate; drawIndex: number; sourceBehavior: BehaviorSignature; patternId: string });

export type VariationWorkerResponse =
  | { id: number; ok: true; kind: 'analyze'; report: EligibilityReport }
  | { id: number; ok: true; kind: 'baseline'; sourceBehavior: BehaviorSignature; sourceSite: MatchedSite }
  | { id: number; ok: true; kind: 'verify'; result: VariationCandidateResult }
  | { id: number; ok: false; kind: VariationWorkerRequest['kind']; error: string; issues?: VariationIssue[] };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const bundleCache = new Map<string, Promise<MapBundle>>();
const eligibilityCache = new Map<string, EligibilityReport>();

scope.onmessage = (event: MessageEvent<VariationWorkerRequest>): void => {
  const request = event.data;
  void handle(request).then(
    (response) => scope.postMessage(response),
    (reason: unknown) => scope.postMessage({
      id: request.id,
      ok: false,
      kind: request.kind,
      error: reason instanceof Error ? reason.message : String(reason),
    } satisfies VariationWorkerResponse),
  );
};

async function handle(request: VariationWorkerRequest): Promise<VariationWorkerResponse> {
  if (request.template.roles.length > MAX_AUTHORED_ACTORS) throw new AuthoredActorLimitError(request.template.roles.length);
  const bundle = await cachedBundle(request.sourceMap);
  const binding = resolveBinding(request, bundle);
  if (request.kind === 'analyze') {
    return { id: request.id, ok: true, kind: 'analyze', report: analyze(request, binding, bundle) };
  }
  if (request.kind === 'baseline') {
    const product = materialize(binding.template, bundle, binding.sourceSite, { drawIndex: -1 });
    if (!product.manifest.feasible) throw new Error('Source scenario cannot establish a feasible simulation baseline.');
    const sourceBehavior = behaviorSignature(runSimulation(product.input, { graph: bundle.graph, guards: 'throw' }).trace);
    return { id: request.id, ok: true, kind: 'baseline', sourceBehavior, sourceSite: binding.sourceSite };
  }
  return { id: request.id, ok: true, kind: 'verify', result: verify(request, binding, bundle) };
}

function resolveBinding(request: BaseRequest, bundle: MapBundle): PortableVariationBinding {
  const binding = request.portableBinding ?? bindAlreadyPortable(request.template, bundle);
  if (!binding) throw new Error('SOURCE_BINDING_INVALID: map-bound scene has no portable binding.');
  if (binding.sourceSite.topologyDigest !== bundle.index.topologyDigest) {
    throw new Error(`SOURCE_TOPOLOGY_STALE: ${binding.sourceSite.topologyDigest} != ${bundle.index.topologyDigest}`);
  }
  return binding;
}

function analyze(
  request: Extract<VariationWorkerRequest, { kind: 'analyze' }>,
  binding: PortableVariationBinding,
  bundle: MapBundle,
): EligibilityReport {
  const started = performance.now();
  const cacheKey = `${bundle.mapId}:${bundle.index.topologyDigest}:${request.sourceRevision}`;
  const cached = eligibilityCache.get(cacheKey);
  if (cached) {
    const axisCombinations = 1;
    const drawsPerLocation = Math.max(1, Math.min(32, Math.floor(request.drawsPerLocation)));
    const candidateBudget = Math.max(1, Math.min(500, Math.floor(request.candidateBudget)));
    const potentialCandidates = Math.min(candidateBudget, cached.locations.compatible * drawsPerLocation);
    return { ...cached, computedInMs: Math.round((performance.now() - started) * 100) / 100, axisCombinations, drawsPerLocation, candidateBudget, potentialCandidates, formula: `${cached.locations.compatible} compatible locations × ${drawsPerLocation} parameter draws, capped at ${candidateBudget} = ${potentialCandidates} potential candidates` };
  }
  const adapted = adaptTemplate(binding.template);
  const requiredRoles = binding.template.roles.filter((role) => role.essentiality === 'required').map((role) => role.id);
  const pattern = inferPortableSitePattern(binding.sourceSite, bundle.index, { requiredRoles, authoredAnchor: adapted.anchor });
  const search = searchScenarioVariations(pattern, [bundle.index], { roles: adapted.roles, scope: adapted.scope, requiredRoles });
  const candidates = search.candidates.filter((candidate) => candidate.site.siteId !== binding.sourceSite.siteId);
  const exact = candidates.filter((candidate) => candidate.equivalence.verdict === 'equivalent').length;
  const degraded = candidates.filter((candidate) => candidate.equivalence.verdict === 'review').length;
  const rejectedCandidates = candidates.filter((candidate) => candidate.equivalence.verdict === 'rejected');
  const rejected = search.reportsByMap[bundle.mapId]?.rejected.length ?? rejectedCandidates.length;
  const compatible = exact + degraded;
  // Typed parameter axes are not yet independently enumerable. Keep this
  // dimension truthful at one and spend the bounded campaign on deterministic
  // materializer draws instead.
  const axisCombinations = 1;
  const drawsPerLocation = Math.max(1, Math.min(32, Math.floor(request.drawsPerLocation)));
  const candidateBudget = Math.max(1, Math.min(500, Math.floor(request.candidateBudget)));
  const potentialCandidates = Math.min(candidateBudget, compatible * drawsPerLocation);
  const issuePool = [...pattern.issues, ...search.issues, ...rejectedCandidates.flatMap((candidate) => candidate.equivalence.issues)];
  const groups = new Map<EligibilityReasonCode, { count: number; message: string; repair?: string }>();
  for (const issue of issuePool) {
    const code = reasonCode(issue);
    const current = groups.get(code);
    groups.set(code, current
      ? { ...current, count: current.count + 1 }
      : { count: 1, message: issue.message, ...(issue.dependency ? { repair: issue.dependency } : {}) });
  }
  if (exact) groups.set('EXACT_STRUCTURAL_MATCH', { count: exact, message: 'All required structural constraints match.' });
  if (degraded) groups.set('DEGRADED_STRUCTURAL_MATCH', { count: degraded, message: 'Required intent is preserved with reviewable soft differences.' });
  const report: EligibilityReport = {
    kind: 'variation-eligibility', version: 1, mapId: bundle.mapId, sourceRevision: request.sourceRevision,
    computedInMs: Math.round((performance.now() - started) * 100) / 100,
    actorCount: binding.template.roles.length,
    actors: binding.template.roles.map((role) => ({ id: role.id, label: role.label ?? role.id, type: role.actor.class, required: role.essentiality === 'required' })),
    referenceActorId: binding.template.metricSubject ?? binding.template.roles[0]?.id ?? null,
    requirements: requirementsFor(binding.template, binding.sourceSite),
    locations: { exact, degraded, rejected, compatible },
    reasons: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, group]) => ({ code, ...group })),
    axisCombinations, drawsPerLocation, candidateBudget, potentialCandidates,
    formula: `${compatible} compatible locations × ${drawsPerLocation} parameter draws, capped at ${candidateBudget} = ${potentialCandidates} potential candidates`,
    structuralOnly: true, patternId: pattern.patternId, resumeToken: search.resumeToken, candidates, issues: search.issues,
  };
  eligibilityCache.set(cacheKey, report);
  return report;
}

function requirementsFor(template: ScenarioTemplateV2, source: MatchedSite): VariationRequirement[] {
  const requirements: VariationRequirement[] = template.roles.map((role) => ({
    kind: 'actor', label: role.label ?? role.id, detail: `${role.actor.class} · ${role.essentiality}`,
  }));
  requirements.push({ kind: source.frame.origin.kind === 'junction' ? 'junction' : 'road', label: 'Current site', detail: source.frame.origin.kind });
  requirements.push({ kind: 'route', label: 'Approach', detail: source.frame.entryLaneRsl });
  requirements.push({ kind: 'runway', label: 'Runway', detail: `${Math.round(source.frame.runwayUpstreamM)} m upstream · ${Math.round(source.frame.runwayDownstreamM)} m downstream` });
  if (template.choreography.interactions.some((interaction) => JSON.stringify(interaction).includes('signal'))) {
    requirements.push({ kind: 'signal', label: 'Signal control', detail: 'Required by authored choreography' });
  }
  return requirements;
}

function reasonCode(issue: VariationIssue): EligibilityReasonCode {
  if (issue.code === 'capability_missing') return 'CAPABILITY_MISSING';
  if (issue.code === 'required_clause_failed') return 'REQUIRED_CLAUSE_FAILED';
  if (issue.code === 'source_lane_missing') return 'TERMINAL_LANE_NO_CONNECTED_APPROACH';
  if (issue.code === 'source_corridor_unobservable') return 'INTERNAL_LANE_AMBIGUOUS';
  return 'SOURCE_BINDING_INVALID';
}

function verify(
  request: Extract<VariationWorkerRequest, { kind: 'verify' }>,
  binding: PortableVariationBinding,
  bundle: MapBundle,
): VariationCandidateResult {
  const candidate = request.candidate;
  if (!candidate.equivalence.eligibleForMaterialization) {
    return { candidate, acceptance: finalizeVariationAcceptance({ candidate, materializationSucceeded: false }), stage: 'failed' };
  }
  try {
    const bound = bindPortableVariation(binding.template, candidate.site);
    const product = materialize(bound.template, bundle, bound.site, { drawIndex: request.drawIndex });
    const materializationIssues: VariationIssue[] = product.manifest.notes.map((note) => ({
      code: 'behavior_mismatch', stage: 'materialize', severity: 'warning', path: note.path,
      mapId: candidate.mapId, siteId: candidate.site.siteId, message: note.reason,
      retryable: true, dependency: `repair portable materialization at ${note.path}`,
    }));
    if (!product.manifest.feasible) {
      return { candidate, acceptance: finalizeVariationAcceptance({ candidate, materializationSucceeded: false, materializationIssues }), stage: 'failed', error: materializationIssues.map((issue) => issue.message).join(' · ') || 'materialization was infeasible' };
    }
    const trace = runSimulation(product.input, { graph: bundle.graph, guards: 'throw' }).trace;
    const behavior = behaviorSignature(trace);
    const acceptance = finalizeVariationAcceptance({ candidate, materializationSucceeded: true, sourceBehavior: request.sourceBehavior, candidateBehavior: behavior, requiredChecksPassed: requiredBehaviorChecksPassed(trace), materializationIssues });
    const conflicts = candidate.site.bindings.flatMap((item) => item.conflict ? [{ x: item.conflict.point.x, z: -item.conflict.point.y, role: item.role }] : []);
    return {
      candidate, acceptance, behavior, stage: acceptance.status === 'accepted' ? 'verified' : 'failed',
      instance: { kind: 'scenario-instance', version: 1, manifest: product.manifest as unknown as Record<string, unknown>, input: product.input },
      trace,
      preview: variationPreview(trace, conflicts, candidate.site.frame.mirrored, candidate.permutationKey),
      lineage: {
        kind: 'variation-lineage', version: 1, sourceRevision: request.sourceRevision, sourcePatternId: request.patternId,
        sourceMapId: request.sourceMap.id, targetMapId: candidate.mapId, siteId: candidate.site.siteId,
        permutationKey: candidate.permutationKey, nativeVerificationToken: acceptance.resumeToken, generatedAt: binding.template.meta.modifiedAt,
      },
    };
  } catch (error) {
    return { candidate, acceptance: finalizeVariationAcceptance({ candidate, materializationSucceeded: false }), stage: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

function bindAlreadyPortable(template: ScenarioTemplateV2, bundle: MapBundle): PortableVariationBinding | null {
  if (template.roles.length === 0 || template.roles.some((role) => role.kind === 'scene_absolute')) return null;
  const adapted = adaptTemplate(template);
  if (adapted.notes.length) throw new Error(`Portable binding is incomplete: ${adapted.notes.map((note) => `${note.path}: ${note.reason}`).join(' · ')}`);
  const report = matchAnchorReport(adapted.anchor, bundle.index, { roles: adapted.roles, scope: adapted.scope });
  const sourceSite = report.sites.find((site) => site.degradation.intentPreserved);
  if (!sourceSite) throw new Error(`The authored source location no longer matches: ${report.failureSummary || 'zero intent-preserving sites'}`);
  return { template, sourceSite };
}

function cachedBundle(map: VariationMapSource): Promise<MapBundle> {
  const key = `${map.id}:${map.topology}:${map.derivedTopology}:${map.locations}`;
  let pending = bundleCache.get(key);
  if (!pending) { pending = loadBundle(map); bundleCache.set(key, pending); }
  return pending;
}

async function loadBundle(map: VariationMapSource): Promise<MapBundle> {
  const [topology, derived, locations, xodr, signals] = await Promise.all([fetchJson(map.topology), fetchJson(map.derivedTopology), fetchJson(map.locations), fetchText(map.xodr), fetchJson(map.signals)]);
  const topologyIndex = topology as TopologyIndex;
  const index = normalizeDerivedMapIndex(derived, { mapId: map.id, topology: topologyIndex as never, locations });
  return { mapId: map.id, catalog: locations as MapBundle['catalog'], derived: derived as MapBundle['derived'], topology: topologyIndex, index, graph: buildLaneGraph(topologyIndex), signalCatalog: parseMapSignalCatalog(xodr, signals) };
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decode gzip map artifacts');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function fetchJson(url: string): Promise<any> { return JSON.parse(new TextDecoder().decode(await fetchBytes(url))); }
async function fetchText(url: string): Promise<string> { return new TextDecoder().decode(await fetchBytes(url)); }
