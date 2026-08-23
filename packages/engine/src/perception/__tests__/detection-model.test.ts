/**
 * The perception model's own contract, exercised without a simulation.
 *
 * These pin the *physics claims* the model makes — that `fogVisibilityM` means
 * what a weather report means by it, that a radar is indifferent to fog because
 * of a declared sensitivity rather than a branch on sensor type, and that every
 * failure mode has its own recorded reason.
 */

import { describe, expect, it } from 'vitest';

import {
  contrastLimitedRangeM,
  koschmiederContrast,
  observeTarget,
  resolutionLimitedRangeM,
  sensorPose,
  DETECTION_REASONS,
  DETECTION_STATUS,
} from '../model.js';
import { simSensorSchema, type SimSensor } from '../schema.js';
import { PerceptionRuntime, inExtent, type PerceptionActorView } from '../runtime.js';
import { perceptionConfigSchema } from '../schema.js';

function sensor(overrides: Record<string, unknown> = {}): SimSensor {
  return simSensorSchema.parse({
    id: 'cam',
    type: 'dash_camera',
    mount: { position: { x: 1.8, y: 1.1, z: 0 } },
    aperture: { horizontalFovDeg: 90, verticalFovDeg: 60, nearM: 0.05, farM: 400 },
    ...overrides,
  });
}

const CLEAR = { fogVisibilityM: 20_000, precipitationMmPerH: 0, illuminationFrac: 1 };

function look(
  atRangeM: number,
  opts: { sensor?: SimSensor; atmosphere?: Record<string, unknown>; lineOfSight?: boolean; glare?: Parameters<typeof observeTarget>[0]['glareSources'] } = {},
) {
  const used = opts.sensor ?? sensor();
  const pose = sensorPose(used, { position: { x: 0, y: 0 }, headingRad: 0 });
  return observeTarget({
    sensor: used,
    pose,
    target: { present: true, position: { x: pose.position.x + atRangeM, y: 0 }, heightM: 1.75 },
    lineOfSight: opts.lineOfSight ?? true,
    atmosphere: { ...CLEAR, ...opts.atmosphere } as never,
    glareSources: opts.glare ?? [],
  });
}

describe('the detection model is optics, not a fudge factor', () => {
  it('reproduces the meteorological definition of visibility', () => {
    // Visibility V is *defined* as the range at which contrast falls to 5%.
    expect(koschmiederContrast(120, 120)).toBeCloseTo(0.02, 6);
    expect(contrastLimitedRangeM(120, 0.02)).toBeCloseTo(120, 6);
    // A detector with a lower contrast floor sees correspondingly further.
    expect(contrastLimitedRangeM(120, 0.005)).toBeGreaterThan(120);
  });

  it('limits clear-air range by angular resolution alone', () => {
    expect(resolutionLimitedRangeM(1.75, 0.0045)).toBeCloseTo(388.9, 1);
    expect(look(100).status).toBe(DETECTION_STATUS.detected);
    expect(look(380).status).toBeLessThan(DETECTION_STATUS.detected);
    expect(look(380).reason).toBe('below_angular_resolution');
  });

  it('shortens the detection range in fog, and says fog was the reason', () => {
    const near = look(30, { atmosphere: { fogVisibilityM: 120 } });
    const far = look(90, { atmosphere: { fogVisibilityM: 120 } });
    expect(near.status).toBe(DETECTION_STATUS.detected);
    expect(far.status).toBeLessThan(DETECTION_STATUS.detected);
    expect(far.reason).toBe('atmospheric_attenuation');
    expect(far.confidence).toBeLessThan(near.confidence);
  });

  it('leaves radar almost untouched by the same fog that blinds the camera', () => {
    // Same range, same air; the only difference is the declared sensitivity
    // exponent, so nothing in the evaluator branches on sensor type.
    const fog = { fogVisibilityM: 60 };
    const camera = look(40, { atmosphere: fog });
    const radar = look(40, {
      sensor: simSensorSchema.parse({
        id: 'radar', type: 'radar', mount: { position: { x: 1.8, y: 0.5, z: 0 } },
        aperture: { horizontalFovDeg: 40, verticalFovDeg: 20, nearM: 0.2, farM: 200 },
      }),
      atmosphere: fog,
    });
    expect(camera.status).toBeLessThan(DETECTION_STATUS.detected);
    expect(radar.status).toBe(DETECTION_STATUS.detected);
  });

  it('goes blind at night unless the modality is active', () => {
    const dark = { illuminationFrac: 0.02 };
    expect(look(60, { atmosphere: dark }).reason).toBe('low_light');
    const lidar = simSensorSchema.parse({
      id: 'lidar', type: 'lidar', mount: { position: { x: 1.8, y: 1.4, z: 0 } },
      aperture: { horizontalFovDeg: 120, verticalFovDeg: 40, nearM: 0.5, farM: 200 },
    });
    expect(look(60, { sensor: lidar, atmosphere: dark }).status).toBe(DETECTION_STATUS.detected);
  });

  it('washes out a target sitting on a bright source, and only then', () => {
    const onAxis = look(60, { glare: [{ azimuthRad: 0, elevationRad: 0, halfAngleRad: 0.35, intensity: 0.95 }] });
    const offAxis = look(60, { glare: [{ azimuthRad: 1.2, elevationRad: 0, halfAngleRad: 0.35, intensity: 0.95 }] });
    expect(onAxis.reason).toBe('glare');
    expect(onAxis.status).toBeLessThan(DETECTION_STATUS.detected);
    expect(offAxis.status).toBe(DETECTION_STATUS.detected);
  });

  it('separates the hard gates from the soft degradation, with distinct reasons', () => {
    expect(look(600).reason).toBe('out_of_range');
    const pose = sensorPose(sensor(), { position: { x: 0, y: 0 }, headingRad: 0 });
    const behind = observeTarget({
      sensor: sensor(),
      pose,
      target: { present: true, position: { x: pose.position.x - 60, y: 0 }, heightM: 1.75 },
      lineOfSight: true,
      atmosphere: CLEAR as never,
      glareSources: [],
    });
    expect(behind.reason).toBe('out_of_fov');
    expect(look(60, { lineOfSight: false }).reason).toBe('occluded');
    expect(look(60, { sensor: sensor({ enabled: false }) }).reason).toBe('disabled');
    // Every reason the model can produce is in the recorded legend.
    for (const observation of [look(600), behind, look(60, { lineOfSight: false })]) {
      expect(DETECTION_REASONS).toContain(observation.reason);
    }
  });

  it('rejects a mistyped sensor field instead of discarding it', () => {
    expect(() => simSensorSchema.parse({
      id: 'cam', type: 'dash_camera',
      mount: { position: { x: 1, y: 1, z: 0 } },
      camera: { horizontalFovDeg: 90 },
    })).toThrow(/Unrecognized key/);
  });

  it('refuses a detection model whose thresholds are inverted', () => {
    expect(() => simSensorSchema.parse({
      id: 'cam', type: 'dash_camera',
      mount: { position: { x: 1, y: 1, z: 0 } },
      detection: { detectConfidence: 0.2, degradedConfidence: 0.5 },
    })).toThrow(/degradedConfidence/);
  });
});

/* ------------------------------------------------------ map/percept divergence */

function view(overrides: Partial<PerceptionActorView> = {}): PerceptionActorView {
  return {
    id: 'ego',
    position: { x: 0, y: 0 },
    headingRad: 0,
    heightM: 1.5,
    present: true,
    stateKeys: new Map(),
    laneRsl: '1:0:-1',
    laneS: 50,
    ...overrides,
  };
}

describe('map/percept divergence is declared, recorded, and honestly open loop', () => {
  const config = perceptionConfigSchema.parse({
    mapDivergences: [
      {
        id: 'repaint',
        kind: 'lane_markings_repainted',
        extent: { kind: 'lane', rsl: '1:0:-1', sMin: 40, sMax: 80 },
        severity: 0.8,
      },
    ],
  });

  it('scopes a lane extent without needing any geometry lookup', () => {
    const divergence = config.mapDivergences[0]!;
    expect(inExtent(divergence, view({ laneS: 50 }))).toBe(true);
    expect(inExtent(divergence, view({ laneS: 10 }))).toBe(false);
    expect(inExtent(divergence, view({ laneRsl: '1:0:-2' }))).toBe(false);
  });

  it('records exposure per observer as a first-class channel and metric', () => {
    const runtime = new PerceptionRuntime(config, [], ['ego'], 0.1);
    runtime.observe(0, [view({ laneS: 10 })], () => true);
    runtime.observe(0.1, [view({ laneS: 50 })], () => true);
    runtime.observe(0.2, [view({ laneS: 60 })], () => true);
    expect(runtime.divergenceTracks()['repaint/ego']!.active).toEqual([0, 1, 1]);
    const metric = runtime.metrics().mapDivergence[0]!;
    expect(metric.firstActiveT).toBeCloseTo(0.1, 9);
    expect(metric.activeS).toBeCloseTo(0.2, 9);
    expect(metric.severity).toBe(0.8);
  });

  it('insists that a shifted-geometry divergence say how far the map is wrong', () => {
    expect(() => perceptionConfigSchema.parse({
      mapDivergences: [{ id: 'shift', kind: 'lane_geometry_shifted', extent: { kind: 'lane', rsl: '1:0:-1' } }],
    })).toThrow(/lateralErrorM/);
  });
});
