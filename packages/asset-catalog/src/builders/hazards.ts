import { Group } from 'three';

import { box, cyl, type Point2, profile, rand, sphere, torus } from '../geometry';
import { material } from '../materials';

/**
 * Small objects that end up in the travelled way. These are the classic
 * "is it drivable-over or is it a rock?" perception cases, so their size is the
 * whole point: a shredded retread is 0.7 m of black rubber, a blown-out
 * cardboard box is 0.6 m of nothing.
 */

/** Shredded truck retread lying in the lane. */
export function buildTireDebris(): Group {
  const group = new Group();
  const rubber = material('tire');

  const ring = torus(0.26, 0.055, rubber, { at: [0, 0.055, 0], rot: [Math.PI / 2, 0, 0], segments: 16 });
  ring.scale.set(1.15, 0.72, 1);
  group.add(ring);
  // A torn-off strip curling up off the road.
  group.add(
    profile(
      [
        [-0.30, 0.02],
        [-0.10, 0.20],
        [0.20, 0.24],
        [0.22, 0.17],
        [-0.06, 0.13],
        [-0.26, 0.0],
      ],
      0.20,
      rubber,
      { radius: 0.03, bevel: 0.02, at: [0.14, 0, 0.10], rot: [0, 0.5, 0] },
    ),
  );
  group.add(box([0.16, 0.05, 0.12], rubber, { at: [-0.24, 0.042, -0.14], rot: [0, 0.7, 0.2] }));
  return group;
}

/** Empty cardboard box, flaps open. */
export function buildCardboardBox(): Group {
  const group = new Group();
  const card = material('cardboard');
  const l = 0.58;
  const w = 0.42;
  const h = 0.36;

  group.add(box([l, h, w], card, { at: [0, h / 2, 0] }));
  // Open flaps, splayed at the top.
  group.add(box([l, 0.012, w * 0.5], card, { at: [0, h + 0.06, w * 0.30], rot: [-0.55, 0, 0] }));
  group.add(box([l, 0.012, w * 0.5], card, { at: [0, h + 0.04, -w * 0.34], rot: [0.75, 0, 0] }));
  group.add(box([0.03, 0.004, w], material('fabric'), { at: [0, h + 0.001, 0] }));
  return group;
}

export interface TrashBagParams {
  count: number;
  seed: number;
}

/** Cluster of tied refuse sacks at the kerb. */
export function buildTrashBags(params: TrashBagParams = { count: 3, seed: 11 }): Group {
  const group = new Group();
  const bag = material('plastic');
  const random = rand(params.seed);
  const count = Math.max(1, Math.round(params.count));

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + random();
    const radius = count === 1 ? 0 : 0.24 + random() * 0.10;
    const r = 0.26 + random() * 0.05;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius * 0.8;
    const bodyH = r * 1.9;
    group.add(
      sphere(r, bag, { at: [x, bodyH / 2, z], scale: [1, 0.95, 0.92], segments: 12 }),
    );
    group.add(
      cyl(r * 0.42, r * 0.42, bag, {
        rTop: r * 0.14,
        at: [x, bodyH - r * 0.06, z],
        segments: 10,
      }),
    );
  }
  return group;
}

/** Storm-broken branch across the lane. */
export function buildDownedBranch(): Group {
  const group = new Group();
  const wood = material('wood');
  const foliage = material('foliage');
  const random = rand(5);

  // Main limb lying on the road; everything else hangs off it, and every piece
  // rests on y = 0 rather than hovering above it.
  const limb = cyl(0.075, 2.10, wood, { axis: 'x', at: [-0.10, 0.075, 0], segments: 8 });
  limb.rotation.y = 0.12;
  group.add(limb);

  const branches: Point2[] = [
    [-0.80, 0.50],
    [-0.25, -0.40],
    [0.35, 0.34],
    [0.70, -0.28],
  ];
  for (const [x, z] of branches) {
    const len = 0.42 + random() * 0.3;
    const r = 0.032;
    const twig = cyl(r, len, wood, { axis: 'x', at: [x + len * 0.28, r, z * 0.5], segments: 6 });
    twig.rotation.y = Math.atan2(z, 0.5);
    group.add(twig);
    const leafR = 0.20 + random() * 0.06;
    group.add(
      sphere(leafR, foliage, {
        at: [x + len * 0.5, leafR * 0.62, z * 0.8],
        scale: [1.2, 0.62, 1],
        segments: 8,
      }),
    );
  }
  // A forked limb propped up off the road — the part that actually protrudes
  // into a bumper rather than passing under the car.
  const fork = cyl(0.045, 0.72, wood, { axis: 'x', at: [0.72, 0.20, 0.12], segments: 6 });
  fork.rotation.z = 0.36;
  fork.rotation.y = -0.25;
  group.add(fork);
  group.add(
    sphere(0.22, foliage, { at: [1.05, 0.30, 0.02], scale: [1.1, 0.7, 1], segments: 8 }),
  );
  return group;
}

/**
 * Aluminium extension ladder that has come off a roof rack.
 *
 * The long thin case: a 3.6 m object lying across a lane is far too long to
 * straddle and far too low to see at range, and its aspect ratio is nothing
 * like a vehicle's.
 */
export function buildLadder(): Group {
  const group = new Group();
  const alu = material('metal');
  const length = 3.55;
  const width = 0.44;
  const railW = 0.055;
  const railH = 0.08;

  // Two rails along +X, rungs across. The whole thing lies flat on the road,
  // slightly askew, which is how a shed load actually comes to rest.
  for (const z of [width / 2 - railW / 2, -(width / 2 - railW / 2)]) {
    group.add(box([length, railH, railW], alu, { at: [0, railH / 2, z] }));
  }
  const rungs = 11;
  for (let i = 0; i < rungs; i += 1) {
    const x = -length / 2 + (length * (i + 0.5)) / rungs;
    group.add(cyl(0.016, width - railW, alu, { axis: 'z', at: [x, railH * 0.55, 0], segments: 8 }));
  }
  return group;
}

/**
 * Double mattress shed from a load, lying folded in the lane.
 *
 * The classic "large, soft, and completely undrivable-over" obstacle: it fills
 * a lane, it is tall enough to matter, and a bumper hitting it is a real event
 * even though the object weighs nothing.
 */
export function buildMattress(): Group {
  const group = new Group();
  const ticking = material('mattress');
  const l = 1.86;
  const w = 1.32;
  const h = 0.24;

  group.add(box([l, h * 0.8, w], ticking, { at: [0, h * 0.4, 0] }));
  // Buckled corner: one end has folded up on itself.
  group.add(box([l * 0.36, h * 0.7, w * 0.98], ticking, {
    at: [l * 0.28, h * 0.72, 0],
    rot: [0, 0, -0.22],
  }));
  // Piping along the edges, so the silhouette is not a perfect slab.
  for (const z of [w / 2 - 0.03, -(w / 2 - 0.03)]) {
    group.add(cyl(0.03, l * 0.98, material('fabric'), { axis: 'x', at: [0, h * 0.4, z], segments: 8 }));
  }
  return group;
}

/**
 * Unidentified debris: a scatter of broken material in the travelled way.
 *
 * The generic escape hatch. When a scenario needs "there is something in the
 * lane" and the exact object is not the point, this is the id to use — it is
 * deliberately irregular and deliberately not any recognisable product, so a
 * brief that says "debris" no longer has to be authored as a cardboard box.
 */
export function buildDebrisPile(): Group {
  const group = new Group();
  const random = rand(23);
  const mats = [material('plastic'), material('wood'), material('cardboard'), material('metal')];

  for (let i = 0; i < 9; i += 1) {
    const mat = mats[i % mats.length] as ReturnType<typeof material>;
    const l = 0.16 + random() * 0.34;
    const w = 0.10 + random() * 0.24;
    const h = 0.05 + random() * 0.16;
    group.add(
      box([l, h, w], mat, {
        at: [(random() - 0.5) * 0.66, h / 2 + 0.006, (random() - 0.5) * 0.5],
        rot: [0, (random() - 0.5) * 2.4, (random() - 0.5) * 0.16],
      }),
    );
  }
  return group;
}
