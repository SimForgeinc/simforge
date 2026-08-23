import { Group, type Mesh, type MeshStandardMaterial } from 'three';

import { box, capsule, cyl, mirrored, type Point2, profile, sphere, torus } from '../geometry';
import { material } from '../materials';
import { rider, type VehicleParams } from './shell';

/**
 * Micro mobility: motorcycle, bicycle, mobility scooter.
 *
 * These three are mostly frame and rider, so `carShell` has nothing to give
 * them — there is no hull to extrude. They are transcribed from the 2D tiles in
 * `vehicle-art/micro.tsx` the same way as everything else (96x48 viewBox,
 * ground at y = 41), but structure-first: every tube in the tile becomes a tube
 * here, because on a bike the voids between the tubes are the silhouette.
 *
 * Icon scale per vehicle, taken from the wheel-to-wheel span so the catalogued
 * length lands exactly:
 *   motorcycle  0.0528 m/unit, axles at icon x 35 / 63, r 5.9  -> r 0.311, wb 1.478
 *   bicycle     0.0476 m/unit, axles at icon x 33 / 57, r 6.4  -> r 0.335, wb 1.080
 *   scooter     0.0348 m/unit, axles at icon x 35 / 60         -> r 0.125 / 0.110
 *
 * Wheel diameter is the first thing that separates them (0.62 m cast, 0.67 m
 * wire, 0.25 m castor), and the second is mass distribution: the motorcycle
 * hangs everything off a central engine, the bicycle is an open diamond with
 * nothing in the middle, the scooter is a seat and a tiller over a flat deck.
 */

/* ---------------------------------------------------------------- helpers */

/** Round tube spanning `a`->`b` in the side plane — the frame vocabulary. */
function strut(
  a: Point2,
  b: Point2,
  r: number,
  mat: MeshStandardMaterial,
  z = 0,
  segments = 8,
): Mesh {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return cyl(r, Math.hypot(dx, dy), mat, {
    at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z],
    rot: [0, 0, Math.atan2(dy, dx) - Math.PI / 2],
    segments,
  });
}

/** Rectangular-section member spanning `a`->`b`: swingarms, chain runs, pads. */
function beam(
  a: Point2,
  b: Point2,
  thickness: number,
  width: number,
  mat: MeshStandardMaterial,
  z = 0,
): Mesh {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return box([Math.hypot(dx, dy), thickness, width], mat, {
    at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z],
    rot: [0, 0, Math.atan2(dy, dx)],
  });
}

/** Limb segment: a capsule whose ends land on `a` and `b`. */
function limb(a: Point2, b: Point2, r: number, mat: MeshStandardMaterial, z = 0): Mesh {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return capsule(r, Math.max(Math.hypot(dx, dy) - 2 * r, 0.01), mat, {
    at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z],
    rot: [0, 0, Math.atan2(dy, dx) - Math.PI / 2],
    segments: 8,
  });
}

/** `count` crossing bars through a hub — a suggestion of spokes, not 32 of them. */
function spokeBars(
  x: number,
  r: number,
  count: number,
  section: number,
  mat: MeshStandardMaterial,
  z = 0,
): Mesh[] {
  const bars: Mesh[] = [];
  for (let i = 0; i < count; i += 1) {
    bars.push(
      box([r * 2, section, section], mat, {
        at: [x, r, z],
        rot: [0, 0, (Math.PI * i) / count],
      }),
    );
  }
  return bars;
}

/**
 * Coil spring along `a`->`b`, drawn as stacked discs so it reads at 5 m. Each
 * disc is 0.8 of the pitch so the coil reads as a spring, not as a bead chain.
 */
function coilOver(a: Point2, b: Point2, r: number, turns: number): Mesh[] {
  const chrome = material('chrome');
  const parts: Mesh[] = [strut(a, b, r * 0.34, material('steel'), 0, 8)];
  const pitch = 0.8 / turns;
  for (let i = 0; i < turns; i += 1) {
    const t = (i + 0.5) / turns;
    const at: Point2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const to: Point2 = [at[0] + (b[0] - a[0]) * pitch, at[1] + (b[1] - a[1]) * pitch];
    parts.push(strut(at, to, r, chrome, 0, 10));
  }
  return parts;
}

/**
 * A helmeted rider posed onto a machine.
 *
 * `rider` from the shell gives the head and torso in one upright piece; the
 * pose is the whole point here, so it goes into a group pivoted at the hips and
 * leant by `lean` radians, and the limbs are then run to wherever the grips and
 * the pegs actually are. Hip-local geometry (shoulder height) is recovered from
 * the same lean so the arms start on the shoulders and not in mid-air.
 */
interface RiderPose {
  /** Hip joint, side view. */
  hip: Point2;
  /** Forward lean from vertical, radians. */
  lean: number;
  scale?: number;
  /** Hand and foot targets, side view. */
  grip: Point2;
  knee: Point2;
  foot: Point2;
  /** Second leg, when the pose is mid-stroke rather than symmetrical. */
  farKnee?: Point2;
  farFoot?: Point2;
  /** Jersey / jacket: torso, shoulder yoke, upper arms. */
  suit: MeshStandardMaterial;
  /** Forearms and hands — bare skin, or a glove. */
  limbMat: MeshStandardMaterial;
  /** Pelvis and thighs. */
  legMat: MeshStandardMaterial;
  /** Shins. Bare on a cyclist, trousered on a scooter, leather on a bike. */
  shinMat?: MeshStandardMaterial;
  helmet: MeshStandardMaterial;
  /** Full-face lid with a chin bar, or an open shell. */
  fullFace?: boolean;
  hipZ?: number;
  shoulderZ?: number;
  gripZ?: number;
  footZ?: number;
}

function posedRider(pose: RiderPose): Group {
  const group = new Group();
  const scale = pose.scale ?? 1;
  const { lean } = pose;
  const sin = Math.sin(lean);
  const cos = Math.cos(lean);
  const hipZ = pose.hipZ ?? 0.12 * scale;
  const shoulderZ = pose.shoulderZ ?? 0.19 * scale;
  const gripZ = pose.gripZ ?? 0.3;
  const footZ = pose.footZ ?? 0.2;

  // Head + torso from the shell, leant forward about the hip. `rider` hands
  // back [head, torso]; the torso is re-dressed, and a yoke, a neck and a
  // pelvis are what separate a figure from a leaning box.
  const torsoPivot = new Group();
  torsoPivot.position.set(pose.hip[0], pose.hip[1], 0);
  torsoPivot.rotation.z = -lean;
  const shell = rider([0, 0, 0], scale);
  const torso = shell[1];
  if (torso) torso.material = pose.suit;
  for (const part of shell) torsoPivot.add(part);
  torsoPivot.add(
    cyl(0.115 * scale, 0.32 * scale, pose.suit, {
      axis: 'z',
      at: [0, 0.455 * scale, 0],
      segments: 12,
    }),
  );
  torsoPivot.add(
    cyl(0.048 * scale, 0.1 * scale, material('skin'), { at: [0, 0.53 * scale, 0], segments: 10 }),
  );
  torsoPivot.add(
    box([0.29 * scale, 0.15 * scale, 0.33 * scale], pose.legMat, { at: [0, 0.045 * scale, 0] }),
  );
  group.add(torsoPivot);

  // Helmet over the shell's head, in the leant frame.
  const headLocal = 0.62 * scale;
  const headAt: Point2 = [
    pose.hip[0] + headLocal * sin,
    pose.hip[1] + headLocal * cos,
  ];
  const lid = 0.137 * scale;
  group.add(sphere(lid, pose.helmet, { at: [headAt[0], headAt[1], 0], segments: 14 }));
  if (pose.fullFace) {
    group.add(
      box([lid * 1.5, lid * 0.72, lid * 1.5], pose.helmet, {
        at: [headAt[0] + lid * 0.44, headAt[1] - lid * 0.62, 0],
        rot: [0, 0, -lean],
      }),
    );
    group.add(
      box([lid * 0.5, lid * 0.66, lid * 1.42], material('glass'), {
        at: [headAt[0] + lid * 0.92, headAt[1] + lid * 0.06, 0],
        rot: [0, 0, -lean],
      }),
    );
  } else {
    group.add(
      box([lid * 1.1, lid * 0.3, lid * 1.7], pose.helmet, {
        at: [headAt[0] + lid * 0.55, headAt[1] + lid * 0.5, 0],
        rot: [0, 0, -lean],
      }),
    );
  }

  // Shoulders, then arms to the grips.
  const shoulderLocal = 0.46 * scale;
  const shoulder: Point2 = [
    pose.hip[0] + shoulderLocal * sin,
    pose.hip[1] + shoulderLocal * cos,
  ];
  const elbow: Point2 = [
    shoulder[0] + (pose.grip[0] - shoulder[0]) * 0.52,
    shoulder[1] + (pose.grip[1] - shoulder[1]) * 0.52 + 0.045,
  ];
  for (const sign of [1, -1]) {
    group.add(
      sphere(0.062 * scale, pose.suit, {
        at: [shoulder[0], shoulder[1], sign * shoulderZ],
        segments: 8,
      }),
    );
    group.add(limb(shoulder, elbow, 0.052 * scale, pose.suit, sign * shoulderZ));
    group.add(limb(elbow, pose.grip, 0.044 * scale, pose.limbMat, sign * ((shoulderZ + gripZ) / 2)));
    group.add(
      sphere(0.05 * scale, pose.limbMat, { at: [pose.grip[0], pose.grip[1], sign * gripZ], segments: 8 }),
    );
  }

  // Legs. A second pair of targets makes the pose mid-stroke instead of static.
  const legs: { knee: Point2; foot: Point2; sign: number }[] = [
    { knee: pose.knee, foot: pose.foot, sign: 1 },
    { knee: pose.farKnee ?? pose.knee, foot: pose.farFoot ?? pose.foot, sign: -1 },
  ];
  for (const leg of legs) {
    group.add(limb(pose.hip, leg.knee, 0.078 * scale, pose.legMat, leg.sign * hipZ));
    group.add(
      limb(leg.knee, leg.foot, 0.058 * scale, pose.shinMat ?? pose.legMat, leg.sign * footZ * 0.85),
    );
    group.add(
      box([0.15 * scale, 0.06 * scale, 0.08 * scale], material('plastic'), {
        at: [leg.foot[0] + 0.02, leg.foot[1] - 0.02, leg.sign * footZ],
      }),
    );
  }
  return group;
}

/* ------------------------------------------------------------- motorcycle */

const MOTO_AXLE = 0.739;
const MOTO_R = 0.311;
/** Grip centres: the bars, plus their mirrors, set the catalogued width. */
const MOTO_BAR_Z = 0.3;
const MOTO_GRIP: Point2 = [0.47, 1.06];

/**
 * Cast wheel: tyre, a narrow rim band, five slim spokes, a disc and a caliper.
 * The rim band is deliberately much narrower than the tyre — a full-width rim
 * cylinder reads as a solid dinner plate rather than as a wheel with voids.
 */
function castWheel(x: number, width: number, discs: readonly number[]): Mesh[] {
  const rim = material('rim');
  const parts: Mesh[] = [
    cyl(MOTO_R, width, material('tire'), { axis: 'z', at: [x, MOTO_R, 0], segments: 20 }),
    cyl(MOTO_R * 0.68, width * 0.34, rim, { axis: 'z', at: [x, MOTO_R, 0], segments: 18 }),
    cyl(0.05, width * 0.92, material('metal'), { axis: 'z', at: [x, MOTO_R, 0], segments: 10 }),
  ];
  parts.push(...spokeBars(x, MOTO_R * 0.64, 5, 0.034, rim));
  for (const z of discs) {
    parts.push(
      cyl(MOTO_R * 0.5, 0.01, material('steel'), { axis: 'z', at: [x, MOTO_R, z], segments: 16 }),
      box([0.07, 0.11, 0.045], material('metal'), { at: [x - 0.13, MOTO_R + 0.1, z] }),
    );
  }
  return parts;
}

/**
 * Naked standard motorcycle, no rider.
 *
 * The 2D tile draws a tucked rider; this mesh deliberately does not, because
 * the catalog entry is "no rider" and its 1.23 m height is the bar-and-mirror
 * height that downstream occlusion and collision extents read. `buildMotorcyclist`
 * is the ridden variant — do not "fix" this one by adding a rider to it.
 */
export function buildMotorcycle(params: VehicleParams = { color: '#25282c' }): Group {
  const group = new Group();
  const paint = material('paint', params.color);
  const plastic = material('plastic');
  const chrome = material('chrome');
  const metal = material('metal');
  const steel = material('steel');

  group.add(...castWheel(-MOTO_AXLE, 0.175, [0.11]));
  group.add(...castWheel(MOTO_AXLE, 0.125, [0.085, -0.085]));

  // Front end: raked fork, triple clamp, mudguard, round lamp, bars.
  const forkTop: Point2 = [0.5, 1.09];
  const forkKnee: Point2 = [0.662, 0.7];
  const forkFoot: Point2 = [0.748, 0.36];
  for (const z of [0.115, -0.115]) {
    group.add(strut(forkTop, [0.672, 0.665], 0.021, chrome, z, 10));
    group.add(strut(forkKnee, forkFoot, 0.031, plastic, z, 10));
  }
  group.add(box([0.11, 0.05, 0.3], metal, { at: [0.535, 0.995, 0], rot: [0, 0, -0.38] }));
  group.add(box([0.1, 0.045, 0.26], metal, { at: [0.578, 0.885, 0], rot: [0, 0, -0.38] }));
  group.add(cyl(0.037, 0.2, steel, { at: [0.552, 0.94, 0], rot: [0, 0, -0.38], segments: 10 }));
  // Mudguard: six overlapping plates riding a circle just clear of the tyre.
  for (let i = 0; i < 6; i += 1) {
    const a = (152 - i * 24) * (Math.PI / 180);
    group.add(
      box([0.16, 0.022, 0.17], paint, {
        at: [MOTO_AXLE + Math.cos(a) * 0.342, MOTO_R + Math.sin(a) * 0.342, 0],
        rot: [0, 0, a - Math.PI / 2],
      }),
    );
  }
  group.add(cyl(0.15, 0.09, plastic, { axis: 'x', at: [0.6, 0.92, 0], segments: 16 }));
  group.add(cyl(0.144, 0.03, material('headlight'), { axis: 'x', at: [0.655, 0.92, 0], segments: 16 }));
  group.add(torus(0.148, 0.014, chrome, { at: [0.662, 0.92, 0], rot: [0, Math.PI / 2, 0], segments: 16 }));

  // Bars: cross tube, grips, levers, mirrors. The mirrors set width and height.
  group.add(cyl(0.016, MOTO_BAR_Z * 2 + 0.09, chrome, { axis: 'z', at: [0.46, 1.055, 0], segments: 10 }));
  group.add(
    ...mirrored(MOTO_BAR_Z, (z) =>
      cyl(0.023, 0.11, plastic, { axis: 'z', at: [0.465, 1.058, z], segments: 10 }),
    ),
  );
  group.add(
    ...mirrored(MOTO_BAR_Z - 0.03, (z) =>
      box([0.12, 0.02, 0.03], chrome, { at: [0.52, 1.045, z], rot: [0, 0, -0.12] }),
    ),
  );
  group.add(
    ...mirrored(MOTO_BAR_Z + 0.015, (z) => strut([0.462, 1.07], [0.435, 1.17], 0.011, chrome, z, 6)),
  );
  group.add(
    ...mirrored(MOTO_BAR_Z + 0.03, (z) =>
      box([0.045, 0.085, 0.115], plastic, { at: [0.432, 1.195, z], rot: [0, 0, 0.2] }),
    ),
  );

  // Frame: spine to the shock mount, down tube to the crankcase, cradle, subframe.
  for (const z of [0.108, -0.108]) {
    group.add(strut([0.545, 0.86], [-0.06, 0.6], 0.024, metal, z, 8));
    group.add(strut([0.539, 0.782], [0.011, 0.433], 0.024, metal, z, 8));
    group.add(strut([0.3, 0.27], [-0.05, 0.33], 0.019, metal, z, 8));
    group.add(strut([-0.06, 0.6], [-0.5, 0.7], 0.018, metal, z, 8));
  }

  // Engine: crankcase, finned barrel, clutch cover, sump, radiator.
  group.add(box([0.36, 0.28, 0.3], metal, { at: [0.08, 0.42, 0] }));
  group.add(box([0.3, 0.07, 0.26], steel, { at: [0.06, 0.245, 0] }));
  group.add(box([0.24, 0.2, 0.28], steel, { at: [0.1, 0.63, 0] }));
  for (let i = 0; i < 4; i += 1) {
    group.add(box([0.22, 0.02, 0.315], metal, { at: [0.1, 0.565 + i * 0.045, 0] }));
  }
  group.add(cyl(0.125, 0.05, metal, { axis: 'z', at: [0.24, 0.4, 0.155], segments: 14 }));
  group.add(cyl(0.05, 0.03, chrome, { axis: 'z', at: [0.24, 0.4, 0.185], segments: 8 }));
  group.add(cyl(0.09, 0.045, steel, { axis: 'z', at: [-0.02, 0.4, -0.16], segments: 12 }));
  group.add(box([0.05, 0.26, 0.26], steel, { at: [0.33, 0.5, 0] }));
  for (let i = 0; i < 3; i += 1) {
    group.add(box([0.02, 0.05, 0.24], plastic, { at: [0.357, 0.42 + i * 0.08, 0] }));
  }

  // Exhaust: header down the front of the engine into a can on the near side.
  group.add(strut([0.31, 0.6], [0.36, 0.34], 0.026, chrome, 0.09, 8));
  group.add(strut([0.36, 0.34], [0.12, 0.25], 0.026, chrome, 0.09, 8));
  group.add(cyl(0.078, 0.36, chrome, { axis: 'x', at: [-0.15, 0.26, 0.115], segments: 12 }));
  group.add(cyl(0.058, 0.06, plastic, { axis: 'x', at: [-0.35, 0.26, 0.115], segments: 12 }));
  group.add(strut([-0.2, 0.34], [-0.18, 0.28], 0.013, steel, 0.115, 6));

  // Tank, saddle, kicked-up tail — the shell, as one profile each.
  group.add(
    profile(
      [
        [0.02, 0.74],
        [0.2, 0.9],
        [0.44, 0.955],
        [0.585, 0.895],
        [0.585, 0.765],
        [0.4, 0.7],
        [0.12, 0.68],
      ],
      0.32,
      paint,
      { radius: 0.07, bevel: 0.05 },
    ),
  );
  group.add(cyl(0.042, 0.022, chrome, { at: [0.38, 0.962, 0], segments: 12 }));
  group.add(box([0.44, 0.07, 0.28], plastic, { at: [-0.2, 0.765, 0], rot: [0, 0, 0.05] }));
  group.add(
    profile(
      [
        [-0.72, 0.79],
        [-0.66, 0.855],
        [-0.32, 0.83],
        [-0.24, 0.75],
        [-0.68, 0.72],
      ],
      0.24,
      paint,
      { radius: 0.05, bevel: 0.04 },
    ),
  );
  group.add(box([0.055, 0.075, 0.12], material('taillight'), { at: [-0.745, 0.795, 0] }));
  group.add(box([0.03, 0.1, 0.14], plastic, { at: [-0.74, 0.68, 0], rot: [0, 0, 0.25] }));
  group.add(box([0.24, 0.05, 0.2], plastic, { at: [-0.62, 0.6, 0], rot: [0, 0, 0.12] }));

  // Swingarm, coil-over, chain, pegs.
  for (const z of [0.1, -0.1]) {
    group.add(beam([-0.05, 0.345], [-MOTO_AXLE, 0.311], 0.062, 0.045, metal, z));
  }
  group.add(box([0.06, 0.055, 0.2], metal, { at: [-0.12, 0.35, 0] }));
  group.add(...coilOver([-0.12, 0.62], [-0.35, 0.36], 0.038, 5));
  group.add(cyl(0.108, 0.014, steel, { axis: 'z', at: [-MOTO_AXLE, MOTO_R, 0.115], segments: 16 }));
  group.add(beam([-0.7, 0.415], [-0.05, 0.395], 0.014, 0.02, steel, 0.115));
  group.add(beam([-0.7, 0.21], [-0.05, 0.295], 0.014, 0.02, steel, 0.115));
  group.add(
    ...mirrored(0.215, (z) => cyl(0.018, 0.1, steel, { axis: 'z', at: [-0.16, 0.32, z], segments: 8 })),
  );
  return group;
}

/** Motorcycle plus a rider in a tuck — the tile's drawing, unmapped for now. */
export function buildMotorcyclist(params: VehicleParams = { color: '#25282c' }): Group {
  const group = buildMotorcycle(params);
  group.add(
    posedRider({
      hip: [-0.3, 0.85],
      lean: 1.0,
      scale: 0.98,
      grip: MOTO_GRIP,
      knee: [0.02, 0.62],
      foot: [-0.15, 0.35],
      // A jacket a shade off the machine: all-black leathers on a black bike
      // collapse into one blob at 20 m.
      suit: material('shirt'),
      limbMat: material('plastic'),
      legMat: material('plastic'),
      helmet: material('signWhite'),
      fullFace: true,
      gripZ: MOTO_BAR_Z,
      footZ: 0.215,
    }),
  );
  return group;
}

/* ---------------------------------------------------------------- bicycle */

const BIKE_AXLE = 0.535;
const BIKE_R = 0.335;
const BIKE_BB: Point2 = [-0.03, 0.275];
const BIKE_SEAT_TOP: Point2 = [-0.165, 0.845];
const BIKE_HEAD_TOP: Point2 = [0.48, 0.878];
const BIKE_HEAD_BOTTOM: Point2 = [0.545, 0.7];
const BIKE_BAR: Point2 = [0.585, 0.905];
const BIKE_HOOD: Point2 = [0.632, 0.872];
const BIKE_BAR_Z = 0.215;

/** Wire wheel: a torus tyre, a rim hoop, five crossing bars, a small hub. */
function wireWheel(x: number): Mesh[] {
  return [
    torus(BIKE_R - 0.019, 0.019, material('tire'), { at: [x, BIKE_R, 0], segments: 26 }),
    torus(BIKE_R - 0.048, 0.012, material('rim'), { at: [x, BIKE_R, 0], segments: 26 }),
    ...spokeBars(x, BIKE_R - 0.055, 5, 0.005, material('chrome')),
    cyl(0.024, 0.1, material('metal'), { axis: 'z', at: [x, BIKE_R, 0], segments: 10 }),
  ];
}

/** Diamond-frame road bike, no rider. `buildCyclist` is the ridden variant. */
export function buildBicycle(params: VehicleParams = { color: '#2f4f74' }): Group {
  const group = new Group();
  const paint = material('paint', params.color);
  const chrome = material('chrome');
  const plastic = material('plastic');
  const steel = material('steel');
  const rear: Point2 = [-BIKE_AXLE, BIKE_R];
  const front: Point2 = [BIKE_AXLE, BIKE_R];

  group.add(...wireWheel(-BIKE_AXLE));
  group.add(...wireWheel(BIKE_AXLE));

  // Diamond: the two open triangles are the whole silhouette, so the tubes are
  // thin and the voids stay voids.
  group.add(strut(BIKE_BB, BIKE_SEAT_TOP, 0.019, paint, 0, 8));
  group.add(strut([BIKE_SEAT_TOP[0] + 0.01, BIKE_SEAT_TOP[1] + 0.01], BIKE_HEAD_TOP, 0.018, paint, 0, 8));
  group.add(strut([BIKE_HEAD_BOTTOM[0] - 0.012, BIKE_HEAD_BOTTOM[1] + 0.012], BIKE_BB, 0.021, paint, 0, 8));
  group.add(strut(BIKE_HEAD_TOP, BIKE_HEAD_BOTTOM, 0.026, paint, 0, 10));
  group.add(cyl(0.026, 0.075, steel, { axis: 'z', at: [BIKE_BB[0], BIKE_BB[1], 0], segments: 12 }));
  group.add(cyl(0.026, 0.055, paint, { axis: 'z', at: [BIKE_SEAT_TOP[0], BIKE_SEAT_TOP[1], 0], segments: 10 }));
  for (const z of [0.048, -0.048]) {
    group.add(strut([BIKE_SEAT_TOP[0] - 0.005, BIKE_SEAT_TOP[1] - 0.02], rear, 0.012, paint, z, 6));
    group.add(strut([BIKE_BB[0] + 0.01, BIKE_BB[1] + 0.008], rear, 0.013, paint, z, 6));
    group.add(strut([BIKE_HEAD_BOTTOM[0] - 0.01, BIKE_HEAD_BOTTOM[1] - 0.015], [0.558, 0.345], 0.014, paint, z, 6));
  }

  // Drivetrain: chainring, cranks caught mid-stroke, chain line, cassette.
  group.add(cyl(0.105, 0.008, chrome, { axis: 'z', at: [BIKE_BB[0], BIKE_BB[1], 0.062], segments: 22 }));
  group.add(cyl(0.032, 0.02, steel, { axis: 'z', at: [BIKE_BB[0], BIKE_BB[1], 0.062], segments: 10 }));
  group.add(strut(BIKE_BB, [-0.155, 0.185], 0.011, chrome, 0.075, 6));
  group.add(strut(BIKE_BB, [0.09, 0.362], 0.011, chrome, -0.075, 6));
  group.add(box([0.1, 0.018, 0.06], plastic, { at: [-0.16, 0.178, 0.155] }));
  group.add(box([0.1, 0.018, 0.06], plastic, { at: [0.095, 0.355, -0.155] }));
  group.add(cyl(0.048, 0.028, steel, { axis: 'z', at: [rear[0], rear[1], 0.055], segments: 14 }));
  group.add(beam([-0.5, 0.378], [-0.05, 0.378], 0.012, 0.014, steel, 0.058));
  group.add(beam([-0.5, 0.275], [-0.05, 0.175], 0.012, 0.014, steel, 0.058));
  group.add(box([0.05, 0.09, 0.035], plastic, { at: [-0.5, 0.23, 0.062] }));

  // Cockpit: stem, drop bars with hooks and hoods, seatpost, saddle.
  group.add(strut([0.498, 0.888], BIKE_BAR, 0.014, steel, 0, 8));
  group.add(cyl(0.014, BIKE_BAR_Z * 2, chrome, { axis: 'z', at: [BIKE_BAR[0], BIKE_BAR[1], 0], segments: 10 }));
  for (const z of [BIKE_BAR_Z, -BIKE_BAR_Z]) {
    group.add(strut(BIKE_BAR, [0.66, 0.888], 0.014, chrome, z, 8));
    group.add(strut([0.66, 0.888], [0.648, 0.79], 0.014, chrome, z, 8));
    group.add(strut([0.648, 0.79], [0.605, 0.742], 0.013, chrome, z, 8));
    group.add(box([0.055, 0.11, 0.035], plastic, { at: [BIKE_HOOD[0], BIKE_HOOD[1] - 0.05, z], rot: [0, 0, 0.3] }));
  }
  group.add(strut([-0.168, 0.84], [-0.2, 0.95], 0.014, steel, 0, 8));
  group.add(
    profile(
      [
        [-0.315, 0.955],
        [-0.28, 0.978],
        [-0.12, 0.972],
        [-0.055, 0.952],
        [-0.13, 0.938],
        [-0.3, 0.935],
      ],
      0.115,
      plastic,
      { radius: 0.03, bevel: 0.025 },
    ),
  );
  group.add(cyl(0.032, 0.17, plastic, { at: [0.26, 0.5, 0], rot: [0, 0, -0.93], segments: 10 }));
  group.add(box([0.05, 0.08, 0.07], material('headlight'), { at: [0.655, 0.93, 0] }));
  group.add(box([0.04, 0.055, 0.06], material('taillight'), { at: [-0.212, 0.888, 0] }));
  return group;
}

/** Bicycle plus a rider folded onto the hoods — the catalog's cyclist. */
export function buildCyclist(params: VehicleParams = { color: '#2f4f74' }): Group {
  const group = buildBicycle(params);
  group.add(
    posedRider({
      hip: [-0.25, 1.025],
      lean: 0.576,
      scale: 1,
      grip: [BIKE_HOOD[0] - 0.02, BIKE_HOOD[1] + 0.02],
      knee: [0.05, 0.66],
      foot: [-0.145, 0.215],
      farKnee: [0.1, 0.68],
      farFoot: [0.095, 0.4],
      suit: material('shirt'),
      limbMat: material('skin'),
      legMat: material('pants'),
      shinMat: material('skin'),
      helmet: material('safetyWhite'),
      gripZ: BIKE_BAR_Z - 0.005,
      footZ: 0.155,
      hipZ: 0.115,
      shoulderZ: 0.175,
    }),
  );
  return group;
}

/* -------------------------------------------------------- mobility scooter */

/** Four-wheel pavement scooter: seat and tiller over a flat deck. */
export function buildMobilityScooter(params: VehicleParams = { color: '#287ba8' }): Group {
  const group = new Group();
  const paint = material('paint', params.color);
  const plastic = material('plastic');
  const steel = material('steel');
  const fabric = material('fabric');

  // Four castors: the rear pair is wider and taller and sets the width.
  for (const [x, r, w, z] of [
    [-0.42, 0.125, 0.085, 0.285],
    [0.4, 0.11, 0.075, 0.245],
  ] as const) {
    group.add(
      ...mirrored(z, (zz) => cyl(r, w, material('tire'), { axis: 'z', at: [x, r, zz], segments: 14 })),
    );
    group.add(
      ...mirrored(z + w * 0.2, (zz) =>
        cyl(r * 0.55, w * 0.4, material('rim'), { axis: 'z', at: [x, r, zz], segments: 10 }),
      ),
    );
  }

  // Deck and running board between the shrouds — where the feet go.
  group.add(box([0.74, 0.05, 0.44], paint, { at: [0.0, 0.215, 0] }));
  group.add(box([0.66, 0.022, 0.4], plastic, { at: [0.0, 0.248, 0] }));
  group.add(...mirrored(0.225, (z) => box([0.7, 0.09, 0.03], paint, { at: [0.0, 0.185, z] })));

  // Body shrouds over each axle.
  group.add(
    profile(
      [
        [-0.6, 0.2],
        [-0.575, 0.45],
        [-0.42, 0.49],
        [-0.2, 0.46],
        [-0.16, 0.21],
      ],
      0.44,
      paint,
      { radius: 0.06, bevel: 0.05 },
    ),
  );
  group.add(
    profile(
      [
        [0.19, 0.21],
        [0.23, 0.45],
        [0.38, 0.49],
        [0.55, 0.44],
        [0.56, 0.21],
      ],
      0.42,
      paint,
      { radius: 0.06, bevel: 0.05 },
    ),
  );
  for (let i = 0; i < 3; i += 1) {
    group.add(box([0.02, 0.045, 0.2], plastic, { at: [0.545, 0.3 + i * 0.055, 0] }));
  }
  group.add(box([0.05, 0.075, 0.12], material('headlight'), { at: [0.552, 0.41, 0] }));
  group.add(...mirrored(0.14, (z) => box([0.035, 0.06, 0.08], material('taillight'), { at: [-0.6, 0.4, z] })));

  // Seat: column, pan, backrest, one armrest each side.
  group.add(cyl(0.055, 0.24, steel, { at: [-0.3, 0.45, 0], segments: 12 }));
  group.add(box([0.2, 0.05, 0.24], plastic, { at: [-0.3, 0.34, 0] }));
  group.add(box([0.52, 0.075, 0.46], paint, { at: [-0.34, 0.595, 0] }));
  group.add(box([0.48, 0.045, 0.42], fabric, { at: [-0.35, 0.648, 0] }));
  group.add(box([0.09, 0.4, 0.42], paint, { at: [-0.598, 0.845, 0] }));
  group.add(box([0.055, 0.34, 0.36], fabric, { at: [-0.545, 0.86, 0] }));
  group.add(
    ...mirrored(0.27, (z) => cyl(0.018, 0.17, steel, { at: [-0.5, 0.735, z], segments: 8 })),
  );
  group.add(
    ...mirrored(0.27, (z) => box([0.32, 0.05, 0.07], plastic, { at: [-0.37, 0.825, z], rot: [0, 0, -0.06] })),
  );

  // Tiller: leaning column into a delta control head with the grips swept back.
  group.add(strut([0.44, 0.36], [0.305, 0.885], 0.045, paint, 0, 12));
  group.add(box([0.12, 0.1, 0.16], plastic, { at: [0.425, 0.4, 0], rot: [0, 0, 0.25] }));
  group.add(box([0.3, 0.1, 0.3], paint, { at: [0.335, 0.93, 0], rot: [0, 0, -0.14] }));
  group.add(box([0.13, 0.018, 0.17], material('glass'), { at: [0.3, 0.984, 0], rot: [0, 0, -0.14] }));
  for (const z of [0.2, -0.2]) {
    group.add(strut([0.29, 0.925], [0.06, 0.9], 0.022, paint, z, 8));
    group.add(cyl(0.026, 0.075, plastic, { axis: 'z', at: [0.07, 0.9, z * 1.07], segments: 10 }));
  }
  group.add(...mirrored(0.15, (z) => box([0.1, 0.03, 0.05], plastic, { at: [0.17, 0.945, z] })));

  // Front basket on a pair of stays.
  const floor = 0.605;
  // Wire, not a crate: a floor, four corner posts and two rails a side, so the
  // basket reads as something you can see your shopping through.
  group.add(box([0.26, 0.018, 0.38], steel, { at: [0.565, floor, 0] }));
  for (const x of [0.448, 0.682]) {
    group.add(...mirrored(0.185, (z) => box([0.016, 0.24, 0.016], steel, { at: [x, floor + 0.12, z] })));
  }
  for (const y of [floor + 0.11, floor + 0.235]) {
    group.add(...mirrored(0.185, (z) => box([0.25, 0.013, 0.013], steel, { at: [0.565, y, z] })));
    group.add(box([0.013, 0.013, 0.37], steel, { at: [0.682, y, 0] }));
  }
  group.add(box([0.013, 0.013, 0.37], steel, { at: [0.448, floor + 0.235, 0] }));
  group.add(...mirrored(0.12, (z) => strut([0.5, floor], [0.4, 0.47], 0.014, steel, z, 6)));

  group.add(
    posedRider({
      hip: [-0.38, 0.68],
      lean: -0.07,
      scale: 0.91,
      grip: [0.06, 0.9],
      knee: [0.02, 0.655],
      foot: [0.14, 0.3],
      suit: material('shirt'),
      limbMat: material('skin'),
      legMat: material('pants'),
      helmet: material('fabric'),
      gripZ: 0.2,
      footZ: 0.15,
      hipZ: 0.11,
      shoulderZ: 0.17,
    }),
  );
  return group;
}
