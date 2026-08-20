import type { SimEvent } from '@uniscenarios/sim-engine';
import { describe, expect, it, vi } from 'vitest';
import type { PlaybackBundle } from '../model';
import { Group, PerspectiveCamera, Scene, Vector3 } from 'three';
import {
  PlaybackController,
  allActorsCameraView,
  buildAllActorsCameraPlan,
  buildIncidentCameraPlan,
  dashCameraFrame,
  galleryCameraChoice,
  realtimePlaybackTime,
  samplePlaybackDoors,
  samplePlaybackVehicleCues,
} from '../controller';
import { DashCameraSensorSchema } from '@uniscenarios/scenario-model';

describe('actor dash-camera transform', () => {
  const sensor = DashCameraSensorSchema.parse({
    id: 'front-camera',
    type: 'dash_camera',
    enabled: true,
    mount: {
      position: { x: 2, y: 1.2, z: 0.25 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    },
    camera: { horizontalFovDeg: 90, nearM: 0.05, farM: 500, aspectRatio: 16 / 9 },
  });

  it('mounts at actor-local position and looks along actor forward', () => {
    const frame = dashCameraFrame({ x: 10, z: 20, headingRad: 0 }, 3, sensor);
    expect(frame.position).toEqual([12, 4.2, 20.25]);
    expect(frame.target[0]).toBeGreaterThan(frame.position[0]);
    expect(frame.target[2]).toBeCloseTo(frame.position[2]);
    expect(frame.verticalFovDeg).toBeCloseTo(58.7155, 3);
    expect(frame).toMatchObject({ nearM: 0.05, farM: 500, aspectRatio: 16 / 9 });
  });

  it('rotates the physical mount and view every frame with the trace heading', () => {
    const frame = dashCameraFrame({ x: -4, z: 8, headingRad: Math.PI / 2 }, 0, sensor);
    expect(frame.position[0]).toBeCloseTo(-3.75);
    expect(frame.position[2]).toBeCloseTo(6);
    expect(frame.target[2]).toBeLessThan(frame.position[2]);
  });
});

describe('real-time playback pacing', () => {
  it('switches shared renderer layers without replacing playback state', () => {
    const setLayerVisible = vi.fn();
    const renderer = {
      syncLayer: vi.fn(),
      setSelection: vi.fn(),
      setLayerVisible,
      clearLayer: vi.fn(),
    };
    const bundle = cameraBundle({ subject: 'ego', pair: ['ego', 'other'], tracks: { ego: [[0, 0]], other: [[2, 0]] } });
    (bundle.actors.find((actor) => actor.id === 'ego') as { bodyColor?: string }).bodyColor = '#8c2f2f';
    const controller = new PlaybackController({
      viewer: {
        camera: new PerspectiveCamera(55, 16 / 9, 0.1, 2000),
        scene: new Scene(),
        controls: { getView: vi.fn(), applyView: vi.fn(), setView: vi.fn() },
      } as never,
      bundle,
      sampleHeight: () => 0,
      renderer: renderer as never,
    });
    const bundleIdentity = controller.bundle;
    controller.setPresentationActive(true);
    controller.seek(0);
    const playbackViews = renderer.syncLayer.mock.calls
      .filter(([layer]) => layer === 'playback')
      .at(-1)?.[1];
    expect(playbackViews).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ego', bodyColor: '#8c2f2f' }),
    ]));
    controller.setPresentationActive(false);
    expect(controller.bundle).toBe(bundleIdentity);
    expect(setLayerVisible).toHaveBeenCalledWith('playback', true);
    expect(setLayerVisible).toHaveBeenCalledWith('editor', false);
    expect(setLayerVisible).toHaveBeenCalledWith('playback', false);
    expect(setLayerVisible).toHaveBeenCalledWith('editor', true);
    controller.dispose();
  });

  it('drops render frames instead of stretching a verified 20-second trace', () => {
    // Representative software/headless cadence: only seven rendered frames
    // arrive during the entire clip. The playhead must still track wall time.
    const renderedAtMs = [0, 3_500, 7_000, 10_500, 14_000, 17_500, 20_250];
    const sampled = renderedAtMs.map((now) => realtimePlaybackTime(0, 0, now, 20));
    expect(sampled).toEqual([0, 3.5, 7, 10.5, 14, 17.5, 20]);
    expect(sampled.at(-1)).toBe(20);
    expect(renderedAtMs.at(-1)! / 1000 - sampled.at(-1)!).toBeLessThanOrEqual(0.25);
  });

  it('preserves pause/resume offsets and clamps to the exact evidence envelope', () => {
    expect(realtimePlaybackTime(8.27, 24_000, 25_000, 20)).toBeCloseTo(9.27);
    expect(realtimePlaybackTime(8.27, 24_000, 60_000, 20)).toBe(20);
    expect(realtimePlaybackTime(8.27, 24_000, 23_000, 20)).toBe(8.27);
  });

  it('completes the real controller at 20 seconds under a throttled RAF cadence', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
    });
    let nextFrame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const camera = new PerspectiveCamera(55, 16 / 9, 0.1, 2000);
    const controller = new PlaybackController({
      viewer: {
        camera,
        scene: new Scene(),
        controls: {
          getView: () => ({ position: [0, 10, 20], target: [0, 0, 0], fov: 55 }),
          applyView: () => undefined,
          setView: () => undefined,
        },
      } as never,
      bundle: cameraBundle({ subject: 'ego', pair: ['ego', 'other'], tracks: { ego: [[0, 0], [10, 0], [20, 0]], other: [[4, 2], [8, 2], [12, 2]] } }),
      sampleHeight: () => 0,
      loop: false,
    });
    try {
      expect(controller.state).toMatchObject({ time: 0, playing: false });
      controller.play();
      expect(controller.state).toMatchObject({ time: 0, playing: true });
      for (const wallMs of [3_500, 7_000, 10_500, 14_000, 17_500, 20_250]) {
        const callback = nextFrame as FrameRequestCallback | null;
        expect(callback).not.toBeNull();
        callback!(wallMs);
      }
      expect(controller.state.time).toBe(20);
      expect(controller.state.playing).toBe(false);
    } finally {
      controller.dispose();
      now.mockRestore();
      vi.unstubAllGlobals();
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });

  it('loops by default instead of freezing on the final frame', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
    });
    let nextFrame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const controller = new PlaybackController({
      viewer: {
        camera: new PerspectiveCamera(55, 16 / 9, 0.1, 2000),
        scene: new Scene(),
        controls: {
          getView: () => ({ position: [0, 10, 20], target: [0, 0, 0], fov: 55 }),
          applyView: () => undefined,
          setView: () => undefined,
        },
      } as never,
      bundle: cameraBundle({ subject: 'ego', pair: ['ego', 'other'], tracks: { ego: [[0, 0], [10, 0], [20, 0]], other: [[4, 2], [8, 2], [12, 2]] } }),
      sampleHeight: () => 0,
    });
    try {
      controller.play();
      (nextFrame as FrameRequestCallback | null)!(20_250);
      expect(controller.state.time).toBeCloseTo(0.25);
      expect(controller.state.playing).toBe(true);
      expect(nextFrame).not.toBeNull();
    } finally {
      controller.dispose();
      now.mockRestore();
      vi.unstubAllGlobals();
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });
});

describe('playback door sampling', () => {
  it('samples each actor and door independently with a closed pre-event pose', () => {
    const events: SimEvent[] = [
      { t: 1, kind: 'state_set', actorId: 'parked', key: 'doors.left', value: 'opening' },
      { t: 2, kind: 'state_set', actorId: 'parked', key: 'doors.left', value: 'open' },
      { t: 1.5, kind: 'state_set', actorId: 'van', key: 'doors.rear', value: 'open' },
      { t: 0.5, kind: 'state_set', actorId: 'parked', key: 'lights.brake', value: true },
    ];

    expect(samplePlaybackDoors({ events }, 0).get('parked')).toEqual({ left: 'closed' });
    expect(samplePlaybackDoors({ events }, 1).get('parked')).toEqual({ left: 'opening' });
    expect(samplePlaybackDoors({ events }, 2).get('parked')).toEqual({ left: 'open' });
    expect(samplePlaybackDoors({ events }, 1).get('van')).toEqual({ rear: 'closed' });
    expect(samplePlaybackDoors({ events }, 2).get('van')).toEqual({ rear: 'open' });
  });

  it('keeps simultaneous state events deterministic in trace order', () => {
    const events: SimEvent[] = [
      { t: 3, kind: 'state_set', actorId: 'car', key: 'doors.right', value: 'opening' },
      { t: 3, kind: 'state_set', actorId: 'car', key: 'doors.right', value: 'open' },
    ];
    expect(samplePlaybackDoors({ events }, 3).get('car')).toEqual({ right: 'open' });
  });
});

describe('playback emergency cue sampling', () => {
  it('samples ambulance beacons, siren and horn state at the playhead', () => {
    const events: SimEvent[] = [
      { t: 1, kind: 'state_set', actorId: 'ambulance', key: 'lights.emergency', value: 'flashing_siren' },
      { t: 2, kind: 'state_set', actorId: 'ambulance', key: 'audio.horn', value: true },
      { t: 3, kind: 'state_set', actorId: 'ambulance', key: 'audio.horn', value: false },
      { t: 2.5, kind: 'state_set', actorId: 'ambulance', key: 'lights.indicator', value: 'left' },
    ];
    expect(samplePlaybackVehicleCues({ events }, 0).get('ambulance')).toBeUndefined();
    expect(samplePlaybackVehicleCues({ events }, 1).get('ambulance')).toEqual({ emergency: 'flashing_siren', hornActive: false, indicator: 'off' });
    expect(samplePlaybackVehicleCues({ events }, 2.5).get('ambulance')).toEqual({ emergency: 'flashing_siren', hornActive: true, indicator: 'left' });
    expect(samplePlaybackVehicleCues({ events }, 4).get('ambulance')).toEqual({ emergency: 'flashing_siren', hornActive: false, indicator: 'left' });
  });
});

describe('Gallery incident camera planning', () => {
  it('frames scenario 01 from the critical pair and occluder, not remote ambient traffic', () => {
    const bundle = cameraBundle({
      subject: 'driver',
      pair: ['driver', 'worker'],
      occluders: ['pipe-carrier'],
      tracks: {
        driver: [[0, 0], [10, 0], [20, 0]],
        worker: [[8, 3], [12, 2], [16, 1]],
        'pipe-carrier': [[9, 1], [11, 1], [13, 1]],
        'ambient-remote': [[900, 900], [950, 950], [1000, 1000]],
      },
    });
    const plan = buildIncidentCameraPlan(bundle);
    expect(plan?.actorIds).toEqual(['driver', 'pipe-carrier', 'worker']);
    expect(plan?.radius).toBeLessThan(20);
    expect(plan?.direction.x).toBeLessThan(0);
  });

  it('is deterministic across representative cross-map coordinate ranges', () => {
    const yale = cameraBundle({
      subject: 'ego', pair: ['ego', 'pedestrian'],
      tracks: { ego: [[100, -50], [110, -50]], pedestrian: [[106, -44], [106, -43]] },
    });
    const easterbrook = cameraBundle({
      subject: 'ego', pair: ['ego', 'wrong-way'],
      tracks: { ego: [[-420, 730], [-410, 730]], 'wrong-way': [[-414, 731], [-416, 731]] },
    });
    expect(buildIncidentCameraPlan(yale)).toEqual(buildIncidentCameraPlan(yale));
    expect(buildIncidentCameraPlan(easterbrook)).toEqual(buildIncidentCameraPlan(easterbrook));
    expect(buildIncidentCameraPlan(yale)?.radius).toBeLessThan(20);
    expect(buildIncidentCameraPlan(easterbrook)?.radius).toBeLessThan(20);
  });

  it('restores the pre-replay camera when returning to the Gallery', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
    });
    type TestView = { readonly position: readonly [number, number, number]; readonly target: readonly [number, number, number]; readonly fov: number };
    const original: TestView = { position: [1, 12, 24], target: [1, 0, 2], fov: 55 };
    let current: TestView = original;
    const camera = new PerspectiveCamera(55, 16 / 9, 0.1, 2000);
    const scene = new Scene();
    const viewer = {
      camera,
      scene,
      controls: {
        getView: () => current,
        applyView: (view: TestView) => { current = view; },
        setView: (position: Vector3, target: Vector3) => {
          current = { position: position.toArray() as [number, number, number], target: target.toArray() as [number, number, number], fov: camera.fov };
        },
      },
    };
    const replayView = { position: [40, 6, 20], target: [10, 1, 0], fov: 42 } as const;
    try {
      const controller = new PlaybackController({
        viewer: viewer as never,
        bundle: cameraBundle({ subject: 'ego', pair: ['ego', 'pedestrian'], tracks: { ego: [[0, 0], [2, 0]], pedestrian: [[3, 2], [3, 1]] } }),
        sampleHeight: () => 0,
        cameraPolicy: 'authored',
        cameraView: replayView,
        restoreCameraOnDispose: true,
      });
      expect(current).toEqual(replayView);
      controller.dispose();
      expect(current).toEqual(original);
      // ActorRenderer is completely detached as part of the same Gallery return.
      expect(scene.children.filter((child) => child instanceof Group && child.name === 'playback-actors')).toHaveLength(0);
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });
});

describe('all-actors playback camera', () => {
  it('keeps an author-adjusted viewport unchanged when the playhead seeks', () => {
    const applyView = vi.fn();
    const controller = new PlaybackController({
      viewer: {
        camera: new PerspectiveCamera(55, 16 / 9, 0.1, 2000),
        scene: new Scene(),
        controls: {
          getView: () => ({ position: [0, 10, 20], target: [0, 0, 0], fov: 55 }),
          applyView,
          setView: vi.fn(),
        },
      } as never,
      bundle: cameraBundle({
        subject: 'driver',
        pair: ['driver', 'pedestrian'],
        tracks: { driver: [[0, 0], [20, 0]], pedestrian: [[4, 2], [8, 2]] },
      }),
      sampleHeight: () => 0,
      cameraPolicy: 'all-actors',
      renderer: {
        syncLayer: vi.fn(),
        setSelection: vi.fn(),
        setLayerVisible: vi.fn(),
        clearLayer: vi.fn(),
      } as never,
    });
    try {
      expect(applyView).toHaveBeenCalledTimes(1);
      controller.seek(10);
      controller.seek(20);
      expect(applyView).toHaveBeenCalledTimes(1);
      expect(controller.state.time).toBe(20);
    } finally {
      controller.dispose();
    }
  });

  it('selects a trailing camera for the first sensor-bearing actor', () => {
    const base = cameraBundle({ subject: 'driver', pair: ['driver', 'pedestrian'], tracks: { driver: [[0, 0], [20, 0]], pedestrian: [[4, 2], [8, 2]] } });
    const one = withSensorActors(base, ['driver']);
    const multiple = withSensorActors(base, ['pedestrian', 'driver']);

    expect(galleryCameraChoice(one)).toEqual({
      policy: 'subject-chase', selectionId: 'subject-chase:driver', label: 'Trailing camera vehicle · driver',
      reason: 'Following the sensor-bearing camera vehicle “driver”.', subjectActorId: 'driver',
    });
    expect(galleryCameraChoice(base)).toMatchObject({ policy: 'all-actors', subjectActorId: null });
    expect(galleryCameraChoice(base).reason).toContain('no sensor-bearing camera vehicle');
    expect(galleryCameraChoice(multiple)).toMatchObject({
      policy: 'subject-chase', subjectActorId: 'driver',
    });
  });

  it('tracks the sensor-derived subject from behind without affecting the verified time envelope', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
    });
    let nextFrame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const views: Array<{ position: Vector3; target: Vector3 }> = [];
    const base = cameraBundle({ subject: 'driver', pair: ['driver', 'pedestrian'], tracks: { driver: [[0, 0], [10, 0], [20, 0]], pedestrian: [[4, 2], [8, 2], [12, 2]] } });
    const bundle = withSensorActors(base, ['driver']);
    const controller = new PlaybackController({
      viewer: {
        camera: new PerspectiveCamera(55, 16 / 9, 0.1, 2000), scene: new Scene(),
        controls: {
          getView: () => ({ position: [0, 10, 20], target: [0, 0, 0], fov: 55 }), applyView: () => undefined,
          setView: (position: Vector3, target: Vector3) => views.push({ position: position.clone(), target: target.clone() }),
        },
      } as never,
      bundle, sampleHeight: () => 0, cameraPolicy: 'subject-chase', loop: false,
    });
    try {
      expect(controller.state).toMatchObject({ cameraPolicy: 'subject-chase', cameraSelectionId: 'subject-chase:driver' });
      expect(views.at(-1)!.position.x).toBeLessThan(0);
      expect(views.at(-1)!.target.x).toBeGreaterThan(0);
      controller.play();
      (nextFrame as FrameRequestCallback | null)!(20_250);
      expect(controller.state).toMatchObject({ time: 20, playing: false, cameraPolicy: 'subject-chase' });
      expect(views.at(-1)!.position.x).toBeLessThan(20);
      expect(views.at(-1)!.target.x).toBeGreaterThan(20);
    } finally {
      controller.dispose(); now.mockRestore(); vi.unstubAllGlobals();
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });

  it('keeps overview framing independent of sensor ownership', () => {
    const base = cameraBundle({ subject: 'driver', pair: ['driver', 'pedestrian'], tracks: { driver: [[0, 0], [20, 0]], pedestrian: [[4, 2], [8, 2]] } });
    const one = withSensorActors(base, ['driver']);
    const multiple = withSensorActors(base, ['driver', 'pedestrian']);
    const view = (bundle: PlaybackBundle) => allActorsCameraView(buildAllActorsCameraPlan(bundle)!, 0);
    expect(view(base)).toEqual(view(one));
    expect(view(multiple)).toEqual(view(one));
  });

  it('plays a sensor-free bundle to the exact 20-second envelope with All actors overview', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
    });
    let nextFrame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const controller = new PlaybackController({
      viewer: {
        camera: new PerspectiveCamera(55, 16 / 9, 0.1, 2000), scene: new Scene(),
        controls: {
          getView: () => ({ position: [0, 10, 20], target: [0, 0, 0], fov: 55 }),
          applyView: () => undefined, setView: () => undefined,
        },
      } as never,
      bundle: cameraBundle({
        subject: 'driver', pair: ['driver', 'pedestrian'],
        tracks: { driver: [[0, 0], [10, 0], [20, 0]], pedestrian: [[4, 2], [8, 2], [12, 2]] },
      }),
      sampleHeight: () => 0,
      cameraPolicy: 'all-actors',
      loop: false,
    });
    try {
      expect(controller.state).toMatchObject({ cameraPolicy: 'all-actors', cameraSelectionId: 'all-actors' });
      controller.play();
      (nextFrame as FrameRequestCallback | null)!(20_250);
      expect(controller.state).toMatchObject({ time: 20, playing: false, cameraPolicy: 'all-actors' });
    } finally {
      controller.dispose();
      now.mockRestore();
      vi.unstubAllGlobals();
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });

  it('excludes remote ambient actors while retaining authored movement bounds', () => {
    const bundle = cameraBundle({ subject: 'driver', pair: ['driver', 'pedestrian'], tracks: { driver: [[0, 0], [20, 0]], pedestrian: [[4, 2], [8, 2]], 'ambient-remote': [[900, 900], [1000, 1000]] } });
    const plan = buildAllActorsCameraPlan(bundle)!;
    expect(plan.actorIds).toEqual(['driver', 'pedestrian']);
    expect(plan.centerX).toBeLessThan(20);
    expect(plan.radius).toBeGreaterThan(10);
  });
});

describe('editor free-camera playback', () => {
  it.each(['none', 'multiple'] as const)(
    'never mutates the viewport through start, pause/resume, completion, Stop/Escape disposal with %s sensor owners',
    (sensorMode) => {
      const originalDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
      });
      let nextFrame: FrameRequestCallback | null = null;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      });
      vi.stubGlobal('cancelAnimationFrame', () => undefined);
      const now = vi.spyOn(performance, 'now').mockReturnValue(0);
      const camera = new PerspectiveCamera(47, 16 / 9, 0.1, 2000);
      const exactViewport = {
        position: [17.125, 9.75, -43.5] as const,
        target: [-2.25, 1.375, 8.625] as const,
        fov: 47,
        mode: 'orbit',
        pivot: [-2.25, 1.375, 8.625] as const,
      };
      const applyView = vi.fn();
      const setView = vi.fn();
      const base = cameraBundle({
        subject: 'driver',
        pair: ['driver', 'pedestrian'],
        tracks: { driver: [[0, 0], [10, 0], [20, 0]], pedestrian: [[4, 2], [8, 2], [12, 2]] },
      });
      const bundle = sensorMode === 'multiple'
        ? withSensorActors(base, ['driver', 'pedestrian'])
        : base;
      const controller = new PlaybackController({
        viewer: {
          camera,
          scene: new Scene(),
          controls: { getView: () => exactViewport, applyView, setView },
        } as never,
        bundle,
        sampleHeight: () => 0,
        cameraPolicy: 'free',
        restoreCameraOnDispose: false,
        loop: false,
      });
      try {
        expect(controller.state).toMatchObject({ cameraPolicy: 'free', cameraSelectionId: 'free' });
        controller.play();
        (nextFrame as FrameRequestCallback | null)!(5_000);
        controller.pause();
        now.mockReturnValue(5_000);
        controller.play();
        (nextFrame as FrameRequestCallback | null)!(10_000);
        controller.seek(12.5);
        controller.pause();
        now.mockReturnValue(10_000);
        controller.play();
        (nextFrame as FrameRequestCallback | null)!(17_500);
        expect(controller.state).toMatchObject({ time: 20, playing: false, cameraPolicy: 'free' });

        controller.dispose();
        expect(applyView).not.toHaveBeenCalled();
        expect(setView).not.toHaveBeenCalled();
        expect(exactViewport).toEqual({
          position: [17.125, 9.75, -43.5],
          target: [-2.25, 1.375, 8.625],
          fov: 47,
          mode: 'orbit',
          pivot: [-2.25, 1.375, 8.625],
        });
      } finally {
        controller.dispose();
        now.mockRestore();
        vi.unstubAllGlobals();
        Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
      }
    },
  );
});

function cameraBundle(options: {
  subject: string;
  pair: [string, string];
  occluders?: string[];
  tracks: Record<string, Array<[number, number]>>;
}): PlaybackBundle {
  const actorIds = Object.keys(options.tracks);
  const ticks = [0, 10, 20].slice(0, Math.max(...Object.values(options.tracks).map((track) => track.length)));
  return {
    startTime: 0,
    endTime: 20,
    actors: actorIds.map((id) => ({
      id, kind: 'vehicle', static: false, tags: id === 'ego' ? ['role:ego'] : [], catalogId: 'vehicle.sedan', modelBasis: 'kind-default',
      dims: { l: 4.5, w: 1.8, h: 1.5 }, initial: { x: 0, z: 0, headingRad: 0 },
    })),
    props: [], signals: [], source: { instanceName: 'instance', traceName: 'trace' },
    instance: {
      kind: 'scenario-instance',
      version: 1,
      manifest: { instanceId: 'camera-test', inputHash: 'hash', replayKey: { mapId: 'test' }, actors: actorIds.map((id) => ({ id })) },
      input: { mapId: 'test', actors: actorIds.map((id) => ({ id, sensors: [] })) } as never,
    },
    trace: {
      header: { metricSubject: options.subject } as never,
      ticks: {
        t: ticks,
        actors: Object.fromEntries(Object.entries(options.tracks).map(([id, points]) => [id, {
          x: points.map((point) => point[0]), z: points.map((point) => point[1]),
          headingRad: points.map(() => 0), speedMps: points.map(() => 1),
          laneRsl: points.map(() => null), s: points.map((_, index) => index), present: points.map(() => 1),
        }])),
      },
      events: [],
      metrics: {
        revealToConflict: options.occluders ? {
          pair: options.pair, observer: options.pair[0], target: options.pair[1], relevantOccluderIds: options.occluders,
          value: 1, firstBlockedT: 0, losOpenT: 10, conflictT: 12,
        } : null,
        minTTC: { pair: options.pair, value: 1, t: 10 }, minDistance: [], requiredDecelMax: {}, collisions: [],
        triggerNeverFired: [], clippedCriticality: false, ticksSimulated: ticks.length,
      },
    } as never,
  } as PlaybackBundle;
}

function withSensorActors(bundle: PlaybackBundle, actorIds: readonly string[]): PlaybackBundle {
  const owners = new Set(actorIds);
  return {
    ...bundle,
    instance: {
      ...bundle.instance,
      input: {
        ...bundle.instance.input,
        actors: bundle.instance.input.actors.map((actor) => ({
          ...actor,
          ...(owners.has(actor.id) ? { sensors: [{} as never] } : { sensors: [] }),
        })),
      },
    },
  };
}
