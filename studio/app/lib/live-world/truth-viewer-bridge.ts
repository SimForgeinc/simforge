import type { TruthFrame } from '@simforge-oss/training-env/browser';
import {
  ThreeRendererAdapter,
  followCameraPose,
  indexedWorldHeightSampler,
  type ActorRenderState,
  type CityViewer,
} from '@simforge-oss/viewer';

export interface TruthViewerBridge {
  apply(frame: TruthFrame): void;
  setFollow(actorId: string | null, mode?: 'chase' | 'dash'): void;
  dispose(): void;
}

export function createTruthViewerBridge(
  viewer: CityViewer,
  opts: { layer?: string; groundLift?: boolean } = {},
): TruthViewerBridge {
  const layer = opts.layer ?? 'live-world';
  const shouldGroundLift = opts.groundLift ?? true;
  const adapter = new ThreeRendererAdapter(viewer);
  const sampleGround = indexedWorldHeightSampler(viewer);
  const previousFrameHook = viewer.onFrame;
  let earlier: TruthFrame | null = null;
  let latest: TruthFrame | null = null;
  let elapsedSinceLatest = 0;
  let followId: string | null = null;
  let followMode: 'chase' | 'dash' = 'chase';
  let disposed = false;
  let lastRendered = new Map<string, ActorRenderState>();

  viewer.scene.add(adapter.actors.group);

  const render = (dt: number): void => {
    if (disposed || !latest) return;
    elapsedSinceLatest += Math.max(0, dt);
    const duration = earlier ? latest.timeSec - earlier.timeSec : 0;
    const alpha = duration > 0 ? Math.min(1, elapsedSinceLatest / duration) : 1;
    const priorActors = earlier ? sceneActors(earlier) : new Map();
    const metadata = new Map(latest.actors.map((actor) => [actor.id, actor]));
    const groundReady = shouldGroundLift && viewer.getGroundIndex() !== null;
    const actors: ActorRenderState[] = [];

    for (const current of latest.scene.actors) {
      if (current.kind === 'despawn') continue;
      const meta = metadata.get(current.id);
      if (!meta) continue;
      const prior = priorActors.get(current.id);
      const x = prior ? interpolate(prior.position[0], current.position[0], alpha) : current.position[0];
      const z = prior ? interpolate(prior.position[2], current.position[2], alpha) : current.position[2];
      const headingRad = prior ? interpolateAngle(prior.yawRad, current.yawRad, alpha) : current.yawRad;
      const y = groundReady ? sampleGround(x, z) ?? current.position[1] : current.position[1];
      actors.push({
        id: current.id,
        catalogId: catalogIdFor(meta.class),
        catalogIdAuthored: false,
        x,
        y,
        z,
        headingRad,
        dims: meta.dims,
        kind: renderKindFor(meta.class),
        speedMps: Math.hypot(current.velocity[0], current.velocity[2]),
      });
    }

    if (disposed) return;
    adapter.applyActorFrame({
      contractVersion: adapter.contractVersion,
      layer,
      tick: latest.tick,
      timeS: latest.timeSec,
      actors,
    });
    lastRendered = new Map(actors.map((actor) => [actor.id, actor]));
    if (followId) applyFollow();
  };

  const frameHook = (dt: number): void => {
    previousFrameHook?.(dt);
    render(dt);
  };
  viewer.onFrame = frameHook;

  const applyFollow = (): void => {
    if (!followId || disposed) return;
    const actor = lastRendered.get(followId);
    if (!actor) return;
    const pose = followCameraPose(actor, followMode);
    viewer.controls.applyView({
      position: pose.position,
      target: pose.target,
      fov: viewer.camera.fov,
    });
  };

  return {
    apply(frame) {
      if (disposed) return;
      if (latest && frame.tick <= latest.tick) return;
      earlier = latest;
      latest = frame;
      elapsedSinceLatest = 0;
      render(0);
    },
    setFollow(actorId, mode = 'chase') {
      if (disposed) return;
      followId = actorId;
      followMode = mode;
      viewer.controls.setEnabled(actorId === null);
      if (actorId) applyFollow();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      followId = null;
      viewer.controls.setEnabled(true);
      if (viewer.onFrame === frameHook) viewer.onFrame = previousFrameHook;
      adapter.actors.clearLayer(layer);
      adapter.actors.dispose();
      earlier = null;
      latest = null;
      lastRendered.clear();
    },
  };
}

function sceneActors(frame: TruthFrame): Map<string, TruthFrame['scene']['actors'][number]> {
  return new Map(frame.scene.actors.filter((actor) => actor.kind !== 'despawn').map((actor) => [actor.id, actor]));
}

function interpolate(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

function interpolateAngle(from: number, to: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * alpha;
}

function catalogIdFor(actorClass: TruthFrame['actors'][number]['class']): string {
  switch (actorClass) {
    case 'truck': return 'vehicle.box_truck';
    case 'bus': return 'vehicle.bus';
    case 'motorcycle': return 'vehicle.motorcycle';
    case 'bicycle': return 'vehicle.bicycle';
    case 'pedestrian': return 'pedestrian.adult';
    case 'prop': return 'object.cone';
    default: return 'vehicle.sedan';
  }
}

function renderKindFor(actorClass: TruthFrame['actors'][number]['class']): ActorRenderState['kind'] {
  return actorClass === 'prop' ? 'static_object' : actorClass;
}
