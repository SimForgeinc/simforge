import { z } from 'zod';
import { canonicalJson, sha256Bytes } from '../core/hash.js';

export const MATERIALIZED_TRAFFIC_SCHEMA = 'uniscenarios.materialized-traffic.v1' as const;
export const MATERIALIZED_TRAFFIC_TIME_PRECISION = 9;
export const MATERIALIZED_TRAFFIC_MAX_ACTORS = 256;
export const MATERIALIZED_TRAFFIC_MAX_ACTOR_STATES = 2_000_000;

const finite = z.number().finite();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(256);

export const materializedTrafficActorStateSchema = z.object({
  t: finite.min(0),
  present: z.boolean(),
  x: finite,
  z: finite,
  headingRad: finite,
  speedMps: finite.min(0),
  accelerationMps2: finite,
  /** SUMO vehicle-light mask: bit 0 right, bit 1 left; both means hazard. */
  signals: z.number().int().min(0).max(0xffff_ffff),
}).strict();

export const materializedTrafficActorSchema = z.object({
  id,
  kind: z.enum(['vehicle', 'pedestrian', 'bicycle', 'obstacle']),
  states: z.array(materializedTrafficActorStateSchema).min(1),
}).strict();

export const materializedTrafficSignalStateSchema = z.object({
  t: finite.min(0),
  state: z.enum(['green', 'yellow', 'red', 'off']),
}).strict();

export const materializedTrafficSignalSchema = z.object({
  id,
  states: z.array(materializedTrafficSignalStateSchema).min(1),
}).strict();

export const materializedTrafficArtifactSchema = z.object({
  schema: z.literal(MATERIALIZED_TRAFFIC_SCHEMA),
  sourceInputDigest: digest,
  map: z.object({
    /** Canonical source_map_asset_id, never the historical map slug. */
    assetId: id,
    /** Immutable database map-version identity. */
    versionId: id,
  }).strict(),
  provider: z.object({
    id: z.enum(['disabled', 'native', 'sumo']),
    version: z.string().min(1).max(128),
    seed: z.string().max(256),
  }).strict(),
  fixedStepSeconds: finite.gt(0),
  durationSeconds: finite.min(0),
  actors: z.array(materializedTrafficActorSchema),
  signals: z.array(materializedTrafficSignalSchema),
}).strict().superRefine((artifact, context) => {
  const frameCount = materializedTrafficFrameCount(artifact.fixedStepSeconds, artifact.durationSeconds);
  if (frameCount === null) {
    context.addIssue({ code: 'custom', path: ['durationSeconds'], message: 'durationSeconds must end on the fixed-step grid' });
    return;
  }
  if (artifact.actors.length > MATERIALIZED_TRAFFIC_MAX_ACTORS || artifact.actors.length * frameCount > MATERIALIZED_TRAFFIC_MAX_ACTOR_STATES) {
    context.addIssue({ code: 'custom', path: ['actors'], message: 'materialized traffic exceeds execution actor limits' });
  }
  validateSortedUnique(artifact.actors.map((actor) => actor.id), ['actors'], context);
  validateSortedUnique(artifact.signals.map((signal) => signal.id), ['signals'], context);
  artifact.actors.forEach((actor, actorIndex) => {
    if (actor.states.length !== frameCount) {
      context.addIssue({ code: 'custom', path: ['actors', actorIndex, 'states'], message: `expected ${frameCount} complete fixed-step states` });
      return;
    }
    actor.states.forEach((state, stateIndex) => {
      validateFrameTime(state.t, stateIndex, artifact.fixedStepSeconds, ['actors', actorIndex, 'states', stateIndex, 't'], context);
      if (!state.present && (state.x !== 0 || state.z !== 0 || state.headingRad !== 0 || state.speedMps !== 0 || state.accelerationMps2 !== 0 || state.signals !== 0)) {
        context.addIssue({ code: 'custom', path: ['actors', actorIndex, 'states', stateIndex], message: 'absent actor state must use the canonical zero payload' });
      }
    });
  });
  artifact.signals.forEach((signal, signalIndex) => {
    if (signal.states.length !== frameCount) {
      context.addIssue({ code: 'custom', path: ['signals', signalIndex, 'states'], message: `expected ${frameCount} complete fixed-step states` });
      return;
    }
    signal.states.forEach((state, stateIndex) => validateFrameTime(
      state.t,
      stateIndex,
      artifact.fixedStepSeconds,
      ['signals', signalIndex, 'states', stateIndex, 't'],
      context,
    ));
  });
  if (artifact.provider.id === 'disabled') {
    if (artifact.provider.version !== 'none' || artifact.provider.seed !== '') {
      context.addIssue({ code: 'custom', path: ['provider'], message: 'disabled provider must use version "none" and an empty seed' });
    }
    if (artifact.actors.length !== 0 || artifact.signals.length !== 0) {
      context.addIssue({ code: 'custom', path: ['actors'], message: 'disabled traffic artifact must have empty actors and signals' });
    }
  }
});

export type MaterializedTrafficActorState = z.infer<typeof materializedTrafficActorStateSchema>;
export type MaterializedTrafficActor = z.infer<typeof materializedTrafficActorSchema>;
export type MaterializedTrafficSignalState = z.infer<typeof materializedTrafficSignalStateSchema>;
export type MaterializedTrafficSignal = z.infer<typeof materializedTrafficSignalSchema>;
export type MaterializedTrafficArtifact = z.infer<typeof materializedTrafficArtifactSchema>;
export type MaterializedTrafficProvider = MaterializedTrafficArtifact['provider'];

export interface MaterializedTrafficFrameActor extends Omit<MaterializedTrafficActorState, 't' | 'present'> {
  readonly id: string;
  readonly kind: MaterializedTrafficActor['kind'];
}

export interface MaterializedTrafficFrame {
  readonly t: number;
  readonly actors: readonly MaterializedTrafficFrameActor[];
  readonly signals: Readonly<Record<string, MaterializedTrafficSignalState['state']>>;
}

export interface MaterializedTrafficArtifactEnvelope {
  readonly artifact: MaterializedTrafficArtifact;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface MaterializedTrafficBinding {
  readonly sourceInputDigest: string;
  readonly mapAssetId: string;
  readonly mapVersionId: string;
  readonly durationSeconds?: number;
  readonly sha256?: string;
}

export function materializedTrafficTime(frameIndex: number, fixedStepSeconds: number): number {
  return Number((frameIndex * fixedStepSeconds).toFixed(MATERIALIZED_TRAFFIC_TIME_PRECISION));
}

export function materializedTrafficFrameCount(fixedStepSeconds: number, durationSeconds: number): number | null {
  if (!(fixedStepSeconds > 0) || durationSeconds < 0 || !Number.isFinite(fixedStepSeconds) || !Number.isFinite(durationSeconds)) return null;
  const intervals = Math.round(durationSeconds / fixedStepSeconds);
  return Math.abs(materializedTrafficTime(intervals, fixedStepSeconds) - durationSeconds) <= 1e-9 ? intervals + 1 : null;
}

export function parseMaterializedTrafficArtifact(value: unknown): MaterializedTrafficArtifact {
  return materializedTrafficArtifactSchema.parse(value);
}

export function decodeMaterializedTrafficArtifact(bytes: Uint8Array, binding?: MaterializedTrafficBinding): MaterializedTrafficArtifactEnvelope {
  const actualSha256 = sha256Bytes(bytes);
  if (binding?.sha256 && actualSha256 !== binding.sha256) throw new Error(`materialized traffic sha256 mismatch: expected ${binding.sha256}, got ${actualSha256}`);
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('materialized traffic artifact is not valid UTF-8 JSON'); }
  const artifact = parseMaterializedTrafficArtifact(decoded);
  const canonicalBytes = encodeMaterializedTrafficArtifact(artifact);
  if (!bytesEqual(bytes, canonicalBytes)) throw new Error('materialized traffic artifact bytes are not canonical JSON');
  if (binding) validateMaterializedTrafficBinding(artifact, binding);
  return { artifact, bytes: canonicalBytes, sha256: actualSha256, sizeBytes: canonicalBytes.byteLength };
}

export function encodeMaterializedTrafficArtifact(value: MaterializedTrafficArtifact): Uint8Array {
  const artifact = parseMaterializedTrafficArtifact(value);
  return new TextEncoder().encode(canonicalJson(artifact));
}

export function materializedTrafficArtifactEnvelope(value: MaterializedTrafficArtifact): MaterializedTrafficArtifactEnvelope {
  const artifact = parseMaterializedTrafficArtifact(value);
  const bytes = encodeMaterializedTrafficArtifact(artifact);
  return { artifact, bytes, sha256: sha256Bytes(bytes), sizeBytes: bytes.byteLength };
}

export function validateMaterializedTrafficBinding(artifact: MaterializedTrafficArtifact, binding: MaterializedTrafficBinding): void {
  if (artifact.sourceInputDigest !== binding.sourceInputDigest) throw new Error('materialized traffic sourceInputDigest is stale');
  if (artifact.map.assetId !== binding.mapAssetId) throw new Error('materialized traffic map asset identity is stale');
  if (artifact.map.versionId !== binding.mapVersionId) throw new Error('materialized traffic map version identity is stale');
  if (binding.durationSeconds !== undefined && artifact.durationSeconds !== binding.durationSeconds) throw new Error('materialized traffic duration is stale');
}

export function createDisabledMaterializedTrafficArtifact(input: Omit<MaterializedTrafficArtifact, 'schema' | 'provider' | 'actors' | 'signals'>): MaterializedTrafficArtifactEnvelope {
  return materializedTrafficArtifactEnvelope({
    schema: MATERIALIZED_TRAFFIC_SCHEMA,
    ...input,
    provider: { id: 'disabled', version: 'none', seed: '' },
    actors: [],
    signals: [],
  });
}

/** Accumulates real provider frames and only yields an artifact after the last fixed frame. */
export class MaterializedTrafficRecorder {
  private readonly frames: MaterializedTrafficFrame[] = [];
  private finalized = false;

  constructor(private readonly header: Omit<MaterializedTrafficArtifact, 'schema' | 'actors' | 'signals'>) {
    if (materializedTrafficFrameCount(header.fixedStepSeconds, header.durationSeconds) === null) {
      throw new Error('materialized traffic duration must end on the fixed-step grid');
    }
    if (header.provider.id === 'disabled') throw new Error('use createDisabledMaterializedTrafficArtifact for disabled traffic');
  }

  get nextTime(): number { return materializedTrafficTime(this.frames.length, this.header.fixedStepSeconds); }
  get complete(): boolean { return this.frames.length === materializedTrafficFrameCount(this.header.fixedStepSeconds, this.header.durationSeconds); }

  record(frame: MaterializedTrafficFrame): void {
    if (this.finalized) throw new Error('materialized traffic recorder is finalized');
    if (this.complete) throw new Error('materialized traffic recorder already has the final frame');
    if (frame.t !== this.nextTime) throw new Error(`materialized traffic frame time ${frame.t} does not match next fixed time ${this.nextTime}`);
    const actors = [...frame.actors].sort((left, right) => compareCodeUnits(left.id, right.id));
    validateNoDuplicateIds(actors.map((actor) => actor.id), 'actor');
    const signals = Object.fromEntries(Object.entries(frame.signals).sort(([left], [right]) => compareCodeUnits(left, right)));
    this.frames.push({ t: frame.t, actors, signals });
  }

  finalize(): MaterializedTrafficArtifactEnvelope {
    if (!this.complete) throw new Error(`materialized traffic playback is incomplete at ${this.nextTime}s`);
    if (this.finalized) throw new Error('materialized traffic recorder is finalized');
    this.finalized = true;
    const actorDefinitions = new Map<string, MaterializedTrafficActor['kind']>();
    const signalIds = new Set<string>();
    for (const frame of this.frames) {
      for (const actor of frame.actors) {
        const prior = actorDefinitions.get(actor.id);
        if (prior && prior !== actor.kind) throw new Error(`materialized traffic actor ${actor.id} changed kind`);
        actorDefinitions.set(actor.id, actor.kind);
      }
      Object.keys(frame.signals).forEach((signalId) => signalIds.add(signalId));
    }
    const actors: MaterializedTrafficActor[] = [...actorDefinitions].sort(([left], [right]) => compareCodeUnits(left, right)).map(([actorId, kind]) => ({
      id: actorId,
      kind,
      states: this.frames.map((frame) => {
        const actor = frame.actors.find((candidate) => candidate.id === actorId);
        return actor
          ? { t: frame.t, present: true, x: actor.x, z: actor.z, headingRad: actor.headingRad, speedMps: actor.speedMps, accelerationMps2: actor.accelerationMps2, signals: actor.signals }
          : { t: frame.t, present: false, x: 0, z: 0, headingRad: 0, speedMps: 0, accelerationMps2: 0, signals: 0 };
      }),
    }));
    const signals: MaterializedTrafficSignal[] = [...signalIds].sort(compareCodeUnits).map((signalId) => ({
      id: signalId,
      states: this.frames.map((frame) => ({ t: frame.t, state: frame.signals[signalId] ?? 'off' })),
    }));
    return materializedTrafficArtifactEnvelope({ schema: MATERIALIZED_TRAFFIC_SCHEMA, ...this.header, actors, signals });
  }
}

function validateSortedUnique(values: readonly string[], path: Array<string | number>, context: z.RefinementCtx): void {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && compareCodeUnits(values[index - 1]!, values[index]!) >= 0) {
      context.addIssue({ code: 'custom', path: [...path, index, 'id'], message: 'ids must be unique and lexicographically sorted' });
    }
  }
}

function validateFrameTime(t: number, index: number, step: number, path: Array<string | number>, context: z.RefinementCtx): void {
  if (t !== materializedTrafficTime(index, step)) context.addIssue({ code: 'custom', path, message: 'state times must cover the complete fixed-step grid' });
}

function validateNoDuplicateIds(values: readonly string[], kind: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate materialized traffic ${kind} id`);
}

/** Matches canonicalJson's ECMAScript UTF-16 code-unit key ordering in every locale. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
