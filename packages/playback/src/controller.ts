import { Quaternion, Vector3 } from 'three';
import type { CameraMode, CameraView, CityViewer } from '@uniscenarios/city-renderer';
import type { DashCameraSensor } from '@uniscenarios/scenario-model';
import { CONTROL_INDICATIONS, type ControlIndication, type SceneTrace } from '@uniscenarios/sim-engine';
import {
  ActorRenderer,
  type ActorView,
  type DoorName,
  type DoorState,
  type DoorStates,
} from '@uniscenarios/city-renderer';
import {
  samplePlaybackActors,
  samplePlaybackSignals,
  type PlaybackBundle,
  type SampledActor,
  type SampledSignal,
} from './model';
import { StudioTransport } from './transport';

/** Presentation policy shared by local Studio and cloud product adapters. */
export type CameraPolicy = 'editor' | 'all-actors' | 'subject-chase' | 'dash-camera' | 'authored' | 'auto-incident' | 'free';

function isInternalTrafficActor(actor: { readonly id: string }): boolean {
  return actor.id === 'ambient-world-seed';
}

export interface PlaybackState {
  readonly time: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly playing: boolean;
  readonly actorCount: number;
  readonly visibleActorCount: number;
  readonly propCount: number;
  readonly signalCount: number;
  readonly signalHeadCount: number;
  readonly renderedSignalHeadCount: number;
  readonly signalPhases: Readonly<Record<ControlIndication, number>>;
  readonly signalTimingSources: readonly string[];
  readonly instanceId: string;
  readonly inputHash: string;
  readonly cameraPolicy: CameraPolicy;
  readonly cameraSelectionId: string;
  readonly cameraReason?: string;
}

export interface PlaybackControllerOptions {
  viewer: CityViewer;
  bundle: PlaybackBundle;
  sampleHeight: (x: number, z: number) => number | null;
  setSignalStates?: (states: Readonly<Record<string, ControlIndication>>, timeSeconds: number) => number;
  clearSignalStates?: () => void;
  /** Auto framing is opt-in. Authored/free/editor policies preserve the user's view. */
  cameraPolicy?: CameraPolicy;
  /** Fixed presentation camera, used when policy is authored. */
  cameraView?: CameraView;
  /** An actor-local physical camera. The actor transform continues to come from the trace. */
  dashCamera?: { actorId: string; sensor: DashCameraSensor };
  /** Restore the editor/gallery view when this read-only replay is closed. */
  restoreCameraOnDispose?: boolean;
  /** Reuse the editor's persistent actor renderer and its GPU allocations. */
  renderer?: ActorRenderer;
  /** StudioTransport owns animation; this controller only samples/render frames. */
  externalClock?: boolean;
  /** Wrap at the trace boundary. Preview playback loops by default. */
  loop?: boolean;
  /** Restrict the one-time overview fit to these actors. */
  cameraActorIds?: readonly string[];
}

export interface DashCameraFrame {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly verticalFovDeg: number;
  readonly aspectRatio: number;
  readonly nearM: number;
  readonly farM: number;
}

/** Resolve an actor-local +X-forward/+Y-up/+Z-left sensor into scene space. */
export function dashCameraFrame(
  actor: Pick<SampledActor, 'x' | 'z' | 'headingRad'>,
  groundY: number,
  sensor: DashCameraSensor,
): DashCameraFrame {
  const actorRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), actor.headingRad);
  const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), sensor.mount.rotation.yawRad);
  const pitch = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), sensor.mount.rotation.pitchRad);
  const roll = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), sensor.mount.rotation.rollRad);
  const orientation = actorRotation.clone().multiply(yaw).multiply(pitch).multiply(roll);
  const mount = new Vector3(sensor.mount.position.x, sensor.mount.position.y, sensor.mount.position.z)
    .applyQuaternion(actorRotation);
  const position = new Vector3(actor.x, groundY, actor.z).add(mount);
  const forward = new Vector3(1, 0, 0).applyQuaternion(orientation).normalize();
  const up = new Vector3(0, 1, 0).applyQuaternion(orientation).normalize();
  const target = position.clone().addScaledVector(forward, 50);
  const horizontalRad = sensor.camera.horizontalFovDeg * Math.PI / 180;
  const verticalFovDeg = 2 * Math.atan(Math.tan(horizontalRad / 2) / sensor.camera.aspectRatio) * 180 / Math.PI;
  return {
    position: [position.x, position.y, position.z],
    target: [target.x, target.y, target.z],
    up: [up.x, up.y, up.z],
    verticalFovDeg,
    aspectRatio: sensor.camera.aspectRatio,
    nearM: sensor.camera.nearM,
    farM: sensor.camera.farM,
  };
}

/**
 * Project an exact trace playhead from a monotonic wall clock.
 *
 * Render cadence is deliberately absent from this calculation. Slow or
 * throttled renderers skip intermediate samples instead of slowing the
 * scenario itself down.
 */
export function realtimePlaybackTime(
  traceStart: number,
  wallStartMs: number,
  wallNowMs: number,
  traceEnd: number,
): number {
  const elapsedSeconds = Math.max(0, (wallNowMs - wallStartMs) / 1000);
  return Math.min(traceEnd, traceStart + elapsedSeconds);
}

export interface AllActorsCameraPlan {
  readonly actorIds: readonly string[];
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
}

export interface GalleryCameraChoice {
  readonly policy: 'subject-chase' | 'all-actors';
  readonly selectionId: string;
  readonly label: string;
  readonly reason: string;
  readonly subjectActorId: string | null;
}

/** Resolve Gallery presentation from physical sensor ownership in authoring order. */
export function galleryCameraChoice(bundle: PlaybackBundle): GalleryCameraChoice {
  const subjectActorId = bundle.instance.input.actors.find(
    (actor) => (actor.sensors?.length ?? 0) > 0
      && bundle.actors.some((metadata) => metadata.id === actor.id),
  )?.id;
  if (subjectActorId) {
    return {
      policy: 'subject-chase',
      selectionId: `subject-chase:${subjectActorId}`,
      label: `Trailing camera vehicle · ${subjectActorId}`,
      reason: `Following the sensor-bearing camera vehicle “${subjectActorId}”.`,
      subjectActorId,
    };
  }
  return {
    policy: 'all-actors',
    selectionId: 'all-actors',
    label: 'All actors overview',
    reason: 'All actors overview: this scenario has no sensor-bearing camera vehicle.',
    subjectActorId: null,
  };
}

/** Full-timeline authored bounds are independent of sensor ownership. */
export function buildAllActorsCameraPlan(
  bundle: PlaybackBundle,
  actorIds?: readonly string[],
): AllActorsCameraPlan | null {
  const selected = actorIds ? new Set(actorIds) : null;
  const authored = bundle.actors.filter((actor) => (
    !actor.id.startsWith('ambient-') && !actor.tags.some((tag) => tag.startsWith('ambient:'))
    && (!selected || selected.has(actor.id))
  ));
  const points: Array<{ x: number; z: number; pad: number }> = [];
  for (const actor of authored) {
    const track = bundle.trace.ticks.actors[actor.id];
    if (!track) continue;
    for (let index = 0; index < track.x.length; index++) {
      if (!track.present[index]) continue;
      points.push({ x: track.x[index]!, z: track.z[index]!, pad: Math.max(actor.dims.l, actor.dims.w) / 2 });
    }
  }
  if (!selected) {
    for (const prop of bundle.props) {
      points.push({ x: prop.pose.x, z: prop.pose.z, pad: Math.max(prop.dims.l, prop.dims.w) * prop.scale / 2 });
    }
  }
  if (points.length === 0) return null;
  const minX = Math.min(...points.map((point) => point.x - point.pad));
  const maxX = Math.max(...points.map((point) => point.x + point.pad));
  const minZ = Math.min(...points.map((point) => point.z - point.pad));
  const maxZ = Math.max(...points.map((point) => point.z + point.pad));
  return {
    actorIds: authored.map((actor) => actor.id).sort(),
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    radius: Math.max(10, Math.hypot(maxX - minX, maxZ - minZ) / 2),
  };
}

export function allActorsCameraView(plan: AllActorsCameraPlan, ground: number): CameraView {
  const distance = Math.max(24, plan.radius * 1.75);
  return {
    position: [plan.centerX + distance * 0.72, ground + Math.max(14, plan.radius * 1.05), plan.centerZ + distance * 0.72],
    target: [plan.centerX, ground + 1.4, plan.centerZ],
    fov: 52,
  };
}

export interface IncidentCameraPlan {
  readonly actorIds: readonly string[];
  readonly radius: number;
  readonly direction: Readonly<{ x: number; z: number }>;
  readonly fov: number;
}

/**
 * Derive one deterministic composition from the complete verified trace.
 * Only semantically critical actors participate, so ambient traffic or a remote
 * static prop cannot shrink the incident to a few pixels.
 */
export function buildIncidentCameraPlan(bundle: PlaybackBundle): IncidentCameraPlan | null {
  const metrics = bundle.trace.metrics;
  const declaredOcclusion = metrics.declaredOcclusion?.find((item) => (
    item.status === 'revealed_before_conflict' || item.status === 'blocked_at_conflict'
  ));
  const primaryPair = metrics.revealToConflict?.pair
    ?? declaredOcclusion?.pair
    ?? metrics.minPathTTC?.pair
    ?? metrics.minTTC?.pair
    ?? metrics.minPET?.pair
    ?? metrics.minDistance[0]?.pair
    ?? null;
  const ids = new Set<string>(primaryPair ?? []);
  if (metrics.revealToConflict) {
    ids.add(metrics.revealToConflict.observer);
    ids.add(metrics.revealToConflict.target);
    for (const id of metrics.revealToConflict.relevantOccluderIds) ids.add(id);
  }
  if (declaredOcclusion) {
    ids.add(declaredOcclusion.observer);
    ids.add(declaredOcclusion.target);
    for (const id of declaredOcclusion.relevantOccluderIds) ids.add(id);
  }
  if (ids.size === 0 && bundle.trace.header.metricSubject) ids.add(bundle.trace.header.metricSubject);
  if (ids.size < 2) {
    const authored = bundle.actors.filter((actor) => !actor.id.startsWith('ambient-'));
    for (const actor of authored) {
      ids.add(actor.id);
      if (ids.size >= 2) break;
    }
  }
  const actorIds = [...ids].filter((id) => bundle.trace.ticks.actors[id]).sort();
  if (actorIds.length === 0) return null;

  // Maximum simultaneous spread over the whole clip. The camera follows the
  // incident centroid but never changes zoom, avoiding both jitter and loss at
  // the reveal/conflict moment.
  let maxRadius = 0;
  const tickCount = bundle.trace.ticks.t.length;
  for (let tick = 0; tick < tickCount; tick++) {
    const points = actorIds.flatMap((id) => {
      const track = bundle.trace.ticks.actors[id]!;
      return track.present[tick] ? [{ x: track.x[tick]!, z: track.z[tick]! }] : [];
    });
    if (points.length === 0) continue;
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const cz = points.reduce((sum, point) => sum + point.z, 0) / points.length;
    for (const point of points) maxRadius = Math.max(maxRadius, Math.hypot(point.x - cx, point.z - cz));
  }

  const subjectId = bundle.trace.header.metricSubject && ids.has(bundle.trace.header.metricSubject)
    ? bundle.trace.header.metricSubject
    : actorIds[0]!;
  const otherId = actorIds.find((id) => id !== subjectId) ?? subjectId;
  const criticalT = metrics.revealToConflict?.conflictT
    ?? declaredOcclusion?.conflictT
    ?? metrics.minPathTTC?.t
    ?? metrics.minTTC?.t
    ?? metrics.minPET?.t
    ?? bundle.startTime;
  const criticalTick = bundle.trace.ticks.t.reduce((best, t, index) => (
    Math.abs(t - criticalT) < Math.abs(bundle.trace.ticks.t[best]! - criticalT) ? index : best
  ), 0);
  const subject = bundle.trace.ticks.actors[subjectId]!;
  const other = bundle.trace.ticks.actors[otherId]!;
  const dx = subject.x[criticalTick]! - other.x[criticalTick]!;
  const dz = subject.z[criticalTick]! - other.z[criticalTick]!;
  const length = Math.hypot(dx, dz);
  const heading = subject.headingRad[criticalTick] ?? 0;
  const direction = length > 0.1
    ? { x: dx / length, z: dz / length }
    : { x: -Math.cos(heading), z: Math.sin(heading) };
  const radius = Math.max(7, Math.min(34, maxRadius + 4));
  return { actorIds, radius, direction, fov: radius > 22 ? 48 : 42 };
}

const DOOR_NAMES = new Set<DoorName>(['left', 'right', 'rear']);
const DOOR_STATES = new Set<DoorState>(['closed', 'opening', 'open', 'closing']);

export interface PlaybackVehicleCues {
  readonly emergency: 'off' | 'flashing' | 'flashing_siren';
  readonly hornActive: boolean;
  readonly indicator: 'off' | 'left' | 'right' | 'hazard';
}

export function samplePlaybackVehicleCues(
  trace: Pick<SceneTrace, 'events'>,
  time: number,
): ReadonlyMap<string, PlaybackVehicleCues> {
  const sampled = new Map<string, PlaybackVehicleCues>();
  for (const event of trace.events) {
    if (event.kind !== 'state_set' || event.t > time) continue;
    const current = sampled.get(event.actorId) ?? { emergency: 'off', hornActive: false, indicator: 'off' };
    if (event.key === 'lights.emergency' && typeof event.value === 'string' && ['off', 'flashing', 'flashing_siren'].includes(event.value)) {
      sampled.set(event.actorId, { ...current, emergency: event.value as PlaybackVehicleCues['emergency'] });
    } else if (event.key === 'audio.horn' && typeof event.value === 'boolean') {
      sampled.set(event.actorId, { ...current, hornActive: event.value });
    } else if (event.key === 'lights.indicator' && typeof event.value === 'string' && ['off', 'left', 'right', 'hazard'].includes(event.value)) {
      sampled.set(event.actorId, { ...current, indicator: event.value as PlaybackVehicleCues['indicator'] });
    }
  }
  return sampled;
}

/** Sample the last recorded doors.* value at or before time; absent state is closed. */
export function samplePlaybackDoors(
  trace: Pick<SceneTrace, 'events'>,
  time: number,
): ReadonlyMap<string, DoorStates> {
  const sampled = new Map<string, Partial<Record<DoorName, DoorState>>>();
  for (const event of trace.events) {
    if (event.kind !== 'state_set' || !event.key.startsWith('doors.')) continue;
    const name = event.key.slice('doors.'.length) as DoorName;
    if (!DOOR_NAMES.has(name) || typeof event.value !== 'string' || !DOOR_STATES.has(event.value as DoorState)) {
      continue;
    }
    let actor = sampled.get(event.actorId);
    if (!actor) {
      actor = {};
      sampled.set(event.actorId, actor);
    }
    if (actor[name] === undefined) actor[name] = 'closed';
    if (event.t <= time) actor[name] = event.value as DoorState;
  }
  return sampled;
}

/** Drives the real Studio actor renderer from trace time, independent of React render cadence. */
export class PlaybackController {
  readonly renderer: ActorRenderer;
  readonly bundle: PlaybackBundle;

  private readonly viewer: CityViewer;
  private readonly sampleHeight: (x: number, z: number) => number | null;
  private readonly listeners = new Set<() => void>();
  private time: number;
  private playing = false;
  private readonly transport = new StudioTransport();
  private readonly metadataByActor: ReadonlyMap<string, PlaybackBundle['actors'][number]>;
  private sampled: readonly SampledActor[] = [];
  private sampledSignals: readonly SampledSignal[] = [];
  private renderedSignalHeadCount = 0;
  private cameraPolicy: CameraPolicy;
  private cameraSelectionId: string;
  private readonly allActorsCameraPlan: AllActorsCameraPlan | null;
  private readonly incidentCameraPlan: IncidentCameraPlan | null;
  private readonly galleryCameraChoice: GalleryCameraChoice;
  private readonly previousCameraView: CameraView | null;
  private readonly previousCameraMode: CameraMode | null;
  private readonly previousCameraUp: Vector3 | null;
  private readonly previousCameraProjection: { near: number; far: number; aspect: number } | null;
  private snapshot: PlaybackState;
  private presentationActive = false;
  private signalPresentationKey = '';

  constructor(private readonly options: PlaybackControllerOptions) {
    this.viewer = options.viewer;
    this.bundle = options.bundle;
    this.sampleHeight = options.sampleHeight;
    this.renderer = options.renderer ?? new ActorRenderer();
    this.metadataByActor = new Map(this.bundle.actors.map((actor) => [actor.id, actor]));
    this.cameraPolicy = options.cameraPolicy ?? 'free';
    this.galleryCameraChoice = galleryCameraChoice(this.bundle);
    this.cameraSelectionId = this.cameraPolicy === 'subject-chase'
      ? this.galleryCameraChoice.selectionId
      : this.cameraPolicy;
    this.allActorsCameraPlan = buildAllActorsCameraPlan(this.bundle, options.cameraActorIds);
    this.incidentCameraPlan = buildIncidentCameraPlan(this.bundle);
    this.previousCameraView = options.restoreCameraOnDispose
      ? this.viewer.controls.getView()
      : null;
    this.previousCameraMode = options.restoreCameraOnDispose
      ? ((this.viewer.controls as typeof this.viewer.controls & { mode?: CameraMode }).mode ?? 'orbit')
      : null;
    this.previousCameraUp = options.restoreCameraOnDispose ? this.viewer.camera.up.clone() : null;
    this.previousCameraProjection = options.restoreCameraOnDispose
      ? { near: this.viewer.camera.near, far: this.viewer.camera.far, aspect: this.viewer.camera.aspect }
      : null;
    this.time = this.bundle.startTime;
    this.transport.configure(
      (time) => this.renderAt(time),
      (time) => {
        this.time = time;
        if (time >= this.bundle.endTime && options.loop === false) this.playing = false;
        this.publish();
      },
    );
    if (!options.renderer) {
      this.renderer.group.name = 'playback-actors';
      this.viewer.scene.add(this.renderer.group);
    } else {
      this.renderer.setLayerVisible('playback', false);
    }
    if (this.cameraPolicy === 'dash-camera') this.viewer.setCameraPoseConstraintsEnabled(false);
    this.syncScene();
    if (this.cameraPolicy === 'all-actors') {
      this.frameAllActors();
    } else if (this.cameraPolicy === 'subject-chase') {
      this.frameSubjectChase();
    } else if (this.cameraPolicy === 'authored' && options.cameraView) {
      this.viewer.controls.applyView(options.cameraView);
    } else if (this.cameraPolicy === 'auto-incident') {
      this.frameActors();
    } else if (this.cameraPolicy === 'dash-camera') {
      this.frameDashCamera();
    }
    this.snapshot = this.buildState();
  }

  get state(): PlaybackState {
    return this.snapshot;
  }

  /** Current scene-frame actor samples, exposed for deterministic verification. */
  get currentActors(): readonly SampledActor[] {
    return this.sampled;
  }

  /** Current discrete signal states, exposed for deterministic verification/export capture. */
  get currentSignals(): readonly SampledSignal[] {
    return this.sampledSignals;
  }

  /** Re-assert trace-owned head colours after another provider releases them. */
  refreshSignalPresentation(): void {
    this.signalPresentationKey = '';
    this.syncScene();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PlaybackState => this.snapshot;

  /**
   * Swap only renderer presentation. The controller, trace, transport and
   * playhead remain alive while editor chrome is shown.
   */
  setPresentationActive(active: boolean): void {
    if (!this.options.renderer || this.presentationActive === active) return;
    this.presentationActive = active;
    this.renderer.setLayerVisible('playback', active);
    this.renderer.setLayerVisible('sumo-traffic', active);
    this.renderer.setLayerVisible('editor', !active);
    this.renderer.setLayerVisible('ambient-preview', !active);
    if (active) this.renderer.setSelection([]);
  }

  play(): void {
    if (this.playing) return;
    if (this.time >= this.bundle.endTime) this.time = this.bundle.startTime;
    this.playing = true;
    this.publish();
    if (this.options.externalClock) return;
    this.transport.play(this.time, this.bundle.endTime, {
      loop: this.options.loop ?? true,
      startTime: this.bundle.startTime,
    });
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.transport.pause();
    this.publish();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setCameraPolicy(policy: CameraPolicy): void {
    this.selectCamera(policy, policy);
  }

  selectCamera(selectionId: string, policy: CameraPolicy, view?: CameraView): void {
    const wasDashCamera = this.cameraPolicy === 'dash-camera';
    this.cameraPolicy = policy;
    this.cameraSelectionId = selectionId;
    if (wasDashCamera !== (policy === 'dash-camera')) {
      this.viewer.setCameraPoseConstraintsEnabled(policy !== 'dash-camera');
    }
    if (this.cameraPolicy === 'all-actors') this.frameAllActors();
    else if (this.cameraPolicy === 'subject-chase') this.frameSubjectChase();
    else if (this.cameraPolicy === 'auto-incident') this.frameActors();
    else if (this.cameraPolicy === 'authored' && view) this.viewer.controls.applyView(view);
    else if (this.cameraPolicy === 'dash-camera') this.frameDashCamera();
    this.publish();
  }

  seek(time: number): void {
    this.time = Math.max(this.bundle.startTime, Math.min(this.bundle.endTime, time));
    if (this.playing && !this.options.externalClock) this.transport.seek(this.time);
    this.syncScene();
    // The all-actors camera is an initial composition, not a playhead-owned
    // camera. Scrubbing must preserve any view the author established after
    // entering playback. Explicit following cameras still track their subject.
    if (this.cameraPolicy === 'subject-chase') this.frameSubjectChase();
    else if (this.cameraPolicy === 'auto-incident') this.frameActors();
    else if (this.cameraPolicy === 'dash-camera') this.frameDashCamera();
    this.publish();
  }

  /** Render an externally-owned transport frame without starting another RAF. */
  renderAt(time: number): void {
    this.time = Math.max(this.bundle.startTime, Math.min(this.bundle.endTime, time));
    this.syncScene();
    if (this.cameraPolicy === 'auto-incident') this.frameActors();
    else if (this.cameraPolicy === 'subject-chase') this.frameSubjectChase();
    else if (this.cameraPolicy === 'dash-camera') this.frameDashCamera();
  }

  dispose(): void {
    this.playing = false;
    this.transport.dispose();
    if (this.options.renderer) {
      this.renderer.clearLayer('playback');
      this.renderer.setLayerVisible('sumo-traffic', true);
      this.renderer.setLayerVisible('editor', true);
      this.renderer.setLayerVisible('ambient-preview', true);
    } else {
      this.renderer.dispose();
    }
    this.options.clearSignalStates?.();
    if (this.cameraPolicy === 'dash-camera') this.viewer.setCameraPoseConstraintsEnabled(true);
    if (this.previousCameraView) {
      const controls = this.viewer.controls as typeof this.viewer.controls & { setMode?: (mode: CameraMode) => void };
      controls.setMode?.('orbit');
      if (this.previousCameraUp) this.viewer.camera.up.copy(this.previousCameraUp);
      if (this.previousCameraProjection) {
        this.viewer.camera.near = this.previousCameraProjection.near;
        this.viewer.camera.far = this.previousCameraProjection.far;
        this.viewer.camera.aspect = this.previousCameraProjection.aspect;
        this.viewer.camera.updateProjectionMatrix();
      }
      this.viewer.controls.applyView(this.previousCameraView);
      if (this.previousCameraMode) controls.setMode?.(this.previousCameraMode);
    }
    this.listeners.clear();
  }

  private syncScene(): void {
    this.sampled = samplePlaybackActors(this.bundle, this.time).filter((actor) => !isInternalTrafficActor(actor));
    this.sampledSignals = samplePlaybackSignals(this.bundle, this.time);
    const doorsByActor = samplePlaybackDoors(this.bundle.trace, this.time);
    const cuesByActor = samplePlaybackVehicleCues(this.bundle.trace, this.time);
    const headStates: Record<string, ControlIndication> = {};
    for (const signal of this.sampledSignals) {
      for (const headId of signal.headIds) headStates[headId] = signal.phase;
    }
    const headIds = Object.keys(headStates).sort();
    // Traffic-light geometry only changes when a phase changes or the 2 Hz
    // flashing cadence crosses a boundary. Avoid rewriting instance colors on
    // every 120 Hz actor sample between those moments.
    const signalPresentationKey = `${Math.floor(Math.max(0, this.time) * 2)}:${headIds.map((id) => `${id}=${headStates[id]}`).join('|')}`;
    if (signalPresentationKey !== this.signalPresentationKey) {
      this.signalPresentationKey = signalPresentationKey;
      if (headIds.length > 0) {
        this.renderedSignalHeadCount = this.options.setSignalStates?.(headStates, this.time) ?? 0;
      } else {
        this.options.clearSignalStates?.();
        this.renderedSignalHeadCount = 0;
      }
    }
    const views: ActorView[] = this.sampled
      .filter((actor) => actor.present)
      .map((actor) => {
        const metadata = this.metadataByActor.get(actor.id);
        const cues = cuesByActor.get(actor.id);
        return {
          id: actor.id,
          catalogId: actor.catalogId,
          dims: actor.dims,
          x: actor.x,
          y: this.sampleHeight(actor.x, actor.z) ?? 0,
          z: actor.z,
          headingRad: actor.headingRad,
          animationTimeS: this.time,
          // A body on the ground has no gait: leaving speed here would keep the
          // walk cycle and the bob running while it slides.
          speedMps: (actor.downProgress ?? 0) > 0 ? 0 : actor.speedMps,
          reversing: actor.motionDirection === -1,
          ...((actor.downProgress ?? 0) > 0 ? { downProgress: actor.downProgress } : {}),
          ...(metadata ? { kind: metadata.kind } : {}),
          ...(metadata?.modelBasis === 'input-tag' ? { catalogIdAuthored: true } : {}),
          ...(metadata?.bodyColor ? { bodyColor: metadata.bodyColor } : {}),
          ...(doorsByActor.has(actor.id) ? { doors: doorsByActor.get(actor.id) } : {}),
          ...(cues ? { emergency: cues.emergency, hornActive: cues.hornActive, indicator: cues.indicator } : {}),
        } satisfies ActorView;
      });
    const sampledById = new Map(this.sampled.map((actor) => [actor.id, actor] as const));
    const propViews: ActorView[] = this.bundle.props.flatMap((prop) => {
      let x = prop.pose.x;
      let z = prop.pose.z;
      let headingRad = prop.pose.headingRad;
      let heightM = 0;
      if (prop.attachment) {
        const carrier = sampledById.get(prop.attachment.actorId);
        if (!carrier?.present) return [];
        const cos = Math.cos(carrier.headingRad);
        const sin = Math.sin(carrier.headingRad);
        x = carrier.x + cos * prop.attachment.longitudinalM - sin * prop.attachment.lateralM;
        z = carrier.z - sin * prop.attachment.longitudinalM - cos * prop.attachment.lateralM;
        headingRad = carrier.headingRad + prop.attachment.headingOffsetRad;
        heightM = prop.attachment.heightM;
      }
      return [{
        id: prop.id,
        catalogId: prop.catalogId,
        catalogIdAuthored: true,
        dims: {
          l: prop.dims.l * prop.scale,
          w: prop.dims.w * prop.scale,
          h: prop.dims.h * prop.scale,
        },
        x,
        y: (this.sampleHeight(x, z) ?? 0) + heightM,
        z,
        headingRad,
      }];
    });
    this.renderer.syncLayer(this.options.renderer ? 'playback' : 'editor', [...views, ...propViews]);
  }

  private frameActors(): void {
    const plan = this.incidentCameraPlan;
    const criticalIds = new Set(plan?.actorIds ?? []);
    const visible = this.sampled.filter((actor) => actor.present && criticalIds.has(actor.id));
    const actors = visible.length > 0
      ? visible
      : this.sampled.filter((actor) => criticalIds.has(actor.id));
    if (actors.length === 0) return;
    const centerX = actors.reduce((sum, actor) => sum + actor.x, 0) / actors.length;
    const centerZ = actors.reduce((sum, actor) => sum + actor.z, 0) / actors.length;
    const ground = this.sampleHeight(centerX, centerZ) ?? 0;
    const radius = plan?.radius ?? Math.max(8, ...actors.map((actor) => Math.hypot(actor.x - centerX, actor.z - centerZ)));

    // Prefer the incident pair's sightline over an arbitrary map diagonal. A
    // high top-down camera repeatedly landed behind Yale's roofs: technically
    // three transforms existed, but the result was another map-only video. The
    // trace already declares the metric pair and subject, so use that semantic
    // geometry to place a low, trailing observer. This is the same composition
    // basis used by the accepted still exporter, now inside the real Studio.
    const away = plan?.direction ?? { x: -Math.cos(actors[0]!.headingRad), z: Math.sin(actors[0]!.headingRad) };
    const side = { x: -away.z, z: away.x };
    const distance = Math.max(15, radius * 1.9);
    const sideOffset = Math.max(2.5, radius * 0.32);
    const eyeX = centerX + away.x * distance + side.x * sideOffset;
    const eyeZ = centerZ + away.z * distance + side.z * sideOffset;
    const camera = this.viewer.camera;
    if (camera.isPerspectiveCamera) {
      camera.fov = plan?.fov ?? 46;
      camera.updateProjectionMatrix();
    }
    this.viewer.controls.setView(
      new Vector3(eyeX, ground + Math.max(5, radius * 0.72), eyeZ),
      new Vector3(centerX, ground + 1.35, centerZ),
    );
  }

  private frameAllActors(): void {
    const plan = this.allActorsCameraPlan;
    if (!plan) return;
    this.viewer.controls.applyView(allActorsCameraView(plan, this.sampleHeight(plan.centerX, plan.centerZ) ?? 0));
  }

  private frameSubjectChase(): void {
    const subjectActorId = this.galleryCameraChoice.subjectActorId;
    if (!subjectActorId) {
      this.frameAllActors();
      return;
    }
    const subject = this.sampled.find((actor) => actor.id === subjectActorId && actor.present);
    const metadata = this.bundle.actors.find((actor) => actor.id === subjectActorId);
    if (!subject || !metadata) return;
    const forwardX = Math.cos(subject.headingRad);
    const forwardZ = -Math.sin(subject.headingRad);
    const distance = Math.max(7.5, metadata.dims.l * 1.7);
    const ground = this.sampleHeight(subject.x, subject.z) ?? 0;
    const eyeX = subject.x - forwardX * distance;
    const eyeZ = subject.z - forwardZ * distance;
    const eyeGround = this.sampleHeight(eyeX, eyeZ) ?? ground;
    const camera = this.viewer.camera;
    if (camera.isPerspectiveCamera) {
      camera.fov = 58;
      camera.updateProjectionMatrix();
    }
    this.viewer.controls.setView(
      new Vector3(eyeX, eyeGround + Math.max(3.2, metadata.dims.h + 1.7), eyeZ),
      new Vector3(
        subject.x + forwardX * Math.max(5, metadata.dims.l),
        ground + Math.max(1.2, metadata.dims.h * 0.65),
        subject.z + forwardZ * Math.max(5, metadata.dims.l),
      ),
    );
  }

  private frameDashCamera(): void {
    const selection = this.options.dashCamera;
    if (!selection) return;
    const actor = this.sampled.find((sample) => sample.id === selection.actorId && sample.present);
    if (!actor) return;
    const frame = dashCameraFrame(actor, this.sampleHeight(actor.x, actor.z) ?? 0, selection.sensor);
    const camera = this.viewer.camera;
    camera.up.set(frame.up[0], frame.up[1], frame.up[2]);
    camera.fov = frame.verticalFovDeg;
    camera.aspect = frame.aspectRatio;
    camera.near = frame.nearM;
    camera.far = frame.farM;
    camera.updateProjectionMatrix();
    this.viewer.controls.setView(
      new Vector3(frame.position[0], frame.position[1], frame.position[2]),
      new Vector3(frame.target[0], frame.target[1], frame.target[2]),
    );
  }

  private publish(): void {
    this.snapshot = this.buildState();
    for (const listener of [...this.listeners]) listener();
  }

  private buildState(): PlaybackState {
    const signalPhases = Object.fromEntries(CONTROL_INDICATIONS.map((phase) => [phase, 0])) as Record<ControlIndication, number>;
    let signalHeadCount = 0;
    for (const signal of this.sampledSignals) {
      signalPhases[signal.phase] += 1;
      signalHeadCount += signal.headIds.length;
    }
    return {
      time: this.time,
      startTime: this.bundle.startTime,
      endTime: this.bundle.endTime,
      playing: this.playing,
      actorCount: this.bundle.actors.length,
      visibleActorCount: this.sampled.filter((actor) => actor.present).length,
      propCount: this.bundle.props.length,
      signalCount: this.sampledSignals.length,
      signalHeadCount,
      renderedSignalHeadCount: this.renderedSignalHeadCount,
      signalPhases,
      signalTimingSources: [...new Set(this.sampledSignals.map((signal) => signal.timingSource))].sort(),
      instanceId: this.bundle.instance.manifest.instanceId,
      inputHash: this.bundle.instance.manifest.inputHash,
      cameraPolicy: this.cameraPolicy,
      cameraSelectionId: this.cameraSelectionId,
      cameraReason: this.cameraPolicy === 'subject-chase' || this.cameraPolicy === 'all-actors'
        ? this.galleryCameraChoice.reason
        : '',
    };
  }
}
