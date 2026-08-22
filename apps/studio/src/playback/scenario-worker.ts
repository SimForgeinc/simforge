/// <reference lib="webworker" />

import { matchAnchorReport, normalizeDerivedMapIndex } from '@uniscenarios/anchor-matcher';
import { exportOpenScenarioXml14 } from '@uniscenarios/openscenario/xml-1.4';
import { AsamExportError } from '@uniscenarios/openscenario/types';
import { adaptTemplate, buildMapControlPlan, buildSignalControlIndex, compileMapSignalPlans, materializationSemanticLosses, materialize, materializeMapBound, parseMapSignalCatalog, topologyWithMapSpeedLimits, type MapBundle, type MapControlPlan, type MapSignalCatalog, type SignalControlIndex } from '@uniscenarios/scenario-materializer';
import {
  buildLaneGraph,
  contentHash,
  createFixedStepSimulation,
  createAmbientCandidatePool,
  pruneDanglingAfterInteractions,
  evaluateAmbientRobustness,
  evaluateIntentRubric,
  runSimulation,
  materializeAmbientCandidatePool,
  parseSimScenarioInput,
  resolveAmbientTrafficProfile,
  traceDigest,
  type AmbientTrafficProfile,
  type AmbientTrafficProvenance,
  type AmbientTrafficResult,
  type AmbientCandidatePool,
  type EvaluateFilters,
  type IntentRubricInput,
  type SimScenarioInput,
  type SimResult,
  type SimTrace,
  type FixedStepSimulationSession,
  type TopologyIndex,
} from '@uniscenarios/sim-engine';
import type { ScenarioTemplateV2 } from '@uniscenarios/scenario-model';
import { ambientRobustnessGate } from '../ambient/robustnessGate';
import type { OpenScenarioSnapshot, OpenScenarioSourceMapping } from '../openscenario/model';
import { selectPlayableSite } from '@uniscenarios/playback';
import { withEditablePhysicsDefault } from '@uniscenarios/playback';
import { emptyStaticColliderBundle, loadStaticMapCollidersBounded } from '@uniscenarios/playback';
import type { StaticColliderDiagnostics } from '@uniscenarios/playback';
import { initialLiveTickBudget, planLiveRefill } from '@uniscenarios/playback';
import { mapAssetDigest, runtimeDigest, type MapRuntimeIdentity } from '@uniscenarios/playback';
import { runCanonicalPreview } from '@uniscenarios/playback';

export interface ScenarioWorkerMap {
  id: string;
  manifest: string;
  topology: string;
  derivedTopology: string;
  locations: string;
  xodr: string;
  signals: string;
}

export interface ScenarioWorkerRequest {
  kind?: 'compile' | 'export' | 'robustness';
  id: number;
  /** The editor revision that must be echoed back unchanged. */
  revision?: string;
  template: ScenarioTemplateV2;
  map: ScenarioWorkerMap;
  ambientTraffic: AmbientTrafficProfile;
  /** Validated concrete authored evidence used as the immutable base for an editable world. */
  baseInstance?: {
    readonly manifest: Record<string, unknown>;
    readonly input: SimScenarioInput;
  };
  /** Stable map/profile candidates returned by an earlier preparation. */
  ambientCandidatePool?: AmbientCandidatePool;
  staticCollisionMode?: 'skip' | 'bounded';
  operation?: 'prepare' | 'materialize' | 'robustness';
  evaluationFilters?: EvaluateFilters;
  /** Optional canonical intent rubric. Without it robustness is incomplete, never accepted. */
  intentRubric?: IntentRubricInput;
}

export interface ScenarioWorkerStartRequest {
  readonly kind: 'start';
  readonly id: number;
  readonly revision: string;
  readonly runtimeKey: string;
  readonly input: SimScenarioInput;
}
export interface ScenarioWorkerCancelRequest { readonly kind: 'cancel'; readonly id?: number }
export interface ScenarioWorkerInspectSignalsRequest {
  readonly kind: 'inspect-signals';
  readonly id: number;
  readonly revision: string;
  readonly map: ScenarioWorkerMap;
}
export interface ScenarioWorkerTransportRequest {
  readonly kind: 'transport';
  readonly id: number;
  readonly playing: boolean;
  /** Authoritative display playhead, including seeks. */
  readonly time?: number;
}
export type ScenarioWorkerMessage = ScenarioWorkerRequest | ScenarioWorkerStartRequest | ScenarioWorkerCancelRequest | ScenarioWorkerTransportRequest | ScenarioWorkerInspectSignalsRequest;

export interface AmbientRobustnessSummary {
  readonly version: 1;
  readonly baseInputHash: string;
  readonly baselineVerdict: string;
  readonly accepted: boolean;
  readonly overall: 'accepted' | 'rejected' | 'incomplete';
  readonly intent: {
    readonly status: 'evaluated' | 'not_evaluated';
    readonly baselineVerdict: 'accept' | 'reject' | null;
    readonly caseVerdicts: Readonly<Record<string, 'accept' | 'reject'>>;
  };
  readonly filters: EvaluateFilters;
  readonly cases: readonly {
    label: string;
    accepted: boolean;
    deterministic: boolean;
    authoredEventOrderPreserved: boolean;
    authoredNeverFiredPreserved: boolean;
    ambientCollisions: number;
    runtimeMs: number;
    generatedActors: number;
    profileHash: string;
    verdict: string;
    failures: readonly string[];
    warnings: readonly string[];
  }[];
}

export type ScenarioWorkerResponse =
  | { id: number; revision: string; ok: true; kind: 'signal-catalog'; signalCatalog: MapSignalCatalog; signalControlIndex: SignalControlIndex; controlDigest: string }
  | { id: number; revision: string; ok: true; kind: 'prepare'; runtimeKey: string; cache: 'cold' | 'warm'; timing?: { totalMs: number; compileCache: 'hit' | 'miss' }; instance: unknown; trace: SimTrace; siteId: string; ambientTraffic: AmbientTrafficProvenance; ambientCandidatePool: AmbientCandidatePool; openScenario?: OpenScenarioSnapshot; mapCollisions: StaticColliderDiagnostics }
  | { id: number; revision: string; ok: true; kind: 'robustness'; report: AmbientRobustnessSummary }
  | { id: number; revision: string; ok: true; kind: 'ready' | 'progress' | 'complete'; trace: SimTrace; recordedUntil: number }
  | { id: number; revision: string; ok: false; error: string };

interface MapRuntime {
  readonly key: string;
  readonly identity: MapRuntimeIdentity;
  readonly topology: TopologyIndex;
  readonly graph: ReturnType<typeof buildLaneGraph>;
  readonly bundle: MapBundle;
  readonly controls: MapControlPlan;
  readonly xodr: string;
  readonly colliders: Promise<Awaited<ReturnType<typeof loadStaticMapCollidersBounded>>>;
}

const runtimesByAsset = new Map<string, Promise<MapRuntime>>();
const runtimesByKey = new Map<string, MapRuntime>();
const compiledWorlds = new Map<string, Promise<ScenarioWorkerResponse>>();
// Interactive compilation already advances the canonical engine through
// warmup to produce t=0. Hand that exact session to Play once, avoiding a
// second warmup pass over all dynamic actors.
const preparedLiveSessions = new Map<string, FixedStepSimulationSession>();
let liveGeneration = 0;
let transport: {
  id: number;
  playing: boolean;
  playheadS: number;
  wallStartedMs: number | null;
  wake: (() => void) | null;
} | null = null;

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<ScenarioWorkerMessage>): void => {
  const request = event.data;
  if (request.kind === 'cancel') {
    liveGeneration += 1;
    transport?.wake?.();
    transport = null;
    return;
  }
  if (request.kind === 'transport') {
    if (transport?.id !== request.id) return;
    const now = performance.now();
    if (typeof request.time === 'number') {
      transport.playheadS = Math.max(0, request.time);
    } else if (transport.playing && transport.wallStartedMs !== null) {
      transport.playheadS += Math.max(0, now - transport.wallStartedMs) / 1000;
    }
    transport.playing = request.playing;
    transport.wallStartedMs = request.playing ? now : null;
    transport.wake?.();
    transport.wake = null;
    return;
  }
  if (request.kind === 'start') {
    const token = ++liveGeneration;
    transport = { id: request.id, playing: false, playheadS: 0, wallStartedMs: null, wake: null };
    void runLive(request, token).catch((reason: unknown) => postFailure(request.id, request.revision, reason));
    return;
  }
  if (request.kind === 'inspect-signals') {
    void getMapRuntime(request.map).then(
      (runtime) => scope.postMessage({
        id: request.id,
        revision: request.revision,
        ok: true,
        kind: 'signal-catalog',
        signalCatalog: runtime.bundle.signalCatalog,
        signalControlIndex: buildSignalControlIndex(
          runtime.controls.signalPrograms,
          runtime.bundle.signalCatalog.heads.map((head) => head.id),
        ),
        controlDigest: runtime.identity.controlDigest,
      } satisfies ScenarioWorkerResponse),
      (reason: unknown) => postFailure(request.id, request.revision, reason),
    );
    return;
  }
  void prepare(request).then(
    (response) => scope.postMessage(response),
    (reason: unknown) => postFailure(request.id, request.revision ?? String(request.id), reason),
  );
};

async function prepare(request: ScenarioWorkerRequest): Promise<ScenarioWorkerResponse> {
  const interactive = request.kind === 'compile' || request.operation === 'materialize';
  if (!interactive) return prepareUncached(request);
  const started = performance.now();
  const revision = request.revision ?? String(request.id);
  const key = contentHash({
    map: mapAssetDigest(request.map),
    revision,
    document: request.template,
    ambient: request.ambientTraffic,
    base: request.baseInstance?.input ?? null,
    candidatePool: request.ambientCandidatePool?.profileHash ?? null,
  });
  const cached = compiledWorlds.get(key);
  if (cached) {
    const response = await cached;
    return response.ok && response.kind === 'prepare'
      ? { ...response, id: request.id, revision, cache: 'warm', timing: { totalMs: performance.now() - started, compileCache: 'hit' } }
      : response;
  }
  const pending = prepareUncached(request);
  compiledWorlds.set(key, pending);
  try {
    const response = await pending;
    return response.ok && response.kind === 'prepare'
      ? { ...response, timing: { totalMs: performance.now() - started, compileCache: 'miss' } }
      : response;
  } catch (error) {
    compiledWorlds.delete(key);
    throw error;
  }
}

async function prepareUncached(request: ScenarioWorkerRequest): Promise<ScenarioWorkerResponse> {
  const assetKey = mapAssetDigest(request.map);
  const cache = runtimesByAsset.has(assetKey) ? 'warm' : 'cold';
  const runtime = await getMapRuntime(request.map);
  const { topology: topologyIndex, graph, bundle, controls: mapControls, xodr } = runtime;
  const { index } = bundle;
  // Collider extraction starts once per map runtime, but compile/t=0 never
  // awaits it. Explicit export/validation jobs can consume the cached result.
  const isInteractiveCompile = request.kind === 'compile' || request.operation === 'materialize';
  const staticCollision = isInteractiveCompile || request.staticCollisionMode === 'skip'
    ? emptyStaticColliderBundle('skipped', 'Static map collision extraction is cached in the map runtime and deferred off the compile path.')
    : await runtime.colliders;
  const revision = request.revision ?? String(request.id);

  // A blank editor still owns one normal concrete world. It has no authored
  // rows yet, but its ambient SimActors use the same routes, controls, physics,
  // collision handling and trace format as every later authored scenario.
  if (request.template.roles.length === 0 && !request.baseInstance) {
    const base = withMapControls(
      withEditablePhysicsDefault({
        ...createEmptyAmbientInput(request.map.id),
        clipSeconds: request.template.choreography.clipSeconds,
        warmupSeconds: request.template.choreography.warmupSeconds,
      }),
      controlsForTemplate(runtime, request.template),
    );
    const populated = applyRequestedAmbientPopulation(base, graph, request, {
      maxAchievableDecelMps2: request.evaluationFilters?.maxAchievableDecelMps2,
    });
    // The core schema requires one actor. Keep a remote, non-render-authoritative
    // clock only when an external provider (SUMO) owns the entire visible
    // population; remove it as soon as native ambient actors exist.
    const ambient = populated.provenance.actors.length === 0 ? populated : {
      ...populated,
      input: { ...populated.input, actors: populated.input.actors.filter((actor) => actor.id !== 'ambient-world-seed') },
    };
    const result = simulateForRequest(ambient.input, graph, staticCollision.colliders, request.operation);
    const manifest = {
      instanceId: `ambient-world:${request.map.id}`,
      inputHash: contentHash(base),
      replayKey: { mapId: request.map.id, engineGraphDigest: graph.topologyDigest, siteId: 'ambient-world' },
      actors: [],
    };
    return {
      id: request.id,
      revision,
      ok: true,
      kind: 'prepare',
      runtimeKey: runtime.key,
      cache,
      instance: ambientInstance(manifest, ambient.input, ambient.provenance),
      trace: result.trace,
      siteId: 'ambient-world',
      ambientTraffic: ambient.provenance,
      ambientCandidatePool: ambient.candidatePool,
      mapCollisions: staticCollision.diagnostics,
    };
  }

  if (request.baseInstance) {
    if (request.baseInstance.input.mapId !== request.map.id) {
      throw new Error(`Verified base targets ${request.baseInstance.input.mapId}, not ${request.map.id}`);
    }
    // A verified bundle is replayed directly elsewhere. Reaching the worker
    // means the user requested a regenerated editable simulation: deterministically
    // migrate an unpinned legacy input to the current dynamic authoring default.
    const repaired = pruneDanglingAfterInteractions(request.baseInstance.input.interactions);
    const editableInput = withMapControls(withEditablePhysicsDefault({
      ...request.baseInstance.input,
      actors: request.baseInstance.input.actors.filter((actor) => !isAmbientSimActor(actor)),
      interactions: repaired.interactions,
    }), mapControls);
    const generated = applyRequestedAmbientPopulation(editableInput, graph, request, {
      maxAchievableDecelMps2: request.evaluationFilters?.maxAchievableDecelMps2,
    });
    const ambient = repaired.removed.length === 0 ? generated : {
      ...generated,
      provenance: {
        ...generated.provenance,
        warnings: [
          ...generated.provenance.warnings,
          ...repaired.removed.map((item) => `Removed stale concrete command ${item.interactionId}: after(${item.missingInteractionId}) has no source interaction.`),
        ],
      },
    };
    const result = simulateForRequest(ambient.input, graph, staticCollision.colliders, request.operation);
    const instance = ambientInstance(request.baseInstance.manifest, ambient.input, ambient.provenance);
    const replayKey = request.baseInstance.manifest['replayKey'] as Record<string, unknown> | undefined;
    return {
      id: request.id,
      revision,
      ok: true,
      kind: 'prepare',
      runtimeKey: runtime.key,
      cache,
      instance,
      trace: result.trace,
      siteId: String(replayKey?.['siteId'] ?? 'verified-base'),
      ambientTraffic: ambient.provenance,
      ambientCandidatePool: ambient.candidatePool,
      mapCollisions: staticCollision.diagnostics,
      ...(isInteractiveCompile ? {} : { openScenario: createOpenScenarioSnapshot(request.template, instance, ambient.input, result.trace, graph, xodr) }),
    };
  }

  const isMapBound = request.template.roles.length > 0 && request.template.roles.every((role) => role.kind === 'scene_absolute');
  if (isMapBound) {
    const product = materializeMapBound(request.template, bundle, { drawIndex: -1 });
    if (!product.manifest.feasible) {
      const errors = product.manifest.issues.filter((issue) => issue.severity === 'error');
      throw new Error(`Scenario is not feasible: ${errors.map((issue) => issue.reason).join(' · ')}`);
    }
    const controlledInput = withMapControls(product.input, mapControls);
    const ambient = applyRequestedAmbientPopulation(controlledInput, graph, request, {
      maxAchievableDecelMps2: request.evaluationFilters?.maxAchievableDecelMps2,
    });
    if (request.operation === 'robustness') return robustnessResponse(request, controlledInput, graph);
    const result = simulateForRequest(ambient.input, graph, staticCollision.colliders, request.operation);
    const instance = ambientInstance(product.manifest, ambient.input, ambient.provenance);
    return {
      id: request.id,
      revision,
      ok: true,
      kind: 'prepare',
      runtimeKey: runtime.key,
      cache,
      instance,
      trace: result.trace,
      siteId: product.manifest.replayKey.siteId,
      ambientTraffic: ambient.provenance,
      ambientCandidatePool: ambient.candidatePool,
      mapCollisions: staticCollision.diagnostics,
      ...(isInteractiveCompile ? {} : { openScenario: createOpenScenarioSnapshot(request.template, instance, ambient.input, result.trace, graph, xodr) }),
    };
  }

  const adapted = adaptTemplate(request.template);
  if (adapted.notes.length > 0) {
    throw new Error(`Scenario uses constructs the matcher cannot preserve: ${adapted.notes.map((note) => `${note.path}: ${note.reason}`).join(' · ')}`);
  }
  const report = matchAnchorReport(adapted.anchor, index, { roles: adapted.roles });
  if (!report.sites.some((candidate) => candidate.degradation.intentPreserved)) {
    const summary = Object.entries(report.failureSummary).map(([key, value]) => `${key}: ${value}`).join(', ');
    throw new Error(`No intent-preserving site matches this scenario on ${request.map.id}${summary ? ` (${summary})` : ''}`);
  }
  const selected = selectPlayableSite(report.sites, (candidate) => {
    const candidateProduct = materialize(request.template, bundle, candidate, { drawIndex: -1 });
    const semanticLosses = materializationSemanticLosses(candidateProduct.manifest.notes);
    if (semanticLosses.length > 0) {
      throw new Error(`materialization would lose authored semantics: ${semanticLosses.map((note) => `${note.path}: ${note.reason}`).join(' · ')}`);
    }
    if (!candidateProduct.manifest.feasible) {
      const errors = candidateProduct.manifest.issues.filter((issue) => issue.severity === 'error');
      throw new Error(`scenario is not feasible: ${errors.map((issue) => issue.reason).join(' · ')}`);
    }
    return candidateProduct;
  });
  const { site, product } = selected;
  const controlledInput = withMapControls(product.input, mapControls);
  const ambient = applyRequestedAmbientPopulation(controlledInput, graph, request, {
    maxAchievableDecelMps2: request.evaluationFilters?.maxAchievableDecelMps2,
  });
  if (request.operation === 'robustness') return robustnessResponse(request, controlledInput, graph);
  const result = simulateForRequest(ambient.input, graph, staticCollision.colliders, request.operation);
  const instance = ambientInstance(product.manifest, ambient.input, ambient.provenance);
  return {
    id: request.id,
    revision,
    ok: true,
    kind: 'prepare',
    runtimeKey: runtime.key,
    cache,
    instance,
    trace: result.trace,
    siteId: site.siteId,
    ambientTraffic: ambient.provenance,
    ambientCandidatePool: ambient.candidatePool,
    mapCollisions: staticCollision.diagnostics,
    ...(isInteractiveCompile ? {} : { openScenario: createOpenScenarioSnapshot(request.template, instance, ambient.input, result.trace, graph, xodr) }),
  };
}

/** Empty authored document base. Ambient actors are ordinary runtime actors added afterward. */
function createEmptyAmbientInput(mapId: string): SimScenarioInput {
  const parsed = parseSimScenarioInput({
    mapId,
    clipSeconds: 20,
    warmupSeconds: 0,
    dt: 0.05,
    seed: `ambient-world:${mapId}`,
    actors: [{
      id: 'ambient-world-seed',
      kind: 'static_object',
      static: true,
      initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
      behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } },
      tags: ['ambient:internal-clock'],
    }],
    physics: { mode: 'dynamic-v1' },
  });
  return parsed;
}

async function getMapRuntime(map: ScenarioWorkerMap): Promise<MapRuntime> {
  const assetDigest = mapAssetDigest(map);
  const existing = runtimesByAsset.get(assetDigest);
  if (existing) return existing;
  const pending = (async (): Promise<MapRuntime> => {
    const [topology, derived, locations, xodr, signals] = await Promise.all([
      fetchJson(map.topology),
      fetchJson(map.derivedTopology),
      fetchJson(map.locations),
      fetchText(map.xodr),
      fetchJson(map.signals),
    ]);
    const signalCatalog = parseMapSignalCatalog(xodr, signals);
    const topologyIndex = topologyWithMapSpeedLimits(topology as TopologyIndex, signalCatalog);
    const index = normalizeDerivedMapIndex(derived, {
      mapId: map.id,
      topology: topologyIndex as never,
      locations,
    });
    const graph = buildLaneGraph(topologyIndex);
    const bundle: MapBundle = {
      mapId: map.id,
      catalog: locations as MapBundle['catalog'],
      derived: derived as MapBundle['derived'],
      topology: topologyIndex,
      index,
      graph,
      signalCatalog,
    };
    const controls = buildMapControlPlan(bundle);
    // Start exactly once and reuse the result for validation/export. This does
    // not delay an editor compile or its t=0 response.
    const colliders = loadStaticMapCollidersBounded(map.manifest, topologyIndex);
    const identity: MapRuntimeIdentity = {
      mapId: map.id,
      assetDigest,
      graphDigest: graph.topologyDigest,
      controlDigest: contentHash(controls),
      // The artifact source is part of the identity immediately; diagnostics
      // expose the parsed manifest digest once the background load completes.
      colliderDigest: contentHash({ manifest: map.manifest }),
    };
    const runtime: MapRuntime = {
      key: runtimeDigest(identity), identity, topology: topologyIndex, graph,
      bundle, controls, xodr, colliders,
    };
    runtimesByKey.set(runtime.key, runtime);
    return runtime;
  })();
  runtimesByAsset.set(assetDigest, pending);
  try {
    return await pending;
  } catch (error) {
    runtimesByAsset.delete(assetDigest);
    throw error;
  }
}

async function runLive(request: ScenarioWorkerStartRequest, token: number): Promise<void> {
  const runtime = runtimesByKey.get(request.runtimeKey);
  if (!runtime) throw new Error('The compiled map runtime is no longer available; compile this revision again.');
  const inputKey = contentHash(request.input);
  const prepared = preparedLiveSessions.get(inputKey);
  if (prepared) preparedLiveSessions.delete(inputKey);
  const simulation = prepared ?? createFixedStepSimulation(request.input, { graph: runtime.graph, guards: 'throw' });
  let progress = simulation.advance(prepared
    ? 1
    : initialLiveTickBudget(request.input.warmupSeconds, request.input.dt), { trace: true });
  postLive(request, progress.done ? 'complete' : 'ready', progress.trace!, progress.recordedUntil ?? 0);
  while (!progress.done && token === liveGeneration) {
    await waitUntilPlaying(request.id, token);
    if (transport?.id === request.id && !transport.playing) continue;
    if (token !== liveGeneration) return;
    const activeTransport = transport;
    if (!activeTransport || activeTransport.id !== request.id) return;
    const playhead = activeTransport.playheadS + (activeTransport.wallStartedMs === null
      ? 0
      : Math.max(0, performance.now() - activeTransport.wallStartedMs) / 1000);
    const refill = planLiveRefill(progress.recordedUntil ?? 0, playhead, request.input.dt);
    if (refill.advanceTicks === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, refill.waitMs));
      continue;
    }
    progress = simulation.advance(refill.advanceTicks, { trace: true });
    postLive(request, progress.done ? 'complete' : 'progress', progress.trace!, progress.recordedUntil ?? 0);
    // Let cancellation, pause, and a newer document revision preempt long
    // catch-up work without imposing a fixed delay on normal playback.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function waitUntilPlaying(id: number, token: number): Promise<void> {
  while (token === liveGeneration && transport?.id === id && !transport.playing) {
    await new Promise<void>((resolve) => {
      if (!transport || transport.id !== id || transport.playing) resolve();
      else transport.wake = resolve;
    });
  }
}

function postLive(
  request: ScenarioWorkerStartRequest,
  kind: 'ready' | 'progress' | 'complete',
  trace: SimTrace,
  recordedUntil: number,
): void {
  scope.postMessage({ id: request.id, revision: request.revision, ok: true, kind, trace, recordedUntil } satisfies ScenarioWorkerResponse);
}

function postFailure(id: number, revision: string, reason: unknown): void {
  scope.postMessage({
    id,
    revision,
    ok: false,
    error: reason instanceof Error ? reason.message : String(reason),
  } satisfies ScenarioWorkerResponse);
}

function simulateForRequest(
  input: SimScenarioInput,
  graph: ReturnType<typeof buildLaneGraph>,
  staticColliders: Parameters<typeof runSimulation>[1]['staticColliders'],
  operation: ScenarioWorkerRequest['operation'],
): SimResult {
  if (operation !== 'materialize') return runSimulation(input, { graph, guards: 'throw', staticColliders });
  const key = contentHash(input);
  // Authoring and Play share this exact full-duration fixed-step result. This
  // removes the former t=0 + heuristic future-path split: trigger decisions,
  // route gates, signals, collisions and action timing have one authority.
  const result = runCanonicalPreview(input, graph, staticColliders);
  preparedLiveSessions.delete(key);
  return result;
}

function applyRequestedAmbientPopulation(
  base: SimScenarioInput,
  graph: ReturnType<typeof buildLaneGraph>,
  request: ScenarioWorkerRequest,
  options: { maxAchievableDecelMps2?: number },
): AmbientTrafficResult & { readonly candidatePool: AmbientCandidatePool } {
  const requestedProfileHash = contentHash(resolveAmbientTrafficProfile(request.ambientTraffic));
  const reusable = request.ambientCandidatePool;
  const candidatePool = reusable
    && reusable.mapGraphDigest === graph.topologyDigest
    && reusable.profileHash === requestedProfileHash
    ? reusable
    : createAmbientCandidatePool(graph, request.ambientTraffic);
  return {
    ...materializeAmbientCandidatePool(base, graph, candidatePool, options),
    candidatePool,
  };
}

function isAmbientSimActor(actor: { readonly id: string; readonly tags: readonly string[] }): boolean {
  return actor.id.startsWith('ambient:')
    || actor.id.startsWith('ambient-')
    || actor.tags.some((tag) => tag === 'ambient' || tag.startsWith('ambient:'));
}


function createOpenScenarioSnapshot(
  template: ScenarioTemplateV2,
  instance: unknown,
  input: SimScenarioInput,
  trace: SimTrace,
  graph: Parameters<typeof exportOpenScenarioXml14>[1]['graph'],
  xodr: string,
): OpenScenarioSnapshot {
  const manifest = (instance as { manifest: { instanceId: string } }).manifest;
  const templateHash = contentHash(template);
  const inputHash = contentHash(input);
  const filenameStem = template.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';
  const mapping = sourceMapping(input);
  try {
    const result = exportOpenScenarioXml14(input, {
      graph,
      roadFile: `${input.mapId}.xodr`,
      executionMode: 'trajectory-replay',
      author: template.meta.author ?? 'UniScenarios Studio',
      description: template.meta.description || template.meta.name,
      provenance: { templateHash, inputHash, laneGraphDigest: graph.topologyDigest },
    });
    return {
      version: 1,
      source: { name: template.meta.name, templateHash, mapping },
      concrete: { input, inputHash, instanceId: manifest.instanceId, traceHash: traceDigest(trace), traceHeader: trace.header, trace },
      map: { id: input.mapId, roadFile: `${input.mapId}.xodr`, xodrDigest: graph.topologyDigest, laneGraphDigest: graph.topologyDigest },
      artifact: {
        state: 'ready',
        standard: 'ASAM OpenSCENARIO XML 1.4.0',
        profile: 'xml-1.4-trajectory-replay',
        intent: 'trajectory-replay',
        filename: `${filenameStem}.xosc`,
        mediaType: 'application/xml',
        content: result.content,
        capabilityReport: result.capabilityReport,
        warnings: result.warnings,
        issues: [],
      },
      validation: validationStages(true, result.warnings.length, input.mapId, graph.topologyDigest),
    };
  } catch (reason) {
    const issues = reason instanceof AsamExportError
      ? reason.issues
      : [{ code: 'export_failed', path: 'input', reason: reason instanceof Error ? reason.message : String(reason) }];
    return {
      version: 1,
      source: { name: template.meta.name, templateHash, mapping },
      concrete: { input, inputHash, instanceId: manifest.instanceId, traceHash: traceDigest(trace), traceHeader: trace.header, trace },
      map: { id: input.mapId, roadFile: `${input.mapId}.xodr`, xodrDigest: graph.topologyDigest, laneGraphDigest: graph.topologyDigest },
      artifact: {
        state: 'rejected',
        standard: 'ASAM OpenSCENARIO XML 1.4.0',
        profile: 'xml-1.4-trajectory-replay',
        intent: 'trajectory-replay',
        filename: `${filenameStem}.xosc`,
        mediaType: 'application/xml',
        content: null,
        capabilityReport: null,
        warnings: [],
        issues,
      },
      validation: validationStages(false, 0, input.mapId, graph.topologyDigest),
    };
  }
}

/** Preserve authored control programs verbatim and fill only missing physical
 * map controls. This keeps authored signal overrides stable while allowing
 * ambient traffic elsewhere in the city to obey the same real heads. */
function withMapControls(input: SimScenarioInput, controls: MapControlPlan): SimScenarioInput {
  const signalIds = new Set(input.signalPrograms.map((program) => program.id));
  const roadControlIds = new Set(input.roadControls.map((control) => control.id));
  return {
    ...input,
    signalPrograms: [
      ...input.signalPrograms,
      ...controls.signalPrograms.filter((program) => !signalIds.has(program.id)),
    ],
    roadControls: [
      ...input.roadControls,
      ...controls.roadControls.filter((control) => !roadControlIds.has(control.id)),
    ],
  };
}

/** A signal-only authored scene still compiles through the same controller
 * contract even though it has no actor/site for the ordinary materializer. */
function controlsForTemplate(runtime: MapRuntime, template: ScenarioTemplateV2): MapControlPlan {
  if (template.mapSignalPlans.length === 0) return runtime.controls;
  const directWorldHandles = template.choreography.interactions.flatMap((interaction) => {
    if (interaction.actor !== '@world' || interaction.verb !== 'set') return [];
    const match = /^signal:(.+)\.phase$/.exec(interaction.target.key);
    if (!match) return [];
    const handle = match[1]!;
    const program = runtime.controls.signalPrograms.find((candidate) =>
      candidate.id === handle || candidate.mapBinding?.headIds.includes(handle));
    return program ? [program.id] : [];
  });
  return {
    ...runtime.controls,
    signalPrograms: compileMapSignalPlans(runtime.controls.signalPrograms, template.mapSignalPlans, {
      mapId: runtime.bundle.mapId,
      clipSeconds: template.choreography.clipSeconds,
      warmupSeconds: template.choreography.warmupSeconds,
      signalCatalog: runtime.bundle.signalCatalog,
      worldSignalSetIds: directWorldHandles,
    }),
  };
}

function validationStages(exported: boolean, warnings: number, mapId: string, graphDigest: string): OpenScenarioSnapshot['validation'] {
  return [
    { id: 'internal-model', label: 'Concrete model', status: 'passed', detail: 'Materialized input and canonical trace passed strict Studio playback validation.' },
    { id: 'xml-profile', label: 'XML 1.4 export profile', status: exported ? 'passed' : 'failed', detail: exported ? `Fail-closed trajectory profile generated${warnings ? ` with ${warnings} warning(s)` : ''}.` : 'Unsupported or invalid semantics rejected the artifact.' },
    { id: 'official-xsd', label: 'Official ASAM XSD', status: exported ? 'pending' : 'not-run', detail: exported ? 'Awaiting pinned official schema validation.' : 'No XML artifact to validate.' },
    { id: 'dependencies', label: 'Dependencies', status: 'pending', detail: `Full ${mapId}.xodr must resolve to lane graph ${graphDigest}.` },
    { id: 'external-execution', label: 'External execution', status: 'not-run', detail: 'No pinned external runner result is attached to this immutable snapshot.' },
    { id: 'behavior-parity', label: 'Behavior parity', status: 'not-run', detail: 'Requires an external trace before quantitative comparison.' },
  ];
}

function sourceMapping(input: SimScenarioInput): OpenScenarioSourceMapping[] {
  const id = (prefix: string, raw: string): string => {
    let stem = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (!stem || /^[0-9]/.test(stem)) stem = `id_${stem || 'unnamed'}`;
    return `${prefix}_${stem}`;
  };
  return [
    ...input.actors.flatMap((actor, index) => [
      { sourcePath: `actors.${index}`, sourceId: actor.id, exportKind: 'entity' as const, exportName: id('actor', actor.id), selector: `ScenarioObject[name="${id('actor', actor.id)}"]` },
      { sourcePath: `actors.${index}.route`, sourceId: actor.id, exportKind: 'trajectory' as const, exportName: id('trajectory', actor.id), selector: `Trajectory[name="${id('trajectory', actor.id)}"]` },
    ]),
    ...input.interactions.map((interaction, index) => ({ sourcePath: `interactions.${index}`, sourceId: interaction.id, exportKind: 'event' as const, exportName: id('interaction', interaction.id), selector: `Event[name="${id('interaction', interaction.id)}"]` })),
    ...input.signalPrograms.map((program, index) => ({ sourcePath: `signalPrograms.${index}`, sourceId: program.id, exportKind: 'signal' as const, exportName: program.id, selector: `TrafficSignalController[name="${program.id}"]` })),
  ];
}

function robustnessResponse(
  request: ScenarioWorkerRequest,
  input: SimScenarioInput,
  graph: Parameters<typeof evaluateAmbientRobustness>[1],
): ScenarioWorkerResponse {
  const filters = request.evaluationFilters ?? {};
  const report = evaluateAmbientRobustness(input, graph, undefined, {
    filters,
    now: () => performance.now(),
  });
  const baselineIntent = request.intentRubric
    ? evaluateIntentRubric(report.baselineTrace, request.intentRubric)
    : null;
  const caseIntent = request.intentRubric
    ? Object.fromEntries(report.cases.map((item) => [item.label, evaluateIntentRubric(item.trace, request.intentRubric!).verdict])) as Record<string, 'accept' | 'reject'>
    : {};
  const gate = ambientRobustnessGate(report.accepted, baselineIntent ? {
    baseline: baselineIntent.verdict,
    cases: caseIntent,
  } : null);
  return {
    id: request.id,
    revision: request.revision ?? String(request.id),
    ok: true,
    kind: 'robustness',
    report: {
      version: 1,
      baseInputHash: report.baseInputHash,
      baselineVerdict: report.baselineEvaluation.verdict,
      accepted: gate.accepted,
      overall: gate.overall,
      intent: {
        status: request.intentRubric ? 'evaluated' : 'not_evaluated',
        baselineVerdict: baselineIntent?.verdict ?? null,
        caseVerdicts: caseIntent,
      },
      filters,
      cases: report.cases.map((item) => ({
        label: item.label,
        accepted: item.accepted,
        deterministic: item.deterministic,
        authoredEventOrderPreserved: item.authoredEventOrderPreserved,
        authoredNeverFiredPreserved: item.authoredNeverFiredPreserved,
        ambientCollisions: item.ambientCollisions,
        runtimeMs: item.runtimeMs,
        generatedActors: item.provenance.actors.length,
        profileHash: item.provenance.profileHash,
        verdict: item.evaluation.verdict,
        failures: item.failures,
        warnings: item.provenance.warnings,
      })),
    },
  };
}

function ambientInstance(
  baseManifest: Record<string, any>,
  input: SimScenarioInput,
  provenance: AmbientTrafficProvenance,
): unknown {
  // The blank-world path may remove its schema-only seed actor after ambient
  // population has been materialized. Always derive identity from the exact
  // input returned to playback rather than trusting an earlier intermediate
  // hash; otherwise the editor rejects its own freshly prepared scenario.
  const generatedInputHash = contentHash(input);
  const normalizedProvenance = provenance.generatedInputHash === generatedInputHash
    ? provenance
    : { ...provenance, generatedInputHash };
  const authored = new Map((baseManifest['actors'] as Array<Record<string, unknown>>).map((actor) => [actor['id'], actor]));
  const actors = input.actors.map((actor) => authored.get(actor.id) ?? {
    id: actor.id,
    actorKind: actor.kind,
    roleKind: 'ambient',
    origin: 'ambient',
    timelineVisible: false,
    editable: false,
    laneRsl: actor.initial.laneRef?.rsl ?? null,
    spawnS: actor.initial.laneRef?.s ?? 0,
    initialSpeedMps: actor.initial.speedMps,
    bindingStatus: 'generated',
  });
  return {
    kind: 'scenario-instance',
    version: 1,
    manifest: {
      ...baseManifest,
      inputHash: generatedInputHash,
      instanceId: `${String(baseManifest['instanceId'])}@ambient:${provenance.profileHash.slice(0, 12)}`,
      actors,
      ambientTraffic: normalizedProvenance,
      ambientBaseInputHash: provenance.baseInputHash,
    },
    input,
    ambientTraffic: normalizedProvenance,
  };
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

async function fetchJson(url: string): Promise<any> {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(url)));
}

async function fetchText(url: string): Promise<string> {
  return new TextDecoder().decode(await fetchBytes(url));
}
