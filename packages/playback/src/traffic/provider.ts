import {
  MaterializedTrafficRecorder,
  decodeMaterializedTrafficArtifact,
  type MaterializedTrafficArtifactEnvelope,
  type MaterializedTrafficBinding,
  type MaterializedTrafficFrameActor,
  type MaterializedTrafficProvider,
  type SceneTrace,
  type SimTrace,
} from '@simforge/engine';
import type { TrafficStepResult } from '../index.js';

export type AmbientTrafficProviderId = 'off' | 'native' | 'sumo';

/** Execution-bearing provider choice. Unlike camera/layout presentation state, this changes the world. */
export const AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY = 'studio.ambientTraffic.provider.v1';
/** Read-only migration path for scenarios saved before provider choice became execution-bearing. */
export const LEGACY_AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY = 'studio.presentation.ambientTrafficProvider.v1';

export function ambientTrafficProviderFromExtensions(
  extensions: Readonly<Record<string, unknown>> | undefined,
): AmbientTrafficProviderId {
  const value = extensions?.[AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY]
    ?? extensions?.[LEGACY_AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY];
  // Missing and malformed preferences fail closed. SUMO is a sizeable,
  // execution-bearing runtime and must only start after an explicit author
  // choice in the editor.
  return value === 'off' || value === 'native' || value === 'sumo' ? value : 'off';
}

/**
 * SUMO may paint physical signal heads only while it also owns their live
 * controller cycle. An authored map-signal plan or an imported canonical
 * playback transfers that ownership to the playback trace, even when SUMO
 * remains the saved ambient traffic preference.
 */
export function sumoOwnsPhysicalSignalStates(
  provider: AmbientTrafficProviderId,
  fallbackActive: boolean,
  hasAuthoredMapSignals: boolean,
  canonicalPlaybackActive: boolean,
): boolean {
  return provider === 'sumo' && !fallbackActive && !hasAuthoredMapSignals && !canonicalPlaybackActive;
}

export type SumoTrafficPhase = 'disabled' | 'loading' | 'ready' | 'running' | 'fallback';

export interface SumoTrafficStatus {
  readonly phase: SumoTrafficPhase;
  readonly actorCount: number;
  readonly initMilliseconds?: number;
  readonly stepP95Milliseconds?: number;
  readonly heapBytes?: number;
  readonly wasmBytes?: number;
  readonly reason?: string;
  readonly nearbyActorCount?: number;
  readonly queuedActorCount?: number;
  readonly completedActorCount?: number;
  readonly emergencyStoppingActorCount?: number;
  readonly requestedActorCount?: number;
  readonly simulatedActorCount?: number;
  readonly nearbyRouteStarts?: number;
  /** The lean bridge does not currently expose SUMO's teleport/collision counters. */
  readonly detailedSafetyMetricsAvailable?: boolean;
  /** Physical OpenDRIVE head ids normalized from SUMO's live link states. */
  readonly signalStates?: Readonly<Record<string, 'green' | 'yellow' | 'red' | 'off'>>;
  readonly mappedSignalHeads?: number;
  readonly unmappedSignalLinks?: number;
  readonly adjustedSignalControllers?: number;
}

export const DISABLED_SUMO_STATUS: SumoTrafficStatus = Object.freeze({
  phase: 'disabled',
  actorCount: 0,
});

export interface BrowserMaterializedTrafficCaptureOptions {
  readonly sourceInputDigest: string;
  readonly mapAssetId: string;
  readonly mapVersionId: string;
  readonly provider: MaterializedTrafficProvider;
  readonly fixedStepSeconds: number;
  readonly durationSeconds: number;
}

/** Browser-side recorder for provider output. It cannot finalize a partial Play run. */
export class BrowserMaterializedTrafficCapture {
  private readonly recorder: MaterializedTrafficRecorder;

  constructor(readonly options: BrowserMaterializedTrafficCaptureOptions) {
    this.recorder = new MaterializedTrafficRecorder({
      sourceInputDigest: options.sourceInputDigest,
      map: { assetId: options.mapAssetId, versionId: options.mapVersionId },
      provider: options.provider,
      fixedStepSeconds: options.fixedStepSeconds,
      durationSeconds: options.durationSeconds,
    });
  }

  get nextTime(): number { return this.recorder.nextTime; }
  get complete(): boolean { return this.recorder.complete; }

  recordProviderFrame(
    time: number,
    actors: readonly MaterializedTrafficFrameActor[],
    signalStates: Readonly<Record<string, 'green' | 'yellow' | 'red' | 'off'>>,
  ): void {
    this.recorder.record({ t: time, actors, signals: signalStates });
  }

  recordSumoFrame(
    time: number,
    result: Pick<TrafficStepResult, 'states' | 'actorCount'>,
    signalStates: Readonly<Record<string, 'green' | 'yellow' | 'red' | 'off'>>,
  ): void {
    this.recordProviderFrame(time, decodeSumoMaterializedActors(result), signalStates);
  }

  finalize(): MaterializedTrafficArtifactEnvelope { return this.recorder.finalize(); }
}

/** Evidence and playback use the same canonical bytes and expected SHA-256. */
export function consumeMaterializedTrafficEvidence(
  bytes: Uint8Array,
  binding: MaterializedTrafficBinding & { readonly sha256: string },
): MaterializedTrafficArtifactEnvelope {
  return decodeMaterializedTrafficArtifact(bytes, binding);
}

export interface BrowserMaterializedTrafficTraceEvidence {
  readonly trace: SimTrace;
  readonly materializedTraffic: MaterializedTrafficArtifactEnvelope;
}

export interface BrowserMaterializedTrafficSceneTraceEvidence {
  readonly trace: SceneTrace;
  readonly materializedTraffic: MaterializedTrafficArtifactEnvelope;
}

/**
 * Closes the browser evidence boundary: no trace may claim the traffic digest
 * until the exact artifact bytes, source input, map identity and duration have
 * all passed validation.
 */
export function consumeMaterializedTrafficTraceEvidence(
  trace: SimTrace,
  bytes: Uint8Array,
  binding: MaterializedTrafficBinding & { readonly sha256: string },
): BrowserMaterializedTrafficTraceEvidence {
  const materializedTraffic = consumeMaterializedTrafficEvidence(bytes, binding);
  if (trace.header.inputHash !== materializedTraffic.artifact.sourceInputDigest) {
    throw new Error('browser trace inputHash does not match materialized traffic sourceInputDigest');
  }
  if (trace.header.clipSeconds !== materializedTraffic.artifact.durationSeconds) {
    throw new Error('browser trace duration does not match materialized traffic duration');
  }
  if (trace.header.dt !== materializedTraffic.artifact.fixedStepSeconds) {
    throw new Error('browser trace timestep does not match materialized traffic timestep');
  }
  const expectedTimes = materializedTraffic.artifact.actors[0]?.states.map(({ t }) => t)
    ?? materializedTraffic.artifact.signals[0]?.states.map(({ t }) => t)
    ?? Array.from(
      { length: Math.round(materializedTraffic.artifact.durationSeconds / materializedTraffic.artifact.fixedStepSeconds) + 1 },
      (_, index) => Number((index * materializedTraffic.artifact.fixedStepSeconds).toFixed(9)),
    );
  if (trace.ticks.t.length !== expectedTimes.length
      || trace.ticks.t.some((time, index) => Math.abs(time - expectedTimes[index]!) > 1e-9)) {
    throw new Error('browser trace frames do not match materialized traffic fixed-step grid');
  }
  const ambientActors = Object.fromEntries(materializedTraffic.artifact.actors.map((actor) => [actor.id, {
    x: actor.states.map((state) => state.x),
    // Provider output is scene x/z; SimTrace is OpenDRIVE-local x/y.
    y: actor.states.map((state) => -state.z),
    headingRad: actor.states.map((state) => state.headingRad),
    speedMps: actor.states.map((state) => state.speedMps),
    lateralOffsetM: actor.states.map(() => 0),
    laneRsl: actor.states.map(() => null),
    s: actor.states.map(() => 0),
    present: actor.states.map((state) => state.present ? 1 : 0),
  }]));
  const overlap = Object.keys(ambientActors).filter((actorId) => trace.ticks.actors[actorId]);
  if (overlap.length > 0) throw new Error(`materialized traffic actors collide with browser trace actors: ${overlap.join(', ')}`);
  const ambientSignals = Object.fromEntries(materializedTraffic.artifact.signals.map((signal) => [signal.id, {
    phase: signal.states.map(({ state }) => state),
  }]));
  return {
    trace: {
      ...trace,
      header: {
        ...trace.header,
        actorIds: [...trace.header.actorIds, ...Object.keys(ambientActors)].sort(),
        materializedTrafficDigest: materializedTraffic.sha256,
      },
      ticks: {
        ...trace.ticks,
        actors: { ...trace.ticks.actors, ...ambientActors },
        signals: { ...(trace.ticks.signals ?? {}), ...ambientSignals },
      },
    },
    materializedTraffic,
  };
}


/** Decode and bind the exact content-addressed bytes into the mounted scene-frame playback trace. */
export function consumeMaterializedTrafficSceneTraceEvidence(
  trace: SceneTrace,
  bytes: Uint8Array,
  binding: MaterializedTrafficBinding & { readonly sha256: string },
  options: { readonly replaceActorIds?: ReadonlySet<string> } = {},
): BrowserMaterializedTrafficSceneTraceEvidence {
  const materializedTraffic = consumeMaterializedTrafficEvidence(bytes, binding);
  if (trace.header.inputHash !== materializedTraffic.artifact.sourceInputDigest) {
    throw new Error('browser trace inputHash does not match materialized traffic sourceInputDigest');
  }
  if (trace.header.clipSeconds !== materializedTraffic.artifact.durationSeconds
      || trace.header.dt !== materializedTraffic.artifact.fixedStepSeconds) {
    throw new Error('browser trace grid does not match materialized traffic');
  }
  const frameCount = Math.round(materializedTraffic.artifact.durationSeconds / materializedTraffic.artifact.fixedStepSeconds) + 1;
  if (trace.ticks.t.length !== frameCount || trace.ticks.t.some(
    (time, index) => Math.abs(time - Number((index * materializedTraffic.artifact.fixedStepSeconds).toFixed(9))) > 1e-9,
  )) throw new Error('browser trace frames do not match materialized traffic fixed-step grid');
  const actors = Object.fromEntries(materializedTraffic.artifact.actors.map((actor) => [actor.id, {
    x: actor.states.map((state) => state.x),
    z: actor.states.map((state) => state.z),
    headingRad: actor.states.map((state) => state.headingRad),
    speedMps: actor.states.map((state) => state.speedMps),
    lateralOffsetM: actor.states.map(() => 0),
    laneRsl: actor.states.map(() => null),
    s: actor.states.map(() => 0),
    present: actor.states.map((state) => state.present ? 1 : 0),
  }]));
  const unauthorizedOverlap = Object.keys(actors).filter(
    (actorId) => trace.ticks.actors[actorId] && !options.replaceActorIds?.has(actorId),
  );
  if (unauthorizedOverlap.length > 0) {
    throw new Error(`materialized traffic actors collide with browser trace actors: ${unauthorizedOverlap.join(', ')}`);
  }
  const signals = Object.fromEntries(materializedTraffic.artifact.signals.map((signal) => [signal.id, {
    phase: signal.states.map(({ state }) => state),
  }]));
  return {
    trace: {
      ...trace,
      header: {
        ...trace.header,
        actorIds: [...new Set([...trace.header.actorIds, ...Object.keys(actors)])].sort(),
        materializedTrafficDigest: materializedTraffic.sha256,
      },
      ticks: {
        ...trace.ticks,
        actors: { ...trace.ticks.actors, ...actors },
        signals: { ...(trace.ticks.signals ?? {}), ...signals },
      },
    },
    materializedTraffic,
  };
}

/** Revision provenance always identifies the exact canonical traffic evidence bytes. */
export function bindAmbientProvenanceToMaterializedTraffic<T extends { readonly resultSha256: string }>(
  provenance: T,
  artifact: Pick<MaterializedTrafficArtifactEnvelope, 'sha256'>,
): T {
  return { ...provenance, resultSha256: artifact.sha256 };
}

export function decodeSumoMaterializedActors(
  result: Pick<TrafficStepResult, 'states' | 'actorCount'>,
): readonly MaterializedTrafficFrameActor[] {
  const view = new DataView(result.states);
  const actors: MaterializedTrafficFrameActor[] = [];
  for (let index = 0; index < result.actorCount; index += 1) {
    const offset = index * 32;
    const idHash = view.getUint32(offset, true).toString(16).padStart(8, '0');
    const headingDegrees = view.getFloat32(offset + 12, true);
    actors.push({
      id: `sumo:${idHash}`,
      kind: 'vehicle',
      x: view.getFloat32(offset + 4, true),
      z: view.getFloat32(offset + 8, true),
      headingRad: normalizeRadians((headingDegrees - 90) * Math.PI / 180),
      speedMps: Math.max(0, view.getFloat32(offset + 16, true)),
      accelerationMps2: view.getFloat32(offset + 20, true),
      signals: view.getUint32(offset + 28, true),
    });
  }
  return actors.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function normalizeRadians(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

