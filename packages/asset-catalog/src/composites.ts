import { Group, Object3D } from 'three';

import { type CatalogId, getEntry } from './catalog';
import { vehicleColor } from './materials';
import { buildProp } from './registry';

/**
 * Composites are the edge cases people actually place: nobody wants to position
 * fourteen cones by hand. Each returns a single `THREE.Group` whose children
 * carry `userData.catalogId`, so a composite can be exploded back into
 * individual catalog props at any time.
 */

export interface WorkZoneParams {
  /** Length of the closed work area downstream of the taper, metres. */
  length: number;
  /**
   * Merging taper length, metres. MUTCD: L = W·S for 45 mph and above,
   * L = W·S²/60 below — 55 m is a 3.6 m lane at 30 mph.
   */
  taperLength: number;
  /** Which lane is closed, relative to the direction of travel (+X). */
  side: 'left' | 'right';
  laneWidth: number;
  /** Channelizing device spacing through the taper, metres. */
  deviceSpacing?: number;
  /** Drum spacing along the closed work area, metres. */
  drumSpacing?: number;
  /** Distance from the taper start back to the advance warning sign, metres. */
  advanceWarning?: number;
  /** Downstream taper length used to reopen the lane, metres. */
  terminationLength?: number;
}

export interface WorkZoneCounts {
  cones: number;
  drums: number;
  signs: number;
  arrowBoards: number;
  total: number;
}

const DEFAULT_WORK_ZONE: WorkZoneParams = {
  length: 60,
  taperLength: 55,
  side: 'right',
  laneWidth: 3.6,
};

/**
 * A single-lane closure, laid out as MUTCD lays one out.
 *
 * ```
 *          sign            arrow board
 *            ▼                  ▼
 *   ─────────────────────────────────────────────────────  open lane
 *   · · · · · · · · · ·  o                                  ← lane line (z = 0)
 *                    ╲ o o o o o o o o o o o o o    o       ← drums, work area
 *   ══════════════════ o ═══════════════════════ o ══════   kerb (z = ±laneWidth)
 *      advance          taper            work area   termination
 * ```
 *
 * The origin is on the lane line at the station where the taper begins; +X is
 * the direction of travel and the closed lane lies towards +Z (`side: 'right'`)
 * or −Z (`side: 'left'`). Everything upstream of the origin has negative X.
 */
export function buildWorkZone(params: Partial<WorkZoneParams> = {}): Group {
  const p: WorkZoneParams = { ...DEFAULT_WORK_ZONE, ...params };
  const group = new Group();
  group.name = 'work-zone';

  const side = p.side === 'right' ? 1 : -1;
  const lane = p.laneWidth;
  const taper = Math.max(p.taperLength, 1);
  const spacing = p.deviceSpacing ?? Math.min(12, taper / 4);
  const drumSpacing = p.drumSpacing ?? 15;
  const advance = p.advanceWarning ?? 45;
  const termination = p.terminationLength ?? 12;

  const place = (id: CatalogId, x: number, z: number, yaw = 0): Object3D => {
    const prop = buildProp(id);
    prop.position.set(x, 0, z);
    prop.rotation.y = yaw;
    group.add(prop);
    return prop;
  };

  // Advance warning sign on the shoulder, facing oncoming traffic.
  place('construction.sign_road_work', -advance, side * (lane + 0.9), Math.PI);
  const signs = 1;

  // Arrow board just upstream of the taper, telling traffic which way to merge.
  const board = buildProp('construction.arrow_board', {
    direction: p.side === 'right' ? 'left' : 'right',
    raised: true,
  });
  board.position.set(-4, 0, side * lane * 0.55);
  board.rotation.y = Math.PI;
  group.add(board);
  const arrowBoards = 1;

  // Merging taper: kerb-side edge at the upstream end, lane line at the
  // downstream end. Devices are evenly spaced along the taper.
  const taperCones = Math.max(3, Math.floor(taper / spacing) + 1);
  for (let i = 0; i < taperCones; i++) {
    const t = i / (taperCones - 1);
    place('construction.traffic_cone', t * taper, side * lane * (1 - t));
  }

  // Work area: drums on the lane line, plus a drum closing each end.
  const drums = Math.max(2, Math.floor(p.length / drumSpacing) + 1);
  for (let i = 0; i < drums; i++) {
    const t = drums === 1 ? 0 : i / (drums - 1);
    place('construction.channelizer_drum', taper + t * p.length, 0);
  }

  // Downstream termination taper reopening the lane.
  const terminationCones = 3;
  for (let i = 0; i < terminationCones; i++) {
    const t = (i + 1) / terminationCones;
    place(
      'construction.traffic_cone',
      taper + p.length + t * termination,
      side * lane * t,
    );
  }

  const counts: WorkZoneCounts = {
    cones: taperCones + terminationCones,
    drums,
    signs,
    arrowBoards,
    total: taperCones + terminationCones + drums + signs + arrowBoards,
  };
  group.userData.workZone = { ...p, ...counts };
  group.userData.counts = counts;
  return group;
}

export interface ParkedRowParams {
  count: number;
  /** Bumper-to-bumper gap between neighbours, metres. */
  gap: number;
  /** Vehicle ids to cycle through. */
  mix?: readonly CatalogId[];
  /** Deterministic variation seed (picks types and paint). */
  seed?: number;
  /** Face the row along −X instead (the far kerb of a two-way street). */
  facing?: 'forward' | 'reverse';
}

const DEFAULT_MIX: readonly CatalogId[] = [
  'vehicle.sedan',
  'vehicle.suv',
  'vehicle.hatchback',
  'vehicle.sedan',
  'vehicle.pickup',
  'vehicle.van',
  'vehicle.hatchback',
  'vehicle.suv',
];

/**
 * A kerbside row of parked vehicles, centred on the origin and running along
 * +X. Spacing is bumper-to-bumper `gap`, so the row's total length is
 * deterministic and the group can be dropped straight onto a parking lane.
 */
export function buildParkedRow(params: Partial<ParkedRowParams> = {}): Group {
  const count = Math.max(0, Math.round(params.count ?? 5));
  const gap = params.gap ?? 1.0;
  const mix = params.mix ?? DEFAULT_MIX;
  const seed = params.seed ?? 0;
  const reverse = params.facing === 'reverse';
  const group = new Group();
  group.name = 'parked-row';

  // Lay the row out nose-to-tail, then recentre it on the origin.
  let cursor = 0;
  const spans: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = mix[(i + seed) % mix.length] as CatalogId;
    const prop = buildProp(id, { color: vehicleColor(i + seed) } as never);
    const length = getEntry(id).dims.l;
    prop.position.x = cursor + length / 2;
    prop.rotation.y = reverse ? Math.PI : 0;
    spans.push(length);
    cursor += length + gap;
    group.add(prop);
  }

  const total = count > 0 ? cursor - gap : 0;
  for (const child of group.children) child.position.x -= total / 2;
  group.userData.counts = { vehicles: count };
  group.userData.rowLength = total;
  group.userData.spans = spans;
  return group;
}
