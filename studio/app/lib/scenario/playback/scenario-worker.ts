/// <reference lib="webworker" />

/* eslint-disable @typescript-eslint/no-explicit-any */

import { matchAnchorReport, normalizeDerivedMapIndex } from '@simforge/compiler';
import { exportOpenScenarioXml14 } from '@simforge/openscenario';
import { AsamExportError } from '@simforge/openscenario';
import { adaptTemplate, buildMapControlPlan, materializationSemanticLosses, materialize, materializeMapBound, parseMapSignalCatalog, topologyWithMapSpeedLimits, type MapBundle, type MapControlPlan } from '@simforge/compiler';
import { withParkedCarActors } from "@/app/lib/studio-shared/parked-cars";
import { parkedCarsFromExtensions } from '@/app/lib/scenario/parking/extension';
import {
  buildLaneGraph,
  contentHash,
  pruneDanglingAfterInteractions,
  evaluateAmbientRobustness,
  evaluateIntentRubric,
  runSimulation,
  materializeAmbientTrafficProfile,
  parseSimScenarioInput,
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
} from '@simforge/engine';
import type { ScenarioTemplateV2 } from '@simforge/scenario';
import { registerExternalCatalogEntry, type ExternalCatalogEntry } from '@simforge/asset-catalog';
import { ambientRobustnessGate } from '@simforge/playback/traffic';
import type { OpenScenarioSnapshot, OpenScenarioSourceMapping } from '@simforge/openscenario';
import {
  selectPlayableSite,
  withBoundedSpeedCruiseRestoration,
  withEditablePhysicsDefault,
  withStableHighSpeedWorldRoutes,
} from '@simforge/playback';
import { loadStaticMapCollidersBounded } from '@simforge/playback';
import type { StaticColliderDiagnostics } from '@simforge/playback';
import { initialLiveTickBudget, planLiveRefill } from '@simforge/playback';
import { mapAssetDigest, runtimeDigest, type MapRuntimeIdentity } from '@simforge/playback';
import {
  createCollisionAwareFixedStepSimulation,
  requireReadyStaticColliderBundle,
} from '@simforge/playback';
import { withStudioBodyColorTags } from '@simforge/compiler';

export interface ScenarioWorkerMap {
  /** Immutable browser asset/cache identity. Never used as semantic mapId. */
  runtimeAssetId: string;
  mapVersionId: string;
  sourceMapId: string;
  browserClosureSha256: string;
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
  operation?: 'prepare' | 'materialize' | 'robustness';
  evaluationFilters?: EvaluateFilters;
  /** Optional canonical intent rubric. Without it robustness is incomplete, never accepted. */
  intentRubric?: IntentRubricInput;
  /**
   * Every runtime catalog entry registered on the main thread: gallery uploads
   * and CARLA objects. The worker holds a separate module instance of the
   * catalog, so an unshared entry materialises as an unknown id.
   */
  externalCatalog?: readonly ExternalCatalogEntry[];
}

export interface ScenarioWorkerStartRequest {
  readonly kind: 'start';
  readonly id: number;
  readonly revision: string;
  readonly runtimeKey: string;
  readonly input: SimScenarioInput;
  readonly externalCatalog?: readonly ExternalCatalogEntry[];
}
export interface ScenarioWorkerCancelRequest {
  readonly kind: 'cancel';
  readonly id?: number;
  readonly externalCatalog?: readonly ExternalCatalogEntry[];
}
export interface ScenarioWorkerTransportRequest {
  readonly kind: 'transport';
  readonly id: number;
  readonly playing: boolean;
  /** Authoritative display playhead, including seeks. */
  readonly time?: number;
  readonly externalCatalog?: readonly ExternalCatalogEntry[];
}
export type ScenarioWorkerMessage = ScenarioWorkerRequest | ScenarioWorkerStartRequest | ScenarioWorkerCancelRequest | ScenarioWorkerTransportRequest;

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
  | { id: number; revision: string; ok: true; kind: 'prepare-progress'; phase: 'map-assets' | 'map-collisions' | 'simulation' }
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
  // The worker holds its own module instance of the prop catalog, so gallery
  // entries registered on the main thread are invisible here. Without this the
  // materializer reports the id as unknown and substitutes a default model.
  for (const entry of request.externalCatalog ?? []) registerExternalCatalogEntry(entry);
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
  postPrepareProgress(request, 'map-assets');
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
  const { graph, bundle, controls: mapControls, xodr } = runtime;
  const { index } = bundle;
  // A rendered map is part of the simulated world, not decorative scenery.
  // Fail closed when its immutable collider derivative is unavailable so an
  // editor preview can never present cars passing through visible structures.
  const isInteractiveCompile = request.kind === 'compile' || request.operation === 'materialize';
  postPrepareProgress(request, 'map-collisions');
  const staticCollision = requireReadyStaticColliderBundle(
    await readyRuntimeColliders(runtime),
    graph,
  );
  const revision = request.revision ?? String(request.id);

  // A blank editor still owns one normal concrete world. It has no authored
  // rows yet, but its ambient SimActors use the same routes, controls, physics,
  // collision handling and trace format as every later authored scenario.
  if (request.template.roles.length === 0 && !request.baseInstance) {
    // Parked cars belong here too, so they do not blink out of the preview the
    // moment the last authored actor is deleted.
    const base = withParkedCarActors(
      withMapControls(withEditablePhysicsDefault(createEmptyAmbientInput(request.map.sourceMapId)), mapControls),
      parkedCarsFromExtensions(request.template.extensions).baked,
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
    const result = simulateForRequest(ambient.input, graph, staticCollision.colliders, request.operation, request);
    const manifest = {
      instanceId: `ambient-world:${request.map.sourceMapId}`,
      inputHash: contentHash(base),
      replayKey: { mapId: request.map.sourceMapId, engineGraphDigest: graph.topologyDigest, siteId: 'ambient-world' },
      actors: [],
    };
    return {
      id: request.id,
      revision,
      ok: true,
      kind: 'prepare',
      runtimeKey: runtime.key,
      cache,
      instance: ambientInstance(manifest, result.input, ambient.provenance, result.issues),
      trace: result.trace,
      siteId: 'ambient-world',
      ambientTraffic: ambient.provenance,
      ambientCandidatePool: ambient.candidatePool,
      mapCollisions: staticCollision.diagnostics,
    };
  }

  if (request.baseInstance) {
    if (request.baseInstance.input.mapId !== request.map.sourceMapId) {
      throw new Error(`Verified base targets ${request.baseInstance.input.mapId}, not ${request.map.sourceMapId}`);
    }
    // A verified bundle is replayed directly elsewhere. Reaching the worker
    // means the user requested a regenerated editable simulation: deterministically
    // migrate an unpinned legacy input to the current dynamic authoring default.
    const repaired = pruneDanglingAfterInteractions(request.baseInstance.input.interactions);
    const editableInput = withParkedCarActors(withStudioBodyColorTags(withMapControls(withEditablePhysicsDefault({
      ...request.baseInstance.input,
      // Parked cars are regenerated from the document like ambient traffic is,
      // so a stale bake never outlives the extension that produced it.
      actors: request.baseInstance.input.actors.filter(
        (actor) => !isAmbientSimActor(actor) && !isParkedSimActor(actor),
      ),
      interactions: repaired.interactions,
    }), mapControls), request.template), parkedCarsFromExtensions(request.template.extensions).baked);
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
    const result = simulateForRequest(ambient.input, graph, staticCollision.colliders, request.operation, request);
    const instance = ambientInstance(request.baseInstance.manifest, result.input, ambient.provenance, result.issues);
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
      ...(isInteractiveCompile ? {} : { openScenario: createOpenScenarioSnapshot(request.template, instance, result.input, result.trace, graph, xodr) }),
    };
  }

  const isMapBound = request.template.roles.length > 0 && request.template.roles.every((role) => role.kind === 'scene_absolute');
  if (isMapBound) {
    const product = materializeMapBound(request.template, bundle, { drawIndex: -1 });
    if (!product.manifest.feasible) {
      const errors = product.manifest.issues.filter((issue) => issue.severity === 'error');
      throw new Error(`Scenario is not feasible: ${errors.map((issue) => issue.reason).join(' · ')}`);
    }
    const controlledInput = withParkedCarActors(
      withStudioBodyColorTags(withMapControls(product.input, mapControls), request.template),
      parkedCarsFromExtensions(request.template.extensions).baked,
    );
    const ambient = applyRequestedAmbientPopulation(controlledInput, graph, request, {
      maxAchievableDecelMps2: request.evaluationFilters?.maxAchievableDecelMps2,
    });
    if (request.operation === 'robustness') return robustnessResponse(request, controlledInput, graph);
    const result = simulateForRequest(ambient.input, graph, staticCollision.colliders, request.operation, request);
    const instance = ambientInstance(product.manifest, result.input, ambient.provenance, result.issues);
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
      ...(isInteractiveCompile ? {} : { openScenario: createOpenScenarioSnapshot(request.template, instance, result.input, result.trace, graph, xodr) }),
    };
  }

  const adapted = adaptTemplate(request.template);
  if (adapted.notes.length > 0) {
    throw new Error(`Scenario uses constructs the matcher cannot preserve: ${adapted.notes.map((note) => `${note.path}: ${note.reason}`).join(' · ')}`);
  }
  const report = matchAnchorReport(adapted.anchor, index, { roles: adapted.roles });
  if (!report.sites.some((candidate) => candidate.degradation.intentPreserved)) {
    const summary = Object.entries(report.failureSummary).map(([key, value]) => `${key}: ${value}`).join(', ');
    throw new Error(`No intent-preserving site matches this scenario on ${request.map.sourceMapId}${summary ? ` (${summary})` : ''}`);
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
  const controlledInput = withStudioBodyColorTags(withMapControls(product.input, mapControls), request.template);
  const ambient = applyRequestedAmbientPopulation(controlledInput, graph, request, {
    maxAchievableDecelMps2: request.evaluationFilters?.maxAchievableDecelMps2,
  });
  if (request.operation === 'robustness') return robustnessResponse(request, controlledInput, graph);
  const result = simulateForRequest(ambient.input, graph, staticCollision.colliders, request.operation, request);
  const instance = ambientInstance(product.manifest, result.input, ambient.provenance, result.issues);
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
    ...(isInteractiveCompile ? {} : { openScenario: createOpenScenarioSnapshot(request.template, instance, result.input, result.trace, graph, xodr) }),
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
  if (map.runtimeAssetId !== map.mapVersionId) {
    throw new Error(`Map runtime identity ${map.runtimeAssetId} does not match immutable version ${map.mapVersionId}`);
  }
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
      mapId: map.sourceMapId,
      topology: topologyIndex as never,
      locations,
    });
    const graph = buildLaneGraph(topologyIndex);
    const bundle: MapBundle = {
      mapId: map.sourceMapId,
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
      mapId: map.sourceMapId,
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

async function readyRuntimeColliders(runtime: MapRuntime) {
  try {
    return await runtime.colliders;
  } catch (error) {
    // A resolved MapRuntime otherwise keeps its rejected collider promise for
    // the worker's lifetime. Evict both identities so the next preparation
    // genuinely reloads the immutable map assets and collider bundle.
    runtimesByAsset.delete(runtime.identity.assetDigest);
    if (runtimesByKey.get(runtime.key) === runtime) runtimesByKey.delete(runtime.key);
    throw error;
  }
}

async function runLive(request: ScenarioWorkerStartRequest, token: number): Promise<void> {
  const runtime = runtimesByKey.get(request.runtimeKey);
  if (!runtime) throw new Error('The compiled map runtime is no longer available; compile this revision again.');
  const inputKey = contentHash(request.input);
  const prepared = preparedLiveSessions.get(inputKey);
  if (prepared) preparedLiveSessions.delete(inputKey);
  const liveStaticCollision = prepared
    ? null
    : requireReadyStaticColliderBundle(await readyRuntimeColliders(runtime), runtime.graph);
  const simulation = prepared ?? createCollisionAwareFixedStepSimulation(
    request.input,
    runtime.graph,
    liveStaticCollision!.colliders,
  );
  let progress = simulation.advance(
    prepared ? 1 : initialLiveTickBudget(request.input.warmupSeconds, request.input.dt),
    { trace: true },
  );
  if (!progress.trace) {
    throw new Error("Initial live advance did not return its requested trace.");
  }
  postLive(request, progress.done ? 'complete' : 'ready', progress.trace, progress.recordedUntil ?? 0);
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
    if (!progress.trace) {
      throw new Error("Live refill did not return its requested trace.");
    }
    postLive(request, progress.done ? 'complete' : 'progress', progress.trace, progress.recordedUntil ?? 0);
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
  request: ScenarioWorkerRequest,
): SimResult {
  postPrepareProgress(request, 'simulation');
  input = withStableHighSpeedWorldRoutes(input);
  input = withBoundedSpeedCruiseRestoration(input);
  if (operation !== 'materialize') {
    return runSimulation(input, { graph, guards: 'throw', staticColliders });
  }
  const session = createCollisionAwareFixedStepSimulation(input, graph, staticColliders);
  // Authoring needs the warmed t=0 world, not a speculative 20-second trace.
  // The same concrete input is handed to the live worker when Play is pressed.
  const progress = session.advance(Math.round(input.warmupSeconds / input.dt) + 1, {
    trace: true,
  });
  preparedLiveSessions.clear();
  preparedLiveSessions.set(contentHash(input), session);
  if (!progress.trace) {
    throw new Error("Materialization advance did not return its requested trace.");
  }
  return { ...progress, trace: progress.trace };
}

function postPrepareProgress(
  request: ScenarioWorkerRequest,
  phase: 'map-assets' | 'map-collisions' | 'simulation',
): void {
  // Robustness runs use a short-lived one-response worker whose caller treats
  // any non-report message as terminal.
  if (request.kind === 'robustness') return;
  scope.postMessage({
    id: request.id,
    revision: request.revision ?? String(request.id),
    ok: true,
    kind: 'prepare-progress',
    phase,
  } satisfies ScenarioWorkerResponse);
}

function applyRequestedAmbientPopulation(
  base: SimScenarioInput,
  graph: ReturnType<typeof buildLaneGraph>,
  request: ScenarioWorkerRequest,
  options: { maxAchievableDecelMps2?: number },
): AmbientTrafficResult & { readonly candidatePool: AmbientCandidatePool } {
  return materializeAmbientTrafficProfile(base, graph, request.ambientTraffic, request.ambientCandidatePool, options);
}

function isAmbientSimActor(actor: { readonly id: string; readonly tags: readonly string[] }): boolean {
  return actor.id.startsWith('ambient:')
    || actor.id.startsWith('ambient-')
    || actor.tags.some((tag) => tag === 'ambient' || tag.startsWith('ambient:'));
}

/** Baked parked cars carry the `parked:` id prefix `withParkedCarActors` writes. */
function isParkedSimActor(actor: { readonly id: string }): boolean {
  return actor.id.startsWith('parked:');
}


function createOpenScenarioSnapshot(
  template: ScenarioTemplateV2,
  instance: unknown,
  input: SimScenarioInput,
  trace: SimTrace,
  graph: Parameters<typeof exportOpenScenarioXml14>[1]['graph'],
  _xodr: string,
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
      author: template.meta.author ?? 'SimForge Studio',
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
  engineIssues: ReadonlyArray<SimResult['issues'][number]> = [],
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
  const issues = [...(Array.isArray(baseManifest['issues']) ? baseManifest['issues'] : []), ...engineIssues]
    .filter((entry, index, all) => all.findIndex((candidate) =>
      candidate?.code === entry?.code && candidate?.path === entry?.path && candidate?.reason === entry?.reason) === index);
  return {
    kind: 'scenario-instance',
    version: 1,
    manifest: {
      ...baseManifest,
      inputHash: generatedInputHash,
      instanceId: `${String(baseManifest['instanceId'])}@ambient:${provenance.profileHash.slice(0, 12)}`,
      actors,
      issues,
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
