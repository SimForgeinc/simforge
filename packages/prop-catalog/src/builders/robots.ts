import { Group, type Mesh, type MeshStandardMaterial, type Object3D, Vector3 } from 'three';

import {
  box,
  capsule,
  cyl,
  lathe,
  type Point2,
  profile,
  sphere,
  type Vec3,
} from '../geometry';
import { material, type MaterialKey } from '../materials';
import { addWheels } from './shell';

/**
 * Sidewalk robots: three wheeled/legged machines and five humanoids.
 *
 * Authored the same way as the road vehicles (see `shell.ts`): the 2D tile and
 * the mesh are one drawing at two fidelities. The robot tiles put the pavement
 * contact line at `AXLE + 5.9 = 42.9` and the humanoid sole on `GROUND = 41`,
 * so a tile coordinate becomes metres by
 *
 *     x = (iconX - iconCentre) * length / iconLengthSpan
 *     y = (iconContact - iconY) * height / iconHeightSpan
 *
 * with one reinterpretation the tiles force on us. A side elevation can only
 * show a far limb by drawing it *behind* the near one, so a near/far pair
 * offset in the tile's x is a pair offset in Z. Where the pair's mean x is the
 * body centreline the limbs really do hang straight (the standing units);
 * where it is not, that offset is a real stride — which is also where the
 * catalogued length comes from, since a staggered stance on 30 cm feet is what
 * makes a 1.78 m humanoid 0.58 m deep.
 *
 * The five humanoids come off one production line and are built that way: one
 * `humanoid()` chassis — capsule limb segments with an exposed actuator disc at
 * every shoulder, elbow, hip, knee and ankle, a visored sensor head over a
 * conduit neck and collar, a chest panel above a cooling stack, a pelvis
 * casting the legs hang off — and then a pose and a role kit per unit. Nothing
 * but the kit and the pose distinguishes them, which is the point.
 */

/** Every robot takes a shell colour; the rest of the shape is per model. */
export interface RobotParams {
  color?: string;
}

const UP = new Vector3(0, 1, 0);

/* ------------------------------------------------------------------ kit */

/** Side-view rectangle for `profile`; corners are rounded by `radius`. */
function rect(x0: number, y0: number, w: number, h: number): Point2[] {
  return [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ];
}

/**
 * One limb segment: a capsule spanning two joint centres, so the round ends
 * read as sockets seated in the actuators at either end.
 *
 * A capsule is symmetric about its axis, so a segment that runs downwards is
 * aimed *up* the same line: `setFromUnitVectors` would otherwise resolve a
 * near-180° flip, and a flipped frame inflates the mesh's axis-aligned box —
 * which is what the catalog dimensions are measured from — by most of a limb
 * radius in the wrong axis.
 */
function bone(from: Vec3, to: Vec3, r: number, mat: MeshStandardMaterial, name?: string): Mesh {
  const a = new Vector3(from[0], from[1], from[2]);
  const b = new Vector3(to[0], to[1], to[2]);
  const span = a.distanceTo(b);
  const dir = b.clone().sub(a);
  if (dir.y < 0) dir.negate();
  const mesh = capsule(r, Math.max(span - 2 * r, 0.008), mat, { segments: 10, name });
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return mesh;
}

/**
 * Exposed actuator at a limb joint: a metal barrel across the limb axis with a
 * chrome hub flush in its outer face. The barrel's outer face is the widest
 * point of a shoulder or hip, so it is what sets the catalogued width.
 */
function actuator(at: Vec3, r: number, width: number, side: number): Mesh[] {
  const hub = width * 0.34;
  return [
    cyl(r, width, material('metal'), { axis: 'z', at, segments: 14, name: 'actuator' }),
    cyl(r * 0.36, hub, material('chrome'), {
      axis: 'z',
      at: [at[0], at[1], at[2] + (side * (width - hub)) / 2],
      segments: 10,
    }),
  ];
}

/** Three-finger gripper. `pitch` 0 points the fingers at the ground. */
function gripper(at: Vec3, pitch: number, scale: number, paint: MeshStandardMaterial): Group {
  const g = new Group();
  g.position.set(at[0], at[1], at[2]);
  g.rotation.z = pitch;
  g.name = 'gripper';
  const metal = material('metal');
  g.add(box([0.055 * scale, 0.06 * scale, 0.085 * scale], paint, { at: [0, -0.03 * scale, 0] }));
  for (const z of [0.026 * scale, -0.026 * scale]) {
    g.add(
      bone(
        [0.004 * scale, -0.058 * scale, z],
        [-0.006 * scale, -0.12 * scale, z],
        0.011 * scale,
        metal,
      ),
    );
  }
  g.add(
    bone(
      [0.03 * scale, -0.035 * scale, 0],
      [0.05 * scale, -0.085 * scale, 0],
      0.01 * scale,
      metal,
    ),
  );
  return g;
}

/**
 * Sensor head: shell, wraparound visor, mono lens and the two comm pods on the
 * ear line. Shared by all five humanoids and by the quadruped's head.
 */
function sensorHead(at: Vec3, size: Vec3, paint: MeshStandardMaterial): Object3D[] {
  const [d, hh, w] = size;
  const glass = material('glass');
  return [
    profile(rect(at[0] - d / 2, at[1] - hh / 2, d, hh), w, paint, {
      radius: hh * 0.3,
      bevel: 0.014,
      at: [0, 0, at[2]],
      name: 'head',
    }),
    box([d * 0.66, hh * 0.4, w * 1.03], glass, {
      at: [at[0] + d * 0.16, at[1] + hh * 0.04, at[2]],
      name: 'visor',
    }),
    cyl(hh * 0.17, d * 0.12, glass, {
      axis: 'x',
      at: [at[0] + d * 0.48, at[1] + hh * 0.02, at[2]],
      segments: 12,
      name: 'lens',
    }),
    cyl(hh * 0.21, d * 0.05, material('chrome'), {
      axis: 'x',
      at: [at[0] + d * 0.44, at[1] + hh * 0.02, at[2]],
      segments: 12,
    }),
    ...[1, -1].map((side) =>
      cyl(hh * 0.16, w * 0.09, material('steel'), {
        axis: 'z',
        at: [at[0] - d * 0.18, at[1], at[2] + side * w * 0.52],
        segments: 10,
        name: 'comm-pod',
      }),
    ),
    box([d * 0.6, hh * 0.05, w * 0.42], material('plastic'), {
      at: [at[0] - d * 0.04, at[1] + hh * 0.46, at[2]],
    }),
  ];
}

/** Louvred vent in a Z-facing flank: backing plate plus slats. */
function vent(at: Vec3, size: Point2, slats: number, side: number): Mesh[] {
  const [l, hh] = size;
  const parts: Mesh[] = [
    box([l, hh, 0.012], material('plastic'), { at, name: 'vent' }),
  ];
  for (let i = 0; i < slats; i += 1) {
    parts.push(
      box([l * 0.9, hh / (slats * 2.6), 0.02], material('steel'), {
        at: [at[0], at[1] - hh / 2 + (hh * (i + 0.5)) / slats, at[2] + side * 0.004],
      }),
    );
  }
  return parts;
}

/**
 * Mudguard lip over a wheel: the upper arc only, as one extruded band. A full
 * torus would sink below the road and stand proud of the track.
 */
function mudguard(at: Vec3, r: number, width: number, mat: MeshStandardMaterial): Mesh {
  const steps = 7;
  const outer: Point2[] = [];
  const inner: Point2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (20 + (140 * i) / steps) * (Math.PI / 180);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    outer.push([cos * (r + r * 0.14), sin * (r + r * 0.14)]);
    inner.unshift([cos * r, sin * r]);
  }
  return profile([...outer, ...inner], width, mat, { at, bevel: 0.006, name: 'mudguard' });
}

/* ------------------------------------------------------------ rover */

/**
 * Six-wheel pavement rover: long and low, mass in a crowned cargo lid, eyes on
 * a short mast standing clear of the roofline, and a rocker-bogie linkage under
 * it carrying three axles a side.
 */
export function buildDeliveryRover(params: RobotParams = {}): Group {
  const group = new Group();
  const paint = material('paint', params.color ?? '#f1a34f');
  const dark = material('plastic');
  const steel = material('steel');
  const chrome = material('chrome');
  const glass = material('glass');

  const wheelR = 0.079;
  const axles = [-0.301, -0.057, 0.187];

  // Chassis tub and the crowned, rear-hinged cargo lid.
  group.add(
    profile(rect(-0.372, 0.133, 0.724, 0.187), 0.46, paint, {
      radius: 0.035,
      bevel: 0.02,
      name: 'chassis',
    }),
  );
  group.add(
    profile(
      [
        [-0.326, 0.312],
        [0.307, 0.312],
        [0.307, 0.5],
        [0.236, 0.594],
        [-0.256, 0.594],
        [-0.326, 0.472],
      ],
      0.472,
      paint,
      { radius: 0.05, bevel: 0.022, name: 'cargo-lid' },
    ),
  );

  // Lid parting line, rear hinge and front latch: the lid actually opens.
  group.add(box([0.6, 0.016, 0.478], dark, { at: [-0.01, 0.315, 0], name: 'lid-gasket' }));
  group.add(cyl(0.022, 0.1, material('metal'), { at: [-0.319, 0.405, 0], axis: 'z', segments: 12 }));
  for (const z of [0.032, -0.032]) {
    group.add(cyl(0.013, 0.03, dark, { at: [-0.319, 0.405, z], axis: 'z', segments: 8 }));
  }
  group.add(box([0.05, 0.088, 0.09], material('metal'), { at: [0.274, 0.34, 0], name: 'latch' }));
  group.add(box([0.03, 0.014, 0.1], dark, { at: [0.276, 0.31, 0] }));

  // Lid ribs and chassis panel splits.
  for (const x of [-0.13, 0.09]) {
    group.add(box([0.012, 0.01, 0.44], dark, { at: [x, 0.593, 0], name: 'lid-rib' }));
  }
  group.add(box([0.7, 0.014, 0.468], dark, { at: [-0.01, 0.196, 0], name: 'strake' }));
  for (const side of [1, -1]) {
    group.add(box([0.008, 0.17, 0.012], dark, { at: [0, 0.226, side * 0.231] }));
  }

  // Flank vents, nose bumper, lamps and reflectors.
  for (const side of [1, -1]) {
    for (const mesh of vent([0.104, 0.232, side * 0.232], [0.11, 0.075], 2, side)) group.add(mesh);
  }
  group.add(
    profile(
      [
        [0.33, 0.158],
        [0.375, 0.172],
        [0.375, 0.28],
        [0.33, 0.294],
      ],
      0.42,
      dark,
      { radius: 0.02, bevel: 0.014, name: 'bumper' },
    ),
  );
  for (const side of [1, -1]) {
    group.add(
      box([0.02, 0.05, 0.07], material('headlight'), { at: [0.35, 0.288, side * 0.15] }),
    );
    group.add(
      box([0.018, 0.045, 0.065], material('taillight'), { at: [-0.371, 0.29, side * 0.15] }),
    );
    for (const x of [-0.222, -0.128]) {
      group.add(box([0.06, 0.022, 0.008], material('lamp'), { at: [x, 0.207, side * 0.232] }));
    }
    group.add(box([0.052, 0.022, 0.008], material('signWhite'), { at: [0.24, 0.204, side * 0.232] }));
  }

  // Sensor mast: short, standing clear of the lid, lidar puck on top.
  group.add(box([0.096, 0.022, 0.13], dark, { at: [0.148, 0.6, 0], name: 'mast-base' }));
  group.add(cyl(0.023, 0.06, paint, { at: [0.148, 0.62, 0], segments: 10, name: 'mast' }));
  group.add(cyl(0.072, 0.127, paint, { at: [0.15, 0.706, 0], segments: 16, name: 'lidar-puck' }));
  group.add(cyl(0.075, 0.05, glass, { at: [0.15, 0.706, 0], segments: 16 }));
  group.add(cyl(0.062, 0.01, chrome, { at: [0.15, 0.772, 0], segments: 16 }));
  group.add(cyl(0.008, 0.014, material('taillight'), { axis: 'x', at: [0.222, 0.72, 0] }));

  // Camera cluster on the front face of the mast.
  group.add(box([0.12, 0.119, 0.12], dark, { at: [0.224, 0.586, 0], name: 'cameras' }));
  group.add(cyl(0.028, 0.02, glass, { axis: 'x', at: [0.29, 0.612, 0], segments: 12 }));
  group.add(cyl(0.032, 0.008, chrome, { axis: 'x', at: [0.284, 0.612, 0], segments: 12 }));
  group.add(cyl(0.021, 0.018, glass, { axis: 'x', at: [0.29, 0.558, 0], segments: 12 }));

  // Safety whip and pennant, rear of the lid where they clear the mast.
  group.add(sphere(0.018, material('rim'), { at: [-0.267, 0.556, 0], segments: 10 }));
  group.add(bone([-0.267, 0.556, 0], [-0.281, 0.68, 0], 0.006, chrome));
  group.add(bone([-0.281, 0.68, 0], [-0.244, 0.792, 0], 0.006, chrome));
  group.add(
    profile(
      [
        [-0.245, 0.8],
        [-0.14, 0.757],
        [-0.243, 0.704],
      ],
      0.01,
      material('safetyOrange'),
      { name: 'pennant' },
    ),
  );
  group.add(
    profile(
      [
        [-0.238, 0.786],
        [-0.168, 0.757],
        [-0.237, 0.72],
      ],
      0.014,
      material('signWhite'),
    ),
  );

  // Rocker-bogie: a rocker over the front two axles, a bogie over the rear one,
  // tied together at the two pivots. Drawn under the wheels, as on the tile.
  for (const side of [1, -1]) {
    const z = side * 0.204;
    const links: readonly [Vec3, Vec3][] = [
      [
        [axles[0] as number, wheelR, z],
        [-0.187, 0.169, z],
      ],
      [
        [-0.187, 0.169, z],
        [axles[1] as number, wheelR, z],
      ],
      [
        [0.047, 0.173, z],
        [axles[2] as number, wheelR, z],
      ],
      [
        [-0.187, 0.169, z],
        [0.047, 0.173, z],
      ],
    ];
    for (const [from, to] of links) group.add(bone(from, to, 0.011, steel, 'rocker'));
    for (const x of [-0.187, 0.047]) {
      group.add(cyl(0.02, 0.03, material('metal'), { axis: 'z', at: [x, 0.171, z], segments: 12 }));
    }
  }

  addWheels(group, { radius: wheelR, width: 0.052, xs: axles, z: 0.275, segments: 14 });
  return group;
}

/* ------------------------------------------------------------- cooler */

/**
 * Tall insulated cool box on four chunky tyres: thick overhanging lid with its
 * gasket, hinge and latch, a hazard-chevron skirt at the base, and a sensor
 * dome sitting flat on the lid — no mast at all, so it never reads as the
 * rover.
 */
export function buildCoolerRobot(params: RobotParams = {}): Group {
  const group = new Group();
  const paint = material('paint', params.color ?? '#edf1f4');
  const dark = material('plastic');
  const metal = material('metal');
  const chrome = material('chrome');
  const glass = material('glass');
  const hazard = material('safetyOrange');

  const wheelR = 0.112;
  const axles = [-0.304, 0.262];

  // Insulated body, walls flaring very slightly to the base, and the lid over
  // it: thicker than any panel on the robot and overhanging on every side.
  group.add(
    profile(
      [
        [-0.452, 0.183],
        [0.452, 0.183],
        [0.444, 0.66],
        [-0.444, 0.66],
      ],
      0.56,
      paint,
      { radius: 0.045, bevel: 0.022, name: 'insulated-body' },
    ),
  );
  group.add(
    profile(rect(-0.475, 0.632, 0.95, 0.17), 0.6, paint, {
      radius: 0.05,
      bevel: 0.024,
      name: 'lid',
    }),
  );
  group.add(box([0.9, 0.035, 0.575], dark, { at: [0, 0.628, 0], name: 'lid-gasket' }));

  // Hinge at the rear, latch at the front: it opens like a cool box.
  group.add(cyl(0.024, 0.11, metal, { axis: 'z', at: [-0.45, 0.745, 0], segments: 12 }));
  for (const z of [0.036, -0.036]) {
    group.add(cyl(0.014, 0.032, dark, { axis: 'z', at: [-0.45, 0.745, z], segments: 8 }));
  }
  group.add(box([0.055, 0.13, 0.11], metal, { at: [0.452, 0.69, 0], name: 'latch' }));
  group.add(cyl(0.018, 0.03, dark, { axis: 'x', at: [0.482, 0.69, 0], segments: 10 }));
  group.add(box([0.03, 0.016, 0.12], dark, { at: [0.462, 0.64, 0] }));

  // Handle recess with a grab bar, and the compressor vent, on both flanks.
  for (const side of [1, -1]) {
    group.add(box([0.284, 0.117, 0.016], dark, { at: [-0.194, 0.5, side * 0.278] }));
    group.add(cyl(0.014, 0.24, metal, { axis: 'x', at: [-0.194, 0.51, side * 0.284], segments: 8 }));
    for (const mesh of vent([0.285, 0.5, side * 0.282], [0.186, 0.173], 3, side)) group.add(mesh);
  }

  // Rubbing strake, panel splits, filler plug.
  group.add(box([0.86, 0.05, 0.585], dark, { at: [0, 0.305, 0], name: 'strake' }));
  for (const side of [1, -1]) {
    group.add(box([0.01, 0.34, 0.012], dark, { at: [0.042, 0.47, side * 0.281] }));
    group.add(cyl(0.03, 0.014, dark, { axis: 'z', at: [-0.36, 0.42, side * 0.283], segments: 12 }));
    group.add(cyl(0.012, 0.02, chrome, { axis: 'z', at: [-0.36, 0.42, side * 0.288], segments: 10 }));
  }

  // Hazard skirt: dark band with chevrons leaning the way the bot travels.
  group.add(box([0.88, 0.075, 0.585], dark, { at: [0, 0.223, 0], name: 'hazard-skirt' }));
  for (const side of [1, -1]) {
    for (let i = 0; i < 5; i += 1) {
      group.add(
        box([0.05, 0.088, 0.008], hazard, {
          at: [-0.42 + i * 0.108, 0.223, side * 0.294],
          rot: [0, 0, 0.5],
        }),
      );
    }
  }

  // Sensor dome and its collar, flat on the lid.
  group.add(box([0.3, 0.026, 0.29], dark, { at: [0, 0.808, 0], name: 'dome-collar' }));
  group.add(
    lathe(
      [
        [0.137, 0],
        [0.129, 0.048],
        [0.104, 0.098],
        [0.058, 0.132],
        [0, 0.142],
      ],
      paint,
      { at: [0, 0.808, 0], segments: 18, name: 'sensor-dome' },
    ),
  );
  group.add(
    lathe(
      [
        [0.121, 0.014],
        [0.112, 0.056],
        [0.086, 0.098],
        [0, 0.13],
      ],
      glass,
      { at: [0, 0.808, 0], segments: 18 },
    ),
  );
  group.add(
    cyl(0.016, 0.022, material('lamp', '#4f8ef7'), { at: [0.28, 0.812, 0.12], segments: 10 }),
  );

  // Stub antenna: a nub, not a mast.
  group.add(cyl(0.007, 0.106, chrome, { at: [-0.332, 0.852, 0.11], segments: 8 }));
  group.add(sphere(0.02, material('rim'), { at: [-0.332, 0.915, 0.11], segments: 10 }));

  for (const side of [1, -1]) {
    group.add(box([0.02, 0.07, 0.1], material('headlight'), { at: [0.45, 0.522, side * 0.19] }));
    group.add(box([0.018, 0.06, 0.09], material('taillight'), { at: [-0.45, 0.522, side * 0.19] }));
  }

  // Mudguard lips, then the chunky tyres over them.
  for (const x of axles) {
    for (const z of [0.29, -0.29]) group.add(mudguard([x, wheelR, z], wheelR * 1.16, 0.07, dark));
  }
  addWheels(group, { radius: wheelR, width: 0.075, xs: axles, z: 0.325, segments: 16, disc: true });
  return group;
}

/* ---------------------------------------------------------- quadruped */

/** One two-jointed leg: thigh, shin, pastern, actuators and a rubber paw. */
function dogLeg(
  group: Group,
  paint: MeshStandardMaterial,
  side: number,
  joints: { hip: Point2; knee: Point2; hock: Point2; paw: Point2 },
): void {
  const z = side * 0.2;
  const at = (p: Point2): Vec3 => [p[0], p[1], z];
  const dark = material('plastic');
  group.add(bone(at(joints.hip), at(joints.knee), 0.045, paint, 'thigh'));
  group.add(bone(at(joints.knee), at(joints.hock), 0.035, paint, 'shin'));
  group.add(
    bone(
      at(joints.hock),
      [joints.paw[0], joints.paw[1] + 0.032, side * 0.2],
      0.026,
      material('steel'),
      'pastern',
    ),
  );
  for (const mesh of actuator(at(joints.hip), 0.055, 0.11, side)) group.add(mesh);
  for (const mesh of actuator(at(joints.knee), 0.04, 0.085, side)) group.add(mesh);
  group.add(cyl(0.03, 0.07, material('metal'), { axis: 'z', at: at(joints.hock), segments: 12 }));
  group.add(
    box([0.09, 0.028, 0.1], material('tire'), {
      at: [joints.paw[0], joints.paw[1] + 0.014, z],
      name: 'paw',
    }),
  );
  group.add(
    box([0.06, 0.01, 0.07], dark, { at: [joints.paw[0], joints.paw[1] + 0.004, z] }),
  );
}

/**
 * Legged courier: a body pod held clear of the pavement on four two-jointed
 * legs, caught in a diagonal trot — near-side foreleg and far-side hind leg
 * extended and loaded, the other diagonal tucked and swinging — with a strapped
 * payload crate on its back and a lidar head on a short forward neck.
 */
export function buildQuadrupedCourier(params: RobotParams = {}): Group {
  const group = new Group();
  const paint = material('paint', params.color ?? '#e6b84f');
  const dark = material('plastic');
  const chrome = material('chrome');
  const glass = material('glass');

  // Body pod and its underslung battery pack.
  group.add(
    profile(rect(-0.379, 0.264, 0.679, 0.23), 0.42, paint, {
      radius: 0.055,
      bevel: 0.024,
      name: 'body-pod',
    }),
  );
  group.add(box([0.3, 0.065, 0.3], dark, { at: [-0.03, 0.247, 0], name: 'battery' }));
  for (const y of [0.232, 0.262]) {
    group.add(box([0.26, 0.012, 0.31], material('steel'), { at: [-0.03, y, 0] }));
  }

  // Shell splits, a rear-facing camera in the tail plate, and the cable runs
  // clipped along both flanks.
  for (const side of [1, -1]) {
    group.add(box([0.34, 0.01, 0.012], dark, { at: [-0.15, 0.42, side * 0.211] }));
    group.add(box([0.008, 0.19, 0.012], dark, { at: [0.03, 0.379, side * 0.211] }));
    group.add(cyl(0.008, 0.3, material('rim'), { axis: 'x', at: [-0.06, 0.33, side * 0.214] }));
    for (const x of [-0.19, -0.06, 0.07]) {
      group.add(cyl(0.013, 0.014, chrome, { axis: 'z', at: [x, 0.33, side * 0.219], segments: 8 }));
    }
  }
  group.add(box([0.014, 0.075, 0.09], glass, { at: [-0.382, 0.36, 0], name: 'tail-camera' }));
  group.add(
    cyl(0.012, 0.016, material('lamp', '#4f8ef7'), { axis: 'x', at: [-0.384, 0.45, 0.07] }),
  );

  // Payload crate, corner-reinforced and strapped down over the pod.
  group.add(
    profile(rect(-0.288, 0.443, 0.396, 0.177), 0.36, paint, {
      radius: 0.03,
      bevel: 0.018,
      name: 'payload-crate',
    }),
  );
  group.add(box([0.41, 0.022, 0.375], paint, { at: [-0.09, 0.615, 0], name: 'crate-lid' }));
  for (const x of [-0.286, 0.106]) {
    group.add(box([0.014, 0.17, 0.37], dark, { at: [x, 0.53, 0] }));
  }
  for (const x of [-0.2, -0.01]) {
    group.add(box([0.032, 0.2, 0.386], dark, { at: [x, 0.53, 0], name: 'strap' }));
    group.add(box([0.05, 0.036, 0.05], material('metal'), { at: [x, 0.452, 0.19] }));
  }

  // Neck, head, lidar crown.
  group.add(bone([0.254, 0.429, 0], [0.367, 0.486, 0], 0.037, paint, 'neck'));
  for (const mesh of sensorHead([0.425, 0.525, 0], [0.2, 0.192, 0.26], paint)) group.add(mesh);
  group.add(cyl(0.078, 0.104, dark, { at: [0.44, 0.668, 0], segments: 16, name: 'lidar' }));
  group.add(cyl(0.081, 0.042, glass, { at: [0.44, 0.668, 0], segments: 16 }));
  group.add(cyl(0.066, 0.01, chrome, { at: [0.44, 0.716, 0], segments: 16 }));

  // Diagonal trot. The loaded diagonal reaches the pavement; the swinging one
  // is tucked under the pod and clear of it.
  dogLeg(group, paint, 1, {
    hip: [0.19, 0.306],
    knee: [0.293, 0.188],
    hock: [0.283, 0.088],
    paw: [0.346, 0],
  });
  dogLeg(group, paint, -1, {
    hip: [0.19, 0.306],
    knee: [0.086, 0.2],
    hock: [0.128, 0.115],
    paw: [0.082, 0.052],
  });
  dogLeg(group, paint, -1, {
    hip: [-0.26, 0.303],
    knee: [-0.371, 0.207],
    hock: [-0.404, 0.103],
    paw: [-0.471, 0],
  });
  dogLeg(group, paint, 1, {
    hip: [-0.26, 0.303],
    knee: [-0.171, 0.2],
    hock: [-0.214, 0.115],
    paw: [-0.168, 0.052],
  });
  return group;
}

/* ------------------------------------------------------------ humanoid */

interface HumanoidSpec {
  /** Catalogued height, metres. Every joint is a fraction of it. */
  height: number;
  /** Catalogued width: the outer face of the shoulder actuators. */
  width: number;
  /** Chest fore-aft depth. */
  depth: number;
  /** Torso lateral width. */
  chest: number;
  /** Sole length and how much of it sits behind the ankle. */
  foot: readonly [number, number];
  paint: MeshStandardMaterial;
}

/** The assembled chassis plus every anchor a role kit or a pose needs. */
interface Chassis {
  group: Group;
  spec: HumanoidSpec;
  h: number;
  paint: MeshStandardMaterial;
  shoulder: number;
  elbow: number;
  wrist: number;
  hip: number;
  knee: number;
  ankle: number;
  armZ: number;
  legZ: number;
  armR: number;
  foreR: number;
  thighR: number;
  shinR: number;
  front: number;
  back: number;
  torsoTop: number;
  torsoBottom: number;
  headY: number;
  headTop: number;
}

/**
 * The shared humanoid chassis: torso shell over a dorsal equipment case, chest
 * panel and cooling stack, shoulder yoke, pelvis casting, conduit neck and
 * visored head. Limbs are the caller's, because the pose is the role.
 */
function humanoid(spec: HumanoidSpec): Chassis {
  const h = spec.height;
  const { paint, depth: d, chest } = spec;
  const dark = material('plastic');
  const steel = material('steel');
  const group = new Group();

  const torsoBottom = 0.385 * h;
  const torsoTop = 0.755 * h;
  const torsoH = torsoTop - torsoBottom;
  const front = d * 0.5;
  const back = -d * 0.5;
  const armR = 0.027 * h;
  const headH = 0.16 * h;
  const headY = 0.885 * h;

  const c: Chassis = {
    group,
    spec,
    h,
    paint,
    shoulder: 0.665 * h,
    elbow: 0.49 * h,
    wrist: 0.315 * h,
    hip: 0.305 * h,
    knee: 0.185 * h,
    ankle: 0.085 * h,
    armZ: spec.width / 2 - armR * 1.15,
    legZ: chest * 0.29,
    armR,
    foreR: 0.023 * h,
    thighR: 0.036 * h,
    shinR: 0.03 * h,
    front,
    back,
    torsoTop,
    torsoBottom,
    headY,
    headTop: headY + headH / 2,
  };

  // Torso: a rounded shell, tapered in at the top, over the dorsal case that
  // carries the cooling fins — the tile's sunk back plane in three dimensions.
  group.add(
    profile(
      [
        [back + d * 0.1, torsoBottom],
        [front, torsoBottom + torsoH * 0.04],
        [front - d * 0.17, torsoTop],
        [back + d * 0.22, torsoTop - torsoH * 0.05],
      ],
      chest,
      paint,
      { radius: d * 0.18, bevel: 0.022, name: 'torso' },
    ),
  );
  // Upper chest, narrowed across the shoulders so the arms hang clear of it.
  group.add(
    profile(
      [
        [back + d * 0.2, c.shoulder - torsoH * 0.16],
        [front - d * 0.12, c.shoulder - torsoH * 0.14],
        [front - d * 0.2, torsoTop + torsoH * 0.02],
        [back + d * 0.26, torsoTop + torsoH * 0.02],
      ],
      chest * 0.86,
      paint,
      { radius: d * 0.14, bevel: 0.02, name: 'upper-chest' },
    ),
  );
  group.add(
    box([d * 0.2, torsoH * 0.52, chest * 0.66], steel, {
      at: [back - d * 0.06, torsoBottom + torsoH * 0.42, 0],
      name: 'dorsal-case',
    }),
  );
  for (let i = 0; i < 3; i += 1) {
    group.add(
      box([d * 0.23, torsoH * 0.028, chest * 0.6], dark, {
        at: [back - d * 0.06, torsoBottom + torsoH * (0.28 + i * 0.16), 0],
      }),
    );
  }

  // Chest panel, its status bars, and the cooling stack under it.
  const panelY = torsoBottom + torsoH * 0.72;
  group.add(
    box([d * 0.1, torsoH * 0.26, chest * 0.5], dark, {
      at: [front - d * 0.03, panelY, chest * 0.03],
      name: 'chest-panel',
    }),
  );
  const bars: MaterialKey[] = ['lamp', 'headlight', 'taillight'];
  bars.forEach((key, i) => {
    group.add(
      box([0.01, torsoH * 0.034, chest * (0.3 - i * 0.07)], material(key), {
        at: [front - d * 0.005, panelY + torsoH * (0.07 - i * 0.07), chest * 0.03],
      }),
    );
  });
  group.add(
    box([d * 0.08, torsoH * 0.14, chest * 0.46], dark, {
      at: [front - d * 0.03, torsoBottom + torsoH * 0.44, chest * 0.03],
      name: 'cooling-stack',
    }),
  );
  for (let i = 0; i < 4; i += 1) {
    group.add(
      box([0.008, torsoH * 0.018, chest * 0.42], steel, {
        at: [front - d * 0.005, torsoBottom + torsoH * (0.39 + i * 0.033), chest * 0.03],
      }),
    );
  }

  // Panel seams down the chest, shoulder yoke, waist ring, pelvis casting.
  for (const side of [1, -1]) {
    group.add(
      box([d * 0.42, torsoH * 0.012, 0.008], dark, {
        at: [d * 0.06, torsoBottom + torsoH * 0.58, side * chest * 0.3],
      }),
    );
  }
  group.add(
    box([d * 0.44, h * 0.042, c.armZ * 1.72], paint, {
      at: [-d * 0.02, c.shoulder + h * 0.048, 0],
      name: 'shoulder-yoke',
    }),
  );
  group.add(box([d * 0.86, h * 0.028, chest * 0.86], dark, { at: [0, torsoBottom + h * 0.012, 0] }));
  // Pelvis casting: narrower than the chest, so the unit has a waist, with a
  // flare over each hip actuator for the leg to swing under.
  group.add(
    profile(rect(back * 0.88, 0.275 * h, d * 0.88, 0.12 * h), chest * 0.8, paint, {
      radius: 0.03 * h,
      bevel: 0.018,
      name: 'pelvis',
    }),
  );
  group.add(box([d * 0.9, h * 0.022, chest * 0.84], steel, { at: [0, 0.288 * h, 0] }));
  for (const side of [1, -1]) {
    group.add(
      cyl(0.055 * h, chest * 0.12, paint, {
        axis: 'z',
        at: [-d * 0.02, 0.315 * h, side * chest * 0.34],
        segments: 14,
        name: 'hip-flare',
      }),
    );
  }

  // Conduit neck into the collar plate, then the sensor head.
  const collarY = torsoTop + h * 0.014;
  group.add(
    box([d * 0.42, h * 0.026, chest * 0.5], steel, { at: [-d * 0.02, collarY, 0], name: 'collar' }),
  );
  for (const z of [chest * 0.13, -chest * 0.13]) {
    group.add(
      cyl(h * 0.013, h * 0.055, material('rim'), {
        at: [-d * 0.05, collarY + h * 0.03, z],
        segments: 8,
        name: 'neck-conduit',
      }),
    );
  }
  for (const mesh of sensorHead([d * 0.04, headY, 0], [d * 0.68, headH, chest * 0.82], paint)) {
    group.add(mesh);
  }
  return c;
}

interface ArmPose {
  shoulder: Vec3;
  elbow: Vec3;
  wrist: Vec3;
  /** Gripper roll; 0 points the fingers at the ground. */
  grip?: number;
}

/** Shoulder cap, actuators at shoulder/elbow/wrist, two segments, a gripper. */
function arm(c: Chassis, pose: ArmPose): void {
  const side = Math.sign(pose.shoulder[2]) || 1;
  const g = c.group;
  g.add(
    cyl(c.h * 0.05, c.armR * 2.2, c.paint, {
      axis: 'z',
      at: [pose.shoulder[0], pose.shoulder[1] + c.h * 0.008, pose.shoulder[2] - side * c.armR * 0.5],
      segments: 14,
      name: 'pauldron',
    }),
  );
  for (const mesh of actuator(pose.shoulder, c.h * 0.036, c.armR * 2.3, side)) g.add(mesh);
  g.add(bone(pose.shoulder, pose.elbow, c.armR, c.paint, 'upper-arm'));
  for (const mesh of actuator(pose.elbow, c.armR * 1.12, c.armR * 2, side)) g.add(mesh);
  g.add(bone(pose.elbow, pose.wrist, c.foreR, c.paint, 'forearm'));
  g.add(
    cyl(c.foreR * 1.1, c.foreR * 1.7, material('steel'), {
      axis: 'z',
      at: pose.wrist,
      segments: 10,
      name: 'wrist',
    }),
  );
  g.add(gripper(pose.wrist, pose.grip ?? 0, c.h / 1.78, c.paint));
}

/** Ankle height for a foot pitched by `pitch`, so the sole stays on the road. */
function ankleLift(c: Chassis, pitch: number): number {
  const toe = c.spec.foot[0] - c.spec.foot[1];
  return c.ankle * Math.cos(pitch) - toe * Math.sin(pitch);
}

/**
 * Foot: sole pad with a heel behind the ankle and a toe ramp ahead of it, a
 * rubber tread under it, an ankle boot over the joint and a scuff cap on the
 * toe — enough that a foot reads as a foot and not as a plank.
 */
function sole(c: Chassis, at: Vec3, pitch: number): Group {
  const [len, heel] = c.spec.foot;
  const toe = len - heel;
  const t = c.h * 0.042;
  const a = c.ankle;
  const width = len * 0.44;
  const g = new Group();
  g.position.set(at[0], at[1], at[2]);
  g.rotation.z = pitch;
  g.name = 'foot';
  g.add(
    profile(
      [
        [-heel, -a],
        [toe, -a],
        [toe, -a + t * 0.5],
        [toe * 0.84, -a + t],
        [-heel + 0.014, -a + t],
      ],
      width,
      c.paint,
      { radius: t * 0.3, bevel: 0.01 },
    ),
  );
  g.add(
    box([len * 0.74, t * 0.3, width * 0.82], material('tire'), {
      at: [(toe - heel) / 2, -a + t * 0.16, 0],
      name: 'tread',
    }),
  );
  g.add(
    box([len * 0.12, t * 0.8, width * 0.9], material('steel'), {
      at: [toe - len * 0.07, -a + t * 0.5, 0],
      name: 'toe-cap',
    }),
  );
  g.add(
    box([len * 0.3, c.ankle * 0.62, width * 0.72], c.paint, {
      at: [-len * 0.02, -c.ankle * 0.3, 0],
      name: 'ankle-boot',
    }),
  );
  return g;
}

interface LegPose {
  hip: Vec3;
  knee: Vec3;
  ankle: Vec3;
  /** Negative pitches the toe down — a foot at toe-off. */
  pitch?: number;
  /** Wrap plate over the knee, for the units that work near loads. */
  guard?: boolean;
}

/** Actuators at hip/knee/ankle, thigh, shin and the sole. */
function leg(c: Chassis, pose: LegPose): void {
  const side = Math.sign(pose.hip[2]) || 1;
  const g = c.group;
  for (const mesh of actuator(pose.hip, c.thighR * 1.25, c.thighR * 2.2, side)) g.add(mesh);
  g.add(bone(pose.hip, pose.knee, c.thighR, c.paint, 'thigh'));
  for (const mesh of actuator(pose.knee, c.thighR * 1.1, c.thighR * 2, side)) g.add(mesh);
  g.add(bone(pose.knee, pose.ankle, c.shinR, c.paint, 'shin'));
  g.add(
    cyl(c.shinR * 1.1, c.shinR * 1.6, material('metal'), {
      axis: 'z',
      at: pose.ankle,
      segments: 10,
      name: 'ankle',
    }),
  );
  if (pose.guard) {
    g.add(
      cyl(c.thighR * 1.35, c.thighR * 0.7, material('metal'), {
        axis: 'z',
        at: [pose.knee[0] + c.thighR * 0.5, pose.knee[1], pose.knee[2] + side * c.thighR * 1.5],
        segments: 12,
        name: 'knee-guard',
      }),
    );
  }
  g.add(sole(c, pose.ankle, pose.pitch ?? 0));
}

/** Hi-vis duty band round the torso, with its two reflective lines. */
function hivisBand(c: Chassis, y: number, height: number): Object3D[] {
  const { depth: d, chest } = c.spec;
  const band = material('vest');
  const parts: Object3D[] = [
    box([d * 1.02, height, chest * 1.04], band, { at: [0, y, 0], name: 'hi-vis-band' }),
  ];
  for (const off of [height * 0.26, -height * 0.26]) {
    parts.push(
      box([d * 1.03, height * 0.2, chest * 1.05], material('safetyWhite'), {
        at: [0, y + off, 0],
      }),
    );
  }
  return parts;
}

/** Duty / tool belt: band, buckle, a hip pouch each side, one carried behind. */
function belt(c: Chassis): Object3D[] {
  const { depth: d, chest } = c.spec;
  const dark = material('plastic');
  return [
    box([d * 0.94, c.h * 0.03, chest * 1.0], dark, { at: [0, 0.315 * c.h, 0], name: 'belt' }),
    box([d * 0.12, c.h * 0.022, chest * 0.2], material('chrome'), {
      at: [d * 0.42, 0.315 * c.h, 0],
    }),
    box([d * 0.16, c.h * 0.055, chest * 0.22], c.paint, {
      at: [d * 0.3, 0.295 * c.h, chest * 0.5],
      name: 'pouch',
    }),
    box([d * 0.2, c.h * 0.06, chest * 0.24], c.paint, {
      at: [-d * 0.56, 0.298 * c.h, -chest * 0.42],
      name: 'rear-pouch',
    }),
    box([d * 0.14, c.h * 0.05, chest * 0.2], dark, {
      at: [-d * 0.3, 0.292 * c.h, chest * 0.48],
    }),
  ];
}

/* --------------------------------------------------- general purpose */

/** Baseline unit: bare chassis, neutral stance, status panel on the chest. */
export function buildGeneralPurposeHumanoid(params: RobotParams = {}): Group {
  const c = humanoid({
    height: 1.78,
    width: 0.62,
    depth: 0.38,
    chest: 0.36,
    foot: [0.3, 0.1],
    paint: material('paint', params.color ?? '#e8edf2'),
  });

  // Arms hang relaxed, a shade clear of the flanks.
  for (const side of [1, -1]) {
    arm(c, {
      shoulder: [0.006, c.shoulder, side * c.armZ],
      elbow: [0.026, c.elbow, side * (c.armZ + 0.008)],
      wrist: [-0.008, c.wrist, side * (c.armZ - 0.004)],
      grip: 0.06,
    });
  }

  // Neutral stance: weight even, the near foot advanced the way it balances.
  leg(c, { hip: [0, c.hip, c.legZ], knee: [0.052, c.knee, c.legZ], ankle: [0.11, c.ankle, c.legZ] });
  leg(c, {
    hip: [0, c.hip, -c.legZ],
    knee: [-0.05, c.knee, -c.legZ],
    ankle: [-0.15, c.ankle, -c.legZ],
  });

  // Crown transponder — the only thing on the baseline unit that is not chassis.
  c.group.add(
    cyl(0.024, 0.016, material('metal'), { at: [-0.06, c.headTop + 0.008, 0], segments: 12 }),
  );
  c.group.add(sphere(0.026, material('chrome'), { at: [-0.06, c.headTop + 0.03, 0], segments: 12 }));
  return c.group;
}

/* ---------------------------------------------------------- delivery */

/** Courier unit mid-stride, carton hugged to the chest, battery on its back. */
export function buildDeliveryHumanoid(params: RobotParams = {}): Group {
  const c = humanoid({
    height: 1.7,
    width: 0.68,
    depth: 0.38,
    chest: 0.37,
    foot: [0.3, 0.1],
    paint: material('paint', params.color ?? '#f0a44b'),
  });
  const g = c.group;
  const card = material('cardboard');
  const dark = material('plastic');

  // Backpack battery: case, cooling fins, charge strip and a shoulder strap.
  g.add(box([0.12, 0.42, 0.3], c.paint, { at: [-0.25, 0.98, 0], name: 'battery-pack' }));
  for (let i = 0; i < 3; i += 1) {
    g.add(box([0.135, 0.016, 0.28], dark, { at: [-0.25, 0.88 + i * 0.09, 0] }));
  }
  g.add(box([0.02, 0.05, 0.16], material('lamp', '#4f8ef7'), { at: [-0.315, 0.82, 0] }));
  for (const side of [1, -1]) {
    g.add(
      bone([-0.2, 1.14, side * 0.12], [0.1, 1.06, side * 0.16], 0.018, dark, 'strap'),
    );
  }

  // Carton hugged to the chest: clear of the shell so both arms can wrap it,
  // with a taped seam over the flaps and a label on the outer face.
  const cartonX = 0.215;
  g.add(box([0.24, 0.34, 0.34], card, { at: [cartonX, 0.93, 0.01], name: 'carton' }));
  g.add(
    box([0.245, 0.022, 0.345], material('cardboard', '#8d6d49'), { at: [cartonX, 1.1, 0.01] }),
  );
  g.add(box([0.246, 0.026, 0.055], material('signWhite'), { at: [cartonX, 0.96, 0.01] }));
  g.add(box([0.012, 0.35, 0.055], material('signWhite'), { at: [cartonX + 0.12, 0.93, 0.01] }));
  g.add(box([0.012, 0.08, 0.1], material('signWhite'), { at: [cartonX + 0.12, 0.99, 0.1] }));
  g.add(box([0.25, 0.014, 0.35], material('cardboard', '#8d6d49'), { at: [cartonX, 0.86, 0.01] }));

  // Near arm clamps the carton from underneath; the far arm reaches round it.
  arm(c, {
    shoulder: [0.01, c.shoulder, c.armZ],
    elbow: [0.08, c.elbow + 0.04, c.armZ - 0.01],
    wrist: [0.26, 0.79, c.armZ - 0.09],
    grip: -1.8,
  });
  arm(c, {
    shoulder: [0.01, c.shoulder, -c.armZ],
    elbow: [0.09, c.elbow + 0.06, -c.armZ],
    wrist: [0.28, 0.98, -c.armZ + 0.11],
    grip: -1.4,
  });

  // Hip pouch on the near side, flap buckled down.
  g.add(box([0.09, 0.12, 0.09], c.paint, { at: [0.14, 0.47, 0.2], name: 'hip-pouch' }));
  g.add(box([0.095, 0.03, 0.095], dark, { at: [0.14, 0.53, 0.2] }));

  // Leading leg planted, trailing leg at toe-off with its heel off the road.
  leg(c, {
    hip: [0.01, c.hip, c.legZ],
    knee: [0.075, c.knee, c.legZ],
    ankle: [0.1, c.ankle, c.legZ],
  });
  const pitch = -0.38;
  leg(c, {
    hip: [-0.01, c.hip, -c.legZ],
    knee: [-0.09, c.knee + 0.02, -c.legZ],
    ankle: [-0.15, ankleLift(c, pitch), -c.legZ],
    pitch,
  });
  return g;
}

/* --------------------------------------------------------- warehouse */

/** Heavy lifter: broad chassis, exo lift harness, tote raised clear overhead. */
export function buildWarehouseHumanoid(params: RobotParams = {}): Group {
  const c = humanoid({
    height: 1.75,
    width: 0.7,
    depth: 0.4,
    chest: 0.44,
    foot: [0.34, 0.12],
    paint: material('paint', params.color ?? '#d8a31a'),
  });
  const g = c.group;
  const metal = material('metal');
  const rim = material('rim');

  // Load-spreading yoke across the shoulders and the load read-out under it.
  g.add(box([0.2, 0.045, 0.58], c.paint, { at: [0, c.torsoTop - 0.01, 0], name: 'load-yoke' }));
  for (let i = 0; i < 4; i += 1) {
    g.add(
      box([0.012, 0.028, 0.03], material(i < 3 ? 'lamp' : 'chrome'), {
        at: [c.front - 0.004, 1.16, -0.09 + i * 0.06],
      }),
    );
  }

  // Exo lift harness: lumbar band, hip pivots, thigh struts, chest tie.
  g.add(box([0.42, 0.06, 0.5], metal, { at: [0, 0.7, 0], name: 'lumbar-band' }));
  for (const z of [-0.16, 0, 0.16]) {
    g.add(cyl(0.014, 0.03, material('chrome'), { axis: 'x', at: [0.21, 0.7, z], segments: 10 }));
  }
  for (const side of [1, -1]) {
    g.add(bone([0.04, 1.26, side * 0.16], [-0.02, 0.73, side * 0.22], 0.016, rim, 'harness-tie'));
    g.add(bone([-0.02, 0.68, side * 0.25], [0.02, 0.35, side * 0.25], 0.017, rim, 'thigh-strut'));
    g.add(cyl(0.026, 0.05, metal, { axis: 'z', at: [0, 0.52, side * 0.26], segments: 12 }));
  }

  // Tote raised clear overhead and out in front of the visor: an open
  // stackable crate, narrower than the shoulders so the head still reads.
  const toteFront = 0.38;
  const toteBack = 0.12;
  const toteBase = 1.54;
  const toteTop = 1.75;
  const toteZ = 0.18;
  const toteMid = (toteFront + toteBack) / 2;
  g.add(
    box([toteFront - toteBack, 0.026, toteZ * 2], c.paint, {
      at: [toteMid, toteBase + 0.013, 0],
      name: 'tote-floor',
    }),
  );
  for (const x of [toteBack, toteFront]) {
    g.add(
      box([0.022, toteTop - toteBase, toteZ * 2], c.paint, {
        at: [x, (toteBase + toteTop) / 2, 0],
        name: 'tote-wall',
      }),
    );
    g.add(box([0.026, 0.024, toteZ * 2], metal, { at: [x, toteTop, 0], name: 'tote-rim' }));
  }
  for (const side of [1, -1]) {
    g.add(
      box([toteFront - toteBack, toteTop - toteBase, 0.022], c.paint, {
        at: [toteMid, (toteBase + toteTop) / 2, side * toteZ],
        name: 'tote-wall',
      }),
    );
    g.add(
      box([toteFront - toteBack + 0.03, 0.024, 0.03], metal, {
        at: [toteMid, toteTop, side * toteZ],
        name: 'tote-rim',
      }),
    );
  }
  g.add(box([toteFront - toteBack, 0.022, toteZ * 1.7], rim, { at: [toteMid, toteBase, 0] }));

  // Arms up in front of the chest, pressed under the tote floor.
  for (const side of [1, -1]) {
    arm(c, {
      shoulder: [0, c.shoulder, side * c.armZ],
      elbow: [0.16, c.shoulder + 0.1, side * (c.armZ - 0.03)],
      wrist: [0.21, toteBase - 0.07, side * (c.armZ - 0.1)],
      grip: 3.1,
    });
  }

  // Planted wide and braced, knee guards over both knees.
  leg(c, {
    hip: [0, c.hip, c.legZ],
    knee: [0.06, c.knee, c.legZ],
    ankle: [0.12, c.ankle, c.legZ],
    guard: true,
  });
  leg(c, {
    hip: [0, c.hip, -c.legZ],
    knee: [-0.055, c.knee, -c.legZ],
    ankle: [-0.14, c.ankle, -c.legZ],
    guard: true,
  });
  return g;
}

/* ----------------------------------------------------- public safety */

/** Patrol unit: shoulder beacon, chest camera, hi-vis band, arms at its sides. */
export function buildPublicSafetyHumanoid(params: RobotParams = {}): Group {
  const c = humanoid({
    height: 1.82,
    width: 0.68,
    depth: 0.34,
    chest: 0.34,
    foot: [0.32, 0.11],
    paint: material('paint', params.color ?? '#ef4444'),
  });
  const g = c.group;
  const dark = material('plastic');
  const chrome = material('chrome');
  const blue = material('lamp', '#4f8ef7');

  for (const mesh of hivisBand(c, 0.63 * c.h, 0.075)) g.add(mesh);

  // Chest camera over the band, with its record light.
  g.add(cyl(0.045, 0.03, dark, { axis: 'x', at: [c.front - 0.005, 0.72 * c.h, 0.04], segments: 14 }));
  g.add(
    cyl(0.024, 0.026, material('glass'), {
      axis: 'x',
      at: [c.front + 0.012, 0.72 * c.h, 0.04],
      segments: 12,
    }),
  );
  g.add(
    cyl(0.03, 0.008, chrome, { axis: 'x', at: [c.front + 0.008, 0.72 * c.h, 0.04], segments: 12 }),
  );
  g.add(
    cyl(0.008, 0.014, material('taillight'), {
      axis: 'x',
      at: [c.front + 0.004, 0.72 * c.h, -0.08],
      segments: 8,
    }),
  );

  // Shoulder beacon on a short post, standing clear of the near pauldron but
  // well below the crown — level with the head, as the tile draws it.
  const beaconZ = c.armZ - 0.04;
  g.add(cyl(0.015, 0.11, material('rim'), { at: [-0.03, 1.3, beaconZ], segments: 10 }));
  g.add(cyl(0.048, 0.075, blue, { at: [-0.03, 1.39, beaconZ], segments: 14, name: 'beacon' }));
  g.add(cyl(0.051, 0.012, chrome, { at: [-0.03, 1.43, beaconZ], segments: 14 }));

  // Comm whip on the far shoulder.
  g.add(bone([-0.04, 1.26, -beaconZ], [-0.08, 1.47, -beaconZ - 0.02], 0.008, chrome, 'comm-mast'));
  g.add(sphere(0.016, material('lamp'), { at: [-0.08, 1.48, -beaconZ - 0.02], segments: 10 }));

  // Arms straight at its sides, parade stance.
  for (const side of [1, -1]) {
    arm(c, {
      shoulder: [0, c.shoulder, side * c.armZ],
      elbow: [0.014, c.elbow, side * c.armZ],
      wrist: [0, c.wrist, side * c.armZ],
      grip: 0.02,
    });
  }

  for (const mesh of belt(c)) g.add(mesh);
  leg(c, { hip: [0, c.hip, c.legZ], knee: [0.055, c.knee, c.legZ], ankle: [0.13, c.ankle, c.legZ] });
  leg(c, {
    hip: [0, c.hip, -c.legZ],
    knee: [-0.05, c.knee, -c.legZ],
    ankle: [-0.15, c.ankle, -c.legZ],
  });
  return g;
}

/* ------------------------------------------------------ construction */

/** Site unit: hard hat, hi-vis vest, tool belt, driver in the near gripper. */
export function buildConstructionHumanoid(params: RobotParams = {}): Group {
  const c = humanoid({
    height: 1.85,
    width: 0.72,
    depth: 0.4,
    chest: 0.4,
    foot: [0.33, 0.12],
    paint: material('paint', params.color ?? '#f59e0b'),
  });
  const g = c.group;
  const hat = material('signOrange');
  const vest = material('vest');
  const reflect = material('safetyWhite');
  const dark = material('plastic');
  const metal = material('metal');

  // Hi-vis vest: front panels, shoulder straps, two reflective bands.
  g.add(
    box([c.spec.depth * 0.36, 0.42, c.spec.chest * 1.07], vest, {
      at: [c.front - 0.05, 0.98, 0],
      name: 'vest',
    }),
  );
  for (const y of [0.86, 1.06]) {
    g.add(box([c.spec.depth * 0.38, 0.05, c.spec.chest * 1.08], reflect, { at: [c.front - 0.05, y, 0] }));
  }
  for (const side of [1, -1]) {
    g.add(bone([0.1, 1.2, side * 0.1], [0.14, 1.36, side * 0.16], 0.024, vest, 'vest-strap'));
  }
  g.add(cyl(0.012, 0.016, material('lamp'), { axis: 'x', at: [c.front + 0.005, 1.14, -0.1] }));

  // Hard hat: crown shell over the sensor visor, ridge, full brim.
  g.add(
    sphere(0.118, hat, { at: [-0.01, c.headTop - 0.05, 0], scale: [1.04, 0.92, 1], segments: 16, name: 'hard-hat' }),
  );
  g.add(cyl(0.158, 0.016, hat, { at: [0.006, c.headTop - 0.058, 0], segments: 20, name: 'brim' }));
  g.add(
    box([0.12, 0.016, 0.028], material('signOrange', '#bd8218'), {
      at: [-0.01, c.headTop + 0.032, 0],
      name: 'hat-ridge',
    }),
  );

  // Near arm holds the driver out at the work; the far arm hangs clear.
  arm(c, {
    shoulder: [0, c.shoulder, c.armZ],
    elbow: [0.1, c.elbow + 0.04, c.armZ - 0.01],
    wrist: [0.22, c.elbow - 0.05, c.armZ - 0.05],
    grip: 0.3,
  });
  arm(c, {
    shoulder: [0, c.shoulder, -c.armZ],
    elbow: [-0.01, c.elbow, -c.armZ],
    wrist: [0.012, c.wrist, -c.armZ],
    grip: 0.05,
  });

  // Cordless driver held out at the work, clear of the tool belt: body,
  // battery, chuck, bit and a charge lamp.
  const toolY = c.elbow - 0.05;
  const toolZ = c.armZ - 0.05;
  g.add(box([0.14, 0.105, 0.085], dark, { at: [0.24, toolY, toolZ], name: 'driver' }));
  g.add(box([0.1, 0.06, 0.08], material('lamp'), { at: [0.23, toolY - 0.075, toolZ] }));
  g.add(
    cyl(0.03, 0.07, metal, {
      axis: 'x',
      at: [0.33, toolY + 0.012, toolZ],
      segments: 12,
      name: 'chuck',
    }),
  );
  g.add(
    cyl(0.008, 0.06, material('chrome'), {
      axis: 'x',
      at: [0.385, toolY + 0.012, toolZ],
      segments: 8,
      name: 'bit',
    }),
  );

  // Tool belt, plus the hammer slung on the far hip.
  for (const mesh of belt(c)) g.add(mesh);
  g.add(bone([-0.16, 0.56, -0.24], [-0.19, 0.4, -0.24], 0.014, material('rim'), 'hammer-shaft'));
  g.add(box([0.075, 0.04, 0.04], metal, { at: [-0.195, 0.385, -0.24], name: 'hammer-head' }));

  // Braced: forward leg loaded, rear leg straight and back.
  leg(c, {
    hip: [0.01, c.hip, c.legZ],
    knee: [0.07, c.knee, c.legZ],
    ankle: [0.11, c.ankle, c.legZ],
    guard: true,
  });
  leg(c, {
    hip: [-0.01, c.hip, -c.legZ],
    knee: [-0.07, c.knee, -c.legZ],
    ankle: [-0.17, c.ankle, -c.legZ],
  });
  return g;
}
