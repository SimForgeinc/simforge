/**
 * simforge.renderer-contract/v1 — the renderer-neutral boundary between
 * SimForge scene/session state and any concrete renderer (packaged Three
 * WebGL editor viewport, platform Three WebGPU city viewer, native Bevy).
 *
 * This module is deliberately self-contained: **no `three` import, no runtime
 * dependency** beyond erased `import type`s. Every shape here is plain JSON
 * data so it can be copied verbatim into a Rust or Python implementation.
 * Where an existing SimForge type already had the right renderer-neutral
 * shape (`ActorView`, `CameraView`, scene-state.v1 actors, the static
 * semantics index), this contract restates it and the adapter proves
 * assignability at compile time — the contract formalizes, it does not fork.
 *
 * Frozen wire identifiers referenced here (`scene-state.v1`,
 * `uniscenario.static-semantics/v1`) stay byte-identical per
 * docs/engineering/simcloud-sync.md. New identifiers introduced by this
 * contract use the `simforge.` prefix.
 *
 * See docs/renderer-contract.md for the normative prose, viewport ownership,
 * and tolerance table.
 */

import type { SceneState } from '@simforge-oss/engine/scene-state';

export const RENDERER_CONTRACT_VERSION = 'simforge.renderer-contract/v1' as const;

// ---------------------------------------------------------------------------
// Scalars — y-up scene frame, metres, radians, seconds (scene-state.v1 frame).
// ---------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];
/** Quaternion `[x, y, z, w]`, matching scene-state.v1 actor rotation. */
export type Quat = readonly [number, number, number, number];
/**
 * 4×4 matrix as 16 numbers in **column-major** order (Three `Matrix4.elements`
 * order; transpose of glam/row-major conventions — converters own the flip).
 */
export type Mat4 = readonly number[];

// ---------------------------------------------------------------------------
// Camera / view commands
// ---------------------------------------------------------------------------

/** Eye/target pose. `up` defaults to +Y; only sensor rigs override it. */
export interface CameraPoseCommand {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly up?: Vec3;
}

/**
 * Perspective intrinsics. `fovYDeg` is the *vertical* field of view in
 * degrees (Three convention). Renderers with pixel-focal APIs derive
 * `fy = height / (2 * tan(fovYDeg/2))`, `fx = fy` (square pixels), principal
 * point at the image centre. Aspect is width/height and explicit so headless
 * and windowed renderers agree without a canvas.
 */
export interface CameraIntrinsics {
  readonly fovYDeg: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}

/** What a follow/attach camera is bound to (mirrors authored-camera model). */
export type CameraAttachment =
  | { readonly kind: 'actor'; readonly id: string }
  | { readonly kind: 'traffic-signal'; readonly id: string; readonly approach?: string }
  | { readonly kind: 'map-feature'; readonly id: string };

/** Bounds a `frame` command must bring fully inside the frustum. */
export interface FrameBounds {
  readonly center: Vec3;
  /** Bounding-sphere radius in metres; the ground term is inside `center`. */
  readonly radius: number;
}

export type CameraCommand =
  | { readonly kind: 'set-pose'; readonly pose: CameraPoseCommand }
  | { readonly kind: 'set-intrinsics'; readonly intrinsics: CameraIntrinsics }
  | {
      readonly kind: 'frame';
      readonly bounds: FrameBounds;
      /** Orbit angles of the framing eye; defaults documented in `frameCameraPose`. */
      readonly azimuthRad?: number;
      readonly elevationRad?: number;
    }
  | {
      readonly kind: 'follow';
      readonly attachment: CameraAttachment;
      readonly mode: 'chase' | 'dash';
    }
  | {
      /** Sensor rigs temporarily own the exact eye below editor navigation limits. */
      readonly kind: 'set-constraints-enabled';
      readonly enabled: boolean;
    };

/** What a renderer reports back after applying camera commands. */
export interface CameraStateReport {
  readonly pose: CameraPoseCommand;
  readonly intrinsics: CameraIntrinsics;
  /** World→camera (view) matrix, column-major. */
  readonly viewMatrix: Mat4;
  /** Camera→clip (projection) matrix, column-major, OpenGL/WebGL depth [-1,1]. */
  readonly projectionMatrix: Mat4;
}

/**
 * Normative framing pose: eye orbits `bounds.center` at the distance that fits
 * the bounding sphere in the *smaller* frustum axis, padded 15%. Every
 * renderer must produce this exact pose for a `frame` command so parity
 * fixtures can pin camera matrices, not just containment.
 */
export function frameCameraPose(
  bounds: FrameBounds,
  intrinsics: Pick<CameraIntrinsics, 'fovYDeg' | 'aspect'>,
  azimuthRad = Math.PI / 4,
  elevationRad = Math.PI / 5,
): CameraPoseCommand {
  const vHalf = (intrinsics.fovYDeg * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * intrinsics.aspect);
  const distance = (bounds.radius / Math.sin(Math.min(vHalf, hHalf))) * 1.15;
  const cosE = Math.cos(elevationRad);
  const [cx, cy, cz] = bounds.center;
  return {
    position: [
      cx + distance * cosE * Math.cos(azimuthRad),
      cy + distance * Math.sin(elevationRad),
      cz + distance * cosE * Math.sin(azimuthRad),
    ],
    target: bounds.center,
  };
}

/**
 * Normative follow pose for an actor. `chase` sits behind and above the body
 * along -heading; `dash` sits at the windshield looking ahead. Both are pure
 * functions of the actor state so follow cameras are renderer-portable.
 */
export function followCameraPose(
  actor: Pick<ActorRenderState, 'x' | 'y' | 'z' | 'headingRad' | 'dims'>,
  mode: 'chase' | 'dash',
): CameraPoseCommand {
  const fx = Math.cos(actor.headingRad);
  const fz = -Math.sin(actor.headingRad);
  if (mode === 'dash') {
    const eyeY = actor.y + actor.dims.h * 0.78;
    return {
      position: [actor.x + fx * actor.dims.l * 0.18, eyeY, actor.z + fz * actor.dims.l * 0.18],
      target: [actor.x + fx * 30, eyeY, actor.z + fz * 30],
    };
  }
  const back = actor.dims.l * 1.9 + 4;
  return {
    position: [actor.x - fx * back, actor.y + actor.dims.h * 1.6 + 1.2, actor.z - fz * back],
    target: [actor.x + fx * actor.dims.l, actor.y + actor.dims.h * 0.5, actor.z + fz * actor.dims.l],
  };
}

// ---------------------------------------------------------------------------
// Actor frame batches — the existing ActorView shape, formalized
// ---------------------------------------------------------------------------

/** Extents in metres: `l` along facing (+X body), `w` lateral, `h` vertical. */
export interface ActorDims {
  readonly l: number;
  readonly w: number;
  readonly h: number;
}

export type ActorDoorName = 'left' | 'right' | 'rear';
export type ActorDoorState = 'closed' | 'opening' | 'open' | 'closing';

/** Simulation actor kind (engine `ActorKind`, restated for portability). */
export type ActorSimKind =
  | 'vehicle'
  | 'car'
  | 'truck'
  | 'bus'
  | 'van'
  | 'motorcycle'
  | 'bicycle'
  | 'pedestrian'
  | 'scooter'
  | 'sidewalk_robot'
  | 'drone'
  | 'animal'
  | 'static_object';

/**
 * Everything a renderer needs to draw one actor at one instant. This is the
 * viewer's proven `ActorView` shape stated renderer-neutrally; the Three
 * adapter compile-asserts assignability so the two can never drift.
 */
export interface ActorRenderState {
  readonly id: string;
  readonly catalogId: string;
  /** Ground-contact position in scene metres (origins are ground-centred). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Yaw in radians, CCW from +X about +Y (scene-state.v1 `yawRad`). */
  readonly headingRad: number;
  readonly dims: ActorDims;
  readonly kind?: ActorSimKind;
  readonly catalogIdAuthored?: boolean;
  readonly doors?: Readonly<Partial<Record<ActorDoorName, ActorDoorState>>>;
  readonly reversing?: boolean;
  readonly emergency?: 'off' | 'flashing' | 'flashing_siren';
  readonly hornActive?: boolean;
  readonly indicator?: 'off' | 'left' | 'right' | 'hazard';
  /** Explicit low-beam state; absent means "renderer's global default". */
  readonly headlights?: boolean;
  readonly bodyColor?: string;
  readonly animationTimeS?: number;
  readonly speedMps?: number;
  readonly downProgress?: number;
}

/** Render layers with reserved semantics. Other layer ids are renderer-local. */
export type ActorFrameLayer = 'editor' | 'sumo-traffic' | (string & {});

/**
 * One full-set actor frame. Semantics are **idempotent replace-all for the
 * layer**: the renderer draws exactly `actors`, removing instances absent
 * from the batch. Spawn/despawn is derived, never inferred from gaps —
 * matching both `ActorRenderer.syncLayer` and scene-state.v1 tick records.
 */
export interface ActorFrameBatch {
  readonly contractVersion: typeof RENDERER_CONTRACT_VERSION;
  readonly layer: ActorFrameLayer;
  /** Fixed-step tick index this frame samples (scene-state.v1 tick). */
  readonly tick: number;
  /** Seconds since clip start at `tick`. */
  readonly timeS: number;
  readonly actors: readonly ActorRenderState[];
}

// ---------------------------------------------------------------------------
// Light state
// ---------------------------------------------------------------------------

/**
 * At most this many vehicles project real beam lights, chosen by ascending
 * actor id (string sort); emissive lenses stay unbounded. Pinned to the
 * viewer's `MAX_PROJECTED_HEADLIGHTS` by test.
 */
export const PROJECTED_HEADLIGHT_LIMIT = 8;

/**
 * Bounded nearest-camera pool of street luminaires that carry a real point
 * light. Pinned to the viewer's `DEFAULT_ACTIVE_LUMINAIRE_LIMIT` by test.
 */
export const STREET_LUMINAIRE_ACTIVE_LIMIT = 12;

/** Per-vehicle light truth a conforming renderer must reproduce. */
export interface VehicleLightState {
  readonly actorId: string;
  /** Emissive low-beam lenses lit (never bounded). */
  readonly lowBeams: boolean;
  /** One of the `PROJECTED_HEADLIGHT_LIMIT` real projected beams. */
  readonly projectedBeam: boolean;
  readonly emergency: 'off' | 'flashing' | 'flashing_siren';
  readonly indicator: 'off' | 'left' | 'right' | 'hazard';
  /** Luminous reverse panel lit (body travels rear-first). */
  readonly reverseLight: boolean;
}

export interface StreetLightingState {
  readonly enabled: boolean;
  readonly activeLimit: number;
}

export interface LightStateReport {
  readonly streetLighting: StreetLightingState;
  /** Sorted by ascending `actorId`; only vehicles with any lit state appear. */
  readonly vehicles: readonly VehicleLightState[];
}

/**
 * Normative light-state derivation from an actor frame. `globalLowBeams` is
 * the environment-driven default (authored darkness); an explicit per-actor
 * `headlights` always wins. `isVehicle` abstracts catalog lookup so the
 * function stays dependency-free.
 */
export function deriveVehicleLightStates(
  actors: readonly ActorRenderState[],
  globalLowBeams: boolean,
  isVehicle: (actor: ActorRenderState) => boolean,
): readonly VehicleLightState[] {
  const lit = actors
    .filter((actor) => isVehicle(actor) && (actor.headlights ?? globalLowBeams))
    .sort((a, b) => a.id.localeCompare(b.id));
  const beamIds = new Set(lit.slice(0, PROJECTED_HEADLIGHT_LIMIT).map((actor) => actor.id));
  const states: VehicleLightState[] = [];
  for (const actor of actors) {
    if (!isVehicle(actor)) continue;
    const lowBeams = actor.headlights ?? globalLowBeams;
    const state: VehicleLightState = {
      actorId: actor.id,
      lowBeams,
      projectedBeam: beamIds.has(actor.id),
      emergency: actor.emergency ?? 'off',
      indicator: actor.indicator ?? 'off',
      reverseLight: actor.reversing === true,
    };
    if (state.lowBeams || state.projectedBeam || state.emergency !== 'off'
      || state.indicator !== 'off' || state.reverseLight) {
      states.push(state);
    }
  }
  return states.sort((a, b) => a.actorId.localeCompare(b.actorId));
}

// ---------------------------------------------------------------------------
// Picking — id-based; no renderer intersection objects cross this boundary
// ---------------------------------------------------------------------------

export type PickLayer = 'actors' | 'ground' | 'map-static';

export interface PickRequest {
  /** Normalized device coordinates, x/y in [-1, 1], +y up (WebGL NDC). */
  readonly ndc: { readonly x: number; readonly y: number };
  /** Layers to test; defaults to `['actors']`. */
  readonly layers?: readonly PickLayer[];
  readonly maxHits?: number;
}

export interface PickHit {
  readonly layer: PickLayer;
  /**
   * Stable id of the hit: actor id, semantic node instance id (as string), or
   * null for anonymous ground. Never a scene-graph object reference.
   */
  readonly id: string | null;
  readonly distanceM: number;
  /** World-space hit point, y-up scene metres. */
  readonly point: Vec3;
  /** Static-semantics classification when the hit surface carries one. */
  readonly semantic?: { readonly class: string; readonly instanceId: number };
}

/** Hits sorted by ascending `distanceM`. */
export interface PickResult {
  readonly hits: readonly PickHit[];
}

// ---------------------------------------------------------------------------
// Fixed-step render schedule
// ---------------------------------------------------------------------------

/**
 * The canonical capture schedule: every conforming renderer presents exactly
 * `frameCount` frames at `tickHz`, pixel ratio 1, exact backing-buffer size.
 * Timestamps are integer microseconds (WebCodecs/WebM timebase).
 */
export interface RenderSchedule {
  readonly tickHz: number;
  readonly startTick: number;
  readonly frameCount: number;
  readonly width: number;
  readonly height: number;
}

/** Exact per-frame timestamps in integer microseconds. */
export function scheduleTimestampsMicros(schedule: RenderSchedule): number[] {
  const out: number[] = [];
  for (let i = 0; i < schedule.frameCount; i++) {
    out.push(Math.round(((schedule.startTick + i) * 1_000_000) / schedule.tickHz));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Map publication descriptor
// ---------------------------------------------------------------------------

/** Frozen wire id of the static-semantics sidecar schema. */
export const STATIC_SEMANTICS_SCHEMA_ID = 'uniscenario.static-semantics/v1' as const;

/**
 * How a published map is handed to a renderer. Browser renderers stream from
 * `manifestUrl`; native renderers receive the same publication resolved to
 * absolute payload paths — either way identity is `cacheVersion` (16-hex
 * prefix of the manifest byte SHA-256), never mutable URLs.
 */
export interface MapPublicationDescriptor {
  readonly mapId: string;
  readonly manifestUrl: string;
  /** First 16 hex chars of sha256(manifest bytes); asset-cache identity. */
  readonly cacheVersion: string;
  /** Full manifest byte digest when the publisher computed one. */
  readonly manifestSha256?: string;
  /** Manifest `version` field (tiled-city schema version). */
  readonly schemaVersion: string;
  readonly staticSemantics?: {
    readonly file: string;
    readonly schema: typeof STATIC_SEMANTICS_SCHEMA_ID;
  };
  /** Selected asset variant id when the publication ships variants. */
  readonly assetVariant?: string;
}

// ---------------------------------------------------------------------------
// Semantic legend
// ---------------------------------------------------------------------------

/** Static classes of `uniscenario.static-semantics/v1` (frozen; pinned by test). */
export const STATIC_SEMANTIC_CLASS_LEGEND = [
  'road',
  'sidewalk',
  'building',
  'vegetation',
  'pole',
  'traffic_light',
  'traffic_sign',
  'furniture',
  'terrain',
  'other',
] as const;

/** Actor classes of scene-state.v1 (frozen; pinned by test). */
export const ACTOR_CLASS_LEGEND = [
  'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian', 'prop',
] as const;

/**
 * The id spaces an ID/semantic pass must emit. Static instance ids come from
 * the published semantics sidecar; actor instance ids are assigned by sorted
 * actor id at capture time (deterministic across renderers).
 */
export interface SemanticLegend {
  readonly contractVersion: typeof RENDERER_CONTRACT_VERSION;
  readonly staticSchema: typeof STATIC_SEMANTICS_SCHEMA_ID;
  readonly staticClasses: readonly string[];
  readonly actorClasses: readonly string[];
  /** actorId → instance id; ids are `1 + index` in ascending actor-id order. */
  readonly actorInstanceIds: Readonly<Record<string, number>>;
}

/** Deterministic actor instance legend: ascending actor id, ids from 1. */
export function actorInstanceLegend(actorIds: readonly string[]): Record<string, number> {
  const legend: Record<string, number> = {};
  [...actorIds].sort((a, b) => a.localeCompare(b)).forEach((id, index) => {
    legend[id] = 1 + index;
  });
  return legend;
}

// ---------------------------------------------------------------------------
// Artifact provenance
// ---------------------------------------------------------------------------

export type RendererImplementation = 'three-webgl' | 'three-webgpu' | 'bevy-native';

/**
 * Determinism class an artifact may claim. `schedule-and-structure` is the
 * strongest claim any cross-GPU browser artifact can make today: exact frame
 * schedule, container layout, ids and digests — NOT byte-identical pixels.
 */
export type DeterminismClass = 'schedule-and-structure' | 'byte-identical-pixels';

export interface ArtifactProvenance {
  readonly contractVersion: typeof RENDERER_CONTRACT_VERSION;
  readonly renderer: {
    readonly implementation: RendererImplementation;
    readonly version: string;
    /** Graphics backend actually used (webgl2, webgpu, vulkan, metal…). */
    readonly backend: string;
    readonly device?: string;
  };
  readonly determinism: DeterminismClass;
  readonly inputs: {
    readonly sceneStateSha256?: string;
    readonly xodrSha256?: string;
    readonly mapCacheVersion?: string;
    /** sha256 of the JSON-serialized RenderSchedule. */
    readonly scheduleSha256?: string;
  };
}

// ---------------------------------------------------------------------------
// Parity fixtures — what any conforming renderer must reproduce
// ---------------------------------------------------------------------------

export const PARITY_FIXTURE_VERSION = 'simforge.renderer-parity-fixture/v1' as const;

export interface FixtureCameraCase {
  readonly id: string;
  readonly command: CameraCommand & { readonly kind: 'set-pose' | 'frame' };
  readonly intrinsics: CameraIntrinsics;
  readonly expected: {
    readonly viewMatrix: Mat4;
    readonly projectionMatrix: Mat4;
  };
}

export interface FixturePickCase {
  readonly cameraId: string;
  readonly request: PickRequest;
  readonly expected: {
    readonly actorId: string | null;
    readonly distanceM?: number;
  };
}

/**
 * Given `sceneState` at frame index `tick` (plus `renderCues`, the playback
 * light/articulation channel that scene-state.v1 intentionally omits), a
 * conforming renderer must reproduce every `expected` block within the
 * documented tolerances.
 */
export interface ParityFixture {
  readonly fixtureVersion: typeof PARITY_FIXTURE_VERSION;
  readonly contractVersion: typeof RENDERER_CONTRACT_VERSION;
  readonly tolerances: {
    /** Absolute per-element tolerance for 4×4 matrices. */
    readonly matrixAbs: number;
    /** Absolute tolerance for world-space points/distances, metres. */
    readonly pointAbs: number;
  };
  readonly sceneState: SceneState;
  readonly tick: number;
  /** Per-actor playback cues keyed by actor id (trace-event channel). */
  readonly renderCues: Readonly<Record<string, Pick<ActorRenderState,
    'headlights' | 'emergency' | 'indicator' | 'reversing' | 'doors'>>>;
  /** Environment default for low beams (authored darkness). */
  readonly globalLowBeams: boolean;
  readonly cameras: readonly FixtureCameraCase[];
  readonly expectedActorMatrices: Readonly<Record<string, Mat4>>;
  readonly expectedLights: {
    readonly streetLighting: StreetLightingState;
    readonly vehicles: readonly VehicleLightState[];
  };
  readonly expectedSemantics: {
    readonly legend: SemanticLegend;
  };
  readonly picks: readonly FixturePickCase[];
  readonly schedule: RenderSchedule;
  readonly expectedScheduleTimestampsMicros: readonly number[];
}

function fail(path: string, message: string): never {
  throw new Error(`Parity fixture validation failed — ${path}: ${message}`);
}

function mat4(value: unknown, path: string): Mat4 {
  if (!Array.isArray(value) || value.length !== 16 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    fail(path, 'expected 16 finite numbers (column-major 4x4)');
  }
  return value as Mat4;
}

/**
 * Structural validation of an untrusted fixture document: version
 * discriminants and the numeric matrix payloads are checked here; the
 * embedded scene-state document is validated separately by the engine's zod
 * schema (the frozen scene-state.v1 wire owns its own validation).
 */
export function validateParityFixture(raw: unknown): ParityFixture {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('<root>', 'expected an object');
  const doc = raw as ParityFixture;
  if (doc.fixtureVersion !== PARITY_FIXTURE_VERSION) fail('fixtureVersion', `expected ${PARITY_FIXTURE_VERSION}`);
  if (doc.contractVersion !== RENDERER_CONTRACT_VERSION) fail('contractVersion', `expected ${RENDERER_CONTRACT_VERSION}`);
  if (typeof doc.tolerances?.matrixAbs !== 'number' || typeof doc.tolerances?.pointAbs !== 'number') {
    fail('tolerances', 'expected {matrixAbs, pointAbs}');
  }
  if (doc.sceneState?.version !== 'scene-state.v1') fail('sceneState', 'expected an embedded scene-state.v1 document');
  if (!Number.isInteger(doc.tick) || doc.tick < 0) fail('tick', 'expected a non-negative integer');
  if (typeof doc.renderCues !== 'object' || doc.renderCues === null) fail('renderCues', 'expected an object');
  if (typeof doc.globalLowBeams !== 'boolean') fail('globalLowBeams', 'expected a boolean');
  if (!Array.isArray(doc.cameras) || doc.cameras.length === 0) fail('cameras', 'expected a non-empty array');
  for (const [index, camera] of doc.cameras.entries()) {
    if (typeof camera?.id !== 'string') fail(`cameras[${index}]`, 'expected {id, command, intrinsics, expected}');
    mat4(camera.expected?.viewMatrix, `cameras[${index}].expected.viewMatrix`);
    mat4(camera.expected?.projectionMatrix, `cameras[${index}].expected.projectionMatrix`);
  }
  if (typeof doc.expectedActorMatrices !== 'object' || doc.expectedActorMatrices === null) {
    fail('expectedActorMatrices', 'expected an object');
  }
  for (const [id, matrix] of Object.entries(doc.expectedActorMatrices)) {
    mat4(matrix, `expectedActorMatrices[${id}]`);
  }
  if (typeof doc.expectedLights !== 'object' || doc.expectedLights === null) fail('expectedLights', 'expected an object');
  if (typeof doc.expectedSemantics !== 'object' || doc.expectedSemantics === null) fail('expectedSemantics', 'expected an object');
  if (!Array.isArray(doc.picks)) fail('picks', 'expected an array');
  if (typeof doc.schedule !== 'object' || doc.schedule === null) fail('schedule', 'expected a RenderSchedule');
  if (!Array.isArray(doc.expectedScheduleTimestampsMicros)) fail('expectedScheduleTimestampsMicros', 'expected an array');
  return doc;
}

/**
 * Map one scene-state.v1 actor tick (+ its static description and playback
 * cues) into the render state a conforming renderer draws. This is the
 * normative frame-assembly rule shared by every renderer.
 */
export function actorRenderStateFromSceneState(
  desc: { readonly id: string; readonly catalogId: string; readonly dims?: ActorDims; readonly color?: string },
  tickRecord: {
    readonly position: Vec3;
    readonly yawRad: number;
    readonly velocity: Vec3;
  },
  timeS: number,
  fallbackDims: ActorDims,
  cues?: Pick<ActorRenderState, 'headlights' | 'emergency' | 'indicator' | 'reversing' | 'doors'>,
): ActorRenderState {
  const [x, y, z] = tickRecord.position;
  const [vx, vy, vz] = tickRecord.velocity;
  return {
    id: desc.id,
    catalogId: desc.catalogId,
    x,
    y,
    z,
    headingRad: tickRecord.yawRad,
    dims: desc.dims ?? fallbackDims,
    catalogIdAuthored: true,
    animationTimeS: timeS,
    speedMps: Math.hypot(vx, vy, vz),
    ...(desc.color === undefined ? {} : { bodyColor: desc.color }),
    ...cues,
  };
}
