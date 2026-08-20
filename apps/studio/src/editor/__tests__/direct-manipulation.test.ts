import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityViewer } from '@uniscenarios/city-renderer';
import { MemoryStorage, WebTemplateFileStore } from '@uniscenarios/scenario-model';
import type { CatalogId } from '@uniscenarios/prop-catalog';
import { MAPS } from '../../maps';
import { actionsForActor, EditorController, interactionForAction, isRoadBoundMotorVehicle } from '../controller';
import { EditorDocument } from '../document';
import { LaneIndex } from '../laneIndex';

interface ControllerInternals {
  actorIdAt: (event: PointerEvent) => string | null;
  groundPoint: (event: PointerEvent) => Vector3 | null;
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  computeGhostPose: (catalogId: CatalogId, ground: Vector3) => {
    x: number; z: number; headingRad: number; valid: boolean;
    laneRef: { roadId: string; laneId: number; s: number; t: number } | null;
  };
  preview: Map<string, {
    x: number; headingRad: number;
    laneRef?: { roadId: string; laneId: number; s: number; t: number } | null;
    routeLaneRsls?: readonly string[] | null;
  }>;
  selection: string[];
  publish: () => void;
  ghost: { setValid: (valid: boolean) => void };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture(actors: Array<{
  id: string;
  catalogId: 'construction.traffic_cone' | 'vehicle.sedan' | 'pedestrian.adult_standing';
  x: number;
  z: number;
  lane?: boolean;
}> = [{ id: 'cone', catalogId: 'construction.traffic_cone', x: 0, z: 0 }]) {
  const storage = new MemoryStorage();
  const store = new WebTemplateFileStore({ storage });
  const document = await EditorDocument.open(MAPS[0]!, { store, autosaveMs: 60_000 });
  document.add(actors.map((actor) => ({
    id: actor.id,
    catalogId: actor.catalogId,
    x: actor.x,
    y: 0,
    z: actor.z,
    headingRad: 0,
    ...(actor.lane ? {
      laneRef: { roadId: '1', section: 0, laneId: -1, s: actor.x, t: 0, headingOffsetRad: 0 },
      routeLaneRsls: ['1:0:-1'],
      initialSpeedKph: 48.28032,
    } : {}),
  })));
  const laneIndex = LaneIndex.build({ mapName: 'direct-manipulation', lanes: {
    '1:0:-1': {
      roadId: 1, section: 0, laneId: -1, laneType: 'driving',
      polyline: [{ x: 0, y: 0 }, { x: 400, y: 0 }],
    },
    '1:0:1': {
      roadId: 1, section: 0, laneId: 1, laneType: 'driving',
      polyline: [{ x: 0, y: 4 }, { x: 400, y: 4 }],
    },
  } });
  const captures = new Set<number>();
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    setPointerCapture: (id: number) => captures.add(id),
    releasePointerCapture: (id: number) => captures.delete(id),
    hasPointerCapture: (id: number) => captures.has(id),
  };
  const camera = new PerspectiveCamera(55, 2, 0.1, 1000);
  camera.position.set(0, 30, 30);
  camera.lookAt(0, 0, 0);
  const controls = {
    setEnabled: vi.fn(),
    getView: () => ({ position: [0, 30, 30] as const, target: [0, 0, 0] as const }),
    setView: vi.fn(),
  };
  const viewer = { scene: new Scene(), camera, controls, renderer: { domElement: canvas } } as unknown as CityViewer;
  const controller = new EditorController({ viewer, laneIndex, document, sampleHeight: () => 0 });
  const internals = controller as unknown as ControllerInternals;
  internals.actorIdAt = () => actors[0]?.id ?? null;
  internals.groundPoint = (event) => {
    const point = new Vector3(event.clientX, 0, -event.clientY);
    (internals as unknown as { lastGround: Vector3 }).lastGround = point;
    return point;
  };
  return { controller, document, internals, controls, canvas, captures, store };
}

function pointer(canvas: object, clientX: number, clientY = 0, extras: Record<string, unknown> = {}): PointerEvent {
  return {
    target: canvas, pointerId: 7, pointerType: 'mouse', button: 0,
    clientX, clientY, altKey: false, shiftKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    ...extras,
  } as unknown as PointerEvent;
}

function key(value: string, target: EventTarget | null = null, repeat = false): KeyboardEvent {
  return {
    key: value, target, repeat, metaKey: false, ctrlKey: false, altKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe('direct authored-actor manipulation', () => {
  it('keeps a normal click as selection and begins move after the hold threshold', async () => {
    const first = await fixture();
    const revision = first.document.revision;
    const frame = vi.spyOn(first.controller, 'frameActor').mockImplementation(() => undefined);
    first.internals.onPointerDown(pointer(first.canvas, 0));
    first.internals.onPointerUp(pointer(first.canvas, 0));
    expect(first.internals.selection).toEqual(['cone']);
    expect(frame).toHaveBeenCalledWith('cone');
    expect(first.document.revision).toBe(revision);
    expect(first.controls.setEnabled).toHaveBeenNthCalledWith(1, false);
    expect(first.controls.setEnabled).toHaveBeenLastCalledWith(true);
    first.controller.dispose(); first.document.dispose();

    const held = await fixture();
    held.internals.onPointerDown(pointer(held.canvas, 0));
    vi.advanceTimersByTime(220);
    expect(held.internals.preview.has('cone')).toBe(true);
    held.internals.onPointerMove(pointer(held.canvas, 14));
    held.internals.onPointerUp(pointer(held.canvas, 14));
    expect(held.document.actor('cone')?.x).toBe(14);
    held.controller.dispose(); held.document.dispose();
  });

  it('starts immediately after drag slop, lifts the actor, commits once, and undoes atomically', async () => {
    const { controller, document, internals, canvas } = await fixture();
    const revision = document.revision;
    const synced: number[] = [];
    vi.spyOn(controller.renderer, 'sync').mockImplementation((views) => { synced.push(views[0]?.y ?? 0); });
    internals.onPointerDown(pointer(canvas, 0));
    internals.onPointerMove(pointer(canvas, 8));
    expect(internals.preview.get('cone')?.x).toBe(8);
    expect(synced.at(-1)).toBeCloseTo(0.42, 6);
    internals.onPointerUp(pointer(canvas, 8));
    expect(document.revision).toBe(revision + 1);
    expect(document.actor('cone')?.x).toBe(8);
    expect(document.undo()).toBe(true);
    expect(document.actor('cone')?.x).toBe(0);
    controller.dispose(); document.dispose();
  });

  it('restores the exact original pose on Escape and pointer cancellation without history', async () => {
    for (const cancelWithKey of [true, false]) {
      const { controller, document, internals, canvas } = await fixture();
      const revision = document.revision;
      internals.onPointerDown(pointer(canvas, 0));
      internals.onPointerMove(pointer(canvas, 12));
      if (cancelWithKey) internals.onKeyDown(key('Escape'));
      else internals.onPointerCancel(pointer(canvas, 12));
      expect(document.revision).toBe(revision);
      expect(document.actor('cone')).toMatchObject({ x: 0, z: 0, headingRad: 0 });
      expect(internals.preview.size).toBe(0);
      controller.dispose(); document.dispose();
    }
  });

  it('rejects an overlapping drop and leaves no history entry', async () => {
    const { controller, document, internals, canvas } = await fixture([
      { id: 'moving', catalogId: 'construction.traffic_cone', x: 0, z: 0 },
      { id: 'blocker', catalogId: 'construction.traffic_cone', x: 20, z: 0 },
    ]);
    const revision = document.revision;
    const validity = vi.spyOn(internals.ghost, 'setValid');
    internals.onPointerDown(pointer(canvas, 0));
    internals.onPointerMove(pointer(canvas, 20));
    expect(validity).toHaveBeenLastCalledWith(false);
    internals.onPointerUp(pointer(canvas, 20));
    expect(document.revision).toBe(revision);
    expect(document.actor('moving')?.x).toBe(0);
    controller.dispose(); document.dispose();
  });

  it('keeps playback/read-only input out of the direct manipulation state machine', async () => {
    const { controller, document, internals, controls, canvas } = await fixture();
    const revision = document.revision;
    controller.setAuthoringEnabled(false);
    internals.onPointerDown(pointer(canvas, 0, 0, { pointerType: 'touch' }));
    vi.advanceTimersByTime(500);
    internals.onPointerMove(pointer(canvas, 30, 0, { pointerType: 'pen' }));
    internals.onPointerUp(pointer(canvas, 30));
    expect(document.revision).toBe(revision);
    expect(internals.preview.size).toBe(0);
    expect(controls.setEnabled).not.toHaveBeenCalled();
    controller.dispose(); document.dispose();
  });

  it('refreshes the transient route and lane pose without mutating the document before release', async () => {
    const { controller, document, internals, canvas } = await fixture([
      { id: 'ego', catalogId: 'vehicle.sedan', x: 10, z: 0, lane: true },
    ]);
    const revision = document.revision;
    internals.onPointerDown(pointer(canvas, 10));
    internals.onPointerMove(pointer(canvas, 100));
    expect(document.revision).toBe(revision);
    expect(document.actor('ego')).toMatchObject({ x: 10, laneRef: { s: 10 } });
    expect(controller.authoringPreviewData.roles[0]).toMatchObject({
      pose: { position: { x: 100 } }, laneRef: { s: 100 },
    });
    internals.onPointerUp(pointer(canvas, 100));
    expect(document.actor('ego')).toMatchObject({ x: 100, laneRef: { s: 100 } });
    expect(document.actor('ego')?.routeLaneRsls).toBeUndefined();
    controller.dispose(); document.dispose();
  });

  it('snaps a held motor vehicle to the nearest semantic lane and its travel yaw', async () => {
    const { controller, document, internals, canvas } = await fixture([
      { id: 'ego', catalogId: 'vehicle.sedan', x: 10, z: 0, lane: true },
    ]);
    internals.onPointerDown(pointer(canvas, 10));
    internals.onPointerMove(pointer(canvas, 80, 4));
    const preview = internals.preview.get('ego');
    expect(preview).toMatchObject({ x: 80, laneRef: { roadId: '1', laneId: 1, t: 0 } });
    expect(preview?.headingRad).toBeCloseTo(Math.PI, 6);
    internals.publish();
    expect(controller.state.snapped).toBe(true);
    expect(controller.state.laneLabel).toContain('lane 1');
    expect(controller.state.hint).toContain('snapped to');
    internals.onPointerUp(pointer(canvas, 80, 4));
    expect(document.actor('ego')).toMatchObject({ x: 80, z: -4, laneRef: { laneId: 1, t: 0 } });
    expect(document.actor('ego')?.headingRad).toBeCloseTo(Math.PI, 6);
    controller.dispose(); document.dispose();
  });

  it('shows an invalid off-road vehicle ghost and restores the exact pose on release', async () => {
    const { controller, document, internals, canvas } = await fixture([
      { id: 'ego', catalogId: 'vehicle.sedan', x: 10, z: 0, lane: true },
    ]);
    const before = document.actor('ego');
    const revision = document.revision;
    internals.onPointerDown(pointer(canvas, 10));
    internals.onPointerMove(pointer(canvas, 90, 100, { altKey: true }));
    internals.publish();
    expect(controller.state.valid).toBe(false);
    expect(controller.state.snapped).toBe(false);
    expect(controller.state.hint).toContain('release cancels move');
    internals.onPointerUp(pointer(canvas, 90, 100, { altKey: true }));
    expect(document.revision).toBe(revision);
    expect(document.actor('ego')).toEqual(before);
    controller.dispose(); document.dispose();
  });
});

describe('custom route actor seed', () => {
  it('keeps the actor seed as the only point when the initiating click lands visually on it', async () => {
    const { controller, document, internals, canvas } = await fixture([
      { id: 'ego', catalogId: 'vehicle.sedan', x: 10, z: 0, lane: true },
    ]);
    const definition = actionsForActor('car').find((candidate) => candidate.id === 'custom_route')!;
    const interaction = interactionForAction(definition, 'ego', 0, 1);
    document.addInteraction(interaction);

    expect(controller.beginCustomRouteAuthoring(interaction.id, {
      reset: true,
      startPose: { x: 10, z: 0, headingRad: 0 },
    })).toBe(true);
    internals.publish();
    expect(controller.state.customRoutePointCount).toBe(1);

    internals.onPointerDown(pointer(canvas, 10.2));
    internals.publish();

    expect(controller.state.customRoutePointCount).toBe(1);

    internals.onPointerDown(pointer(canvas, 20));
    internals.publish();
    expect(controller.state.customRoutePointCount).toBe(2);
    controller.dispose(); document.dispose();
  });
});

describe('mandatory motor-vehicle road placement', () => {
  it('uses one semantic snap for palette placement and cannot be bypassed with Alt', async () => {
    const { controller, document, internals, canvas } = await fixture([]);
    controller.togglePlacement('vehicle.sedan');
    internals.onPointerMove(pointer(canvas, 60, 4));
    internals.publish();
    expect(controller.state).toMatchObject({ snapped: true, valid: true });
    expect(controller.state.laneLabel).toContain('lane 1');
    internals.onPointerDown(pointer(canvas, 60, 4));
    internals.onPointerUp(pointer(canvas, 60, 4));
    expect(document.actors[0]).toMatchObject({ x: 60, z: -4, laneRef: { laneId: 1, t: 0 } });
    expect(document.actors[0]?.headingRad).toBeCloseTo(Math.PI, 6);

    internals.onPointerMove(pointer(canvas, 60, 100, { altKey: true }));
    internals.publish();
    expect(controller.state).toMatchObject({ snapped: false, valid: false });
    internals.onPointerDown(pointer(canvas, 60, 100, { altKey: true }));
    internals.onPointerUp(pointer(canvas, 60, 100, { altKey: true }));
    expect(document.actors).toHaveLength(1);
    controller.dispose(); document.dispose();
  });

  it('classifies roadway motor actors without forcing pedestrian/VRU props onto driving lanes', () => {
    expect(isRoadBoundMotorVehicle('vehicle.sedan')).toBe(true);
    expect(isRoadBoundMotorVehicle('vehicle.pickup')).toBe(true);
    expect(isRoadBoundMotorVehicle('vehicle.box_truck')).toBe(true);
    expect(isRoadBoundMotorVehicle('vehicle.bus')).toBe(true);
    expect(isRoadBoundMotorVehicle('vehicle.motorcycle')).toBe(true);
    expect(isRoadBoundMotorVehicle('vehicle.bicycle')).toBe(false);
    expect(isRoadBoundMotorVehicle('vehicle.mobility_scooter')).toBe(false);
    expect(isRoadBoundMotorVehicle('pedestrian.adult_standing')).toBe(false);
    expect(isRoadBoundMotorVehicle('construction.traffic_cone')).toBe(false);
  });
});

describe('non-vehicle Q/E rotation', () => {
  it('rotates placement left/right in repeatable 5° steps and ignores focused fields', async () => {
    const { controller, document, internals } = await fixture();
    controller.togglePlacement('construction.traffic_cone');
    internals.onKeyDown(key('q', { tagName: 'INPUT' } as unknown as EventTarget));
    expect(internals.computeGhostPose('construction.traffic_cone', new Vector3()).headingRad).toBe(0);
    internals.onKeyDown(key('q'));
    internals.onKeyDown(key('q', null, true));
    internals.onKeyDown(key('e'));
    expect(internals.computeGhostPose('construction.traffic_cone', new Vector3()).headingRad)
      .toBeCloseTo(5 * Math.PI / 180, 10);
    internals.publish();
    expect(controller.state.hint).toContain('Q / E rotate 5°');
    controller.dispose(); document.dispose();
  });

  it('applies direct prop rotation to preview and commit, but never rotates a vehicle', async () => {
    const prop = await fixture();
    prop.internals.onPointerDown(pointer(prop.canvas, 0));
    prop.internals.onPointerMove(pointer(prop.canvas, 8));
    prop.internals.onKeyDown(key('q'));
    prop.internals.onKeyDown(key('q'));
    expect(prop.internals.preview.get('cone')?.headingRad).toBeCloseTo(10 * Math.PI / 180, 10);
    prop.internals.onPointerUp(pointer(prop.canvas, 8));
    expect(prop.document.actor('cone')?.headingRad).toBeCloseTo(10 * Math.PI / 180, 5);
    expect(prop.document.undo()).toBe(true);
    expect(prop.document.actor('cone')?.headingRad).toBe(0);
    prop.controller.dispose(); prop.document.dispose();

    const vehicle = await fixture([{ id: 'ego', catalogId: 'vehicle.sedan', x: 10, z: 0, lane: true }]);
    vehicle.internals.onPointerDown(pointer(vehicle.canvas, 10));
    vehicle.internals.onPointerMove(pointer(vehicle.canvas, 20));
    const event = key('q');
    vehicle.internals.onKeyDown(event);
    expect(vehicle.internals.preview.get('ego')?.headingRad).toBe(0);
    expect(event.preventDefault).not.toHaveBeenCalled();
    vehicle.internals.onPointerCancel(pointer(vehicle.canvas, 20));
    vehicle.controller.dispose(); vehicle.document.dispose();
  });

  it('rotates a newly placed pedestrian and preserves the yaw through ground-snap movement', async () => {
    const { controller, document, internals, canvas } = await fixture([]);
    controller.togglePlacement('pedestrian.adult_standing');
    internals.onPointerMove(pointer(canvas, 20));
    internals.onKeyDown(key('q'));
    internals.onPointerMove(pointer(canvas, 28));
    internals.publish();
    expect(controller.state.hint).toContain('Q / E rotate 5°');
    expect(internals.computeGhostPose('pedestrian.adult_standing', new Vector3(28, 0, 0)).headingRad)
      .toBeCloseTo(5 * Math.PI / 180, 10);
    internals.onPointerDown(pointer(canvas, 28));
    internals.onPointerUp(pointer(canvas, 28));
    expect(document.actors).toHaveLength(1);
    expect(document.actors[0]).toMatchObject({ kind: 'pedestrian', x: 28, y: 0 });
    expect(document.actors[0]?.headingRad).toBeCloseTo(5 * Math.PI / 180, 5);
    controller.dispose(); document.dispose();
  });

  it('cancels, undoes, redoes, and reloads a directly repositioned pedestrian yaw', async () => {
    const first = await fixture([
      { id: 'walker', catalogId: 'pedestrian.adult_standing', x: 0, z: 0 },
    ]);
    const revision = first.document.revision;
    first.internals.onPointerDown(pointer(first.canvas, 0));
    first.internals.onPointerMove(pointer(first.canvas, 8));
    first.internals.onKeyDown(key('q'));
    first.internals.onPointerMove(pointer(first.canvas, 12));
    first.internals.onKeyDown(key('Escape'));
    expect(first.document.revision).toBe(revision);
    expect(first.document.actor('walker')).toMatchObject({ x: 0, headingRad: 0 });

    first.internals.onPointerDown(pointer(first.canvas, 0));
    first.internals.onPointerMove(pointer(first.canvas, 8));
    first.internals.onKeyDown(key('q'));
    first.internals.onKeyDown(key('q', null, true));
    first.internals.onPointerMove(pointer(first.canvas, 15));
    first.internals.publish();
    expect(first.controller.state.hint).toContain('Q / E rotate 5°');
    expect(first.internals.preview.get('walker')).toMatchObject({ x: 15 });
    expect(first.internals.preview.get('walker')?.headingRad).toBeCloseTo(10 * Math.PI / 180, 10);
    first.internals.onPointerUp(pointer(first.canvas, 15));
    expect(first.document.actor('walker')).toMatchObject({ x: 15, y: 0 });
    expect(first.document.actor('walker')?.headingRad).toBeCloseTo(10 * Math.PI / 180, 5);
    expect(first.document.undo()).toBe(true);
    expect(first.document.actor('walker')).toMatchObject({ x: 0, headingRad: 0 });
    expect(first.document.redo()).toBe(true);
    expect(first.document.actor('walker')?.headingRad).toBeCloseTo(10 * Math.PI / 180, 5);
    await first.document.flush();
    first.controller.dispose(); first.document.dispose();

    const reloaded = await EditorDocument.open(MAPS[0]!, { store: first.store, autosaveMs: 60_000 });
    expect(reloaded.actor('walker')).toMatchObject({ x: 15, kind: 'pedestrian' });
    expect(reloaded.actor('walker')?.headingRad).toBeCloseTo(10 * Math.PI / 180, 5);
    reloaded.dispose();
  });
});
