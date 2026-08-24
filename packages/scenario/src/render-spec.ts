/**
 * Renderer-neutral capture intent and its immutable resolution receipt.
 *
 * The editable contract names actor-mounted sensors by stable ids. Resolution
 * snapshots the physical sensor, authored environment, evidence digests, frame
 * schedule, and renderer capabilities so later rendering never dereferences a
 * mutable scenario or sensor-rig template.
 */

import { z } from 'zod';

import { canonicalize, deepFreeze } from './serialize.js';
import { EntityIdSchema } from './schema/v1.js';
import {
  EnvironmentSchema,
  WeatherSchema,
  type Environment,
} from './schema/v2/environment.js';
import {
  ActorSensorSchema,
  SensorMountSchema,
  type ActorSensor,
  type SensorMount,
} from './schema/v2/sensors.js';

export const RENDER_SPEC_V2_SCHEMA = 'uniscenario.render-spec/v2' as const;
export const RESOLVED_CAPTURE_MANIFEST_V1_SCHEMA = 'uniscenario.capture-manifest/v1' as const;
export const RENDER_SPEC_V3_SCHEMA = 'uniscenario.render-spec/v3' as const;

const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be lowercase hex sha-256');

export const CaptureSensorModalitySchema = z.enum([
  'rgb',
  'depth',
  'semantic',
  'instance',
]);

export const CaptureCapabilitySchema = z.enum([
  'sensor.rgb',
  'sensor.depth',
  'sensor.semantic',
  'sensor.instance',
  'artifact.video',
  'artifact.frames',
  'artifact.manifest',
  'artifact.trace',
  'artifact.annotations',
  'environment.authored',
  'timing.fixed_step',
]);

export const CaptureArtifactSchema = z.enum([
  'video',
  'frames',
  'manifest',
  'trace',
  'annotations',
]);

export const RenderSensorSourceSchema = z.strictObject({
  actorId: EntityIdSchema,
  sensorId: EntityIdSchema,
  modality: CaptureSensorModalitySchema.default('rgb'),
  /** Stable artifact stem. Labels are presentation-only and never identify a source. */
  outputName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(),
});

export const RenderClipSchema = z.strictObject({
  /** Inclusive source-playback time. */
  startSeconds: z.number().finite().min(0),
  /** Exclusive source-playback time. */
  endSeconds: z.number().finite().positive(),
}).check((ctx) => {
  if (ctx.value.endSeconds <= ctx.value.startSeconds) {
    ctx.issues.push({
      code: 'custom',
      message: 'endSeconds must be greater than startSeconds',
      path: ['endSeconds'],
      input: ctx.value.endSeconds,
    });
  }
});

export const RenderVideoSchema = z.strictObject({
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  fps: z.number().int().min(1).max(120),
  container: z.enum(['mp4', 'webm']),
  codec: z.enum(['h264', 'vp9', 'av1']),
  quality: z.enum(['draft', 'standard', 'high', 'lossless']),
  /** Optional encoder target. Adapters may reject it instead of silently clamping. */
  bitrateMbps: z.number().finite().positive().max(500).optional(),
}).check((ctx) => {
  const profile = `${ctx.value.container}+${ctx.value.codec}`;
  if (profile !== 'mp4+h264' && profile !== 'webm+vp9' && profile !== 'webm+av1') {
    ctx.issues.push({
      code: 'custom',
      message: 'supported codec profiles are mp4+h264, webm+vp9, and webm+av1',
      path: ['codec'],
      input: ctx.value.codec,
    });
  }
});

/** Exact numeric conditions used by the verified playback execution. */
export const ExecutedOperationalConditionsSchema = z.strictObject({
  weather: z.enum(['clear', 'rain', 'overcast']),
  timeOfDay: z.enum(['day', 'dusk', 'night', 'dawn']),
  traffic: z.enum(['light', 'moderate', 'heavy']),
  visibility: z.enum([
    'unrestricted',
    'reduced-contrast',
    'headlight-limited',
    'directional-glare',
    'dense-occlusion',
  ]),
  effects: z.strictObject({
    visibilityRangeM: z.number().finite().positive().max(10_000),
    frictionScale: z.number().finite().positive().min(0.1).max(1.2),
    trafficSpeedFactor: z.number().finite().positive().min(0.1).max(1.5),
  }),
});

export const ResolvedEnvironmentNumericsSchema = z.strictObject({
  frictionScale: z.number().finite().optional(),
  sunAzimuthDeg: z.number().finite().optional(),
  sunElevationDeg: z.number().finite().optional(),
  surfacePatches: z.array(z.strictObject({
    id: z.string().min(1).max(64),
    atM: z.number().finite(),
    lengthM: z.number().finite(),
    frictionScale: z.number().finite().optional(),
    edgeTaperM: z.number().finite(),
  })).max(8),
});

export const EnvironmentStateChangeSchema = z.discriminatedUnion('key', [
  z.strictObject({
    timeSeconds: z.number().finite().min(0),
    key: z.literal('env.weather'),
    value: WeatherSchema,
  }),
  z.strictObject({
    timeSeconds: z.number().finite().min(0),
    key: z.literal('env.frictionScale'),
    value: z.number().finite().min(0.1).max(1.2),
  }),
  z.strictObject({
    timeSeconds: z.number().finite().min(0),
    key: z.literal('env.fogDensity'),
    value: z.number().finite().min(0).max(1),
  }),
  z.strictObject({
    timeSeconds: z.number().finite().min(0),
    key: z.literal('env.rainIntensity'),
    value: z.number().finite().min(0).max(1),
  }),
]);

export const ResolvedEnvironmentProvenanceSchema = z.strictObject({
  source: z.literal('scenario-revision'),
  /** Exact authoring block bound to the immutable revision. */
  baseAuthoredEnvironment: EnvironmentSchema,
  /** Every authored numeric expression resolved to the value that executed. */
  resolvedNumerics: ResolvedEnvironmentNumericsSchema,
  operationalConditions: ExecutedOperationalConditionsSchema,
  /** Trace-order environment changes; equal timestamps preserve source order. */
  stateChanges: z.array(EnvironmentStateChangeSchema).max(256),
}).check((ctx) => {
  try {
    assertResolvedEnvironmentNumerics(ctx.value.baseAuthoredEnvironment, ctx.value.resolvedNumerics);
  } catch (error) {
    ctx.issues.push({
      code: 'custom',
      message: messageOf(error),
      path: ['resolvedNumerics'],
      input: ctx.value.resolvedNumerics,
    });
  }
  for (let index = 1; index < ctx.value.stateChanges.length; index++) {
    if (ctx.value.stateChanges[index]!.timeSeconds < ctx.value.stateChanges[index - 1]!.timeSeconds) {
      ctx.issues.push({
        code: 'custom',
        message: 'environment state changes must be ordered by timeSeconds',
        path: ['stateChanges', index, 'timeSeconds'],
        input: ctx.value.stateChanges[index]!.timeSeconds,
      });
    }
  }
});

export const CaptureCapabilityIntentSchema = z.strictObject({
  /** Missing required capabilities make the capture inadmissible. */
  required: z.array(CaptureCapabilitySchema).max(32).default([
    'artifact.video',
    'artifact.manifest',
    'environment.authored',
    'timing.fixed_step',
  ]),
  /** Missing preferred capabilities are recorded in provenance as warnings. */
  preferred: z.array(CaptureCapabilitySchema).max(32).default([]),
  fidelity: z.enum(['review', 'dataset']).default('review'),
}).check((ctx) => {
  const required = new Set<string>();
  ctx.value.required.forEach((capability, index) => {
    if (required.has(capability)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate required capability "${capability}"`,
        path: ['required', index],
        input: capability,
      });
    }
    required.add(capability);
  });
  const preferred = new Set<string>();
  ctx.value.preferred.forEach((capability, index) => {
    if (preferred.has(capability)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate preferred capability "${capability}"`,
        path: ['preferred', index],
        input: capability,
      });
    }
    if (required.has(capability)) {
      ctx.issues.push({
        code: 'custom',
        message: `capability "${capability}" cannot be both required and preferred`,
        path: ['preferred', index],
        input: capability,
      });
    }
    preferred.add(capability);
  });
});

/** One canonical author-facing render configuration for every renderer. */
export const RenderSpecV2Schema = z.strictObject({
  schema: z.literal(RENDER_SPEC_V2_SCHEMA),
  /** First release records exactly one actor-mounted image sensor. */
  sources: z.array(RenderSensorSourceSchema).length(1),
  clip: RenderClipSchema,
  video: RenderVideoSchema,
  artifacts: z.array(CaptureArtifactSchema).min(1).max(8).default(['video', 'manifest']),
  capabilityIntent: CaptureCapabilityIntentSchema.prefault({}),
  /**
   * Exact authored scenario environment, not a renderer-specific lowering.
   * It retains weather/time presets, sun angles, surface conditions, and
   * extensions so browser and managed adapters resolve the same intent.
   */
  authoredEnvironment: EnvironmentSchema,
}).check((ctx) => {
  const sourceKeys = new Set<string>();
  ctx.value.sources.forEach((source, index) => {
    const key = `${source.actorId}\u0000${source.sensorId}\u0000${source.modality}`;
    if (sourceKeys.has(key)) {
      ctx.issues.push({
        code: 'custom',
        message: 'duplicate actor/sensor/modality capture source',
        path: ['sources', index],
        input: source,
      });
    }
    sourceKeys.add(key);
  });
  const artifacts = new Set<string>();
  ctx.value.artifacts.forEach((artifact, index) => {
    if (artifacts.has(artifact)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate artifact "${artifact}"`,
        path: ['artifacts', index],
        input: artifact,
      });
    }
    artifacts.add(artifact);
  });
  if (!artifacts.has('video')) {
    ctx.issues.push({
      code: 'custom',
      message: 'render-spec/v2 requires a video artifact',
      path: ['artifacts'],
      input: ctx.value.artifacts,
    });
  }
});
export const RenderModalitySchema = z.enum([
  'rgb',
  'depth',
  'semantic',
  'instance',
  'lidar',
  'radar',
]);

export const RenderSourceTransformSchema = SensorMountSchema;

export const RenderCameraAttributesSchema = z.strictObject({
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  fps: z.number().finite().positive().max(240),
  horizontalFovDeg: z.number().finite().positive().max(180),
  nearM: z.number().finite().positive(),
  farM: z.number().finite().positive(),
}).check((ctx) => {
  if (ctx.value.farM <= ctx.value.nearM) {
    ctx.issues.push({
      code: 'custom',
      message: 'farM must be greater than nearM',
      path: ['farM'],
      input: ctx.value.farM,
    });
  }
});

export const RenderLidarAttributesSchema = z.strictObject({
  channels: z.number().int().min(1).max(256),
  rangeM: z.number().finite().positive().max(1_000),
  pointsPerSecond: z.number().int().positive(),
  rotationFrequencyHz: z.number().finite().positive().max(240),
  upperFovDeg: z.number().finite().min(-180).max(180),
  lowerFovDeg: z.number().finite().min(-180).max(180),
}).check((ctx) => {
  if (ctx.value.upperFovDeg <= ctx.value.lowerFovDeg) {
    ctx.issues.push({
      code: 'custom',
      message: 'upperFovDeg must be greater than lowerFovDeg',
      path: ['upperFovDeg'],
      input: ctx.value.upperFovDeg,
    });
  }
});

export const RenderRadarAttributesSchema = z.strictObject({
  horizontalFovDeg: z.number().finite().positive().max(180),
  verticalFovDeg: z.number().finite().positive().max(180),
  rangeM: z.number().finite().positive().max(1_000),
  pointsPerSecond: z.number().int().positive(),
});

const RenderSourceCommonShape = {
  actorId: EntityIdSchema,
  sensorId: EntityIdSchema,
  outputName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  transform: RenderSourceTransformSchema,
} as const;

export const RenderSourceV3Schema = z.discriminatedUnion('modality', [
  z.strictObject({
    ...RenderSourceCommonShape,
    modality: z.enum(['rgb', 'depth', 'semantic', 'instance']),
    attributes: RenderCameraAttributesSchema,
  }),
  z.strictObject({
    ...RenderSourceCommonShape,
    modality: z.literal('lidar'),
    attributes: RenderLidarAttributesSchema,
  }),
  z.strictObject({
    ...RenderSourceCommonShape,
    modality: z.literal('radar'),
    attributes: RenderRadarAttributesSchema,
  }),
]);

export const RenderArtifactV3Schema = z.enum([
  'video',
  'manifest',
  'frames',
  'sensorArchive',
  'annotations',
  'trace',
]);

export const RenderVideoV3Schema = z.strictObject({
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  fps: z.number().finite().positive().max(240),
  container: z.enum(['mp4', 'webm']),
  codec: z.enum(['h264', 'vp9', 'av1']),
  quality: z.enum(['draft', 'standard', 'high', 'lossless']),
}).check((ctx) => {
  const profile = `${ctx.value.container}+${ctx.value.codec}`;
  if (profile !== 'mp4+h264' && profile !== 'webm+vp9' && profile !== 'webm+av1') {
    ctx.issues.push({
      code: 'custom',
      message: 'supported codec profiles are mp4+h264, webm+vp9, and webm+av1',
      path: ['codec'],
      input: ctx.value.codec,
    });
  }
});

export const RenderCapabilityNameSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/, 'must be a namespaced capability');

export const RenderCapabilityIntentV3Schema = z.strictObject({
  required: z.array(RenderCapabilityNameSchema).max(64),
  preferred: z.array(RenderCapabilityNameSchema).max(64),
  fidelity: z.enum(['review', 'dataset']),
}).check((ctx) => {
  const required = new Set<string>();
  ctx.value.required.forEach((capability, index) => {
    if (required.has(capability)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate required capability "${capability}"`,
        path: ['required', index],
        input: capability,
      });
    }
    required.add(capability);
  });
  const preferred = new Set<string>();
  ctx.value.preferred.forEach((capability, index) => {
    if (preferred.has(capability)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate preferred capability "${capability}"`,
        path: ['preferred', index],
        input: capability,
      });
    }
    if (required.has(capability)) {
      ctx.issues.push({
        code: 'custom',
        message: `capability "${capability}" cannot be both required and preferred`,
        path: ['preferred', index],
        input: capability,
      });
    }
    preferred.add(capability);
  });
});

export const RenderSpecV3Schema = z.strictObject({
  schema: z.literal(RENDER_SPEC_V3_SCHEMA),
  sources: z.array(RenderSourceV3Schema).min(1).max(64),
  clip: RenderClipSchema,
  video: RenderVideoV3Schema.optional(),
  artifacts: z.array(RenderArtifactV3Schema).min(1).max(8),
  capabilityIntent: RenderCapabilityIntentV3Schema,
  authoredEnvironment: EnvironmentSchema,
}).check((ctx) => {
  const sourceKeys = new Set<string>();
  const outputNames = new Set<string>();
  ctx.value.sources.forEach((source, index) => {
    const key = `${source.actorId}\u0000${source.sensorId}\u0000${source.modality}`;
    if (sourceKeys.has(key)) {
      ctx.issues.push({
        code: 'custom',
        message: 'duplicate actor/sensor/modality capture source',
        path: ['sources', index],
        input: source,
      });
    }
    sourceKeys.add(key);
    if (outputNames.has(source.outputName)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate source outputName "${source.outputName}"`,
        path: ['sources', index, 'outputName'],
        input: source.outputName,
      });
    }
    outputNames.add(source.outputName);
  });
  const artifacts = new Set<string>();
  ctx.value.artifacts.forEach((artifact, index) => {
    if (artifacts.has(artifact)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate artifact "${artifact}"`,
        path: ['artifacts', index],
        input: artifact,
      });
    }
    artifacts.add(artifact);
  });
  if (!artifacts.has('manifest')) {
    ctx.issues.push({
      code: 'custom',
      message: 'render-spec/v3 requires a manifest artifact',
      path: ['artifacts'],
      input: ctx.value.artifacts,
    });
  }
  if (artifacts.has('video') !== (ctx.value.video !== undefined)) {
    ctx.issues.push({
      code: 'custom',
      message: 'video configuration must be present if and only if artifacts includes "video"',
      path: ctx.value.video === undefined ? ['video'] : ['artifacts'],
      input: ctx.value.video ?? ctx.value.artifacts,
    });
  }
});

const ResolvedCaptureSourceSchema = RenderSensorSourceSchema.extend({
  /** Full immutable physical-sensor snapshot from the bound revision. */
  sensor: ActorSensorSchema,
}).check((ctx) => {
  if (ctx.value.sensor.id !== ctx.value.sensorId) {
    ctx.issues.push({
      code: 'custom',
      message: 'sensor snapshot id does not match sensorId',
      path: ['sensor', 'id'],
      input: ctx.value.sensor.id,
    });
  }
  if (!sensorSupportsModality(ctx.value.sensor, ctx.value.modality)) {
    ctx.issues.push({
      code: 'custom',
      message: `sensor type "${ctx.value.sensor.type}" cannot provide modality "${ctx.value.modality}"`,
      path: ['modality'],
      input: ctx.value.modality,
    });
  }
});
const ResolvedCaptureSourceV3Schema = RenderSourceV3Schema.and(z.strictObject({
  sensor: ActorSensorSchema,
})).check((ctx) => {
  if (ctx.value.sensor.id !== ctx.value.sensorId) {
    ctx.issues.push({
      code: 'custom',
      message: 'sensor snapshot id does not match sensorId',
      path: ['sensor', 'id'],
      input: ctx.value.sensor.id,
    });
  }
  if (!sensorSupportsRenderModality(ctx.value.sensor, ctx.value.modality)) {
    ctx.issues.push({
      code: 'custom',
      message: `sensor type "${ctx.value.sensor.type}" cannot provide modality "${ctx.value.modality}"`,
      path: ['modality'],
      input: ctx.value.modality,
    });
  }
  if (!sameCanonicalValue(ctx.value.transform, ctx.value.sensor.mount)) {
    ctx.issues.push({
      code: 'custom',
      message: 'resolved source transform must match the immutable sensor mount',
      path: ['transform'],
      input: ctx.value.transform,
    });
  }
});

const AnyResolvedCaptureSourceSchema = z.union([
  ResolvedCaptureSourceSchema,
  ResolvedCaptureSourceV3Schema,
]);

export const ResolvedFrameScheduleSchema = z.strictObject({
  startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().positive(),
  fps: z.number().finite().positive().max(240),
  frameCount: z.number().int().positive(),
  timestampUnit: z.literal('microseconds'),
  firstTimestampUs: z.literal(0),
  /** Exclusive encoded-media boundary after the final frame. */
  endTimestampUs: z.number().int().positive(),
});

export const VerifiedPlaybackEvidenceSchema = z.strictObject({
  inputSha256: Sha256Schema,
  traceSha256: Sha256Schema,
  engineVersion: z.string().min(1).max(200),
  traceVersion: z.number().int().positive(),
  bounds: z.strictObject({
    startSeconds: z.number().finite().min(0),
    endSeconds: z.number().finite().positive(),
    verified: z.literal(true),
  }).check((ctx) => {
    if (ctx.value.endSeconds <= ctx.value.startSeconds) {
      ctx.issues.push({
        code: 'custom',
        message: 'verified playback endSeconds must be greater than startSeconds',
        path: ['endSeconds'],
        input: ctx.value.endSeconds,
      });
    }
  }),
  identity: z.strictObject({
    complete: z.literal(true),
    hashBound: z.literal(true),
  }),
});

/**
 * Which input the captured frames were rendered from. A browser capture either replays the
 * immutable OpenSCENARIO execution package the managed renderer also consumes, or the live editor
 * simulation when no package exists yet. The distinction is evidence, not decoration: only a
 * package-sourced recording can claim to be the same scenario bytes CARLA rendered, so it must
 * name the package and XOSC digests it verified.
 */
export const CaptureSourceProvenanceSchema = z.union([
  z.strictObject({ kind: z.literal('live-editor') }),
  z.strictObject({
    kind: z.literal('execution-package'),
    executionPackageId: z.string().min(1).max(200),
    executionPackageSha256: Sha256Schema,
    xoscSha256: Sha256Schema,
  }),
]);

export const ResolvedCaptureManifestSchema = z.strictObject({
  schema: z.literal(RESOLVED_CAPTURE_MANIFEST_V1_SCHEMA),
  createdAt: z.iso.datetime({ offset: true }),
  scenarioRevision: z.strictObject({
    id: z.string().min(1).max(200),
    contentSha256: Sha256Schema,
  }),
  playbackEvidence: VerifiedPlaybackEvidenceSchema,
  captureSource: CaptureSourceProvenanceSchema.optional(),
  mapEvidence: z.strictObject({
    mapId: z.string().min(1).max(200),
    xodrSha256: Sha256Schema.optional(),
    assetCatalogSha256: Sha256Schema.optional(),
  }),
  renderer: z.strictObject({
    id: z.string().min(1).max(200),
    version: z.string().min(1).max(200),
    availableCapabilities: z.array(RenderCapabilityNameSchema).max(64),
  }),
  renderSpec: z.union([RenderSpecV2Schema, RenderSpecV3Schema]),
  environmentProvenance: ResolvedEnvironmentProvenanceSchema,
  resolvedSources: z.array(AnyResolvedCaptureSourceSchema).min(1).max(64),
  schedule: ResolvedFrameScheduleSchema,
  capabilityResolution: z.strictObject({
    required: z.array(RenderCapabilityNameSchema).max(64),
    preferredApplied: z.array(RenderCapabilityNameSchema).max(64),
    preferredUnavailable: z.array(RenderCapabilityNameSchema).max(64),
    warnings: z.array(z.string().min(1).max(1000)).max(64).default([]),
  }),
}).check((ctx) => {
  const spec = ctx.value.renderSpec;
  const schedule = ctx.value.schedule;
  const playbackBounds = ctx.value.playbackEvidence.bounds;
  const scheduleFps = captureScheduleFps(spec);
  if (schedule.startSeconds !== spec.clip.startSeconds
    || schedule.endSeconds !== spec.clip.endSeconds
    || schedule.fps !== scheduleFps) {
    ctx.issues.push({
      code: 'custom',
      message: 'resolved frame schedule must match the render spec clip and fps',
      path: ['schedule'],
      input: schedule,
    });
  }
  const expectedFrames = fixedStepFrameCount(spec.clip.startSeconds, spec.clip.endSeconds, scheduleFps);
  const expectedEndTimestampUs = Math.round(expectedFrames * 1_000_000 / scheduleFps);
  if (schedule.frameCount !== expectedFrames || schedule.endTimestampUs !== expectedEndTimestampUs) {
    ctx.issues.push({
      code: 'custom',
      message: 'resolved frame schedule does not match the fixed-step timing contract',
      path: ['schedule', 'frameCount'],
      input: schedule.frameCount,
    });
  }
  if (spec.clip.startSeconds < playbackBounds.startSeconds
    || spec.clip.endSeconds > playbackBounds.endSeconds) {
    ctx.issues.push({
      code: 'custom',
      message: 'render clip must be contained by verified playback bounds',
      path: ['renderSpec', 'clip'],
      input: spec.clip,
    });
  }
  if (!sameCanonicalValue(
    spec.authoredEnvironment,
    ctx.value.environmentProvenance.baseAuthoredEnvironment,
  )) {
    ctx.issues.push({
      code: 'custom',
      message: 'render spec environment must match authoritative revision environment provenance',
      path: ['environmentProvenance', 'baseAuthoredEnvironment'],
      input: ctx.value.environmentProvenance.baseAuthoredEnvironment,
    });
  }
  ctx.value.environmentProvenance.stateChanges.forEach((change, index) => {
    if (change.timeSeconds < playbackBounds.startSeconds || change.timeSeconds > playbackBounds.endSeconds) {
      ctx.issues.push({
        code: 'custom',
        message: 'environment state change is outside verified playback bounds',
        path: ['environmentProvenance', 'stateChanges', index, 'timeSeconds'],
        input: change.timeSeconds,
      });
    }
  });
  if (ctx.value.resolvedSources.length !== spec.sources.length) {
    ctx.issues.push({
      code: 'custom',
      message: 'every render source must have exactly one resolved sensor snapshot',
      path: ['resolvedSources'],
      input: ctx.value.resolvedSources,
    });
  } else {
    ctx.value.resolvedSources.forEach((resolved, index) => {
      const source = spec.sources[index];
      if (!source || source.actorId !== resolved.actorId
        || source.sensorId !== resolved.sensorId || source.modality !== resolved.modality) {
        ctx.issues.push({
          code: 'custom',
          message: 'resolved source order and identity must match renderSpec.sources',
          path: ['resolvedSources', index],
          input: resolved,
        });
      }
    });
  }

  const available = ctx.value.renderer.availableCapabilities;
  const rejectCapabilityDuplicates = (
    capabilities: readonly string[],
    path: Array<string | number>,
  ): void => {
    const seen = new Set<string>();
    capabilities.forEach((capability, index) => {
      if (seen.has(capability)) {
        ctx.issues.push({
          code: 'custom',
          message: `duplicate capability "${capability}"`,
          path: [...path, index],
          input: capability,
        });
      }
      seen.add(capability);
    });
  };
  rejectCapabilityDuplicates(available, ['renderer', 'availableCapabilities']);
  rejectCapabilityDuplicates(ctx.value.capabilityResolution.required, [
    'capabilityResolution', 'required',
  ]);
  rejectCapabilityDuplicates(ctx.value.capabilityResolution.preferredApplied, [
    'capabilityResolution', 'preferredApplied',
  ]);
  rejectCapabilityDuplicates(ctx.value.capabilityResolution.preferredUnavailable, [
    'capabilityResolution', 'preferredUnavailable',
  ]);

  const expectedRequired = requiredCapabilities(spec);
  if (!sameStringArray(ctx.value.capabilityResolution.required, expectedRequired)) {
    ctx.issues.push({
      code: 'custom',
      message: 'capabilityResolution.required must be recomputed from renderSpec intent, sources, and artifacts',
      path: ['capabilityResolution', 'required'],
      input: ctx.value.capabilityResolution.required,
    });
  }
  const availableSet = new Set(available);
  const missingRequired = expectedRequired.filter((capability) => !availableSet.has(capability));
  if (missingRequired.length > 0) {
    ctx.issues.push({
      code: 'custom',
      message: `renderer is missing required capture capabilities: ${missingRequired.join(', ')}`,
      path: ['renderer', 'availableCapabilities'],
      input: available,
    });
  }
  const expectedPreferredApplied = spec.capabilityIntent.preferred.filter((capability) => availableSet.has(capability));
  const expectedPreferredUnavailable = spec.capabilityIntent.preferred.filter((capability) => !availableSet.has(capability));
  if (!sameStringArray(ctx.value.capabilityResolution.preferredApplied, expectedPreferredApplied)) {
    ctx.issues.push({
      code: 'custom',
      message: 'preferredApplied must exactly match available preferred capabilities',
      path: ['capabilityResolution', 'preferredApplied'],
      input: ctx.value.capabilityResolution.preferredApplied,
    });
  }
  if (!sameStringArray(ctx.value.capabilityResolution.preferredUnavailable, expectedPreferredUnavailable)) {
    ctx.issues.push({
      code: 'custom',
      message: 'preferredUnavailable must exactly match unavailable preferred capabilities',
      path: ['capabilityResolution', 'preferredUnavailable'],
      input: ctx.value.capabilityResolution.preferredUnavailable,
    });
  }
});

export type CaptureSensorModality = z.infer<typeof CaptureSensorModalitySchema>;
export type CaptureCapability = z.infer<typeof CaptureCapabilitySchema>;
export type CaptureArtifact = z.infer<typeof CaptureArtifactSchema>;
export type RenderSensorSource = z.infer<typeof RenderSensorSourceSchema>;
export type RenderSpecV2 = z.infer<typeof RenderSpecV2Schema>;
export type RenderModality = z.infer<typeof RenderModalitySchema>;
export type RenderSourceTransform = z.infer<typeof RenderSourceTransformSchema>;
export type RenderCameraAttributes = z.infer<typeof RenderCameraAttributesSchema>;
export type RenderLidarAttributes = z.infer<typeof RenderLidarAttributesSchema>;
export type RenderRadarAttributes = z.infer<typeof RenderRadarAttributesSchema>;
export type RenderSourceV3 = z.infer<typeof RenderSourceV3Schema>;
export type RenderArtifactV3 = z.infer<typeof RenderArtifactV3Schema>;
export type RenderSpecV3 = z.infer<typeof RenderSpecV3Schema>;
export type RenderSpecV3Input = z.input<typeof RenderSpecV3Schema>;

interface CarlaSensorCommon {
  readonly id: string;
  readonly attachTo: string;
  readonly transform: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly pitch: number;
    readonly yaw: number;
    readonly roll: number;
  };
}

export interface CarlaCameraSensor extends CarlaSensorCommon {
  readonly kind: 'rgb' | 'depth' | 'semantic' | 'instance';
  readonly attachment: 'rigid';
  readonly attributes: {
    readonly width: number;
    readonly height: number;
    readonly fov: number;
    readonly clipNear: number;
    readonly clipFar: number;
    readonly enablePostprocessEffects: boolean;
  };
}

export interface CarlaLidarSensor extends CarlaSensorCommon {
  readonly kind: 'lidar';
  readonly attachment: 'rigid';
  readonly attributes: {
    readonly channels: number;
    readonly range: number;
    readonly pointsPerSecond: number;
    readonly rotationFrequency: number;
    readonly upperFov: number;
    readonly lowerFov: number;
  };
}

export interface CarlaRadarSensor extends CarlaSensorCommon {
  readonly kind: 'radar';
  readonly attachment: 'rigid';
  readonly attributes: {
    readonly horizontalFov: number;
    readonly verticalFov: number;
    readonly range: number;
    readonly pointsPerSecond: number;
  };
}

export type CarlaSensorLowering = readonly (
  CarlaCameraSensor | CarlaLidarSensor | CarlaRadarSensor
)[];

interface BrowserRenderPassCommon {
  readonly sensorId: string;
  readonly actorId: string;
  readonly outputName: string;
  readonly transform: RenderSourceTransform;
}

export interface BrowserCameraRenderPass extends BrowserRenderPassCommon, RenderCameraAttributes {
  readonly modality: 'rgb' | 'depth' | 'semantic' | 'instance';
}

export interface BrowserLidarRenderPass extends BrowserRenderPassCommon, RenderLidarAttributes {
  readonly modality: 'lidar';
}

export interface BrowserRadarRenderPass extends BrowserRenderPassCommon, RenderRadarAttributes {
  readonly modality: 'radar';
}

export type BrowserRenderPass =
  | BrowserCameraRenderPass
  | BrowserLidarRenderPass
  | BrowserRadarRenderPass;

export interface BrowserRenderPlan {
  readonly passes: readonly BrowserRenderPass[];
}

export type BrowserRenderLoweringErrorCode =
  | 'semantic_requires_static_semantics'
  | 'unsupported_browser_modality';

export class BrowserRenderLoweringError extends Error {
  override readonly name = 'BrowserRenderLoweringError';

  constructor(
    readonly code: BrowserRenderLoweringErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export type RenderSpecV2Input = z.input<typeof RenderSpecV2Schema>;
export type ResolvedCaptureSource = z.infer<typeof ResolvedCaptureSourceSchema>;
export type ResolvedFrameSchedule = z.infer<typeof ResolvedFrameScheduleSchema>;
export type VerifiedPlaybackEvidence = z.infer<typeof VerifiedPlaybackEvidenceSchema>;
export type ExecutedOperationalConditions = z.infer<typeof ExecutedOperationalConditionsSchema>;
export type ResolvedEnvironmentNumerics = z.infer<typeof ResolvedEnvironmentNumericsSchema>;
export type EnvironmentStateChange = z.infer<typeof EnvironmentStateChangeSchema>;
export type ResolvedEnvironmentProvenance = z.infer<typeof ResolvedEnvironmentProvenanceSchema>;
type MutableResolvedCaptureManifest = z.infer<typeof ResolvedCaptureManifestSchema>;
export type ResolvedCaptureManifest = DeepReadonly<MutableResolvedCaptureManifest>;
export type CaptureSourceProvenance = z.infer<typeof CaptureSourceProvenanceSchema>;

export interface CaptureActorSensors {
  readonly id: string;
  readonly sensors: readonly ActorSensor[];
}

/** Partial numeric resolutions supplied only where authoring used expressions. */
export interface EnvironmentNumericResolutionInput {
  readonly frictionScale?: number;
  readonly sunAzimuthDeg?: number;
  readonly sunElevationDeg?: number;
  readonly surfacePatches?: readonly {
    readonly id: string;
    readonly atM?: number;
    readonly lengthM?: number;
    readonly frictionScale?: number;
    readonly edgeTaperM?: number;
  }[];
}

export interface RevisionEnvironmentContext {
  /** Environment read from the immutable scenario revision, never UI draft state. */
  readonly authoritativeEnvironment: unknown;
  /** Required for every authored numeric expression; direct numeric values are verified. */
  readonly resolvedNumerics?: EnvironmentNumericResolutionInput;
  readonly operationalConditions: z.input<typeof ExecutedOperationalConditionsSchema>;
  readonly stateChanges?: readonly z.input<typeof EnvironmentStateChangeSchema>[];
}

export interface ResolveCaptureManifestContext {
  readonly createdAt: string;
  readonly scenarioRevision: MutableResolvedCaptureManifest['scenarioRevision'];
  readonly playbackEvidence: MutableResolvedCaptureManifest['playbackEvidence'];
  /** Omitted by adapters that only ever capture live authoring playback. */
  readonly captureSource?: MutableResolvedCaptureManifest['captureSource'];
  readonly mapEvidence: MutableResolvedCaptureManifest['mapEvidence'];
  readonly renderer: MutableResolvedCaptureManifest['renderer'];
  readonly revisionEnvironment: RevisionEnvironmentContext;
  readonly actors: readonly CaptureActorSensors[];
}

/** Validate/default an editable render spec without introducing a platform dependency. */
export function parseRenderSpecV2(value: unknown): RenderSpecV2 {
  return RenderSpecV2Schema.parse(value);
}
/** Validate a canonical multi-source render specification. */
export function parseRenderSpecV3(value: unknown): RenderSpecV3 {
  return RenderSpecV3Schema.parse(value);
}

/**
 * Deterministically migrate the legacy single-camera intent. V2 did not carry
 * an authored mount or camera clipping values, so its historical renderer
 * defaults become explicit v3 values.
 */
export function renderSpecV2ToV3(v2: RenderSpecV2): RenderSpecV3 {
  const parsed = parseRenderSpecV2(v2);
  const source = parsed.sources[0]!;
  const { bitrateMbps: _legacyBitrate, ...video } = parsed.video;
  const artifacts: RenderArtifactV3[] = parsed.artifacts.includes('manifest')
    ? [...parsed.artifacts]
    : [...parsed.artifacts, 'manifest'];
  return parseRenderSpecV3({
    schema: RENDER_SPEC_V3_SCHEMA,
    sources: [{
      actorId: source.actorId,
      sensorId: source.sensorId,
      outputName: source.outputName ?? source.sensorId,
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
      },
      modality: source.modality,
      attributes: {
        width: parsed.video.width,
        height: parsed.video.height,
        fps: parsed.video.fps,
        horizontalFovDeg: 90,
        nearM: 0.05,
        farM: 1_000,
      },
    }],
    clip: parsed.clip,
    video,
    artifacts,
    capabilityIntent: parsed.capabilityIntent,
    authoredEnvironment: parsed.authoredEnvironment,
  });
}

/** Lower portable mounts and native modality attributes to managed worker v1 sensors. */
export function lowerRenderSpecToCarla(spec: RenderSpecV3): CarlaSensorLowering {
  const parsed = parseRenderSpecV3(spec);
  return parsed.sources.map((source): CarlaCameraSensor | CarlaLidarSensor | CarlaRadarSensor => {
    const common: CarlaSensorCommon = {
      id: source.outputName,
      attachTo: source.actorId,
      transform: {
        x: source.transform.position.x,
        y: -source.transform.position.z,
        z: source.transform.position.y,
        pitch: -source.transform.rotation.pitchRad,
        yaw: source.transform.rotation.yawRad,
        roll: source.transform.rotation.rollRad,
      },
    };
    if (source.modality === 'lidar') {
      return {
        ...common,
        kind: 'lidar',
        attachment: 'rigid',
        attributes: {
          channels: source.attributes.channels,
          range: source.attributes.rangeM,
          pointsPerSecond: source.attributes.pointsPerSecond,
          rotationFrequency: source.attributes.rotationFrequencyHz,
          upperFov: degreesToRadians(source.attributes.upperFovDeg),
          lowerFov: degreesToRadians(source.attributes.lowerFovDeg),
        },
      };
    }
    if (source.modality === 'radar') {
      return {
        ...common,
        kind: 'radar',
        attachment: 'rigid',
        attributes: {
          horizontalFov: degreesToRadians(source.attributes.horizontalFovDeg),
          verticalFov: degreesToRadians(source.attributes.verticalFovDeg),
          range: source.attributes.rangeM,
          pointsPerSecond: source.attributes.pointsPerSecond,
        },
      };
    }
    return {
      ...common,
      kind: source.modality,
      attachment: 'rigid',
      attributes: {
        width: source.attributes.width,
        height: source.attributes.height,
        fov: degreesToRadians(source.attributes.horizontalFovDeg),
        clipNear: source.attributes.nearM,
        clipFar: source.attributes.farM,
        enablePostprocessEffects: source.modality === 'rgb',
      },
    };
  });
}

/** Lower only sensor passes the browser can faithfully execute. */
export function lowerRenderSpecToBrowser(spec: RenderSpecV3): BrowserRenderPlan {
  const parsed = parseRenderSpecV3(spec);
  const required = new Set(parsed.capabilityIntent.required);
  const passes = parsed.sources.map((source): BrowserRenderPass => {
    if (source.modality === 'semantic' && !required.has('map.static_semantics')) {
      throw new BrowserRenderLoweringError(
        'semantic_requires_static_semantics',
        `semantic source "${source.outputName}" requires capability "map.static_semantics"`,
      );
    }
    const common: BrowserRenderPassCommon = {
      sensorId: source.sensorId,
      actorId: source.actorId,
      outputName: source.outputName,
      transform: source.transform,
    };
    if (source.modality === 'lidar') {
      return { ...common, modality: source.modality, ...source.attributes };
    }
    if (source.modality === 'radar') {
      return { ...common, modality: source.modality, ...source.attributes };
    }
    if (source.modality === 'rgb'
      || source.modality === 'depth'
      || source.modality === 'semantic'
      || source.modality === 'instance') {
      return { ...common, modality: source.modality, ...source.attributes };
    }
    throw new BrowserRenderLoweringError(
      'unsupported_browser_modality',
      `browser renderer does not support modality "${String(source.modality)}"`,
    );
  });
  return { passes };
}

/** Parse and recursively freeze a previously resolved capture receipt. */
export function parseResolvedCaptureManifest(value: unknown): ResolvedCaptureManifest {
  return deepFreeze(ResolvedCaptureManifestSchema.parse(value)) as ResolvedCaptureManifest;
}

/**
 * Resolve stable actor/sensor references and renderer capabilities into an
 * immutable, revision-bound receipt. A missing required capability or mutable
 * sensor reference fails closed; preferred capabilities become warnings.
 */
export function resolveCaptureManifest(
  value: unknown,
  context: ResolveCaptureManifestContext,
): ResolvedCaptureManifest {
  const renderSpec = parseAnyRenderSpec(value);
  const playbackEvidence = VerifiedPlaybackEvidenceSchema.parse(context.playbackEvidence);
  if (renderSpec.clip.startSeconds < playbackEvidence.bounds.startSeconds
    || renderSpec.clip.endSeconds > playbackEvidence.bounds.endSeconds) {
    throw new Error(
      `render clip [${renderSpec.clip.startSeconds}, ${renderSpec.clip.endSeconds}) is outside verified playback bounds `
      + `[${playbackEvidence.bounds.startSeconds}, ${playbackEvidence.bounds.endSeconds}]`,
    );
  }
  const authoritativeEnvironment = EnvironmentSchema.parse(
    context.revisionEnvironment.authoritativeEnvironment,
  );
  if (!sameCanonicalValue(renderSpec.authoredEnvironment, authoritativeEnvironment)) {
    throw new Error('render spec environment does not match the authoritative scenario revision environment');
  }
  const environmentProvenance = resolveEnvironmentProvenance(
    authoritativeEnvironment,
    context.revisionEnvironment,
    playbackEvidence,
  );
  const actors = new Map(context.actors.map((actor) => [actor.id, actor]));
  const resolvedSources = renderSpec.sources.map((source) => {
    const actor = actors.get(source.actorId);
    if (!actor) throw new Error(`capture actor "${source.actorId}" does not exist in the bound revision`);
    const sensor = actor.sensors.find((candidate) => candidate.id === source.sensorId);
    if (!sensor) {
      throw new Error(`capture sensor "${source.sensorId}" does not exist on actor "${source.actorId}"`);
    }
    if (!sensor.enabled) {
      throw new Error(`capture sensor "${source.sensorId}" on actor "${source.actorId}" is disabled`);
    }
    const supports = 'transform' in source
      ? sensorSupportsRenderModality(sensor, source.modality)
      : sensorSupportsModality(sensor, source.modality);
    if (!supports) {
      throw new Error(`capture sensor "${source.sensorId}" cannot provide modality "${source.modality}"`);
    }
    if ('transform' in source
      && !sameCanonicalValue(source.transform, sensor.mount)) {
      throw new Error(
        `capture source "${source.outputName}" transform does not match sensor "${source.sensorId}" mount`,
      );
    }
    return { ...source, sensor };
  });

  const required = requiredCapabilities(renderSpec);
  const available = new Set(context.renderer.availableCapabilities);
  const missing = required.filter((capability) => !available.has(capability));
  if (missing.length > 0) {
    throw new Error(`renderer is missing required capture capabilities: ${missing.join(', ')}`);
  }
  const preferredApplied = renderSpec.capabilityIntent.preferred.filter((capability) => available.has(capability));
  const preferredUnavailable = renderSpec.capabilityIntent.preferred.filter((capability) => !available.has(capability));
  const scheduleFps = captureScheduleFps(renderSpec);
  const frameCount = fixedStepFrameCount(
    renderSpec.clip.startSeconds,
    renderSpec.clip.endSeconds,
    scheduleFps,
  );

  return parseResolvedCaptureManifest({
    schema: RESOLVED_CAPTURE_MANIFEST_V1_SCHEMA,
    createdAt: context.createdAt,
    scenarioRevision: context.scenarioRevision,
    playbackEvidence,
    ...(context.captureSource ? { captureSource: context.captureSource } : {}),
    mapEvidence: context.mapEvidence,
    renderer: context.renderer,
    renderSpec,
    environmentProvenance,
    resolvedSources,
    schedule: {
      startSeconds: renderSpec.clip.startSeconds,
      endSeconds: renderSpec.clip.endSeconds,
      fps: scheduleFps,
      frameCount,
      timestampUnit: 'microseconds',
      firstTimestampUs: 0,
      endTimestampUs: Math.round(frameCount * 1_000_000 / scheduleFps),
    },
    capabilityResolution: {
      required,
      preferredApplied,
      preferredUnavailable,
      warnings: preferredUnavailable.map((capability) => `preferred capability unavailable: ${capability}`),
    },
  });
}

function sensorSupportsModality(sensor: ActorSensor, modality: CaptureSensorModality): boolean {
  return sensor.type === 'dash_camera'
    && (modality === 'rgb' || modality === 'depth' || modality === 'semantic' || modality === 'instance');
}

function sensorSupportsRenderModality(sensor: ActorSensor, modality: RenderModality): boolean {
  if (modality === 'lidar') return sensor.type === 'lidar';
  if (modality === 'radar') return sensor.type === 'radar';
  return sensor.type === 'dash_camera';
}

function parseAnyRenderSpec(value: unknown): RenderSpecV2 | RenderSpecV3 {
  return z.union([RenderSpecV2Schema, RenderSpecV3Schema]).parse(value);
}

function requiredCapabilities(renderSpec: RenderSpecV2 | RenderSpecV3): string[] {
  const artifactCapability = (artifact: CaptureArtifact | RenderArtifactV3): string =>
    artifact === 'sensorArchive' ? 'artifact.sensor_archive' : `artifact.${artifact}`;
  return [...new Set([
    ...renderSpec.capabilityIntent.required,
    ...renderSpec.sources.map((source) => `sensor.${source.modality}`),
    ...renderSpec.artifacts.map(artifactCapability),
  ])];
}

function captureScheduleFps(renderSpec: RenderSpecV2 | RenderSpecV3): number {
  if (renderSpec.schema === RENDER_SPEC_V2_SCHEMA) return renderSpec.video.fps;
  if (renderSpec.video) return renderSpec.video.fps;
  const sourceRates = renderSpec.sources.flatMap((source) => {
    if (source.modality === 'lidar') return [source.attributes.rotationFrequencyHz];
    if (source.modality === 'radar') return [];
    return [source.attributes.fps];
  });
  return sourceRates.length === 0 ? 1 : Math.max(...sourceRates);
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameCanonicalValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function resolveEnvironmentProvenance(
  baseAuthoredEnvironment: Environment,
  context: RevisionEnvironmentContext,
  playbackEvidence: VerifiedPlaybackEvidence,
): ResolvedEnvironmentProvenance {
  const resolvedNumerics = resolveEnvironmentNumerics(
    baseAuthoredEnvironment,
    context.resolvedNumerics,
  );
  const operationalConditions = ExecutedOperationalConditionsSchema.parse(
    context.operationalConditions,
  );
  const stateChanges = z.array(EnvironmentStateChangeSchema).max(256).parse(
    context.stateChanges ?? [],
  );
  stateChanges.forEach((change) => {
    if (change.timeSeconds < playbackEvidence.bounds.startSeconds
      || change.timeSeconds > playbackEvidence.bounds.endSeconds) {
      throw new Error(`environment state change at ${change.timeSeconds}s is outside verified playback bounds`);
    }
  });
  return ResolvedEnvironmentProvenanceSchema.parse({
    source: 'scenario-revision',
    baseAuthoredEnvironment,
    resolvedNumerics,
    operationalConditions,
    stateChanges,
  });
}

function resolveEnvironmentNumerics(
  environment: Environment,
  supplied: EnvironmentNumericResolutionInput | undefined,
): ResolvedEnvironmentNumerics {
  const suppliedPatches = supplied?.surfacePatches ?? [];
  const suppliedById = new Map<string, NonNullable<EnvironmentNumericResolutionInput['surfacePatches']>[number]>();
  for (const patch of suppliedPatches) {
    if (suppliedById.has(patch.id)) throw new Error(`duplicate numeric resolution for surface patch "${patch.id}"`);
    suppliedById.set(patch.id, patch);
  }

  const surfacePatches = environment.surfacePatches.map((patch) => {
    const provided = suppliedById.get(patch.id);
    suppliedById.delete(patch.id);
    return {
      id: patch.id,
      atM: resolveAuthoredNumber(patch.atM, provided?.atM, `surfacePatches.${patch.id}.atM`),
      lengthM: resolveAuthoredNumber(patch.lengthM, provided?.lengthM, `surfacePatches.${patch.id}.lengthM`),
      frictionScale: resolveOptionalAuthoredNumber(
        patch.frictionScale,
        provided?.frictionScale,
        `surfacePatches.${patch.id}.frictionScale`,
      ),
      edgeTaperM: resolveAuthoredNumber(
        patch.edgeTaperM,
        provided?.edgeTaperM,
        `surfacePatches.${patch.id}.edgeTaperM`,
      ),
    };
  });
  if (suppliedById.size > 0) {
    throw new Error(`numeric resolution references unknown surface patch "${suppliedById.keys().next().value}"`);
  }

  return ResolvedEnvironmentNumericsSchema.parse({
    frictionScale: resolveOptionalAuthoredNumber(
      environment.frictionScale,
      supplied?.frictionScale,
      'frictionScale',
    ),
    sunAzimuthDeg: resolveOptionalAuthoredNumber(
      environment.sunAzimuthDeg,
      supplied?.sunAzimuthDeg,
      'sunAzimuthDeg',
    ),
    sunElevationDeg: resolveOptionalAuthoredNumber(
      environment.sunElevationDeg,
      supplied?.sunElevationDeg,
      'sunElevationDeg',
    ),
    surfacePatches,
  });
}

function resolveOptionalAuthoredNumber(
  authored: EnvironmentNumericValue | undefined,
  supplied: number | undefined,
  path: string,
): number | undefined {
  if (authored === undefined) {
    if (supplied !== undefined) throw new Error(`numeric resolution supplied for absent authored field ${path}`);
    return undefined;
  }
  return resolveAuthoredNumber(authored, supplied, path);
}

function resolveAuthoredNumber(
  authored: EnvironmentNumericValue,
  supplied: number | undefined,
  path: string,
): number {
  if (typeof authored === 'number') {
    if (!Number.isFinite(authored)) throw new Error(`authored environment field ${path} is not finite`);
    if (supplied !== undefined && supplied !== authored) {
      throw new Error(`numeric resolution for ${path} disagrees with its authored value`);
    }
    return authored;
  }
  if (supplied === undefined) {
    throw new Error(`authored environment expression ${path} requires a finite resolved value`);
  }
  if (!Number.isFinite(supplied)) {
    throw new Error(`resolved environment value ${path} must be finite`);
  }
  return supplied;
}

function assertResolvedEnvironmentNumerics(
  environment: Environment,
  resolved: ResolvedEnvironmentNumerics,
): void {
  const recomputed = resolveEnvironmentNumerics(environment, resolved);
  if (!sameCanonicalValue(recomputed, resolved)) {
    throw new Error('resolved environment numerics do not match the authored environment');
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type EnvironmentNumericValue = Environment['frictionScale'] extends infer Numeric
  ? Exclude<Numeric, undefined>
  : never;

/** Number of fixed-step samples in the half-open interval [start, end). */
export function fixedStepFrameCount(startSeconds: number, endSeconds: number, fps: number): number {
  const exact = (endSeconds - startSeconds) * fps;
  // Suppress floating-point dust at exact frame boundaries without truncating
  // a genuine partial final frame.
  return Math.max(1, Math.ceil(exact - Number.EPSILON * Math.max(1, Math.abs(exact)) * 8));
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;
