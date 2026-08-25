/**
 * Three-viewer adapter for simforge.renderer-contract/v1.
 *
 * Proves — at compile time and in the parity-fixture tests — that the
 * existing packaged Three WebGL viewer (`CityViewer` + `ActorRenderer`)
 * satisfies the renderer-neutral contract for the camera, pick, and actor
 * paths the scenario editor actually drives. This is a thin wrapper, not a
 * migration: internals keep their proven implementations, and nothing here
 * changes rendering behaviour.
 *
 * Two compile-level proofs live in this file:
 * 1. `ActorRenderState` (contract) is assignable to `ActorView` (renderer),
 *    so contract frames drive the real instanced renderer without mapping.
 * 2. `CityViewer` is assignable to `ThreeAdapterHost`, the narrow structural
 *    slice this adapter needs — the same trick the editor's
 *    `viewer-contract.ts` uses, so the renderer never learns the contract
 *    exists.
 */

import { InstancedMesh, PerspectiveCamera, Raycaster, SpotLight, Vector2 } from 'three';
import { ActorRenderer, MAX_PROJECTED_HEADLIGHTS, type ActorView } from './actorRenderer';
import type { CameraView } from './camera-controls';
import { DEFAULT_ACTIVE_LUMINAIRE_LIMIT } from './luminaire-lighting';
import type { CityViewer } from './viewer';
import {
  PROJECTED_HEADLIGHT_LIMIT,
  RENDERER_CONTRACT_VERSION,
  STREET_LUMINAIRE_ACTIVE_LIMIT,
  frameCameraPose,
  followCameraPose,
  type ActorFrameBatch,
  type ActorRenderState,
  type CameraCommand,
  type CameraStateReport,
  type LightStateReport,
  type PickHit,
  type PickRequest,
  type PickResult,
  type VehicleLightState,
} from './renderer-contract';

// --- Compile-level proofs (exported so tsup/tsc cannot tree-shake them away).

/** Contract actor states ARE renderer actor views; drift breaks the build. */
export const contractActorToView = (state: ActorRenderState): ActorView => state;

/** The contract's bounded-light constants restate the renderer's; drift breaks the build. */
const _headlightLimitPinned: typeof MAX_PROJECTED_HEADLIGHTS = PROJECTED_HEADLIGHT_LIMIT;
const _luminaireLimitPinned: typeof DEFAULT_ACTIVE_LUMINAIRE_LIMIT = STREET_LUMINAIRE_ACTIVE_LIMIT;
void _headlightLimitPinned;
void _luminaireLimitPinned;

/**
 * The structural slice of {@link CityViewer} this adapter needs — camera,
 * rig, and the constraint toggle. Headless tests construct a bare host; the
 * editor surface passes its real `CityViewer`.
 */
export interface ThreeAdapterHost {
  readonly camera: PerspectiveCamera;
  readonly controls: {
    getView(): CameraView;
    applyView(view: CameraView): void;
    setEnabled(enabled: boolean): void;
  };
  setCameraPoseConstraintsEnabled(enabled: boolean): void;
}

/** CityViewer satisfies the host slice; drift breaks the build. */
export const cityViewerAsAdapterHost = (viewer: CityViewer): ThreeAdapterHost => viewer;

/**
 * Contract camera report of a live host — the exchange format editor
 * features (e.g. the studio high-fidelity preview request) send to
 * out-of-process renderers. The adapter's `cameraState()` delegates here so
 * a report captured off the raw viewer is byte-identical to one captured
 * through the adapter.
 */
export function cameraStateReport(host: Pick<ThreeAdapterHost, 'camera' | 'controls'>): CameraStateReport {
  const camera = host.camera;
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const view = host.controls.getView();
  return {
    pose: { position: view.position, target: view.target },
    intrinsics: { fovYDeg: camera.fov, aspect: camera.aspect, near: camera.near, far: camera.far },
    viewMatrix: [...camera.matrixWorldInverse.elements],
    projectionMatrix: [...camera.projectionMatrix.elements],
  };
}

const IGNORED_PICK_STATES: readonly string[] = ['lights.lowBeam', 'lights.emergency', 'reversing'];

/**
 * Contract adapter over the packaged Three WebGL viewer. Owns an
 * {@link ActorRenderer} whose group the caller mounts wherever the editor
 * mounts it today (`viewer.scene.add(adapter.actors.group)`).
 */
export class ThreeRendererAdapter {
  readonly contractVersion = RENDERER_CONTRACT_VERSION;
  readonly actors: ActorRenderer;

  private readonly host: ThreeAdapterHost;
  private readonly raycaster = new Raycaster();
  private lastFrame: ActorFrameBatch | null = null;
  private globalLowBeams = false;

  constructor(host: ThreeAdapterHost, actors = new ActorRenderer()) {
    this.host = host;
    this.actors = actors;
  }

  // --- Camera path -----------------------------------------------------

  applyCameraCommand(command: CameraCommand): void {
    const camera = this.host.camera;
    switch (command.kind) {
      case 'set-pose': {
        this.host.controls.applyView({
          position: command.pose.position,
          target: command.pose.target,
          fov: camera.fov,
        });
        return;
      }
      case 'set-intrinsics': {
        camera.fov = command.intrinsics.fovYDeg;
        camera.aspect = command.intrinsics.aspect;
        camera.near = command.intrinsics.near;
        camera.far = command.intrinsics.far;
        camera.updateProjectionMatrix();
        return;
      }
      case 'frame': {
        const pose = frameCameraPose(
          command.bounds,
          { fovYDeg: camera.fov, aspect: camera.aspect },
          command.azimuthRad,
          command.elevationRad,
        );
        this.host.controls.applyView({ position: pose.position, target: pose.target, fov: camera.fov });
        return;
      }
      case 'follow': {
        if (command.attachment.kind !== 'actor') return;
        const actor = this.lastFrame?.actors.find((entry) => entry.id === command.attachment.id);
        if (!actor) return;
        const pose = followCameraPose(actor, command.mode);
        this.host.controls.applyView({ position: pose.position, target: pose.target, fov: camera.fov });
        return;
      }
      case 'set-constraints-enabled': {
        this.host.setCameraPoseConstraintsEnabled(command.enabled);
        return;
      }
    }
  }

  cameraState(): CameraStateReport {
    return cameraStateReport(this.host);
  }

  // --- Actor frame path --------------------------------------------------

  /** Environment-driven low-beam default (authored darkness). */
  setGlobalLowBeams(enabled: boolean): void {
    this.globalLowBeams = enabled;
    this.actors.setHeadlightsEnabled(enabled);
  }

  applyActorFrame(batch: ActorFrameBatch): void {
    this.lastFrame = batch;
    this.actors.syncLayer(batch.layer, batch.actors.map(contractActorToView));
  }

  // --- Pick path -----------------------------------------------------------

  pick(request: PickRequest): PickResult {
    this.host.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new Vector2(request.ndc.x, request.ndc.y), this.host.camera);
    const intersections = this.raycaster.intersectObjects(this.actors.pickables(), true);
    const hits: PickHit[] = [];
    const seen: Record<string, true> = {};
    for (const intersection of intersections) {
      // Light/cue volumes are pickable scene objects but not selection targets.
      if (IGNORED_PICK_STATES.includes(String(intersection.object.userData.state ?? ''))) continue;
      const id = this.actors.actorIdForHit(intersection);
      if (id !== null && seen[id]) continue;
      if (id !== null) seen[id] = true;
      hits.push({
        layer: 'actors',
        id,
        distanceM: intersection.distance,
        point: [intersection.point.x, intersection.point.y, intersection.point.z],
      });
      if (hits.length >= (request.maxHits ?? 8)) break;
    }
    return { hits };
  }

  // --- Light state -----------------------------------------------------

  /**
   * Report per-vehicle light truth from the *observed* renderer scene graph
   * (batch `userData.actorIds`), not by re-deriving from inputs — the fixture
   * test compares this against the contract's normative derivation.
   */
  lightStates(): LightStateReport {
    const lensIds = this.batchActorIds('actor-headlights');
    const beamCount = this.actors.group.children
      .filter((child) => child instanceof SpotLight && child.visible).length;
    const sortedLens = [...new Set(lensIds)].sort((a, b) => a.localeCompare(b));
    const beamIds = new Set(sortedLens.slice(0, beamCount));
    const emergencyIds = new Set(this.batchActorIds('actor-emergency-red'));
    const leftIds = new Set(this.batchActorIds('actor-indicator-left'));
    const rightIds = new Set(this.batchActorIds('actor-indicator-right'));
    const reverseIds = new Set(this.batchActorIds('actor-reverse-lights'));

    const actorIds = new Set<string>([
      ...sortedLens, ...emergencyIds, ...leftIds, ...rightIds, ...reverseIds,
    ]);
    const vehicles: VehicleLightState[] = [];
    for (const actorId of [...actorIds].sort((a, b) => a.localeCompare(b))) {
      const state = this.lastFrame?.actors.find((actor) => actor.id === actorId);
      const left = leftIds.has(actorId);
      const right = rightIds.has(actorId);
      vehicles.push({
        actorId,
        lowBeams: sortedLens.includes(actorId),
        projectedBeam: beamIds.has(actorId),
        emergency: emergencyIds.has(actorId) ? (state?.emergency ?? 'flashing') : 'off',
        indicator: left && right ? 'hazard' : left ? 'left' : right ? 'right' : 'off',
        reverseLight: reverseIds.has(actorId),
      });
    }
    return {
      streetLighting: { enabled: this.globalLowBeams, activeLimit: STREET_LUMINAIRE_ACTIVE_LIMIT },
      vehicles,
    };
  }

  dispose(): void {
    this.actors.dispose();
  }

  private batchActorIds(name: string): string[] {
    const mesh = this.actors.group.getObjectByName(name);
    if (!(mesh instanceof InstancedMesh) || !mesh.visible || mesh.count === 0) return [];
    // Same convention as ActorRenderer.actorIdForHit: userData.actorIds is the
    // renderer-owned id band written by syncLayer.
    const ids = mesh.userData.actorIds as string[] | undefined;
    return (ids ?? []).slice(0, mesh.count);
  }
}
