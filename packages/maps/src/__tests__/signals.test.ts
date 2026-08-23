import { BufferAttribute, Group, InstancedMesh, Matrix4, Points, ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { CoordinateFrame } from '../coordinate-frame.js';
import { MissingHeightError } from '../overlays/height.js';
import { signalsFromGeoJson } from '../signals.js';
import {
  buildSignalOverlay,
  buildTrafficLightOrbLayer,
  clearTrafficLightOrbStates,
  clearTrafficLightStates,
  setTrafficLightOrbDepthMode,
  setTrafficLightOrbHighlights,
  setTrafficLightOrbStates,
  setTrafficLightStates,
  signalIdForHit,
  signalPlacement,
  trafficLightOrbIdForHit,
  type SignalHeadUserData,
  type SignalOverlayUserData,
  type TrafficLightStateUserData,
  type TrafficLightOrbLayerUserData,
} from '../overlays/signals.js';
import { yaleHeaderText, yaleManifest, yaleSignals } from './fixtures.js';

const frame = (): CoordinateFrame =>
  CoordinateFrame.fromMapAssets(yaleHeaderText(), yaleManifest());

async function load() {
  return signalsFromGeoJson(await yaleSignals(), frame());
}

describe('signalsFromGeoJson', () => {
  it('parses all 164 Yale Street features, 59 of them traffic lights', async () => {
    const signals = await load();
    expect(signals).toHaveLength(164);
    expect(signals.filter((s) => s.category === 'traffic_light')).toHaveLength(59);
  });

  it('splits into 143 point signals and 21 crosswalk polygons', async () => {
    const signals = await load();
    const kinds = new Map<string, number>();
    for (const s of signals) kinds.set(s.featureKind, (kinds.get(s.featureKind) ?? 0) + 1);
    expect(kinds.get('signal')).toBe(143);
    expect(kinds.get('crosswalk')).toBe(21);
    // Crosswalks carry no signal_category and keep their surface ring.
    const crosswalks = signals.filter((s) => s.featureKind === 'crosswalk');
    for (const c of crosswalks) {
      expect(c.category).toBe('unknown');
      expect(c.outline!.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('covers the full category vocabulary', async () => {
    const signals = await load();
    const counts = new Map<string, number>();
    for (const s of signals) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({
      traffic_light: 59,
      unknown: 27 + 21, // 27 explicit "unknown" + 21 category-less crosswalks
      stop_sign: 14,
      parking_sign: 11,
      regulatory_sign: 8,
      warning_sign: 6,
      stop_line: 6,
      street_name_sign: 5,
      other_sign: 3,
      turn_restriction_sign: 3,
      bus_stop: 1,
    });
  });

  it('places every good signal inside the manifest scene bounds', async () => {
    const f = frame();
    const signals = signalsFromGeoJson(await yaleSignals(), f);
    const b = f.sceneBounds!;
    for (const s of signals) {
      expect(Number.isFinite(s.position[0])).toBe(true);
      expect(Number.isFinite(s.position[2])).toBe(true);
      if (!s.withinExtents) continue;
      expect(s.position[0]).toBeGreaterThanOrEqual(b.min[0] as number);
      expect(s.position[0]).toBeLessThanOrEqual(b.max[0] as number);
      expect(s.position[2]).toBeGreaterThanOrEqual(b.min[2] as number);
      expect(s.position[2]).toBeLessThanOrEqual(b.max[2] as number);
    }
  });

  it('flags the four bad Stop Line rows on road 918 instead of trusting them', async () => {
    // Source defect: t = -1725.5 m (a 1.7 km lateral offset) and a negative
    // z_offset, which projects these four duplicated rows onto the projection
    // origin, far outside the map.
    const signals = await load();
    const bad = signals.filter((s) => !s.withinExtents);
    expect(bad).toHaveLength(4);
    for (const s of bad) {
      expect(s.name).toBe('Stop Line');
      expect(s.roadId).toBe('918');
      expect(Math.abs(s.t)).toBeGreaterThan(1000);
      expect(s.zOffset).toBeLessThan(0);
    }
    expect(signals.filter((s) => s.withinExtents)).toHaveLength(160);

    const dropped = signalsFromGeoJson(await yaleSignals(), frame(), {
      dropOutsideExtents: true,
    });
    expect(dropped).toHaveLength(160);
  });

  it('exposes mounting height separately from the pole base', async () => {
    const signals = await load();
    const lights = signals.filter((s) => s.category === 'traffic_light');
    expect(lights.every((s) => s.dynamic)).toBe(true);
    expect(lights.every((s) => s.zOffset > 0)).toBe(true);
    // position is the BASE — the ground plane, not the head.
    expect(lights.every((s) => s.position[1] === 0)).toBe(true);

    const sampled = signalsFromGeoJson(await yaleSignals(), frame(), {
      heightSampler: () => 12.5,
    });
    expect(sampled.every((s) => s.position[1] === 12.5)).toBe(true);

    const flat = signalsFromGeoJson(await yaleSignals(), frame(), { groundHeight: 3 });
    expect(flat.every((s) => s.position[1] === 3)).toBe(true);
  });

  it('normalises typed properties and preserves the raw ones', async () => {
    const signals = await load();
    const stop = signals.find((s) => s.category === 'stop_sign')!;
    expect(stop.mutcdCode).toBeTruthy();
    expect(stop.dynamic).toBe(false);
    expect(stop.roadId).toMatch(/^\d+$/);
    expect(typeof stop.s).toBe('number');
    expect(typeof stop.t).toBe('number');
    expect(stop.properties.signal_category).toBe('stop_sign');
    expect(stop.properties.dynamic).toBe('no');
  });
});

describe('buildSignalOverlay', () => {
  it('builds one independent, batched editor orb for every physical Yale head', async () => {
    const signals = await load();
    const furniture = buildSignalOverlay(signals, { heightSampler: () => 12 });
    furniture.visible = false;
    const orbs = buildTrafficLightOrbLayer(furniture);
    const data = orbs.userData as TrafficLightOrbLayerUserData;
    const points = orbs.getObjectByName('traffic-light-orb-points') as Points;
    expect(data.count).toBe(59);
    expect(data.signalIds).toHaveLength(59);
    expect(new Set(data.signalIds).size).toBe(59);
    expect(Object.values(data.states).every((state) => state === 'unknown')).toBe(true);
    expect(points.geometry.getAttribute('position').count).toBe(59);
    const material = points.material as ShaderMaterial;
    expect(material.uniforms.pointSize!.value).toBe(18);
    expect(material.vertexColors).toBe(true);
    // ShaderMaterial injects the built-in `color` attribute whenever
    // vertexColors is enabled. Declaring it again in the custom shader makes
    // the final WebGL program invalid (`color` redefinition).
    expect(material.vertexShader).not.toMatch(/attribute\s+vec3\s+color\s*;/);
    expect(material.vertexShader).toContain('pointColor = color;');
    expect(orbs.visible).toBe(true);
    // A sibling layer remains independently visible when furniture is hidden.
    expect(furniture.visible).toBe(false);
  });

  it('updates, flashes, and resets orb state in place without rebuilding geometry', async () => {
    const furniture = buildSignalOverlay(await load());
    const orbs = buildTrafficLightOrbLayer(furniture);
    const points = orbs.getObjectByName('traffic-light-orb-points') as Points;
    const geometry = points.geometry;
    const colors = geometry.getAttribute('color') as BufferAttribute;
    const ids = (orbs.userData as TrafficLightOrbLayerUserData).signalIds.slice(0, 4);
    expect(setTrafficLightOrbStates(orbs, {
      [ids[0]!]: 'red',
      [ids[1]!]: 'yellow',
      [ids[2]!]: 'green',
      [ids[3]!]: 'flashing_red',
      missing: 'green',
    })).toBe(4);
    expect(points.geometry).toBe(geometry);
    const red = [colors.getX(0), colors.getY(0), colors.getZ(0)];
    const yellow = [colors.getX(1), colors.getY(1), colors.getZ(1)];
    const green = [colors.getX(2), colors.getY(2), colors.getZ(2)];
    expect(red[0]!).toBeGreaterThan(red[1]!);
    expect(yellow[0]!).toBeGreaterThan(yellow[2]!);
    expect(green[1]!).toBeGreaterThan(green[0]!);
    setTrafficLightOrbStates(orbs, { [ids[3]!]: 'flashing_red' }, false);
    expect(colors.getX(3)).toBeLessThan(red[0]!);
    clearTrafficLightOrbStates(orbs);
    expect(points.geometry).toBe(geometry);
    expect(Object.values((orbs.userData as TrafficLightOrbLayerUserData).states)
      .every((state) => state === 'unknown')).toBe(true);
  });

  it('supports scene-depth and x-ray modes and produces no points for maps without heads', async () => {
    const orbs = buildTrafficLightOrbLayer(buildSignalOverlay(await load()), { depthMode: 'scene' });
    const points = orbs.getObjectByName('traffic-light-orb-points') as Points<never, ShaderMaterial>;
    expect(points.material.depthTest).toBe(true);
    setTrafficLightOrbDepthMode(orbs, 'xray');
    expect(points.material.depthTest).toBe(false);
    expect(points.renderOrder).toBe(100);
    orbs.visible = false;
    expect(orbs.visible).toBe(false);

    // Belmont and Easterbrook have no traffic-light features: their input is
    // equivalent to an empty filtered overlay and must cost zero marker draws.
    const empty = buildTrafficLightOrbLayer(buildSignalOverlay([]));
    expect((empty.userData as TrafficLightOrbLayerUserData).count).toBe(0);
    expect((empty.getObjectByName('traffic-light-orb-points') as Points).geometry
      .getAttribute('position').count).toBe(0);
  });

  it('resolves batched orb hits by stable id and highlights scopes in place', async () => {
    const orbs = buildTrafficLightOrbLayer(buildSignalOverlay(await load()));
    const points = orbs.getObjectByName('traffic-light-orb-points') as Points;
    const ids = (orbs.userData as TrafficLightOrbLayerUserData).signalIds.slice(0, 4);
    expect(trafficLightOrbIdForHit({ object: points, index: 2 } as never)).toBe(ids[2]);
    expect(trafficLightOrbIdForHit({ object: points } as never)).toBeNull();
    const geometry = points.geometry;
    expect(setTrafficLightOrbHighlights(orbs, {
      selectedHeadId: ids[0], movementHeadIds: [ids[0]!, ids[1]!], intersectionHeadIds: ids,
    })).toBe(4);
    const highlight = geometry.getAttribute('highlightLevel') as BufferAttribute;
    expect([highlight.getX(0), highlight.getX(1), highlight.getX(2), highlight.getX(3)]).toEqual([3, 2, 1, 1]);
    setTrafficLightOrbHighlights(orbs, null);
    expect(points.geometry).toBe(geometry);
    expect(highlight.getX(0)).toBe(0);
  });

  it('renders and clears one live active-lamp state per physical traffic-light head', async () => {
    const signals = await load();
    const group = buildSignalOverlay(signals);
    const ids = signals.filter((signal) => signal.category === 'traffic_light').slice(0, 3).map((signal) => signal.id);
    const count = setTrafficLightStates(group, {
      [ids[0]!]: 'red',
      [ids[1]!]: 'yellow',
      [ids[2]!]: 'green',
      missing: 'red',
    });
    expect(count).toBe(3);
    const points = group.getObjectByName('traffic-light-live-state')!;
    expect(points).toBeDefined();
    expect(points.userData as TrafficLightStateUserData).toEqual({
      layer: 'traffic-light-state',
      states: { [ids[0]!]: 'red', [ids[1]!]: 'yellow', [ids[2]!]: 'green' },
      count: 3,
    });
    clearTrafficLightStates(group);
    expect(group.getObjectByName('traffic-light-live-state')).toBeUndefined();
  });

  it('places every feature and reports it in byId', async () => {
    const signals = await load();
    const group = buildSignalOverlay(signals, { heightSampler: () => 12 });
    expect(group.name).toBe('signals');

    const poles = group.getObjectByName('signal-poles')!;
    const heads = group.getObjectByName('signal-heads')!;
    expect(poles).toBeDefined();

    const data = group.userData as SignalOverlayUserData;
    // 164 features minus the 4 out-of-extent Stop Line rows.
    expect(data.signalCount).toBe(160);
    expect(Object.keys(data.byId)).toHaveLength(160);
    expect(data.crosswalkCount).toBe(21);
    expect(
      (buildSignalOverlay(signals, { includeOutOfBounds: true }).userData as SignalOverlayUserData)
        .signalCount,
    ).toBe(164);

    // Every kept feature resolves to a drawable and an instance slot.
    for (const s of signals.filter((x) => x.withinExtents)) {
      const placement = signalPlacement(group, s.id)!;
      expect(placement).toBeTruthy();
      expect(placement.signal.id).toBe(s.id);
      expect(placement.groundY).toBe(12);
      if (s.featureKind === 'crosswalk') {
        expect(placement.object.name).toBe('crosswalk-outlines');
        expect(placement.instanceId).toBe(-1);
      } else {
        expect(placement.object.parent).toBe(heads);
        expect(placement.instanceId).toBeGreaterThanOrEqual(0);
      }
    }

    // Head sits at ground + z_offset; the pole spans that.
    const light = signals.find((s) => s.category === 'traffic_light')!;
    const head = signalPlacement(group, light.id)!;
    expect(head.position[1]).toBeCloseTo(12 + light.zOffset, 6);
    const matrix = new Matrix4();
    (head.object as InstancedMesh).getMatrixAt(head.instanceId, matrix);
    expect(matrix.elements[13]).toBeCloseTo(12 + light.zOffset, 4);

    const polePositions = (poles as unknown as { geometry: { attributes: { position: { count: number } } } })
      .geometry.attributes.position;
    expect(polePositions.count).toBeGreaterThan(0);
    expect(polePositions.count % 2).toBe(0);
  });

  it('collapses 160 features into 13 draw calls, one per category', async () => {
    const signals = await load();
    const group = buildSignalOverlay(signals);
    const data = group.userData as SignalOverlayUserData;
    const heads = group.getObjectByName('signal-heads')!;

    // 11 categories + merged poles + merged crosswalk rings.
    expect(heads.children).toHaveLength(11);
    expect(data.categories).toHaveLength(11);
    expect(data.drawCalls).toBe(13);
    for (const child of heads.children) {
      expect((child as InstancedMesh).isInstancedMesh).toBe(true);
    }

    // The 59 traffic lights are one instanced draw, not 59 meshes.
    const lights = heads.children.find(
      (c) => (c.userData as SignalHeadUserData).category === 'traffic_light',
    ) as InstancedMesh;
    expect(lights.count).toBe(59);
    expect((lights.userData as SignalHeadUserData).signalIds).toHaveLength(59);
  });

  it('resolves a raycast hit back to a signal id', async () => {
    const signals = await load();
    const group = buildSignalOverlay(signals);
    const stop = signals.find((s) => s.category === 'stop_sign' && s.withinExtents)!;
    const placement = signalPlacement(group, stop.id)!;
    const hit = {
      object: placement.object,
      instanceId: placement.instanceId,
    } as unknown as Parameters<typeof signalIdForHit>[0];
    expect(signalIdForHit(hit)).toBe(stop.id);

    // A hit on something else in the scene is not a signal.
    expect(
      signalIdForHit({ object: new Group(), instanceId: 0 } as unknown as Parameters<
        typeof signalIdForHit
      >[0]),
    ).toBeNull();
  });

  it('can drop the crosswalk layer', async () => {
    const signals = await load();
    const group = buildSignalOverlay(signals, { includeCrosswalks: false });
    const data = group.userData as SignalOverlayUserData;
    expect(data.signalCount).toBe(143 - 4);
    expect(data.crosswalkCount).toBe(0);
    expect(group.getObjectByName('crosswalk-outlines')).toBeUndefined();
    // No crosswalk ring draw, so one fewer call than the full build.
    expect(data.drawCalls).toBe(12);
  });

  it('honours onMissingHeight', async () => {
    const signals = await load();
    // A sampler with a hole in it: answers only for the eastern half of the map.
    const sampler = (x: number, _z: number): number | null => (x > 700 ? 9 : null);
    const kept = signals.filter((s) => s.withinExtents && s.position[0] > 700).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(160);

    const skipped = buildSignalOverlay(signals, {
      heightSampler: sampler,
      onMissingHeight: 'skip',
    }).userData as SignalOverlayUserData;
    expect(skipped.signalCount).toBeLessThanOrEqual(kept);
    expect(skipped.signalCount).toBeGreaterThan(0);

    const defaulted = buildSignalOverlay(signals, {
      heightSampler: sampler,
      defaultHeight: 4,
      onMissingHeight: 'default',
    });
    expect((defaulted.userData as SignalOverlayUserData).signalCount).toBe(160);
    const missed = signals.find((s) => s.withinExtents && s.position[0] <= 700);
    if (missed) expect(signalPlacement(defaulted, missed.id)!.groundY).toBe(4);

    expect(() =>
      buildSignalOverlay(signals, { heightSampler: sampler, onMissingHeight: 'throw' }),
    ).toThrow(MissingHeightError);
  });

  it('still accepts the deprecated groundHeight alias', async () => {
    const signals = await load();
    const group = buildSignalOverlay(signals, { groundHeight: 7 });
    const light = signals.find((s) => s.category === 'traffic_light')!;
    expect(signalPlacement(group, light.id)!.groundY).toBe(7);
  });
});
