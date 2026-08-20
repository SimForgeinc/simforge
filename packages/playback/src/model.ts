import {
  contentHash,
  CONTROL_INDICATIONS,
  decodeTraceGz,
  SignalBook,
  safeParseSimScenarioInput,
  traceToSceneFrame,
  TRACE_FORMAT_VERSION,
  LATERAL_OFFSET_TRACE_VERSION,
  READABLE_TRACE_FORMAT_VERSIONS,
  isReadableTraceFormatVersion,
  type SceneTrace,
  type SimActor,
  type SimScenarioInput,
  type SimTrace,
  type StaticProp,
  type AmbientTrafficProvenance,
  type ControlIndication,
} from '@uniscenarios/sim-engine';
import {
  getEntry,
  isCatalogId,
  type CatalogId,
  type Dims,
} from '@uniscenarios/prop-catalog';
import type { OpenScenarioSnapshot } from '@uniscenarios/openscenario';

const TRACE_CHANNELS = ['x', 'y', 'headingRad', 'speedMps', 'laneRsl', 's', 'present'] as const;
const STATIC_CHANNELS = ['x', 'y', 'headingRad', 'speedMps', 'present'] as const;
const KIND_DEFAULTS: Record<SimActor['kind'], CatalogId> = {
  vehicle: 'vehicle.sedan',
  car: 'vehicle.sedan',
  truck: 'vehicle.box_truck',
  bus: 'vehicle.bus',
  van: 'vehicle.van',
  motorcycle: 'vehicle.motorcycle',
  bicycle: 'vehicle.bicycle',
  pedestrian: 'pedestrian.adult',
  scooter: 'vehicle.bicycle',
  sidewalk_robot: 'sidewalk_robot.delivery_rover',
  drone: 'drone.camera_quadcopter',
  animal: 'animal.dog',
  static_object: 'hazard.cardboard_box',
};

export function defaultCatalogIdForActorKind(kind: SimActor['kind']): CatalogId {
  return KIND_DEFAULTS[kind];
}

/** Resolve the render catalog identity shared by native traces and replay adapters. */
export function resolvePlaybackCatalogId(
  kind: SimActor['kind'],
  explicit?: string | null,
): { readonly catalogId: CatalogId; readonly modelBasis: PlaybackActor['modelBasis'] } | null {
  const candidate = explicit ?? defaultCatalogIdForActorKind(kind);
  if (!isCatalogId(candidate)) return null;
  getEntry(candidate);
  return {
    catalogId: candidate,
    modelBasis: explicit ? 'input-tag' : 'kind-default',
  };
}

export interface PlaybackSource {
  readonly instanceName: string;
  readonly traceName: string;
}

export interface ConcreteInstance {
  readonly kind: 'scenario-instance';
  readonly version: 1;
  /** Exact catalog reservation/attempt closure, when this is a catalog artifact. */
  readonly catalogSlot?: unknown;
  readonly manifest: {
    readonly instanceId: string;
    readonly inputHash: string;
    readonly replayKey: { readonly mapId: string; readonly engineGraphDigest?: string };
    readonly actors: Array<{ readonly id: string }>;
    readonly [key: string]: unknown;
  };
  readonly input: SimScenarioInput;
}

export interface PlaybackActor {
  readonly id: string;
  /** Original OpenSCENARIO entity identity, when playback came from XOSC evidence. */
  readonly entityName?: string;
  readonly kind: SimActor['kind'];
  readonly static: boolean;
  readonly tags: readonly string[];
  readonly catalogId: CatalogId;
  readonly modelBasis: 'input-tag' | 'kind-default';
  readonly bodyColor?: string;
  readonly dims: Dims;
  readonly initial: { readonly x: number; readonly z: number; readonly headingRad: number };
}

export interface PlaybackProp extends Omit<StaticProp, 'catalogId'> {
  readonly catalogId: CatalogId;
}

export interface PlaybackBundle {
  readonly instance: ConcreteInstance;
  readonly trace: SceneTrace;
  readonly actors: readonly PlaybackActor[];
  readonly props: readonly PlaybackProp[];
  readonly signals: readonly PlaybackSignal[];
  readonly source: PlaybackSource;
  /** Shared, byte-semantic catalog closure after instance/trace equality validation. */
  readonly catalogSlot?: unknown;
  readonly startTime: number;
  readonly endTime: number;
  /** Derived background-traffic provenance; absent for imported legacy evidence. */
  readonly ambientTraffic?: AmbientTrafficProvenance;
  /** Exact static-map proxy build used by editable simulation. */
  readonly mapCollisions?: {
    readonly digest: string;
    readonly status: 'ready' | 'unavailable' | 'skipped';
    readonly warning?: string;
    readonly accepted: number;
    readonly rejectedRoadOverlap: number;
    readonly classes: Readonly<Record<string, number>>;
  };
  /** Immutable export evidence produced from the same input, graph and trace. */
  /** Product/local export evidence is carried through without coupling playback to an adapter UI. */
  readonly openScenario?: OpenScenarioSnapshot;
}

/** Versioned identity for the one canonical full-duration preview/play result. */
export interface CanonicalPreviewIdentity {
  readonly contractVersion: 1;
  readonly inputHash: string;
  readonly traceInputHash: string;
  readonly traceHash: string;
  readonly engineVersion: string;
  readonly traceVersion: number;
  readonly samples: number;
  readonly endTimeS: number;
  readonly complete: boolean;
  readonly hashBound: boolean;
}

export function canonicalPreviewIdentity(bundle: Pick<PlaybackBundle, 'instance' | 'trace'>): CanonicalPreviewIdentity {
  const endTimeS = bundle.trace.ticks.t.at(-1) ?? 0;
  const inputHash = bundle.trace.header.source === 'openscenario-replay'
    ? bundle.trace.header.inputHash
    : contentHash(bundle.instance.input);
  return {
    contractVersion: 1,
    inputHash,
    traceInputHash: bundle.trace.header.inputHash,
    traceHash: contentHash(bundle.trace),
    engineVersion: bundle.trace.header.engineVersion,
    traceVersion: bundle.trace.header.traceVersion,
    samples: bundle.trace.ticks.t.length,
    endTimeS,
    complete: endTimeS >= bundle.instance.input.clipSeconds - bundle.instance.input.dt / 2,
    hashBound: bundle.trace.header.inputHash === inputHash,
  };
}

export function canonicalPreviewParity(
  preview: Pick<PlaybackBundle, 'instance' | 'trace'>,
  playback: Pick<PlaybackBundle, 'instance' | 'trace'>,
): { readonly ok: boolean; readonly preview: CanonicalPreviewIdentity; readonly playback: CanonicalPreviewIdentity } {
  const a = canonicalPreviewIdentity(preview);
  const b = canonicalPreviewIdentity(playback);
  return {
    ok: a.complete && b.complete && a.hashBound && b.hashBound
      && a.inputHash === b.inputHash && a.traceHash === b.traceHash,
    preview: a,
    playback: b,
  };
}

export interface PlaybackSignal {
  readonly id: string;
  readonly headIds: readonly string[];
  readonly timingSource: 'map' | 'synthetic-default' | 'authored' | 'unbound';
}

export interface PlaybackFile {
  readonly name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SampledActor {
  readonly id: string;
  readonly catalogId: CatalogId;
  readonly dims: Dims;
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly present: boolean;
  readonly static: boolean;
  /** Body motion direction; reverse motion must not be presented by flipping heading. */
  readonly motionDirection: -1 | 1;
  /**
   * 0 while on its feet, rising to 1 over `KNOCKDOWN_FALL_S` after `downSinceS`.
   *
   * Optional so a consumer hand-building a sampled actor for a test need not
   * declare a presentation field with an obvious default. The sampler always
   * sets it, and every reader treats absence as upright.
   */
  readonly downProgress?: number;
}

export interface SampledSignal extends PlaybackSignal {
  readonly phase: ControlIndication;
}

/** One import failure with all repairable findings, rather than the first opaque throw. */
export class PlaybackLoadError extends Error {
  readonly diagnostics: readonly string[];

  constructor(summary: string, diagnostics: readonly string[]) {
    super(`${summary}:\n${diagnostics.map((item) => `• ${item}`).join('\n')}`);
    this.name = 'PlaybackLoadError';
    this.diagnostics = diagnostics;
  }
}

/** Read a concrete instance and either canonical JSON or gzip trace bytes. */
export async function readPlaybackFiles(
  instanceFile: PlaybackFile,
  traceFile: PlaybackFile,
): Promise<PlaybackBundle> {
  let instanceValue: unknown;
  try {
    const text = new TextDecoder().decode(await instanceFile.arrayBuffer());
    instanceValue = JSON.parse(text);
  } catch (error) {
    throw new PlaybackLoadError(`Could not read instance “${instanceFile.name}”`, [
      `instance JSON is invalid: ${messageOf(error)}`,
      'Choose a concrete *.instance.json file produced by uniscenarios instantiate.',
    ]);
  }

  let traceValue: unknown;
  try {
    const bytes = new Uint8Array(await traceFile.arrayBuffer());
    traceValue = await decodeTraceGz(bytes);
  } catch (error) {
    throw new PlaybackLoadError(`Could not read trace “${traceFile.name}”`, [
      `trace is neither valid plain JSON nor gzip JSON: ${messageOf(error)}`,
      'Choose the matching *.trace.json or *.trace.json.gz file produced by uniscenarios simulate.',
    ]);
  }

  return parsePlaybackPair(instanceValue, traceValue, {
    instanceName: instanceFile.name,
    traceName: traceFile.name,
  });
}

/** Strictly join one concrete instance to the exact trace produced from its input. */
export function parsePlaybackPair(
  instanceValue: unknown,
  traceValue: unknown,
  source: PlaybackSource = { instanceName: 'instance', traceName: 'trace' },
): PlaybackBundle {
  const issues: string[] = [];
  const raw = objectOf(instanceValue);
  if (!raw) {
    throw new PlaybackLoadError('Scenario import failed', [
      `${source.instanceName}: document root must be an object`,
    ]);
  }
  if (raw['kind'] !== 'scenario-instance') {
    issues.push(`${source.instanceName}: kind must be "scenario-instance" (templates and editor autosaves cannot be played)`);
  }
  if (raw['version'] !== 1) issues.push(`${source.instanceName}: version must be 1; got ${String(raw['version'])}`);

  const parsedInput = safeParseSimScenarioInput(raw['input']);
  if (!parsedInput.ok) {
    for (const issue of parsedInput.issues) {
      issues.push(`${source.instanceName}: input.${issue.path || '<root>'}: ${issue.message}`);
    }
  }
  const manifest = objectOf(raw['manifest']);
  if (!manifest) issues.push(`${source.instanceName}: manifest is missing`);

  if (!parsedInput.ok || !manifest) {
    throw new PlaybackLoadError('Scenario import failed', issues);
  }
  const input = parsedInput.value;
  const recomputedHash = contentHash(input);
  const manifestHash = manifest['inputHash'];
  if (manifestHash !== recomputedHash) {
    issues.push(
      `${source.instanceName}: manifest.inputHash ${display(manifestHash)} does not match recomputed input hash ${recomputedHash}`,
    );
  }
  const instanceId = manifest['instanceId'];
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    issues.push(`${source.instanceName}: manifest.instanceId is missing`);
  }

  const replayKey = objectOf(manifest['replayKey']);
  const replayMapId = replayKey?.['mapId'];
  if (replayMapId !== input.mapId) {
    issues.push(
      `${source.instanceName}: manifest.replayKey.mapId ${display(replayMapId)} does not match input.mapId ${input.mapId}`,
    );
  }

  const trace = validateTrace(traceValue, source.traceName, issues);
  if (trace) {
    if (trace.header.inputHash !== recomputedHash) {
      issues.push(
        `${source.traceName}: header.inputHash ${display(trace.header.inputHash)} does not match instance input hash ${recomputedHash}`,
      );
    }
    if (trace.header.mapId !== input.mapId) {
      issues.push(
        `${source.traceName}: header.mapId ${display(trace.header.mapId)} does not match instance input.mapId ${input.mapId}`,
      );
    }
    for (const field of ['clipSeconds', 'warmupSeconds', 'dt'] as const) {
      if (trace.header[field] !== input[field]) {
        issues.push(
          `${source.traceName}: header.${field} ${display(trace.header[field])} does not match instance input.${field} ${input[field]}`,
        );
      }
    }
    const replayGraph = replayKey?.['engineGraphDigest'];
    if (typeof replayGraph === 'string' && trace.header.engineGraphDigest !== replayGraph) {
      issues.push(
        `${source.traceName}: header.engineGraphDigest does not match manifest.replayKey.engineGraphDigest`,
      );
    }
    if (typeof replayGraph === 'string' && trace.header.topologyDigest !== replayGraph) {
      issues.push(
        `${source.traceName}: header.topologyDigest does not match manifest.replayKey.engineGraphDigest`,
      );
    }
    if (contentHash(trace.header.operationalConditions) !== contentHash(input.operationalConditions)) {
      issues.push(
        `${source.traceName}: header.operationalConditions does not exactly match instance input.operationalConditions`,
      );
    }
    validateActorIdentity(input, manifest, trace, source, issues);
    validateCatalogSlotIdentity(
      raw['catalogSlot'],
      trace.header.catalogSlot,
      manifest,
      input.mapId,
      input.operationalConditions,
      source,
      issues,
    );
    validatePropIdentity(input, trace, source, issues);
    validateTracks(input, trace, source.traceName, issues);
    validateSignalTracks(input, trace, source.traceName, issues);
  }

  const actors = mapPlaybackActors(input.actors, source.instanceName, issues);
  const props = mapPlaybackProps(input.props, source.instanceName, issues);
  const signals = mapPlaybackSignals(input, source.instanceName, issues);
  if (issues.length > 0 || !trace) throw new PlaybackLoadError('Scenario/trace identity validation failed', issues);

  const times = trace.ticks.t;
  const concreteManifest = manifest as ConcreteInstance['manifest'];
  return {
    instance: {
      kind: 'scenario-instance',
      version: 1,
      ...(raw['catalogSlot'] === undefined ? {} : { catalogSlot: raw['catalogSlot'] }),
      manifest: concreteManifest,
      input,
    },
    trace: traceToSceneFrame(trace),
    actors,
    props,
    signals,
    source,
    ...(raw['catalogSlot'] === undefined ? {} : { catalogSlot: raw['catalogSlot'] }),
    startTime: times[0] as number,
    endTime: times[times.length - 1] as number,
  };
}

function validateCatalogSlotIdentity(
  instanceSlot: unknown,
  traceSlot: unknown,
  manifest: Record<string, unknown>,
  mapId: string,
  inputConditions: unknown,
  source: PlaybackSource,
  issues: string[],
): void {
  if (instanceSlot === undefined && traceSlot === undefined) return;
  if (instanceSlot === undefined) {
    issues.push(`${source.instanceName}: catalogSlot is missing but the trace carries catalog provenance`);
    return;
  }
  if (traceSlot === undefined) {
    issues.push(`${source.traceName}: header.catalogSlot is missing but the instance carries catalog provenance`);
    return;
  }
  const slot = objectOf(instanceSlot);
  if (!slot) {
    issues.push(`${source.instanceName}: catalogSlot must be an object`);
    return;
  }
  if (slot['mapId'] !== mapId) {
    issues.push(`${source.instanceName}: catalogSlot.mapId ${display(slot['mapId'])} does not match input.mapId ${mapId}`);
  }
  if (typeof slot['identity'] !== 'string' || slot['identity'].length === 0) {
    issues.push(`${source.instanceName}: catalogSlot.identity is missing`);
  }
  if (contentHash(instanceSlot) !== contentHash(traceSlot)) {
    issues.push(`${source.traceName}: header.catalogSlot does not exactly match the instance catalogSlot closure`);
  }

  const replayKey = objectOf(manifest['replayKey']);
  const provenance = objectOf(slot['provenance']);
  const variant = objectOf(slot['variant']);
  const joins: Array<readonly [string, unknown, unknown]> = [
    ['selectedMatcherSiteId', slot['selectedMatcherSiteId'], replayKey?.['siteId']],
    ['attemptSeed', slot['attemptSeed'], replayKey?.['paramSeed']],
    ['templateId', slot['templateId'], replayKey?.['templateId']],
    ['provenance.matcherIndexDigest', provenance?.['matcherIndexDigest'], replayKey?.['matcherIndexDigest']],
    ['provenance.engineGraphDigest', provenance?.['engineGraphDigest'], replayKey?.['engineGraphDigest']],
    ['provenance.templateDigest', provenance?.['templateDigest'], replayKey?.['templateDigest']],
  ];
  for (const [path, actual, expected] of joins) {
    if (typeof expected !== 'string' || expected.length === 0 || actual !== expected) {
      issues.push(
        `${source.instanceName}: catalogSlot.${path} ${display(actual)} does not match manifest.replayKey value ${display(expected)}`,
      );
    }
  }
  for (const path of ['seed', 'attemptSeed', 'designDigest'] as const) {
    if (typeof slot[path] !== 'string' || !/^[0-9a-f]{64}$/.test(slot[path])) {
      issues.push(`${source.instanceName}: catalogSlot.${path} must be a 64-character lowercase SHA-256 digest`);
    }
  }
  for (const path of ['selectedLocationId', 'selectedMatcherSiteId', 'templateId'] as const) {
    if (typeof slot[path] !== 'string' || slot[path].length === 0) {
      issues.push(`${source.instanceName}: catalogSlot.${path} is missing`);
    }
  }
  if (!provenance) issues.push(`${source.instanceName}: catalogSlot.provenance is missing`);
  if (!variant || typeof variant['id'] !== 'string' || variant['id'].length === 0) {
    issues.push(`${source.instanceName}: catalogSlot.variant.id is missing`);
  }

  const operationalVariant = objectOf(manifest['operationalVariant']);
  if (!operationalVariant) {
    issues.push(`${source.instanceName}: manifest.operationalVariant is required for catalog playback`);
  } else {
    const { concrete, ...variantSource } = operationalVariant;
    if (contentHash(variantSource) !== contentHash(variant)) {
      issues.push(
        `${source.instanceName}: manifest.operationalVariant source fields do not exactly match catalogSlot.variant`,
      );
    }
    if (contentHash(concrete) !== contentHash(inputConditions)) {
      issues.push(
        `${source.instanceName}: manifest.operationalVariant.concrete does not exactly match input.operationalConditions`,
      );
    }
  }
}

function validatePropIdentity(
  input: SimScenarioInput,
  trace: SimTrace,
  source: PlaybackSource,
  issues: string[],
): void {
  const inputIds = input.props.map((prop) => prop.id).sort();
  const metadata = trace.header.propMetadata;
  if (!metadata) {
    if (inputIds.length > 0) issues.push(`${source.traceName}: header.propMetadata is missing for authored props`);
    return;
  }
  const metadataIds = Object.keys(metadata).sort();
  compareIds(inputIds, metadataIds, 'instance props', 'trace prop metadata', issues);
  for (const prop of input.props) {
    const traced = metadata[prop.id];
    if (traced && contentHash(traced) !== contentHash(prop)) {
      issues.push(`${source.traceName}: prop metadata for ${prop.id} does not match instance input`);
    }
  }
}

function validateSignalTracks(
  input: SimScenarioInput,
  trace: SimTrace,
  name: string,
  issues: string[],
): void {
  const expected = input.signalPrograms.map((program) => program.id).sort();
  const actual = Object.keys(trace.ticks.signals ?? {}).sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    issues.push(`signal program ids differ: instance input=[${expected.join(',')}] trace tracks=[${actual.join(',')}]`);
  }
  for (const id of expected) {
    const phases = trace.ticks.signals?.[id]?.phase;
    if (!Array.isArray(phases) || phases.length !== trace.ticks.t.length) {
      issues.push(
        `${name}: ticks.signals.${id}.phase length ${Array.isArray(phases) ? phases.length : 'missing'} does not match ticks.t length ${trace.ticks.t.length}`,
      );
      continue;
    }
    if (phases.some((phase) => !CONTROL_INDICATIONS.includes(phase as (typeof CONTROL_INDICATIONS)[number]))) {
      issues.push(`${name}: ticks.signals.${id}.phase contains an unknown phase`);
    }
  }
}

function mapPlaybackSignals(
  input: SimScenarioInput,
  name: string,
  issues: string[],
): PlaybackSignal[] {
  const claimedHeads = new Set<string>();
  return input.signalPrograms.map((program) => {
    const headIds = program.mapBinding?.headIds ?? [];
    for (const headId of headIds) {
      if (claimedHeads.has(headId)) issues.push(`${name}: physical signal head ${headId} is bound by multiple programs`);
      claimedHeads.add(headId);
    }
    return {
      id: program.id,
      headIds,
      timingSource: program.mapBinding?.timingSource ?? 'unbound',
    };
  });
}

function validateTrace(value: unknown, name: string, issues: string[]): SimTrace | null {
  const trace = objectOf(value);
  const header = objectOf(trace?.['header']);
  const ticks = objectOf(trace?.['ticks']);
  const actors = objectOf(ticks?.['actors']);
  const times = ticks?.['t'];
  if (!trace) issues.push(`${name}: trace root must be an object`);
  if (!header) issues.push(`${name}: header is missing`);
  if (!ticks) issues.push(`${name}: ticks is missing`);
  if (!actors) issues.push(`${name}: ticks.actors is missing`);
  if (!Array.isArray(times) || times.length === 0) {
    issues.push(`${name}: ticks.t must be a non-empty array`);
  } else {
    for (let index = 0; index < times.length; index++) {
      if (!Number.isFinite(times[index])) issues.push(`${name}: ticks.t.${index} must be finite`);
      if (index > 0 && Number(times[index]) <= Number(times[index - 1])) {
        issues.push(`${name}: ticks.t must be strictly increasing (index ${index})`);
        break;
      }
    }
  }
  if (header) {
    // v1 through v3 are immutable replay/evidence formats. New traces write v4,
    // but saved campaigns and imported verified bundles remain readable.
    if (!isReadableTraceFormatVersion(header['traceVersion'])) {
      issues.push(`${name}: header.traceVersion must be one of ${READABLE_TRACE_FORMAT_VERSIONS.join(', ')} (current ${TRACE_FORMAT_VERSION}); got ${display(header['traceVersion'])}`);
    }
    if (header['frame'] !== 'xodr-local') {
      issues.push(`${name}: header.frame must be "xodr-local"; got ${display(header['frame'])}`);
    }
    for (const key of ['inputHash', 'mapId', 'engineGraphDigest'] as const) {
      if (typeof header[key] !== 'string' || header[key].length === 0) {
        issues.push(`${name}: header.${key} is missing`);
      }
    }
    if (!Array.isArray(header['actorIds'])) issues.push(`${name}: header.actorIds must be an array`);
  }
  return trace && header && ticks && actors && Array.isArray(times) && times.length > 0
    ? (value as SimTrace)
    : null;
}

function validateActorIdentity(
  input: SimScenarioInput,
  manifest: Record<string, unknown>,
  trace: SimTrace,
  source: PlaybackSource,
  issues: string[],
): void {
  const inputIds = sortedIds(input.actors.map((actor) => actor.id), `${source.instanceName}: input actor ids`, issues);
  const manifestActors = manifest['actors'];
  const manifestIds = Array.isArray(manifestActors)
    ? sortedIds(manifestActors.map((actor) => objectOf(actor)?.['id']), `${source.instanceName}: manifest actor ids`, issues)
    : (issues.push(`${source.instanceName}: manifest.actors must be an array`), []);
  const headerIds = sortedIds(trace.header.actorIds, `${source.traceName}: header actor ids`, issues);
  const trackIds = Object.keys(trace.ticks.actors).sort();
  compareIds(inputIds, manifestIds, 'instance input', 'manifest', issues);
  compareIds(inputIds, headerIds, 'instance input', 'trace header', issues);
  compareIds(inputIds, trackIds, 'instance input', 'trace tracks', issues);
  if (trace.header.actorMetadata) {
    const metadataIds = Object.keys(trace.header.actorMetadata).sort();
    compareIds(inputIds, metadataIds, 'instance input', 'trace actor metadata', issues);
    for (const actor of input.actors) {
      const metadata = trace.header.actorMetadata[actor.id];
      if (!metadata) continue;
      if (metadata.kind !== actor.kind) {
        issues.push(`${source.traceName}: actor metadata kind for ${actor.id} does not match instance input`);
      }
      if (metadata.static !== actor.static) {
        issues.push(`${source.traceName}: actor metadata static flag for ${actor.id} does not match instance input`);
      }
      if (
        metadata.dims.l !== actor.dims.l ||
        metadata.dims.w !== actor.dims.w ||
        metadata.dims.h !== actor.dims.h
      ) {
        issues.push(`${source.traceName}: actor metadata dimensions for ${actor.id} do not match instance input`);
      }
    }
  }
  if (inputIds.length === 0) issues.push(`${source.instanceName}: input carries zero actors; playback requires at least one`);
}

function validateTracks(
  input: SimScenarioInput,
  trace: SimTrace,
  name: string,
  issues: string[],
): void {
  const count = trace.ticks.t.length;
  for (const actor of input.actors) {
    const track = trace.ticks.actors[actor.id] as unknown as Record<string, unknown> | undefined;
    if (!track) {
      issues.push(`${name}: ticks.actors.${actor.id} is missing`);
      continue;
    }
    for (const channel of TRACE_CHANNELS) {
      const values = track[channel];
      if (!Array.isArray(values) || values.length !== count) {
        issues.push(
          `${name}: ticks.actors.${actor.id}.${channel} length ${Array.isArray(values) ? values.length : 'missing'} does not match ticks.t length ${count}`,
        );
        continue;
      }
      if (channel !== 'laneRsl' && values.some((value) => !Number.isFinite(value))) {
        issues.push(`${name}: ticks.actors.${actor.id}.${channel} contains a non-finite value`);
      }
    }
    const lateralOffset = track['lateralOffsetM'];
    if (lateralOffset === undefined
      && isReadableTraceFormatVersion(trace.header.traceVersion)
      && trace.header.traceVersion < LATERAL_OFFSET_TRACE_VERSION) {
      // v1-v3 did not define this channel; scene conversion synthesizes zeros.
    } else if (!Array.isArray(lateralOffset) || lateralOffset.length !== count) {
      issues.push(
        `${name}: ticks.actors.${actor.id}.lateralOffsetM length ${Array.isArray(lateralOffset) ? lateralOffset.length : 'missing'} does not match ticks.t length ${count}`,
      );
    } else if (lateralOffset.some((value) => !Number.isFinite(value))) {
      issues.push(`${name}: ticks.actors.${actor.id}.lateralOffsetM contains a non-finite value`);
    }
    const motionDirection = track['motionDirection'];
    if (motionDirection !== undefined) {
      if (!Array.isArray(motionDirection) || motionDirection.length !== count) {
        issues.push(
          `${name}: ticks.actors.${actor.id}.motionDirection length ${Array.isArray(motionDirection) ? motionDirection.length : 'invalid'} does not match ticks.t length ${count}`,
        );
      } else if (motionDirection.some((value) => value !== -1 && value !== 1)) {
        issues.push(`${name}: ticks.actors.${actor.id}.motionDirection must contain only -1 or 1`);
      }
    }
    if (actor.static) {
      for (const channel of STATIC_CHANNELS) {
        const values = track[channel];
        if (Array.isArray(values) && values.length > 0 && values.some((value) => !Object.is(value, values[0]))) {
          issues.push(`${name}: static actor ${actor.id} changes in channel ${channel}`);
        }
      }
      const x = Array.isArray(track['x']) ? Number(track['x'][0]) : Number.NaN;
      const z = Array.isArray(track['y']) ? -Number(track['y'][0]) : Number.NaN;
      const heading = Array.isArray(track['headingRad']) ? Number(track['headingRad'][0]) : Number.NaN;
      if (
        Number.isFinite(x) && Number.isFinite(z) &&
        Math.hypot(x - actor.initial.pose.x, z - actor.initial.pose.z) > 0.001
      ) {
        issues.push(`${name}: static actor ${actor.id} trace pose does not match its instance initial pose`);
      }
      if (Number.isFinite(heading) && Math.abs(angleDelta(heading, actor.initial.pose.headingRad)) > 0.0001) {
        issues.push(`${name}: static actor ${actor.id} trace heading does not match its instance initial heading`);
      }
    }
  }
}

function mapPlaybackActors(
  inputActors: readonly SimActor[],
  name: string,
  issues: string[],
): PlaybackActor[] {
  const actors: PlaybackActor[] = [];
  for (const actor of inputActors) {
    const catalogTags = actor.tags.filter((tag) => tag.startsWith('catalog:'));
    if (catalogTags.length > 1) {
      issues.push(`${name}: actor ${actor.id} has multiple catalog:* tags (${catalogTags.join(', ')})`);
      continue;
    }
    const explicit = catalogTags[0]?.slice('catalog:'.length);
    const bodyColorTags = actor.tags.filter((tag) => tag.startsWith('studio:body-color:'));
    if (bodyColorTags.length > 1) {
      issues.push(`${name}: actor ${actor.id} has multiple studio:body-color:* tags`);
      continue;
    }
    const bodyColor = bodyColorTags[0]?.slice('studio:body-color:'.length);
    if (bodyColor && !/^#[0-9a-f]{6}$/i.test(bodyColor)) {
      issues.push(`${name}: actor ${actor.id} has invalid Studio body color ${display(bodyColor)}`);
      continue;
    }
    const visual = resolvePlaybackCatalogId(actor.kind, explicit);
    if (!visual) {
      issues.push(`${name}: actor ${actor.id} requests unknown Studio catalog model ${display(explicit)}`);
      continue;
    }
    actors.push({
      id: actor.id,
      kind: actor.kind,
      static: actor.static,
      tags: [...actor.tags],
      catalogId: visual.catalogId,
      modelBasis: visual.modelBasis,
      ...(bodyColor ? { bodyColor: bodyColor.toLowerCase() } : {}),
      dims: { l: actor.dims.l, w: actor.dims.w, h: actor.dims.h },
      initial: {
        x: actor.initial.pose.x,
        z: actor.initial.pose.z,
        headingRad: actor.initial.pose.headingRad,
      },
    });
  }
  return actors;
}

function mapPlaybackProps(
  inputProps: readonly StaticProp[],
  name: string,
  issues: string[],
): PlaybackProp[] {
  const props: PlaybackProp[] = [];
  for (const prop of inputProps) {
    if (!isCatalogId(prop.catalogId)) {
      issues.push(`${name}: prop ${prop.id} requests unknown Studio catalog model ${display(prop.catalogId)}`);
      continue;
    }
    getEntry(prop.catalogId);
    props.push({ ...prop, catalogId: prop.catalogId });
  }
  return props;
}

export interface SampleBracket {
  readonly lower: number;
  readonly upper: number;
  readonly alpha: number;
  readonly time: number;
}

/** Binary-search the trace and return the two samples surrounding `time`. */
export function sampleBracket(times: readonly number[], time: number): SampleBracket {
  if (times.length === 0) throw new Error('cannot sample an empty trace');
  const clamped = Math.max(times[0] as number, Math.min(times[times.length - 1] as number, time));
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((times[mid] as number) < clamped) lo = mid + 1;
    else hi = mid;
  }
  const upper = lo;
  if ((times[upper] as number) === clamped || upper === 0) {
    return { lower: upper, upper, alpha: 0, time: clamped };
  }
  const lower = upper - 1;
  const span = (times[upper] as number) - (times[lower] as number);
  return { lower, upper, alpha: (clamped - (times[lower] as number)) / span, time: clamped };
}

const collisionTimesByTrace = new WeakMap<SceneTrace, ReadonlyMap<string, readonly number[]>>();

function collisionTimes(trace: SceneTrace): ReadonlyMap<string, readonly number[]> {
  const cached = collisionTimesByTrace.get(trace);
  if (cached) return cached;
  const byActor = new Map<string, number[]>();
  for (const event of trace.events) {
    if (event.kind !== 'collision') continue;
    for (const actorId of [event.a, event.b]) {
      const times = byActor.get(actorId);
      if (times) times.push(event.t);
      else byActor.set(actorId, [event.t]);
    }
  }
  for (const times of byActor.values()) times.sort((a, b) => a - b);
  collisionTimesByTrace.set(trace, byActor);
  return byActor;
}

function hasCollisionBetween(times: readonly number[] | undefined, after: number, through: number): boolean {
  if (!times?.length) return false;
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle]! <= after) low = middle + 1;
    else high = middle;
  }
  return low < times.length && times[low]! <= through;
}

/**
 * How long a body takes to go from upright to flat, in seconds.
 *
 * Presentation only: the engine's state is binary from `downSinceS` onward, and
 * this is the ramp a renderer plays over it. Roughly a real fall from standing.
 */
export const KNOCKDOWN_FALL_S = 0.45;

/**
 * Fall progress at `time`, 0 upright and 1 flat.
 *
 * Monotonic and derived purely from the recorded timestamp, so scrubbing
 * backwards through the clip stands the body back up exactly where it fell.
 */
export function knockdownProgress(downSinceS: number | undefined, time: number): number {
  if (downSinceS == null || time < downSinceS) return 0;
  return Math.min(1, (time - downSinceS) / KNOCKDOWN_FALL_S);
}

/** Interpolate dynamic poses; static actors always retain their authored instance pose. */
export function samplePlaybackActors(bundle: PlaybackBundle, time: number): SampledActor[] {
  const bracket = sampleBracket(bundle.trace.ticks.t, time);
  const collisions = collisionTimes(bundle.trace);
  return bundle.actors.map((actor) => {
    const track = bundle.trace.ticks.actors[actor.id];
    if (!track) throw new Error(`validated trace lost actor track ${actor.id}`);
    const present = Number(track.present[bracket.lower]) !== 0;
    const motionDirection = track.motionDirection?.[bracket.lower] ?? 1;
    if (actor.static) {
      return {
        id: actor.id,
        catalogId: actor.catalogId,
        dims: actor.dims,
        x: actor.initial.x,
        z: actor.initial.z,
        headingRad: actor.initial.headingRad,
        speedMps: 0,
        present,
        static: true,
        motionDirection,
      };
    }
    // Presence changes and collision response are discontinuities. Holding the
    // preceding physical sample until the exact event boundary prevents a
    // visual pose that the deterministic simulation never occupied.
    const discontinuous = track.present[bracket.lower] !== track.present[bracket.upper]
      || hasCollisionBetween(
        collisions.get(actor.id),
        bundle.trace.ticks.t[bracket.lower] as number,
        bundle.trace.ticks.t[bracket.upper] as number,
      );
    const alpha = discontinuous && bracket.alpha < 1 ? 0 : bracket.alpha;
    return {
      id: actor.id,
      catalogId: actor.catalogId,
      dims: actor.dims,
      x: lerp(track.x[bracket.lower] as number, track.x[bracket.upper] as number, alpha),
      z: lerp(track.z[bracket.lower] as number, track.z[bracket.upper] as number, alpha),
      headingRad: lerpHeading(
        track.headingRad[bracket.lower] as number,
        track.headingRad[bracket.upper] as number,
        alpha,
      ),
      speedMps: lerp(
        track.speedMps[bracket.lower] as number,
        track.speedMps[bracket.upper] as number,
        alpha,
      ),
      present,
      static: false,
      motionDirection,
      downProgress: knockdownProgress(track.downSinceS, time),
    };
  });
}

/** Sample discrete signal phases at the same trace bracket as actor transforms. */
export function samplePlaybackSignals(bundle: PlaybackBundle, time: number): SampledSignal[] {
  const bracket = sampleBracket(bundle.trace.ticks.t, time);
  return bundle.signals.map((signal) => {
    const phase = bundle.trace.ticks.signals?.[signal.id]?.phase[bracket.lower];
    if (!phase) throw new Error(`validated trace lost signal track ${signal.id}`);
    return { ...signal, phase };
  });
}

/** Evaluate physical signal-head states from the immutable program input. */
export function evaluatePlaybackSignalHeadStates(
  bundle: PlaybackBundle,
  time: number,
): Readonly<Record<string, ControlIndication>> {
  const input = bundle.instance.input;
  const book = new SignalBook(input.signalPrograms, input.warmupSeconds, input.roadControls);
  const headStates: Record<string, ControlIndication> = {};
  for (const signal of bundle.signals) {
    const phase = book.phaseAt(signal.id, time);
    if (!phase) throw new Error(`validated input lost signal program ${signal.id}`);
    for (const headId of signal.headIds) headStates[headId] = phase;
  }
  return headStates;
}

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function lerpHeading(a: number, b: number, alpha: number): number {
  return a + angleDelta(b, a) * alpha;
}

function sortedIds(values: readonly unknown[], label: string, issues: string[]): string[] {
  if (values.some((id) => typeof id !== 'string' || id.length === 0)) {
    issues.push(`${label} must contain only non-empty strings`);
  }
  const ids = values.filter((id): id is string => typeof id === 'string' && id.length > 0).sort();
  if (new Set(ids).size !== ids.length) issues.push(`${label} contains duplicates`);
  return ids;
}

function compareIds(
  expected: readonly string[],
  actual: readonly string[],
  expectedLabel: string,
  actualLabel: string,
  issues: string[],
): void {
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    issues.push(`actor ids differ: ${expectedLabel}=[${expected.join(',')}] ${actualLabel}=[${actual.join(',')}]`);
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function display(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value ?? '<missing>');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
