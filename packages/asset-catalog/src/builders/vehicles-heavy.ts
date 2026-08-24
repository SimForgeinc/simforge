import { Group, type Mesh, type MeshStandardMaterial } from 'three';

import { box, cyl, mirrored, type Point2, profile, sphere, torus } from '../geometry';
import { material } from '../materials';
import {
  carShell,
  exhaustStack,
  handrail,
  ladder,
  lightBar,
  shutter,
  type VehicleParams,
} from './shell';

/**
 * Heavy commercial vehicles: nine work trucks that share one chassis language
 * and are told apart entirely by what sits on the frame rails.
 *
 * These are the 3D half of the tiles in `vehicle-art/heavy-trucks.tsx`, and the
 * vertical proportions are transcribed straight off them with the rule at the
 * top of `shell.ts` — ground at icon y = 41, so a body top at icon y = 5.4 on a
 * 3.4 m truck lands at 3.40 m. What is *not* transcribed is longitudinal
 * spacing of round parts: the tiles squash X to fit a 96-unit box (worst on the
 * semi, 2.2x), which would put a tandem bogie 3.8 m apart and a fifth wheel 3 m
 * behind its drive axle. Wheels are round in 3D and the eye measures spacing
 * against tyre diameter, so axle groups are metric here — 1.36 m tandems — and
 * the coupled rig is laid out for real (kingpin over the drive tandem, trailer
 * nose in the cab's shadow) while keeping the tile's silhouette.
 *
 * Shared vocabulary, drawn under every superstructure: frame rails just under
 * the body, a crescent fender over the open steer tyre, mud flaps behind the
 * drive axle, and a clearance-lamp row across the cab roof. Each vehicle then
 * gets the one mass that names it — a box, a tipped bed, a stepped hopper, a
 * rollback deck, a tilted drum, a folded boom, a cylinder, a bare timber deck.
 */

/* ---------------------------------------------------------------- vocabulary */

/** Box member spanning `a -> b` in the side (XY) plane. Booms, rams, legs. */
function member(
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

/** Frame rails and their cross members — the chassis under the superstructure. */
function chassis(x0: number, x1: number, y: number, h: number, z: number, crosses = 4): Mesh[] {
  const steel = material('steel');
  const length = x1 - x0;
  const parts: Mesh[] = mirrored(z, (zz) =>
    box([length, h, 0.1], steel, { at: [(x0 + x1) / 2, y, zz] }),
  ) as Mesh[];
  for (let i = 0; i < crosses; i += 1) {
    const x = x0 + (length * (i + 0.5)) / crosses;
    parts.push(box([0.1, h * 0.66, z * 2], steel, { at: [x, y, 0] }));
  }
  return parts;
}

/** Vertical panel seams pressed into both sides of a body. */
function seams(xs: readonly number[], y: number, h: number, z: number): Mesh[] {
  const dark = material('plastic');
  const parts: Mesh[] = [];
  for (const x of xs) {
    parts.push(...(mirrored(z, (zz) => box([0.05, h, 0.03], dark, { at: [x, y, zz] })) as Mesh[]));
  }
  return parts;
}

/** Rubber mud flaps hanging behind an axle. */
function mudFlaps(x: number, top: number, z: number, width: number, drop: number): Mesh[] {
  return mirrored(z, (zz) =>
    box([0.04, drop, width], material('plastic'), { at: [x, top - drop / 2, zz] }),
  ) as Mesh[];
}

/** Clearance-lamp row across the front of a cab roof. */
function markers(x: number, y: number, count = 3, step = 0.36): Mesh[] {
  const lamp = material('lamp');
  const parts: Mesh[] = [];
  for (let i = 0; i < count; i += 1) {
    parts.push(
      box([0.1, 0.05, 0.16], lamp, { at: [x, y, (i - (count - 1) / 2) * step] }),
    );
  }
  return parts;
}

/**
 * West-coast mirrors on the cab's front pillar. Kept just inside the body width
 * — a real one hangs proud of the cab, but the catalog width is a hard gate.
 */
function mirrors(x: number, y: number, z: number): Mesh[] {
  const steel = material('steel');
  const parts: Mesh[] = [];
  for (const sign of [1, -1]) {
    parts.push(box([0.045, 0.045, 0.2], steel, { at: [x - 0.06, y + 0.22, sign * (z - 0.1)] }));
    parts.push(box([0.06, 0.44, 0.12], material('plastic'), { at: [x, y, sign * z] }));
  }
  return parts;
}

/** Hinged locker door inset into a body side, with its chrome T-handle. */
function lockerDoors(xs: readonly number[], y: number, size: Point2, z: number): Mesh[] {
  const [l, h] = size;
  const shade = material('plastic');
  const chrome = material('chrome');
  const parts: Mesh[] = [];
  for (const x of xs) {
    for (const sign of [1, -1]) {
      parts.push(box([l, h, 0.03], shade, { at: [x, y, sign * z] }));
      parts.push(box([0.12, 0.07, 0.04], chrome, { at: [x + l / 2 - 0.14, y, sign * (z + 0.01)] }));
    }
  }
  return parts;
}

/* -------------------------------------------------------------- semi truck */

/**
 * Sleeper tractor with a box trailer: high-roof sleeper, one chrome stack, the
 * saddle tank between the axles, the fifth wheel under the trailer nose, and a
 * skirted trailer on a tandem bogie.
 */
export function buildSemiTruck(params: VehicleParams = { color: '#8f2f2f' }): Group {
  const width = 2.6;
  const wheelR = 0.56;
  const paint = material('paint', params.color);
  const steel = material('steel');
  const chrome = material('chrome');
  const metal = material('metal');
  const plastic = material('plastic');

  const group = carShell(
    {
      length: 20.1,
      width,
      height: 3.63,
      wheelRadius: wheelR,
      wheelWidth: 0.32,
      axles: [8.52, 3.23, 1.87, -7.22, -8.58],
      dualAxles: [1, 2, 3, 4],
      hull: [
        [3.3, 1.13],
        [3.3, 3.29],
        [4.09, 3.63],
        [5.9, 3.63],
        [5.9, 3.46],
        [8.43, 3.46],
        [9.03, 2.68],
        [9.59, 2.68],
        [10.05, 2.44],
        [10.05, 1.13],
      ],
      hullRadius: 0.16,
      glass: [
        [6.43, 2.74],
        [6.43, 3.41],
        [8.49, 3.41],
        [8.94, 2.74],
      ],
      roof: [4.09, 5.9, 0.12],
      headlight: { x: 10.03, y: 1.62, z: 1.02, w: 0.34, h: 0.26 },
      taillight: { x: -10.07, y: 1.5, z: 1.02, w: 0.24, h: 0.22 },
      grille: [1.98, 0.7],
      flares: [8.52],
    },
    params,
  );

  // Tractor: frame, front bumper, sleeper glazing, stack, saddle tanks.
  group.add(...chassis(1.2, 9.6, 1.08, 0.3, 0.46, 4));
  group.add(box([0.2, 0.44, width - 0.2], chrome, { at: [10.0, 1.06, 0] }));
  group.add(...mirrored(0.9, (z) => box([0.16, 0.1, 0.2], steel, { at: [9.98, 0.74, z] })));
  group.add(
    ...mirrored(width / 2 - 0.08, (z) => box([0.86, 0.5, 0.05], material('glass'), { at: [4.72, 3.0, z] })),
  );
  group.add(...mirrors(8.6, 2.94, width / 2 - 0.04));
  group.add(...markers(4.2, 3.66, 3, 0.4));
  group.add(...exhaustStack([3.15, 1.1, width / 2 - 0.18], 2.8, 0.07));
  group.add(
    ...mirrored(0.95, (z) => cyl(0.33, 1.6, chrome, { axis: 'x', at: [6.3, 0.97, z], segments: 16 })),
  );
  group.add(...mirrored(0.95, (z) => box([0.08, 0.68, 0.68], steel, { at: [5.7, 0.97, z] })));
  group.add(...mirrored(0.95, (z) => box([1.1, 0.06, 0.34], steel, { at: [6.3, 0.55, z] })));
  group.add(box([0.6, 0.5, width - 0.5], plastic, { at: [3.5, 3.2, 0] }));
  group.add(...mudFlaps(1.35, 0.95, 1.02, 0.44, 0.5));

  // Fifth wheel: ramp plate, jaws, kingpin.
  group.add(box([0.9, 0.1, 1.15], metal, { at: [2.6, 1.16, 0] }));
  group.add(member([2.05, 1.02], [2.62, 1.19], 0.09, 1.15, metal));
  group.add(cyl(0.07, 0.14, chrome, { at: [2.55, 1.14, 0], segments: 10 }));

  // Trailer: box, roof rails, doors, skirt, bogie, landing gear.
  group.add(
    profile(
      [
        [-10.05, 1.23],
        [-10.05, 3.8],
        [2.5, 3.8],
        [3.0, 3.45],
        [3.0, 1.23],
      ],
      width,
      paint,
      { radius: 0.1, bevel: 0.06 },
    ),
  );
  group.add(...mirrored(width / 2 - 0.06, (z) => box([13.0, 0.07, 0.1], metal, { at: [-3.5, 3.78, z] })));
  group.add(...seams([-6.6, -1.5], 2.5, 2.4, width / 2 - 0.005));
  group.add(box([13.05, 0.14, width - 0.24], steel, { at: [-3.5, 1.28, 0] }));
  group.add(...chassis(-9.9, 2.6, 1.1, 0.22, 0.5, 3));
  // Rear swing doors, their hinges and the underride bar.
  group.add(...mirrored(0.62, (z) => box([0.06, 2.4, 1.14], plastic, { at: [-10.06, 2.5, z] })));
  for (const y of [1.7, 3.3]) {
    group.add(...mirrored(1.2, (z) => cyl(0.05, 0.12, chrome, { axis: 'x', at: [-10.09, y, z] })));
  }
  group.add(...mirrored(0.12, (z) => box([0.06, 2.2, 0.06], chrome, { at: [-10.1, 2.5, z] })));
  group.add(box([0.14, 0.16, width - 0.5], steel, { at: [-10.02, 0.62, 0] }));
  group.add(...mirrored(0.7, (z) => box([0.1, 0.5, 0.1], steel, { at: [-9.9, 0.9, z] })));
  group.add(...markers(2.6, 3.84, 2, 0.5));
  // Aerodynamic side skirt with its stiffener seams.
  group.add(...mirrored(width / 2 - 0.03, (z) => box([6.4, 0.38, 0.05], plastic, { at: [-3.3, 0.83, z] })));
  group.add(...seams([-5.4, -1.2], 0.83, 0.34, width / 2 - 0.005));
  // Tandem bogie, its slider rails and flaps.
  group.add(box([2.7, 0.28, 1.9], plastic, { at: [-7.9, 0.99, 0] }));
  group.add(...mirrored(0.86, (z) => box([3.4, 0.12, 0.14], steel, { at: [-7.9, 1.16, z] })));
  group.add(...mudFlaps(-9.35, 0.98, 1.04, 0.46, 0.72));
  // Landing gear, retracted.
  group.add(...mirrored(0.6, (z) => box([0.12, 0.46, 0.12], steel, { at: [0.3, 1.0, z] })));
  group.add(...mirrored(0.6, (z) => box([0.34, 0.09, 0.2], steel, { at: [0.3, 0.79, z] })));
  group.add(box([0.08, 0.08, 1.2], steel, { at: [0.3, 0.86, 0] }));

  return group;
}

/* --------------------------------------------------------------- box truck */

/**
 * Cab-over box truck: flat-fronted cab under a taller plain box, roll-up rear
 * shutter with its roller housing, and open chassis rails between them.
 */
export function buildBoxTruck(params: VehicleParams = { color: '#e8e9ea' }): Group {
  const width = 2.44;
  const wheelR = 0.53;
  const paint = material('paint', params.color);
  const steel = material('steel');
  const metal = material('metal');
  const chrome = material('chrome');

  const group = carShell(
    {
      length: 7.6,
      width,
      height: 2.94,
      wheelRadius: wheelR,
      wheelWidth: 0.3,
      axles: [2.96, -1.57],
      dualAxles: [1],
      hull: [
        [1.92, 1.05],
        [1.92, 2.71],
        [2.14, 2.94],
        [3.56, 2.94],
        [3.8, 2.62],
        [3.8, 0.97],
      ],
      hullRadius: 0.14,
      glass: [
        [3.1, 2.01],
        [3.1, 2.81],
        [3.52, 2.81],
        [3.71, 2.56],
        [3.71, 2.01],
      ],
      roof: [2.14, 3.66, 0.1],
      headlight: { x: 3.78, y: 1.16, z: 0.86, w: 0.32, h: 0.24 },
      taillight: { x: -3.8, y: 1.24, z: 0.9, w: 0.22, h: 0.2 },
      bumper: { y: 0.68, h: 0.26 },
      grille: [2.2, 0.5],
      flares: [2.96],
    },
    params,
  );

  group.add(...chassis(-3.57, 3.4, 0.93, 0.28, 0.44, 5));
  group.add(...mirrors(3.6, 2.36, width / 2 - 0.04));
  group.add(...markers(2.2, 2.98, 3, 0.42));
  group.add(...mudFlaps(-2.12, 0.9, 0.98, 0.4, 0.6));
  // Cab steps under the door.
  group.add(...mirrored(width / 2 - 0.1, (z) => box([0.42, 0.05, 0.24], steel, { at: [2.3, 0.78, z] })));

  // Cargo box: taller than the cab, square-cornered, on its own bearers.
  group.add(
    profile(
      [
        [-3.78, 1.09],
        [-3.78, 3.4],
        [1.88, 3.4],
        [1.88, 1.09],
      ],
      width,
      paint,
      { radius: 0.08, bevel: 0.05 },
    ),
  );
  group.add(box([5.66, 0.1, width - 0.1], metal, { at: [-0.95, 3.38, 0] }));
  group.add(box([5.7, 0.14, width - 0.16], steel, { at: [-0.95, 1.13, 0] }));
  group.add(...seams([-2.4, -0.9, 0.6], 2.3, 2.16, width / 2 - 0.005));
  group.add(...mirrored(width / 2 - 0.01, (z) => box([5.66, 0.06, 0.05], metal, { at: [-0.95, 2.28, z] })));
  group.add(...mirrored(width / 2 - 0.01, (z) => box([5.66, 0.08, 0.06], metal, { at: [-0.95, 1.26, z] })));

  // Roll-up rear shutter: the kit panel turned to face down -X, its roller
  // housing above and the track posts either side.
  const door = new Group();
  door.add(...shutter([0, 0, 0], [width - 0.26, 1.9], 6, metal));
  door.position.set(-3.77, 2.16, 0);
  door.rotation.y = Math.PI / 2;
  group.add(door);
  group.add(box([0.3, 0.3, width - 0.16], paint, { at: [-3.66, 3.22, 0] }));
  group.add(...mirrored(width / 2 - 0.07, (z) => box([0.1, 2.2, 0.09], metal, { at: [-3.76, 2.24, z] })));
  group.add(box([0.14, 0.1, 0.4], chrome, { at: [-3.8, 1.24, 0] }));
  // Rear step bumper: the kit bumper plus its two drop supports.
  group.add(...mirrored(0.62, (z) => box([0.12, 0.24, 0.1], steel, { at: [-3.7, 0.92, z] })));

  return group;
}

/* -------------------------------------------------------------- dump truck */

/**
 * Dump truck caught mid-tip: ribbed bed rotated up off its rear hinge, tailgate
 * swinging free on its top pins, hydraulic ram extended, cab guard over the roof.
 */
export function buildDumpTruck(params: VehicleParams = { color: '#e1a11a' }): Group {
  const width = 2.55;
  const wheelR = 0.55;
  const paint = material('paint', params.color);
  const steel = material('steel');
  const chrome = material('chrome');
  const metal = material('metal');

  const group = carShell(
    {
      length: 8.5,
      width,
      height: 3.04,
      wheelRadius: wheelR,
      wheelWidth: 0.32,
      axles: [3.5, -0.595, -1.955],
      dualAxles: [1, 2],
      hull: [
        [1.5, 1.07],
        [1.5, 2.81],
        [1.74, 3.04],
        [2.82, 3.04],
        [2.82, 2.9],
        [3.21, 1.98],
        [4.05, 1.98],
        [4.25, 1.78],
        [4.25, 1.07],
      ],
      hullRadius: 0.14,
      glass: [
        [2.6, 2.07],
        [2.6, 2.85],
        [2.8, 2.85],
        [3.09, 2.07],
      ],
      roof: [1.74, 2.9, 0.1],
      headlight: { x: 4.23, y: 1.52, z: 0.9, w: 0.32, h: 0.26 },
      taillight: { x: -3.62, y: 0.95, z: 1.0, w: 0.22, h: 0.2 },
      grille: [2.05, 0.62],
      flares: [3.5],
    },
    params,
  );

  group.add(...chassis(-3.88, 3.96, 0.92, 0.3, 0.46, 5));
  group.add(box([0.2, 0.4, width - 0.2], steel, { at: [4.2, 1.0, 0] }));
  group.add(...mirrors(3.1, 2.5, width / 2 - 0.04));
  group.add(...markers(1.9, 3.08, 3, 0.4));
  group.add(...mudFlaps(-2.4, 0.9, 1.04, 0.44, 0.62));

  // The bed, hinged at the frame's tail and tipped 12.5 degrees — the angle the
  // tile draws. Everything inside the group is authored in bed space: x runs
  // from the hinge to the headboard, y up from the floor.
  const bed = new Group();
  bed.position.set(-3.88, 0.93, 0);
  bed.rotation.z = 0.2189;
  bed.add(box([5.3, 0.1, 2.35], steel, { at: [2.65, 0.05, 0] }));
  bed.add(...mirrored(1.14, (z) => box([5.3, 1.05, 0.07], paint, { at: [2.65, 0.62, z] })));
  bed.add(box([0.09, 1.15, 2.35], paint, { at: [5.28, 0.675, 0] }));
  bed.add(...mirrored(1.11, (z) => box([5.36, 0.09, 0.17], metal, { at: [2.65, 1.19, z] })));
  bed.add(...mirrored(1.19, (z) => box([5.3, 0.07, 0.05], paint, { at: [2.65, 0.95, z] })));
  for (let i = 0; i < 5; i += 1) {
    const x = 0.6 + i * 1.1;
    bed.add(...mirrored(1.18, (z) => box([0.08, 0.95, 0.06], paint, { at: [x, 0.62, z] })));
  }
  for (let i = 0; i < 4; i += 1) {
    bed.add(box([0.12, 0.14, 2.3], steel, { at: [0.9 + i * 1.15, -0.06, 0] }));
  }
  // Tailgate, hanging off its top pins and swung out of the load's way.
  bed.add(box([0.07, 1.05, 2.3], paint, { at: [-0.16, 0.63, 0], rot: [0, 0, 0.25] }));
  bed.add(box([0.05, 0.06, 2.3], metal, { at: [-0.28, 0.2, 0], rot: [0, 0, 0.25] }));
  bed.add(...mirrored(0.92, (z) => cyl(0.06, 0.14, chrome, { axis: 'z', at: [0.02, 1.12, z] })));
  bed.add(...mirrored(0.8, (z) => box([0.06, 0.12, 0.08], chrome, { at: [-0.42, 0.15, z] })));
  group.add(bed);

  // Hydraulic ram: barrel off the frame, chromed rod into the bed's underside.
  group.add(member([-0.76, 0.87], [0.12, 1.57], 0.19, 0.19, steel));
  group.add(member([0.06, 1.52], [0.68, 2.0], 0.11, 0.11, chrome));
  group.add(cyl(0.11, 0.4, metal, { axis: 'z', at: [-0.78, 0.87, 0], segments: 12 }));
  group.add(cyl(0.08, 0.3, metal, { axis: 'z', at: [0.7, 2.02, 0], segments: 12 }));

  // Cab guard. On the tile it rakes with the bed; here it clears the cab roof
  // and stops at the catalog height instead of passing through the cab.
  group.add(member([1.12, 3.13], [3.05, 3.24], 0.13, width - 0.24, metal));
  for (const x of [1.6, 2.2, 2.8]) {
    group.add(...mirrored(0.62, (z) => box([0.07, 0.1, 0.07], chrome, { at: [x, 3.24, z] })));
  }

  return group;
}

/* ----------------------------------------------------------- garbage truck */

/**
 * Rear-loading refuse truck: cab-over, packer body stepping down into an open
 * hopper, tipper arms folded against the tail, amber bar over the cab.
 */
export function buildGarbageTruck(params: VehicleParams = { color: '#2f855a' }): Group {
  const width = 2.55;
  const wheelR = 0.56;
  const paint = material('paint', params.color);
  const steel = material('steel');
  const metal = material('metal');
  const chrome = material('chrome');
  const dark = material('plastic');

  const group = carShell(
    {
      length: 9.2,
      width,
      height: 3.0,
      wheelRadius: wheelR,
      wheelWidth: 0.32,
      axles: [3.73, -0.4, -1.76],
      dualAxles: [1, 2],
      hull: [
        [2.07, 1.1],
        [2.07, 2.76],
        [2.35, 3.0],
        [4.25, 3.0],
        [4.6, 2.61],
        [4.6, 1.06],
      ],
      hullRadius: 0.14,
      glass: [
        [3.59, 2.0],
        [3.59, 2.86],
        [4.21, 2.86],
        [4.47, 2.57],
        [4.47, 2.0],
      ],
      roof: [2.35, 4.35, 0.1],
      headlight: { x: 4.58, y: 1.22, z: 0.9, w: 0.32, h: 0.24 },
      taillight: { x: -4.51, y: 1.4, z: 0.94, w: 0.22, h: 0.2 },
      bumper: { y: 0.7, h: 0.26 },
      grille: [1.9, 0.5],
      flares: [3.73],
    },
    params,
  );

  group.add(...chassis(-4.32, 4.1, 0.94, 0.3, 0.46, 5));
  group.add(...mirrors(4.4, 2.42, width / 2 - 0.04));
  group.add(...lightBar([2.9, 3.14, 0], [0.66, 0.16, width - 0.7], 'lamp'));
  group.add(...mudFlaps(-2.2, 0.92, 1.04, 0.44, 0.6));

  // Packer body: one profile carries the step down from the roof line to the
  // low tail, which is what makes a rear loader read as a rear loader.
  group.add(
    profile(
      [
        [-4.49, 1.06],
        [-4.49, 2.18],
        [-3.25, 2.31],
        [-2.11, 3.45],
        [1.85, 3.45],
        [2.02, 3.33],
        [2.02, 1.06],
      ],
      width,
      paint,
      { radius: 0.1, bevel: 0.06 },
    ),
  );
  group.add(box([3.9, 0.09, width - 0.12], metal, { at: [-0.1, 3.43, 0] }));
  group.add(...seams([-1.3, -0.2, 0.9], 2.2, 2.1, width / 2 - 0.005));
  group.add(...mirrored(width / 2 - 0.01, (z) => box([4.0, 0.07, 0.05], metal, { at: [-0.1, 1.3, z] })));
  // Packer blade joint and the tailgate seam, both as thin insets.
  group.add(
    ...mirrored(width / 2 - 0.005, (z) => member([-2.09, 3.33], [-2.92, 2.06], 0.06, 0.03, dark, z)),
  );
  group.add(...seams([-2.94], 1.6, 1.0, width / 2 - 0.005));
  // Hopper: open mouth, dark throat, sill lip.
  group.add(box([1.2, 0.4, width - 0.22], dark, { at: [-3.86, 2.0, 0] }));
  group.add(box([0.9, 0.55, width - 0.5], dark, { at: [-3.9, 1.62, 0] }));
  group.add(box([1.28, 0.08, width - 0.1], metal, { at: [-3.85, 2.24, 0] }));
  group.add(box([0.14, 0.5, width - 0.3], steel, { at: [-4.46, 1.55, 0] }));
  // Tipper arms folded against the tail, with their rams.
  for (const sign of [1, -1]) {
    const z = sign * 1.26;
    group.add(member([-2.87, 1.98], [-3.62, 1.6], 0.17, 0.14, metal, z));
    group.add(member([-3.62, 1.6], [-4.3, 1.38], 0.14, 0.12, metal, z));
    group.add(cyl(0.11, 0.14, chrome, { axis: 'z', at: [-2.87, 1.98, z], segments: 10 }));
    group.add(member([-2.44, 2.2], [-2.98, 1.79], 0.13, 0.13, steel, z));
    group.add(member([-2.96, 1.78], [-3.25, 1.59], 0.07, 0.07, chrome, z));
  }
  // Riding step and grab handles on the tail.
  group.add(box([0.4, 0.07, 1.5], metal, { at: [-4.5, 0.84, 0] }));
  group.add(...mirrored(0.86, (z) => box([0.07, 0.9, 0.07], chrome, { at: [-4.42, 1.4, z] })));

  return group;
}

/* --------------------------------------------------------------- tow truck */

/**
 * Wrecker: low rollback deck, A-frame boom raked back over it, winch drum on
 * the mast, wheel-lift stowed under the tail, amber bar on the roof.
 */
export function buildTowTruck(params: VehicleParams = { color: '#f59e0b' }): Group {
  const width = 2.45;
  const wheelR = 0.5;
  const paint = material('paint', params.color);
  const steel = material('steel');
  const metal = material('metal');
  const chrome = material('chrome');
  const dark = material('plastic');

  const group = carShell(
    {
      length: 7.5,
      width,
      height: 2.5,
      wheelRadius: wheelR,
      wheelWidth: 0.3,
      axles: [3.08, -1.46],
      dualAxles: [1],
      hull: [
        [1.36, 0.97],
        [1.36, 2.3],
        [1.55, 2.5],
        [2.45, 2.5],
        [2.75, 1.74],
        [3.58, 1.74],
        [3.75, 1.56],
        [3.75, 0.97],
      ],
      hullRadius: 0.13,
      glass: [
        [2.27, 1.79],
        [2.27, 2.46],
        [2.44, 2.46],
        [2.67, 1.79],
      ],
      roof: [1.55, 2.53, 0.09],
      headlight: { x: 3.73, y: 1.34, z: 0.84, w: 0.3, h: 0.24 },
      taillight: { x: -3.3, y: 1.3, z: 0.92, w: 0.2, h: 0.18 },
      grille: [1.85, 0.5],
      flares: [3.08],
    },
    params,
  );

  group.add(...chassis(-3.12, 3.37, 0.9, 0.28, 0.44, 4));
  group.add(box([0.18, 0.36, width - 0.2], steel, { at: [3.71, 0.88, 0] }));
  group.add(...mirrors(2.7, 2.06, width / 2 - 0.04));
  group.add(...lightBar([2.0, 2.62, 0], [0.6, 0.16, width - 0.7], 'lamp'));
  group.add(...mudFlaps(-1.94, 0.86, 1.0, 0.4, 0.6));

  // Rollback deck: painted apron, chequer top plate, tie-down slots.
  group.add(
    profile(
      [
        [-3.25, 1.16],
        [-3.25, 1.59],
        [1.29, 1.59],
        [1.29, 1.16],
      ],
      width,
      paint,
      { radius: 0.06, bevel: 0.05 },
    ),
  );
  group.add(box([4.6, 0.07, width - 0.14], metal, { at: [-0.98, 1.6, 0] }));
  group.add(...mirrored(width / 2 - 0.05, (z) => box([4.6, 0.1, 0.1], metal, { at: [-0.98, 1.66, z] })));
  for (const x of [-2.6, -1.6, -0.6, 0.4]) {
    group.add(...mirrored(0.9, (z) => box([0.2, 0.05, 0.12], dark, { at: [x, 1.63, z] })));
  }
  group.add(...mirrored(0.86, (z) => box([0.24, 0.16, 0.1], material('lamp'), { at: [-3.24, 1.38, z] })));
  // Underbody tool lockers.
  group.add(box([1.3, 0.41, width - 0.14], paint, { at: [-2.02, 0.97, 0] }));
  group.add(box([1.41, 0.41, width - 0.14], paint, { at: [-0.34, 0.97, 0] }));
  group.add(...lockerDoors([-2.02, -0.34], 0.97, [1.16, 0.3], width / 2 - 0.06));

  // Mast, winch drum, raked boom, cable and hook.
  group.add(box([0.38, 0.95, 0.7], paint, { at: [0.85, 1.91, 0] }));
  group.add(...mirrored(0.36, (z) => box([0.3, 0.9, 0.06], metal, { at: [0.85, 1.94, z] })));
  group.add(cyl(0.26, 0.62, metal, { axis: 'z', at: [0.52, 1.83, 0], segments: 14 }));
  group.add(...mirrored(0.32, (z) => cyl(0.3, 0.05, chrome, { axis: 'z', at: [0.52, 1.83, z], segments: 14 })));
  for (const sign of [1, -1]) {
    group.add(member([0.7, 2.02], [-1.85, 2.66], 0.16, 0.14, metal, sign * 0.28));
  }
  group.add(box([0.1, 0.1, 0.62], metal, { at: [-1.8, 2.66, 0] }));
  group.add(cyl(0.09, 0.2, chrome, { axis: 'z', at: [-1.86, 2.68, 0], segments: 12 }));
  group.add(member([-1.86, 2.6], [-2.14, 1.98], 0.04, 0.04, chrome));
  group.add(box([0.12, 0.2, 0.1], metal, { at: [-2.16, 1.86, 0] }));

  // Wheel-lift, stowed under the tail.
  for (const sign of [1, -1]) {
    group.add(member([-2.77, 0.95], [-3.5, 0.83], 0.13, 0.16, metal, sign * 0.5));
  }
  group.add(box([0.16, 0.14, 1.16], metal, { at: [-3.48, 0.83, 0] }));
  group.add(...mirrored(0.5, (z) => box([0.2, 0.6, 0.14], steel, { at: [-3.56, 0.73, z] })));
  group.add(box([0.34, 0.14, 1.3], steel, { at: [-3.58, 0.48, 0] }));

  return group;
}

/* ------------------------------------------------------------ cement mixer */

/**
 * Concrete mixer: the drum is the vehicle. A ribbed barrel tilted 17 degrees
 * with rib bands, the charge funnel over its high rear mouth, the swing chute
 * below it, roller cradles under the belly, three axles.
 */
export function buildCementMixer(params: VehicleParams = { color: '#e5e7eb' }): Group {
  const width = 2.5;
  const wheelR = 0.6;
  const paint = material('paint', params.color);
  const steel = material('steel');
  const metal = material('metal');
  const chrome = material('chrome');

  const group = carShell(
    {
      length: 8.8,
      width,
      height: 3.13,
      wheelRadius: wheelR,
      wheelWidth: 0.32,
      axles: [3.64, 0.035, -1.325],
      dualAxles: [1, 2],
      hull: [
        [1.83, 1.17],
        [1.83, 2.89],
        [2.07, 3.13],
        [3.11, 3.13],
        [3.11, 2.97],
        [3.46, 2.2],
        [4.22, 2.2],
        [4.4, 1.98],
        [4.4, 1.17],
      ],
      hullRadius: 0.14,
      glass: [
        [2.89, 2.27],
        [2.89, 3.08],
        [3.07, 3.08],
        [3.36, 2.27],
      ],
      roof: [2.07, 3.19, 0.1],
      headlight: { x: 4.38, y: 1.7, z: 0.88, w: 0.32, h: 0.26 },
      taillight: { x: -4.2, y: 1.32, z: 0.98, w: 0.22, h: 0.2 },
      bumper: { y: 1.12, h: 0.34 },
      grille: [2.0, 0.6],
      flares: [3.64],
    },
    params,
  );

  group.add(...chassis(-3.85, 4.11, 1.02, 0.3, 0.46, 5));
  group.add(...mirrors(3.35, 2.66, width / 2 - 0.04));
  group.add(...markers(2.2, 3.17, 3, 0.38));
  group.add(...mudFlaps(-1.78, 1.0, 1.02, 0.44, 0.6));

  // The drum, authored along its own axis: y = 0 at the front bearing, y = 4.84
  // at the mouth, then swung to the tile's 17-degree rake. The barrel is a
  // stack of truncated cones rather than one lathe on purpose — the catalog
  // gate measures each geometry's axis-aligned box through the world matrix, so
  // a single tall lathe reports the corner of its local box (0.31 m of empty
  // air above the belly once raked) instead of its surface.
  const drum = new Group();
  drum.position.set(1.61, 1.76, 0);
  drum.rotation.z = 1.2793;
  const barrel: readonly (readonly [number, number, number])[] = [
    [-0.06, 0.06, 0.12],
    [0.06, 0.56, 0.19],
    [0.56, 1.2, 0.43],
    [1.2, 1.9, 0.68],
    [1.9, 2.6, 0.86],
    [2.6, 3.3, 0.91],
    [3.3, 3.9, 0.85],
    [3.9, 4.35, 0.66],
    [4.35, 4.84, 0.48],
  ];
  barrel.forEach(([y0, y1, r], index) => {
    const rTop = index + 1 < barrel.length ? (barrel[index + 1] as readonly [number, number, number])[2] : 0.36;
    drum.add(
      cyl(r, y1 - y0, paint, { rTop, at: [0, (y0 + y1) / 2, 0], segments: 22, open: index > 0 }),
    );
  });
  for (const [y, r] of [
    [1.0, 0.58],
    [1.75, 0.82],
    [2.5, 0.91],
    [3.2, 0.87],
    [3.85, 0.7],
  ] as const) {
    drum.add(torus(r, 0.05, metal, { at: [0, y, 0], rot: [Math.PI / 2, 0, 0], segments: 20 }));
  }
  drum.add(torus(0.36, 0.05, metal, { at: [0, 4.84, 0], rot: [Math.PI / 2, 0, 0], segments: 18 }));
  drum.add(cyl(0.15, 0.3, steel, { at: [0, -0.2, 0], segments: 12 }));
  group.add(drum);

  // Front bearing pedestal and the two roller cradles under the belly.
  group.add(box([0.78, 0.55, 1.1], paint, { at: [1.28, 1.4, 0] }));
  group.add(cyl(0.2, 0.7, steel, { axis: 'z', at: [1.55, 1.72, 0], segments: 14 }));
  for (const [a, b] of [
    [
      [-2.85, 1.17],
      [-2.3, 2.5],
    ],
    [
      [-1.98, 1.17],
      [-1.58, 2.12],
    ],
  ] as const) {
    for (const sign of [1, -1]) {
      group.add(member(a, b, 0.18, 0.16, paint, sign * 0.5));
    }
    group.add(cyl(0.09, 1.0, steel, { axis: 'z', at: [b[0], b[1], 0], segments: 12 }));
  }
  group.add(box([1.5, 0.12, 1.2], steel, { at: [-2.3, 1.3, 0] }));

  // Charge funnel over the mouth, then the swing chute under it.
  group.add(cyl(0.21, 0.75, paint, { rTop: 0.61, at: [-2.97, 3.32, 0], segments: 14 }));
  group.add(torus(0.6, 0.05, metal, { at: [-2.97, 3.68, 0], rot: [Math.PI / 2, 0, 0], segments: 18 }));
  group.add(member([-3.0, 2.68], [-4.37, 1.97], 0.18, 0.52, paint));
  group.add(
    ...mirrored(0.26, (z) => member([-3.0, 2.82], [-4.37, 2.11], 0.16, 0.05, metal, z)),
  );
  group.add(cyl(0.13, 0.34, chrome, { axis: 'z', at: [-2.93, 2.72, 0], segments: 12 }));
  group.add(member([-3.1, 2.3], [-2.55, 1.9], 0.07, 0.07, steel));
  // Mixer control station on the rear of the frame.
  group.add(box([0.76, 0.66, 1.3], paint, { at: [-3.43, 1.48, 0] }));
  group.add(...mirrored(0.66, (z) => box([0.6, 0.34, 0.03], material('plastic'), { at: [-3.43, 1.55, z] })));
  group.add(member([-3.05, 1.78], [-2.75, 2.06], 0.06, 0.06, chrome));

  return group;
}

/* ------------------------------------------------------ utility bucket truck */

/**
 * Line truck: utility body of tool lockers, telescopic boom folded back over
 * the tail with the person basket on its nose, outriggers down on their pads.
 */
export function buildUtilityBucketTruck(params: VehicleParams = { color: '#f8fafc' }): Group {
  const width = 2.5;
  const wheelR = 0.56;
  const paint = material('paint', params.color);
  const steel = material('steel');
  const metal = material('metal');
  const chrome = material('chrome');

  const group = carShell(
    {
      length: 8.2,
      width,
      height: 2.89,
      wheelRadius: wheelR,
      wheelWidth: 0.32,
      axles: [3.38, -1.65],
      dualAxles: [1],
      hull: [
        [1.54, 1.05],
        [1.54, 2.67],
        [1.77, 2.89],
        [2.95, 2.89],
        [3.28, 2.0],
        [3.92, 2.0],
        [4.1, 1.8],
        [4.1, 1.05],
      ],
      hullRadius: 0.14,
      glass: [
        [2.32, 2.06],
        [2.32, 2.84],
        [2.93, 2.84],
        [3.18, 2.06],
      ],
      roof: [1.77, 2.99, 0.1],
      headlight: { x: 4.08, y: 1.54, z: 0.88, w: 0.32, h: 0.26 },
      taillight: { x: -4.08, y: 1.3, z: 0.94, w: 0.22, h: 0.2 },
      bumper: { y: 0.95, h: 0.3 },
      grille: [1.95, 0.55],
      flares: [3.38],
    },
    params,
  );

  group.add(...chassis(-3.81, 3.83, 0.89, 0.28, 0.44, 5));
  group.add(...mirrors(3.2, 2.44, width / 2 - 0.04));
  group.add(...lightBar([2.2, 3.01, 0], [0.6, 0.16, width - 0.66], 'lamp'));
  group.add(...mudFlaps(-2.1, 0.86, 1.0, 0.42, 0.6));

  // Utility body: locker walls under a walk-on cap.
  group.add(
    profile(
      [
        [-4.06, 1.01],
        [-4.06, 1.84],
        [1.24, 1.84],
        [1.24, 1.01],
      ],
      width,
      paint,
      { radius: 0.06, bevel: 0.05 },
    ),
  );
  group.add(box([5.36, 0.1, width], metal, { at: [-1.41, 1.9, 0] }));
  group.add(...lockerDoors([-3.29, -1.92, -0.55], 1.42, [1.1, 0.6], width / 2 - 0.005));
  group.add(...seams([-2.6, -1.24, 0.12], 1.42, 0.78, width / 2 - 0.005));
  group.add(box([0.24, 0.14, 0.5], material('lamp'), { at: [-4.05, 1.95, 0] }));

  // Turntable pedestal and the folded boom with its lift cylinder.
  group.add(box([0.78, 0.85, 1.0], paint, { at: [0.85, 2.27, 0] }));
  group.add(cyl(0.26, 0.24, metal, { at: [0.85, 2.6, 0], segments: 16 }));
  group.add(member([0.75, 2.72], [-2.79, 3.17], 0.3, 0.34, metal));
  group.add(...mirrored(0.18, (z) => member([0.5, 2.75], [-2.6, 3.14], 0.06, 0.03, material('plastic'), z)));
  group.add(member([0.36, 2.39], [-0.5, 2.65], 0.16, 0.16, steel));
  group.add(member([-0.48, 2.64], [-0.73, 2.73], 0.08, 0.08, chrome));
  group.add(cyl(0.1, 0.42, chrome, { axis: 'z', at: [0.62, 2.66, 0], segments: 12 }));

  // Person basket on the boom nose.
  group.add(box([0.22, 0.16, 0.3], steel, { at: [-2.78, 3.05, 0] }));
  group.add(box([1.05, 0.06, 1.0], metal, { at: [-3.41, 2.88, 0] }));
  group.add(...mirrored(0.48, (z) => box([1.05, 0.62, 0.05], paint, { at: [-3.41, 3.19, z] })));
  group.add(box([0.05, 0.62, 1.0], paint, { at: [-3.92, 3.19, 0] }));
  group.add(box([0.05, 0.62, 1.0], paint, { at: [-2.91, 3.19, 0] }));
  group.add(...mirrored(0.48, (z) => box([1.12, 0.07, 0.07], chrome, { at: [-3.41, 3.555, z] })));
  group.add(box([0.07, 0.07, 1.04], chrome, { at: [-3.94, 3.555, 0] }));
  group.add(box([0.07, 0.07, 1.04], chrome, { at: [-2.89, 3.555, 0] }));

  // Outriggers down on their pads, front pair raked forward, rear pair back.
  for (const [top, foot] of [
    [
      [0.5, 1.09],
      [0.82, 0.14],
    ],
    [
      [-3.2, 1.03],
      [-3.52, 0.14],
    ],
  ] as const) {
    for (const sign of [1, -1]) {
      const z = sign * 1.06;
      group.add(member(top, foot, 0.17, 0.22, steel, z));
      group.add(box([0.36, 0.1, 0.32], metal, { at: [foot[0], 0.05, z] }));
    }
    group.add(box([0.42, 0.3, width - 0.2], paint, { at: [top[0], 1.06, 0] }));
  }

  return group;
}

/* ------------------------------------------------------------ tanker truck */

/**
 * Fuel tanker: welded cylinder with domed heads, ring stiffeners, catwalk rail
 * and rollover guard on the crown, rear ladder, placard diamond, side manifold.
 */
export function buildTankerTruck(params: VehicleParams = { color: '#d7dce1' }): Group {
  const width = 2.55;
  const wheelR = 0.6;
  const tankR = 0.933;
  const tankY = 2.22;
  const paint = material('paint', params.color);
  const steel = material('steel');
  const metal = material('metal');
  const chrome = material('chrome');

  const group = carShell(
    {
      length: 10.5,
      width,
      height: 3.24,
      wheelRadius: wheelR,
      wheelWidth: 0.32,
      axles: [4.32, -0.19, -1.55],
      dualAxles: [1, 2],
      hull: [
        [2.33, 1.24],
        [2.33, 2.98],
        [2.64, 3.24],
        [3.62, 3.24],
        [3.98, 2.4],
        [5.01, 2.4],
        [5.25, 2.18],
        [5.25, 1.24],
      ],
      hullRadius: 0.15,
      glass: [
        [3.38, 2.47],
        [3.38, 3.2],
        [3.6, 3.2],
        [3.89, 2.47],
      ],
      roof: [2.64, 3.7, 0.1],
      headlight: { x: 5.23, y: 1.82, z: 0.9, w: 0.32, h: 0.26 },
      taillight: { x: -5.19, y: 1.36, z: 0.98, w: 0.22, h: 0.2 },
      grille: [2.15, 0.66],
      flares: [4.32],
    },
    params,
  );

  group.add(...chassis(-4.46, 4.87, 1.12, 0.3, 0.46, 6));
  group.add(box([0.2, 0.42, width - 0.2], steel, { at: [5.2, 1.24, 0] }));
  group.add(...mirrors(3.85, 2.86, width / 2 - 0.04));
  group.add(...markers(2.8, 3.28, 3, 0.36));
  group.add(...mudFlaps(-2.0, 1.1, 1.04, 0.44, 0.62));

  // Barrel and its domed heads. The domes are shallow dishes, not hemispheres:
  // a full half-sphere on a 1.87 m barrel reads as a beach ball welded to a
  // tube, where a real tank head bulges about a third of a metre.
  group.add(cyl(tankR, 6.38, paint, { axis: 'x', at: [-1.47, tankY, 0], segments: 22 }));
  for (const x of [1.72, -4.66]) {
    group.add(sphere(tankR - 0.015, paint, { at: [x, tankY, 0], scale: [0.4, 1, 1], segments: 18 }));
  }
  for (const x of [-3.6, -2.1, -0.6, 0.9]) {
    group.add(torus(tankR + 0.01, 0.05, metal, { at: [x, tankY, 0], rot: [0, Math.PI / 2, 0], segments: 22 }));
  }
  group.add(box([0.42, 0.16, 2.0], steel, { at: [-0.19, 1.3, 0] }));
  group.add(box([0.44, 0.14, 2.0], steel, { at: [-1.55, 1.3, 0] }));

  // Crown: grated catwalk, manhole, rollover guard, handrails.
  group.add(box([4.78, 0.05, 0.6], metal, { at: [-1.54, tankR + tankY + 0.01, 0] }));
  group.add(cyl(0.29, 0.38, metal, { at: [-1.32, 3.3, 0], segments: 16 }));
  group.add(torus(0.3, 0.04, chrome, { at: [-1.32, 3.48, 0], rot: [Math.PI / 2, 0, 0], segments: 16 }));
  group.add(box([0.16, 0.06, 0.1], chrome, { at: [-1.02, 3.46, 0] }));
  group.add(...mirrored(0.34, (z) => box([0.09, 0.5, 0.09], steel, { at: [-2.1, 3.34, z] })));
  group.add(...mirrored(0.34, (z) => box([0.09, 0.5, 0.09], steel, { at: [-0.55, 3.34, z] })));
  group.add(box([1.72, 0.07, 0.14], steel, { at: [-1.32, 3.57, 0] }));
  group.add(...mirrored(0.34, (z) => new Group().add(...handrail([-1.54, 3.15, z], 4.78, 4, 0.45))));

  // Placards, rear light panel, ladder and underride bar. The panel is what
  // stops the tail lamps floating behind the rear dome.
  group.add(
    ...mirrored(0.96, (z) =>
      box([0.48, 0.48, 0.04], material('safetyOrange'), { at: [-3.43, 2.11, z], rot: [0, 0, Math.PI / 4] }),
    ),
  );
  group.add(box([0.1, 0.52, 2.05], paint, { at: [-5.12, 1.24, 0] }));
  group.add(...mirrored(0.86, (z) => box([0.08, 0.44, 0.1], steel, { at: [-5.08, 1.72, z] })));
  const rearLadder = new Group();
  rearLadder.add(...ladder([0, 0, 0], 1.53, 0.5, 5));
  rearLadder.position.set(-5.1, 1.65, 0);
  rearLadder.rotation.z = Math.PI / 2;
  group.add(rearLadder);
  group.add(box([0.14, 0.16, 2.1], steel, { at: [-5.15, 0.62, 0] }));
  group.add(...mirrored(0.8, (z) => box([0.1, 0.5, 0.1], steel, { at: [-5.05, 0.88, z] })));

  // Kerbside discharge manifold: pipe, valve cabinet, spill guard.
  group.add(cyl(0.075, 3.42, steel, { axis: 'x', at: [-2.34, 1.09, -0.78] }));
  group.add(box([1.48, 0.49, 0.56], paint, { at: [-1.64, 1.085, -0.78] }));
  group.add(box([1.3, 0.36, 0.03], material('plastic'), { at: [-1.64, 1.085, -1.07] }));
  group.add(box([0.12, 0.06, 0.06], chrome, { at: [-1.06, 1.085, -1.09] }));
  group.add(cyl(0.13, 0.16, metal, { axis: 'x', at: [-0.5, 1.09, -0.78], segments: 12 }));

  return group;
}

/* ----------------------------------------------------------- flatbed truck */

/**
 * Flatbed: ribbed headboard behind the cab, a real open timber deck on visible
 * cross members with stake pockets and D-rings, and a strapped bundle aboard.
 */
export function buildFlatbedTruck(params: VehicleParams = { color: '#475569' }): Group {
  const width = 2.5;
  const wheelR = 0.52;
  const paint = material('paint', params.color);
  const steel = material('steel');
  const metal = material('metal');
  const chrome = material('chrome');
  const wood = material('wood');

  const group = carShell(
    {
      length: 8.0,
      width,
      height: 2.59,
      wheelRadius: wheelR,
      wheelWidth: 0.3,
      axles: [3.26, -1.76],
      dualAxles: [1],
      hull: [
        [1.46, 1.03],
        [1.46, 2.39],
        [1.68, 2.59],
        [2.75, 2.59],
        [3.03, 1.79],
        [3.83, 1.79],
        [4.0, 1.6],
        [4.0, 1.03],
      ],
      hullRadius: 0.14,
      glass: [
        [1.72, 1.85],
        [1.72, 2.55],
        [2.73, 2.55],
        [2.95, 1.85],
      ],
      roof: [1.68, 2.81, 0.1],
      headlight: { x: 3.98, y: 1.34, z: 0.86, w: 0.3, h: 0.24 },
      taillight: { x: -3.92, y: 1.2, z: 0.92, w: 0.22, h: 0.2 },
      bumper: { y: 0.66, h: 0.26 },
      grille: [1.9, 0.5],
      flares: [3.26],
    },
    params,
  );

  group.add(...chassis(-3.6, 3.58, 1.02, 0.28, 0.44, 5));
  group.add(...mirrors(2.9, 2.14, width / 2 - 0.04));
  group.add(...markers(1.8, 2.63, 3, 0.38));
  group.add(...mudFlaps(-2.2, 0.98, 1.0, 0.4, 0.62));
  group.add(...mirrored(0.6, (z) => box([0.12, 0.24, 0.1], steel, { at: [-3.86, 0.9, z] })));

  // Deck: side rails and cross members carrying loose timber planks.
  group.add(...mirrored(1.21, (z) => box([5.0, 0.34, 0.08], paint, { at: [-1.44, 1.23, z] })));
  for (let i = 0; i < 5; i += 1) {
    group.add(box([0.12, 0.26, 2.42], steel, { at: [-3.6 + i * 1.15, 1.22, 0] }));
  }
  for (let i = 0; i < 9; i += 1) {
    group.add(box([5.0, 0.07, 0.24], wood, { at: [-1.44, 1.42, (i - 4) * 0.275] }));
  }
  group.add(...mirrored(1.18, (z) => box([5.0, 0.05, 0.1], metal, { at: [-1.44, 1.47, z] })));
  for (const x of [-3.46, -2.35, -1.25, -0.15, 0.74]) {
    group.add(...mirrored(1.24, (z) => box([0.16, 0.22, 0.1], steel, { at: [x, 1.55, z] })));
  }
  for (const x of [-3.01, -1.9, -0.8, 0.3]) {
    group.add(...mirrored(1.26, (z) => torus(0.06, 0.02, chrome, { at: [x, 1.31, z], segments: 12 })));
  }

  // Headboard behind the cab, ribbed on its load face.
  group.add(
    profile(
      [
        [0.98, 1.36],
        [0.98, 2.56],
        [1.44, 2.56],
        [1.44, 1.36],
      ],
      width,
      paint,
      { radius: 0.06, bevel: 0.05 },
    ),
  );
  group.add(box([0.58, 0.14, width], metal, { at: [1.21, 2.58, 0] }));
  for (const y of [1.7, 2.06, 2.42]) {
    group.add(box([0.06, 0.1, width - 0.16], metal, { at: [0.95, y, 0] }));
  }

  // Strapped bundle: two courses of timber under a pair of tie-downs.
  group.add(box([2.68, 0.2, 1.6], wood, { at: [-1.48, 1.56, 0] }));
  group.add(box([2.5, 0.19, 1.46], wood, { at: [-1.52, 1.75, 0] }));
  for (const x of [-2.19, -0.75]) {
    group.add(box([0.09, 0.04, 1.66], material('plastic'), { at: [x, 1.86, 0] }));
    group.add(...mirrored(0.81, (z) => box([0.09, 0.44, 0.04], material('plastic'), { at: [x, 1.64, z] })));
    group.add(...mirrored(0.84, (z) => box([0.14, 0.2, 0.1], chrome, { at: [x, 1.36, z] })));
  }

  return group;
}
