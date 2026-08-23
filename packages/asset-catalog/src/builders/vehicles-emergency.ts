import { Group, type Mesh, type MeshStandardMaterial } from 'three';

import { box, cyl, mirrored, type Point2, profile, sphere, type Vec3 } from '../geometry';
import { material } from '../materials';
import { beacon, carShell, ladder, lightBar, shutter, type VehicleParams } from './shell';

/**
 * The emergency fleet: ambulance, police cruiser, police SUV, fire command SUV,
 * fire pumper.
 *
 * These five are transcribed from the 2D tiles in the editor's `vehicle-art`
 * region (`emergency.tsx`), one tile per builder, following the icon->metres
 * rule documented at the top of `shell.ts`. The transcription is kept *in icon
 * space* here — every number below can be read straight off the corresponding
 * line of the tile — because that is the only way the two fidelities stay the
 * same drawing as the artwork moves.
 *
 * Livery is the identity of this family, so the shell colour comes from
 * `params.color` (the catalog already defaults these ids to white, dark blue
 * and fire red) and only the *markings* are hardcoded: the red cross, the
 * reflective stripes, the gold department emblems and the beacon lenses.
 */

/** Ground line of the 96x48 tile viewBox. */
const GROUND = 41;

/** Marking hues, straight from the tiles' `LIVERY` table. */
const CROSS_RED = '#e2352c';
const FIRE_RED = '#c92f28';
const STRIPE_WHITE = '#eaf2fc';
const GOLD = '#e6c469';
const BEACON_BLUE = '#4d8ff7';

interface IconFrame {
  /** Icon column -> metres along X, centred on the built bounding box. */
  x(iconX: number): number;
  /** Icon row -> metres above the ground plane. */
  y(iconY: number): number;
  /** Icon column span -> metres. */
  dx(units: number): number;
  /** Icon row span -> metres. */
  dy(units: number): number;
  /** Transcribe a side-view outline for `profile`. */
  pts(points: readonly Point2[]): Point2[];
}

/**
 * `shell.ts`'s transcription rule with both divisors pinned to the drawing
 * rather than assumed: `minX`/`maxX` are the horizontal extremes of the tile
 * and become the catalogued `length` centred on x = 0, and icon row `top`
 * becomes `height` metres. Pinning them is what makes the three hard
 * constraints — dims within 10%, lowest point on the ground, centred on the
 * placement point — fall out of the transcription instead of being chased
 * afterwards.
 */
function tile(f: {
  minX: number;
  maxX: number;
  length: number;
  top: number;
  height: number;
}): IconFrame {
  const sx = f.length / (f.maxX - f.minX);
  const sy = f.height / (GROUND - f.top);
  const midX = (f.minX + f.maxX) / 2;
  const x = (iconX: number): number => (iconX - midX) * sx;
  const y = (iconY: number): number => (GROUND - iconY) * sy;
  return {
    x,
    y,
    dx: (units) => units * sx,
    dy: (units) => units * sy,
    pts: (points) => points.map((p) => [x(p[0]), y(p[1])] as Point2),
  };
}

/* ----------------------------------------------------------------- kit */

/**
 * Thin panel laid on both flanks: stripes, decals, door skins, panel seams.
 * The whole family is liveried, so this is the single most-used part here.
 */
function flankPanels(
  at: Point2,
  size: Point2,
  z: number,
  mat: MeshStandardMaterial,
  thickness = 0.02,
): Mesh[] {
  return mirrored(z, (side) =>
    box([size[0], size[1], thickness], mat, { at: [at[0], at[1], side] }),
  ) as Mesh[];
}

/** Flat panel spanning `a -> b` in the side plane — raked screens and vents. */
function rakedPanel(
  a: Point2,
  b: Point2,
  thickness: number,
  width: number,
  mat: MeshStandardMaterial,
): Mesh {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const mesh = box([Math.hypot(dx, dy), thickness, width], mat);
  mesh.rotation.z = Math.atan2(dy, dx);
  mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0);
  return mesh;
}

/**
 * Radiator grille on the nose face, matching the tiles' `Grille` bar count.
 * `carShell`'s own grille is placed from `spec.length`, which on these five
 * is the extent of a push bar or winch bumper rather than the nose.
 */
function grille(x: number, y: number, h: number, width: number, bars: number): Mesh[] {
  const parts: Mesh[] = [box([0.07, h, width], material('plastic'), { at: [x, y, 0] })];
  for (let i = 0; i < bars; i += 1) {
    const yy = y - h / 2 + (h * (i + 0.5)) / bars;
    parts.push(box([0.09, h / (bars * 3), width * 0.94], material('steel'), { at: [x, yy, 0] }));
  }
  return parts;
}

/**
 * Wheel-arch flare: the upper arc only, as a short fan of tangent blocks,
 * centred on the axle so it registers with the wheel opening cut into the
 * hull by `archOpening` below.
 *
 * `shell.ts`'s `archFlare` centres its arc at `radius` above the ground and
 * `carShell` passes it `wheelRadius * 1.28`, which puts the arc centre 28%
 * of a radius above the axle and the crown at 2.56 radii — clear of the
 * opening rather than around it. Same construction, different datum.
 */
function archLip(x: number, radius: number, z: number, steps = 4): Mesh[] {
  const plastic = material('plastic');
  const span = 2.5;
  const lip = radius * 1.14;
  const chord = (lip * span) / steps;
  const parts: Mesh[] = [];
  for (let i = 0; i < steps; i += 1) {
    // Angle from straight up, so the arc ends stay clear of the ground.
    const a = -span / 2 + (span * (i + 0.5)) / steps;
    parts.push(
      ...(mirrored(z, (side) =>
        box([chord * 1.12, radius * 0.15, 0.05], plastic, {
          at: [x + Math.sin(a) * lip, radius + Math.cos(a) * lip, side],
          rot: [0, 0, -a],
        }),
      ) as Mesh[]),
    );
  }
  return parts;
}

/**
 * Wheel opening spliced into the floor line of a hull outline: the arc of a
 * circle of `radius * 1.16` about the axle, walked front to rear between the
 * two points where it meets `floor`.
 *
 * Costs no extra meshes — it is the same extrusion, with the floor run bent
 * up over each axle — and it is what makes the tyre stand in an arch instead
 * of under a slab. Hulls here are authored nose-to-tail, so the arcs are
 * emitted in the same descending-X direction as the floor run they replace.
 */
function archOpening(x: number, radius: number, floor: number, steps = 7): Point2[] {
  const r = radius * 1.16;
  const edge = Math.acos(Math.min(Math.max((floor - radius) / r, -0.98), 0.98));
  const points: Point2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const phi = edge - (2 * edge * i) / steps;
    points.push([x + Math.sin(phi) * r, radius + Math.cos(phi) * r]);
  }
  return points;
}

/** Door mirror on a stalk. `outer` is the |Z| the mirror head reaches. */
function doorMirrors(x: number, y: number, outer: number, scale = 1): Mesh[] {
  const plastic = material('plastic');
  const parts: Mesh[] = [];
  for (const sign of [1, -1]) {
    parts.push(
      box([0.05, 0.05, 0.11 * scale], plastic, { at: [x, y, sign * (outer - 0.075 * scale)] }),
      box([0.07, 0.20 * scale, 0.05], plastic, { at: [x, y, sign * (outer - 0.025)] }),
    );
  }
  return parts;
}

/** Antenna whip on its roof puck, reaching `tip` metres. */
function whip(at: Vec3, tip: number): Mesh[] {
  const height = Math.max(tip - at[1], 0.02);
  return [
    cyl(0.05, 0.03, material('plastic'), { at, segments: 8 }),
    cyl(0.015, height, material('chrome'), {
      rTop: 0.006,
      at: [at[0], at[1] + height / 2, at[2]],
      segments: 6,
    }),
  ];
}

/** Tubular police push bumper: fore/aft uprights each side, two cross rails. */
function pushBar(aft: number, fore: number, z: number, bottom: number, top: number): Mesh[] {
  const steel = material('steel');
  const height = top - bottom;
  const parts: Mesh[] = [];
  for (const x of [aft, fore]) {
    parts.push(
      ...(mirrored(z, (side) =>
        cyl(0.035, height, steel, { at: [x, bottom + height / 2, side], segments: 8 }),
      ) as Mesh[]),
    );
  }
  const mid = (aft + fore) / 2;
  for (const y of [bottom + height * 0.28, bottom + height * 0.78]) {
    parts.push(cyl(0.032, z * 2, steel, { axis: 'z', at: [mid, y, 0], segments: 8 }));
  }
  return parts;
}

/** Gold department emblem: a faceted badge with a marking-red centre bar. */
function emblem(x: number, y: number, z: number, r: number, segments: number): Mesh[] {
  const parts: Mesh[] = [];
  for (const sign of [1, -1]) {
    parts.push(
      cyl(r, 0.02, material('paint', GOLD), {
        axis: 'z',
        at: [x, y, sign * z],
        segments,
      }),
      box([r * 0.28, r * 1.1, 0.02], material('paint', FIRE_RED), { at: [x, y, sign * (z + 0.01)] }),
    );
  }
  return parts;
}

/* ----------------------------------------------------------- ambulance */

/**
 * Box-body ambulance: a van cab with a taller, square patient box behind it.
 * Cab roof lands at 2.00 m and the box roof at 2.48 m, so the step up between
 * them — the one cue that separates an ambulance from a panel van — is half a
 * metre of it. Rear step, side door, roof bar and the red cross come from the
 * `vehicle.ambulance` tile.
 */
export function buildAmbulance(params: VehicleParams = { color: '#eceff1' }): Group {
  // Rear step to nose, and the box roof as the height datum; the rear beacon
  // dome on top of it is what finally reaches the catalogued 2.65 m.
  const f = tile({ minX: 2.8, maxX: 91.6, length: 6.1, top: 6.6, height: 2.48 });
  const width = 2.06;
  const flank = width / 2 - 0.005;
  const wheelRadius = 0.4;
  const roofBox = f.y(6.6);
  const roofCab = f.y(13.2);

  const group = carShell(
    {
      length: 6.1,
      width,
      height: roofBox,
      wheelRadius,
      wheelWidth: 0.26,
      axles: [f.x(79), f.x(22)],
      // AMBULANCE_SHELL: box rear, box roof, the step down to the cab roof,
      // then the raked screen, bonnet and nose.
      hull: [
        ...f.pts([
          [6, 33.6],
          [6, 7.6],
          [8, 6.6],
          [55.4, 6.6],
          [55.4, 13.2],
          [69.4, 13.2],
          [72.6, 15],
          [76.8, 20.6],
          [88.4, 22.6],
          [91.6, 26.2],
          [91.6, 31.4],
          [90.2, 33.6],
        ]),
        ...archOpening(f.x(79), wheelRadius, f.y(33.6)),
        ...archOpening(f.x(22), wheelRadius, f.y(33.6)),
      ],
      hullRadius: 0.1,
      headlight: { x: f.x(87.2), y: f.y(23.4), z: 0.72, w: 0.34, h: 0.17 },
      taillight: { x: f.x(6.3), y: f.y(22.6), z: 0.74, w: 0.3, h: 0.22 },
      sill: [f.y(31.6), 0.1],
      exhaust: { x: f.x(8), y: f.y(32), z: 0.58 },
      discBrakes: true,
    },
    params,
  );

  const paint = material('paint', params.color);
  const glass = material('glass');
  const plastic = material('plastic');
  const chrome = material('chrome');
  group.add(...archLip(f.x(79), wheelRadius, flank));
  group.add(...archLip(f.x(22), wheelRadius, flank));

  // Glazing is inset on a box body: the hull is solid through the cab, so a
  // glass profile would be buried inside it.
  group.add(rakedPanel([f.x(72.4), f.y(15.6)], [f.x(76.6), f.y(20.4)], 0.05, width - 0.3, glass));
  group.add(
    ...flankPanels(
      [f.x(64.3), f.y(17.1)],
      [f.dx(12.2), f.dy(6.2)],
      flank,
      glass,
      0.05,
    ),
  );
  // Frosted window in the box side door.
  group.add(
    ...flankPanels([f.x(48.8), f.y(13.9)], [f.dx(8.8), f.dy(6.2)], flank, glass, 0.05),
  );

  // Front bumper and the rear step that the crew loads over.
  group.add(box([0.16, 0.3, width - 0.14], plastic, { at: [2.99, f.y(31.4), 0] }));
  group.add(box([f.dx(6.2), f.dy(2.8), 1.7], plastic, { at: [f.x(5.9), f.y(34.6), 0] }));
  group.add(box([f.dx(6.2), 0.04, 1.62], chrome, { at: [f.x(5.9), f.y(33.3), 0] }));
  group.add(...grille(3.02, f.y(28.4), f.dy(3.4), width * 0.6, 2));

  // Chassis rails under the box floor.
  group.add(
    ...mirrored(0.42, (z) =>
      box([f.dx(76), f.dy(3), 0.14], plastic, { at: [f.x(48), f.y(34.3), z] }),
    ),
  );

  // Box roof: edge rails, the cab light bar sitting well below the box roof,
  // and the rear dome beacon that tops the vehicle out.
  group.add(
    ...mirrored(flank - 0.06, (z) =>
      box([f.dx(48), 0.05, 0.07], paint, { at: [f.x(30), roofBox + 0.02, z] }),
    ),
  );
  group.add(...lightBar([f.x(64), roofCab + 0.08, 0], [0.85, 0.16, 1.55]));
  group.add(...beacon([f.x(10.5), roofBox + 0.085, 0], 0.1, 0.17, 'taillight'));

  // Amber corner markers on the box, red marker on the rear face.
  for (const iconX of [51.2, 7.4]) {
    group.add(
      ...mirrored(flank, (z) =>
        box([0.11, 0.07, 0.03], material('lamp'), { at: [f.x(iconX + 1.3), f.y(8.7), z] }),
      ),
    );
  }
  group.add(
    ...mirrored(0.55, (z) =>
      box([0.03, 0.1, 0.14], material('taillight'), { at: [f.x(5.6), f.y(31.6), z] }),
    ),
  );

  // Livery: the full red cross on the box flank plus the belt stripe, broken
  // by the arches exactly where the tile breaks it.
  const cross = material('paint', CROSS_RED);
  group.add(...flankPanels([f.x(33.1), f.y(19.9)], [f.dx(12.2), f.dy(3.8)], flank, cross));
  group.add(...flankPanels([f.x(33.1), f.y(19.9)], [f.dx(3.8), f.dy(11.4)], flank, cross));
  for (const [from, to] of [
    [7, 15],
    [29, 72.2],
    [86, 90.4],
  ] as const) {
    group.add(
      ...flankPanels(
        [f.x((from + to) / 2), f.y(29)],
        [f.dx(to - from), f.dy(3.2)],
        flank,
        cross,
      ),
    );
  }

  // Panel joints: rear door, side door and cab bulkhead.
  for (const iconX of [17.8, 42.6, 54.6]) {
    group.add(...flankPanels([f.x(iconX), f.y(20.3)], [0.03, f.dy(25.4)], flank, plastic));
  }
  group.add(...flankPanels([f.x(49), f.y(25.6)], [f.dx(11.2), 0.04], flank, chrome));
  group.add(box([0.04, f.dy(24), 0.05], plastic, { at: [f.x(5.9), f.y(21.6), 0] }));

  group.add(...doorMirrors(f.x(72), f.y(16.6), 1.05));
  return group;
}

/* ------------------------------------------------------ police cruiser */

/**
 * Marked saloon. Low body, deep glasshouse, roof at 1.40 m — set against the
 * SUV below it, which is the same length with a roof 0.38 m higher and a much
 * shallower greenhouse over a much deeper flank.
 */
export function buildPoliceCruiser(params: VehicleParams = { color: '#1f2937' }): Group {
  // Boot to push-bar tip; the tile's roof line is the height datum and the
  // bar plus the boot-lid whip stack above it.
  const f = tile({ minX: 7.6, maxX: 95.9, length: 5.1, top: 15, height: 1.4 });
  const width = 1.88;
  const flank = width / 2 - 0.005;
  const roof = f.y(15);
  const wheelRadius = 0.32;

  const group = carShell(
    {
      length: 5.1,
      width,
      height: roof,
      wheelRadius,
      wheelWidth: 0.24,
      axles: [f.x(73), f.x(24.8)],
      // CRUISER_SHELL below the shoulder line: boot, flank, bonnet, nose.
      hull: [
        ...f.pts([
          [10, 23.6],
          [15, 23],
          [30.2, 22.8],
          [70.8, 22.6],
          [86.4, 23.4],
          [91.4, 26.6],
          [91.8, 30.6],
          [90.2, 33.2],
        ]),
        ...archOpening(f.x(73), wheelRadius, f.y(33.2)),
        ...archOpening(f.x(24.8), wheelRadius, f.y(33.2)),
        ...f.pts([
          [8.6, 33.2],
          [8.6, 30.4],
        ]),
      ],
      hullRadius: 0.08,
      // Notchback backlight, two door panes and the raked screen as one
      // greenhouse; the painted roof cap lands on top of it.
      glass: f.pts([
        [34.8, 22.4],
        [40.2, 16.4],
        [64.6, 16.4],
        [70, 22.3],
      ]),
      glassRadius: 0.06,
      roof: [f.x(40.2), f.x(64.6), 0.1],
      headlight: { x: f.x(85.8), y: f.y(24.4), z: 0.66, w: 0.34, h: 0.16 },
      taillight: { x: f.x(9.4), y: f.y(24.2), z: 0.68, w: 0.3, h: 0.15 },
      sill: [f.y(32.4), 0.09],
      exhaust: { x: f.x(11.6), y: f.y(32.6), z: 0.35 },
      discBrakes: true,
    },
    params,
  );

  const plastic = material('plastic');
  const chrome = material('chrome');

  group.add(box([0.14, 0.24, width - 0.16], plastic, { at: [f.x(90.8), f.y(31.4), 0] }));
  group.add(box([0.14, 0.24, width - 0.16], plastic, { at: [f.x(11), f.y(31.4), 0] }));
  group.add(...grille(f.x(91.6), f.y(27.8), f.dy(3), width * 0.58, 2));

  // Push bumper, and the roof bar the whole vehicle is read by.
  group.add(...pushBar(f.x(91.8), f.x(94.4), 0.52, f.y(33), f.y(24.4)));
  group.add(...lightBar([f.x(51.2), roof + 0.06, 0], [0.95, 0.12, 1.5]));

  // A-pillar spotlight and the boot-lid antenna whip.
  group.add(
    ...mirrored(flank - 0.05, (z) =>
      cyl(0.045, 0.12, chrome, { axis: 'x', at: [f.x(64.4), f.y(17), z], segments: 8 }),
    ),
  );
  group.add(
    ...mirrored(flank - 0.05, (z) =>
      sphere(0.055, material('lamp'), { at: [f.x(67), f.y(17), z], segments: 8 }),
    ),
  );
  group.add(...whip([f.x(16.6), f.y(23), 0.44], 1.55));

  // Two-tone: black door skins over the shell, with the department badge.
  group.add(
    ...flankPanels([f.x(52.2), f.y(28.1)], [f.dx(22.4), f.dy(9)], flank, plastic),
  );
  group.add(...emblem(f.x(52.2), f.y(27.9), flank + 0.015, 0.1, 5));

  for (const iconX of [41, 51.8, 63.4]) {
    group.add(...flankPanels([f.x(iconX), f.y(28.1)], [0.025, f.dy(9)], flank + 0.012, plastic));
  }
  for (const [from, to] of [
    [42.4, 49.4],
    [53, 60.6],
  ] as const) {
    group.add(
      ...flankPanels(
        [f.x((from + to) / 2), f.y(24.6)],
        [f.dx(to - from), 0.035],
        flank + 0.012,
        chrome,
      ),
    );
  }
  group.add(...flankPanels([f.x(52.2), f.y(23.2)], [f.dx(22.4), 0.03], flank, chrome));

  group.add(...doorMirrors(f.x(66), f.y(19.4), 0.99));
  return group;
}

/* ---------------------------------------------------------- police SUV */

/**
 * Marked patrol utility. Same 5.1 m as the cruiser, but the roof is at 1.78 m
 * over a 1.29 m shoulder line, so the glasshouse is a shallow band on a deep
 * flank instead of the cruiser's tall cabin — plus a raked D-pillar, arch
 * flares, rocker cladding and a bank of rear roof antennas.
 */
export function buildPoliceSuv(params: VehicleParams = { color: '#e9ecef' }): Group {
  const f = tile({ minX: 18, maxX: 96.1, length: 5.1, top: 11.4, height: 1.78 });
  const width = 1.9;
  const flank = width / 2 - 0.005;
  const roof = f.y(11.4);
  const wheelRadius = 0.38;
  const front = f.x(74);
  const rear = f.x(27);

  const group = carShell(
    {
      length: 5.1,
      width,
      height: roof,
      wheelRadius,
      wheelWidth: 0.26,
      axles: [front, rear],
      // POLICE_SUV_SHELL below the shoulder: the leading edge is the raked
      // tailgate line, taken where it crosses the belt.
      hull: [
        ...f.pts([
          [18, 32.2],
          [21.6, 14],
          [24.6, 11.4],
          [26.6, 11.4],
          [25.4, 19.6],
          [67.2, 19.6],
          [71.8, 20.4],
          [87.6, 21.8],
          [91.8, 25.2],
          [92.1, 29.4],
          [90.8, 32.2],
        ]),
        ...archOpening(front, wheelRadius, f.y(32.2)),
        ...archOpening(rear, wheelRadius, f.y(32.2)),
        ...f.pts([[18, 32.2]]),
      ],
      hullRadius: 0.1,
      // Shallow greenhouse; the rear edge leans forward as it rises.
      glass: f.pts([
        [25.4, 19],
        [26.6, 12.4],
        [65.6, 12.4],
        [67.2, 13.2],
        [71.2, 19],
      ]),
      glassRadius: 0.06,
      roof: [f.x(26.6), f.x(65.6), 0.09],
      headlight: { x: f.x(86.6), y: f.y(22.6), z: 0.66, w: 0.34, h: 0.17 },
      taillight: { x: f.x(19), y: f.y(22), z: 0.7, w: 0.28, h: 0.24 },
      sill: [f.y(31), 0.1],
      exhaust: { x: f.x(20), y: f.y(31.4), z: 0.4 },
      discBrakes: true,
    },
    params,
  );

  const plastic = material('plastic');
  const chrome = material('chrome');

  group.add(box([0.14, 0.26, width - 0.16], plastic, { at: [f.x(90), f.y(31.2), 0] }));
  group.add(box([0.14, 0.26, width - 0.16], plastic, { at: [f.x(19.4), f.y(31.2), 0] }));
  group.add(...grille(f.x(91.6), f.y(26), f.dy(3.4), width * 0.58, 3));
  group.add(...pushBar(f.x(92), f.x(94.3), 0.54, f.y(32), f.y(22.4)));
  group.add(...archLip(front, wheelRadius, flank));
  group.add(...archLip(rear, wheelRadius, flank));

  // Roof kit: bar set forward, then the antenna farm over the rear seats —
  // no A-pillar spotlight, which is the cruiser's tell.
  group.add(...lightBar([f.x(53), roof + 0.055, 0], [1.15, 0.11, 1.52]));
  group.add(...whip([f.x(28), roof, 0.42], 1.93));
  group.add(...whip([f.x(32.4), roof, 0.16], 1.88));
  group.add(...whip([f.x(37.4), roof, -0.34], 1.95));

  // Reflective belt stripe with its blue pinstripe, then blacked-out rockers.
  group.add(
    ...flankPanels(
      [f.x(52.1), f.y(21.45)],
      [f.dx(63), f.dy(1.7)],
      flank,
      material('paint', STRIPE_WHITE),
    ),
  );
  group.add(
    ...flankPanels(
      [f.x(52.1), f.y(22.7)],
      [f.dx(63), f.dy(0.8)],
      flank + 0.005,
      material('paint', BEACON_BLUE),
    ),
  );
  group.add(
    ...flankPanels([f.x(50.6), f.y(30.9)], [f.dx(32), f.dy(2.6)], flank + 0.01, plastic, 0.035),
  );
  group.add(
    ...flankPanels([f.x(86.3), f.y(30.9)], [f.dx(9.4), f.dy(2.6)], flank + 0.01, plastic, 0.035),
  );

  for (const iconX of [25.8, 37.4, 51.6]) {
    group.add(...flankPanels([f.x(iconX), f.y(24.6)], [0.025, f.dy(10)], flank + 0.012, plastic));
  }
  for (const [from, to] of [
    [39, 48.4],
    [53.4, 62.2],
  ] as const) {
    group.add(
      ...flankPanels(
        [f.x((from + to) / 2), f.y(25)],
        [f.dx(to - from), 0.035],
        flank + 0.012,
        chrome,
      ),
    );
  }

  group.add(...doorMirrors(f.x(69.6), f.y(15.1), 0.99));
  return group;
}

/* ----------------------------------------------------- fire command SUV */

/**
 * Fire department command rig: a lifted truck chassis under a two-door body
 * with the rear quarter blanked off for kit. The body floor sits 0.63 m up
 * with the frame rail and rear axle in clear air beneath it, so the running
 * boards and the roof cargo box read as a truck conversion rather than a
 * painted SUV.
 */
export function buildFireCommandSuv(params: VehicleParams = { color: '#b91c1c' }): Group {
  const f = tile({ minX: 17.2, maxX: 93.4, length: 5.2, top: 10.6, height: 1.7 });
  const width = 1.88;
  const flank = width / 2 - 0.005;
  const roof = f.y(10.6);
  const wheelRadius = 0.37;
  const front = f.x(72.5);
  const rear = f.x(24.3);

  const group = carShell(
    {
      length: 5.2,
      width,
      height: roof,
      wheelRadius,
      wheelWidth: 0.28,
      axles: [front, rear],
      // FIRE_COMMAND_SHELL: raked tailgate up to a full-height rear quarter,
      // then down to the belt for the short two-door cab.
      hull: [
        ...f.pts([
          [17.2, 29.8],
          [18.8, 12.4],
          [21.2, 10.6],
          [32.8, 10.6],
          [32.8, 19.4],
          [62.6, 19.4],
          [68.6, 19.8],
          [84.6, 20.8],
          [89.8, 24.2],
          [90.2, 27.8],
          [88.8, 29.8],
        ]),
        ...archOpening(front, wheelRadius, f.y(29.8)),
        ...archOpening(rear, wheelRadius, f.y(29.8)),
      ],
      hullRadius: 0.1,
      glass: f.pts([
        [32.8, 18.4],
        [32.8, 11.8],
        [61, 11.8],
        [62.6, 13],
        [67.8, 19.4],
      ]),
      glassRadius: 0.06,
      roof: [f.x(32.8), f.x(61), 0.09],
      headlight: { x: f.x(84.4), y: f.y(21), z: 0.64, w: 0.34, h: 0.17 },
      taillight: { x: f.x(18.2), y: f.y(21.2), z: 0.68, w: 0.28, h: 0.24 },
      exhaust: { x: f.x(19.6), y: f.y(30.6), z: 0.42 },
      discBrakes: true,
    },
    params,
  );

  const paint = material('paint', params.color);
  const plastic = material('plastic');
  const steel = material('steel');

  group.add(...archLip(front, wheelRadius, flank));
  group.add(...archLip(rear, wheelRadius, flank));

  // Lifted chassis: frame rails and a live rear axle under the body.
  group.add(
    ...mirrored(0.42, (z) =>
      box([f.dx(52), f.dy(2.4), 0.14], plastic, { at: [f.x(47), f.y(30.6), z] }),
    ),
  );
  group.add(cyl(0.055, 1.3, steel, { axis: 'z', at: [rear, wheelRadius, 0], segments: 10 }));
  group.add(sphere(0.13, steel, { at: [rear, wheelRadius, 0.12], segments: 10 }));

  // Running boards slung outboard of the sill.
  for (const sign of [1, -1]) {
    const z = sign * 0.9;
    group.add(box([f.dx(31), f.dy(1.8), 0.16], plastic, { at: [f.x(48.5), f.y(32.1), z] }));
    for (const iconX of [35.4, 61.6]) {
      group.add(box([0.06, 0.1, 0.05], steel, { at: [f.x(iconX), f.y(30.6), z] }));
    }
  }

  // Roof cargo box on its rails — tapered leading edge, so it never reads as
  // a raised roof. This is the silhouette cue for the command rig.
  group.add(
    ...mirrored(0.5, (z) =>
      box([f.dx(32), 0.05, 0.06], steel, { at: [f.x(37), roof + 0.03, z] }),
    ),
  );
  const cargo = profile(
    f
      .pts([
        [27.6, 10.6],
        [27.6, 7.2],
        [29.2, 5.6],
        [46.2, 5.6],
        [50, 7.4],
        [51.2, 10.6],
      ])
      .map(([x, y]) => [x, y + 0.06] as Point2),
    1.34,
    paint,
    { radius: 0.05, bevel: 0.04 },
  );
  group.add(cargo);

  // Single red beacon plus the radio antenna farm.
  group.add(...beacon([f.x(56.4), roof + 0.09, 0], 0.09, 0.16, 'taillight'));
  group.add(...whip([f.x(23.6), roof, 0.4], 1.95));
  group.add(...whip([f.x(54.6), roof, 0.46], 1.92));
  group.add(...whip([f.x(57.6), roof, -0.4], 1.88));

  // Reflective flank stripe over a fire-red pinstripe, and the gold emblem.
  group.add(
    ...flankPanels(
      [f.x(51.7), f.y(20.1)],
      [f.dx(65), f.dy(1.8)],
      flank,
      material('paint', STRIPE_WHITE),
    ),
  );
  group.add(
    ...flankPanels(
      [f.x(51.7), f.y(21.45)],
      [f.dx(65), f.dy(0.9)],
      flank + 0.005,
      material('paint', FIRE_RED),
    ),
  );
  group.add(...emblem(f.x(54), f.y(24.6), flank + 0.015, 0.11, 8));

  // Flank equipment locker.
  for (const sign of [1, -1]) {
    group.add(
      ...shutter([f.x(40), f.y(26), sign * (flank + 0.01)], [f.dx(10), f.dy(4.8)], 3, steel),
    );
  }
  for (const iconX of [32.4, 46.8]) {
    group.add(...flankPanels([f.x(iconX), f.y(24)], [0.025, f.dy(10.4)], flank + 0.012, plastic));
  }
  group.add(
    ...flankPanels([f.x(26.6), f.y(15)], [f.dx(8), 0.035], flank + 0.012, material('chrome')),
  );

  // Winch bumper instead of a police push bar; plain rear valance.
  group.add(box([f.dx(6.2), f.dy(4.8), 1.62], plastic, { at: [f.x(90.3), f.y(27.2), 0] }));
  group.add(
    cyl(0.09, 0.42, material('chrome'), { axis: 'z', at: [f.x(91.6), f.y(27.2), 0], segments: 10 }),
  );
  group.add(box([0.1, f.dy(3.4), width - 0.2], plastic, { at: [f.x(18.4), f.y(28.4), 0] }));
  group.add(...grille(f.x(88.2), f.y(24.2), f.dy(3.2), width * 0.56, 3));

  group.add(...doorMirrors(f.x(65.2), f.y(15.6), 0.99));
  return group;
}

/* --------------------------------------------------------- fire engine */

/**
 * Structural pumper. The proportions are the point: a flat cab-over crew cab
 * whose screen is nearly vertical, then five metres of pump body at 2.56 m
 * with a hose-bed coaming above it, roll-up shutters down both flanks, the
 * pump operator's panel amidships and rear duals under a raised wheel well.
 */
export function buildFireEngine(params: VehicleParams = { color: '#b91c1c' }): Group {
  // Rear step to nose; the cab roof is the datum and the roof bar tops out at
  // the catalogued 3.3 m.
  const f = tile({ minX: 2.2, maxX: 92.8, length: 10.2, top: 6.2, height: 3.12 });
  const width = 2.46;
  const flank = width / 2 - 0.005;
  const roofCab = f.y(6.2);
  const bodyTop = f.y(12.4);
  const wheelRadius = 0.55;
  const front = f.x(76);
  const rear = f.x(24);

  const group = carShell(
    {
      length: 10.2,
      width,
      height: roofCab,
      wheelRadius,
      wheelWidth: 0.3,
      axles: [front, rear],
      dualAxles: [1],
      // FIRE_ENGINE_SHELL: pump body, the step up to the cab-over roof, the
      // near-vertical screen, and the raised rear wheel well in the floor.
      hull: [
        ...f.pts([
          [5, 30.4],
          [5, 12.4],
          [54.6, 12.4],
          [54.6, 6.2],
          [88, 6.2],
          [91.8, 9.4],
          [92.6, 15.4],
          [92.8, 28.4],
          [91.6, 30.4],
        ]),
        ...archOpening(front, wheelRadius, f.y(30.4)),
        ...f.pts([
          [34, 30.4],
          [34, 28.8],
          [14, 28.8],
          [14, 30.4],
        ]),
      ],
      hullRadius: 0.1,
      headlight: { x: f.x(87.2), y: f.y(21.6), z: 0.92, w: 0.36, h: 0.22 },
      taillight: { x: f.x(5.4), y: f.y(20.4), z: 0.88, w: 0.32, h: 0.3 },
      exhaust: { x: f.x(14), y: f.y(31.8), z: 0.66 },
    },
    params,
  );

  const paint = material('paint', params.color);
  const glass = material('glass');
  const plastic = material('plastic');
  const chrome = material('chrome');
  const steel = material('steel');

  group.add(...archLip(front, wheelRadius, flank, 5));

  // Cab-over glazing, inset on the solid hull. The screen lies on the cab's
  // near-vertical front face, not on the side plane, so it is transcribed from
  // the hull's own front edge and nudged clear of it.
  group.add(
    rakedPanel(
      [f.x(91.8) + 0.03, f.y(9.4)],
      [f.x(92.6) + 0.03, f.y(15.4)],
      0.05,
      width - 0.34,
      glass,
    ),
  );
  group.add(...flankPanels([f.x(79.5), f.y(13)], [f.dx(10.2), f.dy(9.2)], flank, glass, 0.06));
  group.add(...flankPanels([f.x(68.4), f.y(13.2)], [f.dx(8.8), f.dy(8.8)], flank, glass, 0.06));

  // Heavy front bumper, rear tailboard, and the frame rails between them.
  group.add(box([f.dx(3.4), f.dy(3.6), 2.4], plastic, { at: [f.x(91.1), f.y(28.4), 0] }));
  group.add(box([f.dx(3.4), 0.05, 2.3], chrome, { at: [f.x(91.1), f.y(26.9), 0] }));
  group.add(box([f.dx(5.6), f.dy(3.2), 2.3], plastic, { at: [f.x(5), f.y(31.4), 0] }));
  group.add(box([f.dx(5.6), 0.05, 2.2], chrome, { at: [f.x(5), f.y(29.9), 0] }));
  group.add(
    ...mirrored(0.55, (z) =>
      box([f.dx(80), f.dy(3.2), 0.16], plastic, { at: [f.x(48), f.y(31.2), z] }),
    ),
  );
  group.add(...grille(f.x(92.4), f.y(26), f.dy(4), width * 0.5, 3));

  // Hose-bed coaming above the pump body, with packed hose in the bed.
  const coaming = f.pts([
    [6.6, 12.4],
    [6.6, 9.6],
    [7.9, 8.4],
    [31.4, 8.4],
    [32.6, 9.6],
    [32.6, 12.4],
  ]);
  group.add(
    ...mirrored(1.14, (z) => profile(coaming, 0.07, paint, { radius: 0.03, bevel: 0.02, at: [0, 0, z] })),
  );
  group.add(box([0.07, f.dy(4), 2.28], paint, { at: [f.x(32.4), f.y(10.4), 0] }));
  group.add(box([0.07, f.dy(4), 2.28], paint, { at: [f.x(6.8), f.y(10.4), 0] }));
  group.add(box([f.dx(23), f.dy(2.6), 2.16], plastic, { at: [f.x(19.6), f.y(10.6), 0] }));
  group.add(
    ...mirrored(0.52, (z) =>
      cyl(0.13, 0.36, plastic, { axis: 'z', at: [f.x(13), f.y(10.4), z], segments: 10 }),
    ),
  );

  // Roll-up equipment shutters down both flanks — the pumper's flank rhythm.
  for (const sign of [1, -1]) {
    const z = sign * (flank + 0.01);
    for (const [from, to] of [
      [7, 19],
      [21, 33],
      [35, 45],
    ] as const) {
      group.add(
        ...shutter(
          [f.x((from + to) / 2), f.y(23.5), z],
          [f.dx(to - from), f.dy(11)],
          4,
          steel,
        ),
      );
    }
  }

  // Ladder carried along the flank: the kit ladder lies in the XZ plane, so
  // rotating it a quarter turn stands it up against the body side.
  for (const sign of [1, -1]) {
    const rack = new Group();
    rack.add(...ladder([0, 0, 0], f.dx(43.8), f.dy(2.6), 6, chrome));
    rack.rotation.x = Math.PI / 2;
    rack.position.set(f.x(28.5), f.y(15), sign * (flank + 0.05));
    group.add(rack);
  }

  // Pump operator's panel amidships: gauges and the suction intake.
  for (const sign of [1, -1]) {
    const z = sign * (flank + 0.015);
    group.add(box([f.dx(7.2), f.dy(12.2), 0.04], plastic, { at: [f.x(50.2), f.y(23.1), z] }));
    for (const [gx, gy] of [
      [48.6, 19.2],
      [51.8, 19.2],
      [50.2, 22],
    ] as const) {
      group.add(
        cyl(0.055, 0.03, chrome, { axis: 'z', at: [f.x(gx), f.y(gy), z + sign * 0.02], segments: 8 }),
      );
    }
    group.add(
      cyl(0.2, 0.06, steel, { axis: 'z', at: [f.x(50.2), f.y(25.8), z + sign * 0.02], segments: 12 }),
    );
    group.add(
      cyl(0.11, 0.08, plastic, { axis: 'z', at: [f.x(50.2), f.y(25.8), z + sign * 0.03], segments: 12 }),
    );
  }

  // Gold cab stripe, roof bar, and beacons front and rear.
  group.add(
    ...flankPanels(
      [f.x(71.9), f.y(18.85)],
      [f.dx(29), f.dy(1.3)],
      flank,
      material('paint', GOLD),
    ),
  );
  group.add(...lightBar([f.x(73), roofCab + 0.09, 0], [2, 0.18, 1.9]));
  group.add(...beacon([f.x(10.4), f.y(8.4) + 0.08, 0], 0.1, 0.16, 'taillight'));
  // Amber marker on the hose-bed coaming rail, red repeater on the cab roof.
  group.add(
    ...mirrored(1.1, (z) =>
      box([0.12, 0.07, 0.05], material('lamp'), { at: [f.x(29.2), f.y(8.4) + 0.05, z] }),
    ),
  );
  group.add(
    ...mirrored(0.88, (z) =>
      box([0.12, 0.07, 0.05], material('taillight'), { at: [f.x(58.8), roofCab + 0.04, z] }),
    ),
  );

  // Cab panel joints and crew-door handles.
  for (const iconX of [63.4, 73.6]) {
    group.add(...flankPanels([f.x(iconX), f.y(23.6)], [0.03, f.dy(11.6)], flank, plastic));
  }
  for (const [from, to] of [
    [65.4, 72.6],
    [75.6, 84],
  ] as const) {
    group.add(
      ...flankPanels([f.x((from + to) / 2), f.y(20.8)], [f.dx(to - from), 0.04], flank + 0.012, chrome),
    );
  }
  group.add(box([0.05, f.dy(17), 0.06], plastic, { at: [f.x(54.6), f.y(21), 0] }));
  group.add(box([f.dx(49.6), 0.05, 2.3], paint, { at: [f.x(29.8), bodyTop + 0.02, 0] }));

  group.add(...doorMirrors(f.x(88), f.y(12.4), 1.275, 1.3));
  return group;
}
