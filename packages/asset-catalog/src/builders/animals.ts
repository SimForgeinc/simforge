import { Group, type Mesh, type MeshStandardMaterial, Vector3 } from 'three';

import { capsule, cone, cyl, mirrored, profile, sphere, torus, type Vec3 } from '../geometry.js';
import { material } from '../materials.js';

/**
 * Animals in the carriageway: dog, cat, deer, raccoon, goose.
 *
 * These are the 2D tiles in `actor-art/animals.tsx` at three dimensions, and
 * they are authored off the same measured skeleton the tiles are pinned to —
 * transcribed from the 96x48 side elevation with the ground at y = 41 by the
 * rule at the top of `shell.ts`. In metres, that skeleton is:
 *
 *   back line   deer 0.93 · goose 0.45 · dog 0.46 · raccoon 0.38 · cat 0.22
 *   belly       deer 0.46 · dog 0.15 · goose 0.10 · raccoon 0.10 · cat 0.09
 *   torso l/d   deer 1.03/0.42 · dog 0.73/0.30 · goose 0.55/0.35 ·
 *               raccoon 0.43/0.26 · cat 0.40/0.12 — the cat is the only tube
 *   tail        deer flicked stub · dog raised sabre · cat upward curl ·
 *               raccoon ringed club · goose pointed feather stack
 *
 * Species proportion *is* the identity at this range, so nothing above the
 * level of a bone or a paw is shared between them: each torso is lofted rib by
 * rib so chest depth and waist tuck are dialled per species, each limb is a
 * tapered chain broken at the joints that species actually shows (the deer's
 * hock, the cat's folded stifle, the raccoon's plantigrade ankle), and no two
 * stances repeat — the dog stands square and alert, the cat walks low with its
 * shoulder blades up, the deer braces mid-stride on straight legs, the raccoon
 * hunches over an arched spine and the goose stands upright over a folded wing.
 *
 * Coat colour is the caller's; only markings are fixed, because a marking is
 * what names the species: the raccoon's mask and tail bands, the deer's bone
 * antlers and pale rump, the goose's chin strap, the dog's collar.
 *
 * Convention as everywhere else: `+X` is the direction the animal faces, the
 * bounding box is centred on the origin in X and Z, and the feet sit on y = 0.
 */

/** Every animal takes a coat colour; the rest of the shape is fixed per species. */
export interface AnimalParams {
  color: string;
}

type Mat = MeshStandardMaterial;

/** Pale fur: muzzle bands, brisket, rump patch, inner ears. */
const PALE = '#e0d2b6';
/** Deep fur: nose leather, eye sockets, pads, hooves. */
const DARK = '#111823';
/** Raccoon bandit mask and tail bands. */
const MASK = '#141a22';
/** Bone antler, warm against the cool fleet palette. */
const ANTLER = '#c3a678';
/** Dog collar webbing. */
const COLLAR = '#c4544a';
/** Goose head, bill and the chin strap that identifies the species. */
const GOOSE_DARK = '#161e28';
const GOOSE_PALE = '#f0ece2';

/* ------------------------------------------------------------- vocabulary */

/**
 * One cross-section of a torso: where the spine is, how deep the body is there
 * and how wide. A run of these is what separates a deep-chested dog from a
 * hunched raccoon, so it is the only body primitive here.
 */
interface Rib {
  x: number;
  /** Spine height at this station — the centre of the section, not the back. */
  y: number;
  /** Half-depth (belly to back) and half-width. */
  ry: number;
  rz: number;
  /** Half-length of the section; defaults to reaching its neighbour. */
  rx?: number;
}

/**
 * Torso as a run of overlapping elliptical sections along the spine.
 *
 * The sections have to overlap generously or the body reads as a caterpillar:
 * two ellipsoids a gap `g` apart pinch to `sqrt(1 - (g/2rx)^2)` of their width
 * halfway between them, so at `rx = 1.5g` the waist between stations closes to
 * within a few percent and the run reads as one hide.
 */
function loft(ribs: readonly Rib[], coat: Mat): Mesh[] {
  return ribs.map((rib, index) => {
    const prev = ribs[index - 1] ?? rib;
    const next = ribs[index + 1] ?? rib;
    const rx = rib.rx ?? Math.max(next.x - rib.x, rib.x - prev.x) * 1.8;
    return sphere(1, coat, {
      at: [rib.x, rib.y, 0],
      scale: [rx, rib.ry, rib.rz],
      segments: 18,
      name: 'body',
    });
  });
}

/** Tapered bone between two points in space. */
function strut(a: Vec3, b: Vec3, r: number, rEnd: number, mat: Mat, name = 'bone'): Mesh {
  const dir = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const length = Math.max(dir.length(), 1e-4);
  const mesh = cyl(r, length, mat, {
    rTop: rEnd,
    at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    segments: 8,
    name,
  });
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.divideScalar(length));
  return mesh;
}

/**
 * Tapered chain through a polyline of joints, with a knuckle at every bend.
 * `radii[i]` is the thickness at `points[i]`, so a leg thins as it descends and
 * the knuckles are what make a hock or a stifle read at distance.
 */
function chain(points: readonly Vec3[], radii: readonly number[], mat: Mat, name = 'bone'): Mesh[] {
  const parts: Mesh[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    parts.push(strut(points[i]!, points[i + 1]!, radii[i]!, radii[i + 1]!, mat, name));
    if (i > 0) {
      parts.push(sphere(radii[i]! * 1.02, mat, { at: points[i]!, segments: 8, name: 'joint' }));
    }
  }
  return parts;
}

/** Band around a limb — a collar, a tail ring — with its axis along `dir`. */
function band(at: Vec3, dir: Vec3, r: number, tube: number, mat: Mat, name = 'band'): Mesh {
  const mesh = torus(r, tube, mat, { at, segments: 14, name });
  mesh.quaternion.setFromUnitVectors(
    new Vector3(0, 0, 1),
    new Vector3(dir[0], dir[1], dir[2]).normalize(),
  );
  return mesh;
}

/** Padded foot flat on the ground. `toes` splits the front edge. */
function paw(
  x: number,
  z: number,
  length: number,
  halfWidth: number,
  toes: number,
  coat: Mat,
  claw: Mat,
): Mesh[] {
  const squash = 0.62;
  const parts: Mesh[] = [
    capsule(halfWidth, Math.max(length - 2 * halfWidth, 0.002), coat, {
      at: [x, halfWidth * squash, z],
      rot: [0, 0, Math.PI / 2],
      scale: [squash, 1, 1],
      segments: 8,
      name: 'paw',
    }),
  ];
  for (let i = 0; i < toes; i += 1) {
    const spread = toes === 1 ? 0 : (i / (toes - 1) - 0.5) * 2;
    parts.push(
      sphere(halfWidth * 0.4, claw, {
        at: [x + length * 0.34, halfWidth * squash * 0.95, z + spread * halfWidth * 0.6],
        scale: [1.1, 0.68, 0.9],
        segments: 6,
        name: 'toe',
      }),
    );
  }
  return parts;
}

/** Cloven hoof: two keratin halves with the split showing between them. */
function hoof(x: number, z: number, height: number, halfWidth: number, mat: Mat): Mesh[] {
  return [z, -z].flatMap((side) =>
    mirrored(halfWidth * 0.52, (dz) =>
      cyl(halfWidth * 0.48, height, mat, {
        rTop: halfWidth * 0.4,
        at: [x, height / 2, side + dz],
        scale: [1.45, 1, 1],
        segments: 6,
        name: 'hoof',
      }),
    ),
  ) as Mesh[];
}

/** Socket and pupil, both sides. */
function eyes(x: number, y: number, z: number, r: number, socket: Mat, pupil: Mat): Mesh[] {
  const parts: Mesh[] = [];
  for (const dz of [z, -z]) {
    parts.push(sphere(r, socket, { at: [x, y, dz], segments: 6, name: 'eye' }));
    parts.push(
      sphere(r * 0.55, pupil, { at: [x + r * 0.4, y, dz * 1.04], segments: 6, name: 'pupil' }),
    );
  }
  return parts;
}

/**
 * Pricked ear: a flattened low-poly cone standing off the crown, swept back by
 * `sweep` and flared away from the skull. `sides` picks how sharp it reads — 3
 * for a cat's triangle, 5 for a deer's leaf.
 */
function ear(at: Vec3, r: number, height: number, sweep: number, flare: number, mat: Mat, sides = 3, flat = 0.45): Mesh {
  const side = at[2] >= 0 ? 1 : -1;
  return cone(r, height, mat, {
    at,
    rot: [flare * side, 0, sweep],
    scale: [1, 1, flat],
    segments: sides,
    name: 'ear',
  });
}

/* -------------------------------------------------------------------- dog */

/** Deep chest at the shoulder, waist tucked up hard behind the ribs. */
const DOG_RIBS: readonly Rib[] = [
  { x: -0.355, y: 0.315, ry: 0.08, rz: 0.098, rx: 0.075 },
  { x: -0.27, y: 0.32, ry: 0.105, rz: 0.118 },
  { x: -0.17, y: 0.33, ry: 0.105, rz: 0.096 },
  { x: -0.06, y: 0.314, ry: 0.139, rz: 0.124 },
  { x: 0.06, y: 0.304, ry: 0.151, rz: 0.1525 },
  { x: 0.16, y: 0.309, ry: 0.139, rz: 0.144 },
  { x: 0.23, y: 0.31, ry: 0.115, rz: 0.115, rx: 0.07 },
];

/**
 * Loose mid-size dog, standing square and alert: the animal an ADS most often
 * has to decide about in a residential street. Deep chest over a tucked waist,
 * pricked ears, a raised sabre tail and a collar — the cues that say *someone's
 * dog* rather than *wildlife*.
 */
export function buildDog(params: AnimalParams = { color: '#a8834f' }): Group {
  const group = new Group();
  const coat = material('fur', params.color);
  const pale = material('fur', PALE);
  const dark = material('fur', DARK);

  group.add(...loft(DOG_RIBS, coat));
  // Pale brisket under the deep chest.
  group.add(sphere(0.062, pale, { at: [0.135, 0.185, 0], scale: [1.5, 0.5, 0.85], name: 'brisket' }));

  // Neck, carried high off the shoulder.
  group.add(...chain([[0.215, 0.4, 0], [0.285, 0.48, 0], [0.345, 0.545, 0]], [0.08, 0.07, 0.062], coat, 'neck'));

  // Skull, cheeks, muzzle: a broad head with a squared-off nose, not a snout.
  group.add(sphere(0.076, coat, { at: [0.375, 0.56, 0], scale: [1, 0.98, 0.9], name: 'skull' }));
  group.add(...mirrored(0.045, (dz) => sphere(0.04, coat, { at: [0.395, 0.505, dz], segments: 8, name: 'cheek' })));
  group.add(...chain([[0.415, 0.52, 0], [0.495, 0.462, 0]], [0.058, 0.04], coat, 'muzzle'));
  group.add(sphere(0.038, pale, { at: [0.478, 0.462, 0], scale: [1.05, 0.72, 0.92], name: 'muzzle-band' }));
  group.add(sphere(0.021, dark, { at: [0.508, 0.45, 0], scale: [1, 0.9, 1], name: 'nose' }));
  group.add(...eyes(0.42, 0.575, 0.048, 0.015, dark, material('fur', '#080d14')));

  // Ears carried up and slightly back — the alert stance in one cue. Broad at
  // the base and set close on the skull, or they read as horns.
  group.add(...mirrored(0.046, (dz) => ear([0.339, 0.682, dz], 0.052, 0.135, 0.24, 0.2, coat, 3, 0.52)));
  group.add(...mirrored(0.044, (dz) => ear([0.344, 0.675, dz], 0.035, 0.098, 0.24, 0.2, dark, 3, 0.36)));

  // Collar, cut across the neck axis, with a tag on it.
  group.add(band([0.28, 0.474, 0], [0.66, 0.75, 0], 0.078, 0.013, material('fabric', COLLAR), 'collar'));
  group.add(sphere(0.012, material('chrome'), { at: [0.29, 0.402, 0], segments: 8, name: 'tag' }));

  // Raised sabre tail.
  group.add(
    ...chain(
      [[-0.36, 0.375, 0], [-0.425, 0.435, 0], [-0.485, 0.48, 0], [-0.53, 0.505, 0]],
      [0.036, 0.03, 0.022, 0.014],
      coat,
      'tail',
    ),
  );

  // Square stance: forelegs plumb under the shoulder, hocks kicked back.
  for (const dz of [0.088, -0.088]) {
    group.add(
      ...chain(
        [[0.14, 0.33, dz], [0.148, 0.205, dz], [0.15, 0.085, dz], [0.146, 0.03, dz]],
        [0.046, 0.03, 0.022, 0.019],
        coat,
        'foreleg',
      ),
    );
    group.add(
      ...chain(
        [[-0.29, 0.33, dz], [-0.3, 0.215, dz], [-0.335, 0.112, dz], [-0.302, 0.032, dz]],
        [0.054, 0.036, 0.024, 0.02],
        coat,
        'hindleg',
      ),
    );
    group.add(...paw(0.152, dz, 0.075, 0.03, 2, coat, dark));
    group.add(...paw(-0.298, dz, 0.07, 0.028, 2, coat, dark));
  }

  return group;
}

/* -------------------------------------------------------------------- cat */

/** Long level tube, shoulder blade proud where the foreleg plants. */
const CAT_RIBS: readonly Rib[] = [
  { x: -0.16, y: 0.1565, ry: 0.0415, rz: 0.0525, rx: 0.045 },
  { x: -0.115, y: 0.155, ry: 0.057, rz: 0.065 },
  { x: -0.05, y: 0.152, ry: 0.062, rz: 0.0735 },
  { x: 0.02, y: 0.1505, ry: 0.0615, rz: 0.0756 },
  { x: 0.085, y: 0.154, ry: 0.062, rz: 0.0714 },
  { x: 0.145, y: 0.155, ry: 0.05, rz: 0.0588, rx: 0.045 },
];

/**
 * Cat mid slow-walk: the small animal, the one that is genuinely hard to see
 * against asphalt at night. The only long tube in the set — three body lengths
 * to one depth — carried low on folded legs, with the shoulder blades riding
 * proud and the tail curled up well above the spine.
 */
export function buildCat(params: AnimalParams = { color: '#5c5750' }): Group {
  const group = new Group();
  const coat = material('fur', params.color);
  const pale = material('fur', PALE);
  const dark = material('fur', DARK);

  group.add(...loft(CAT_RIBS, coat));
  // Shoulder blades riding proud of the spine — the slow-walk cue. Sunk into
  // the flank; standing off it they read as panniers.
  group.add(
    ...mirrored(0.036, (dz) =>
      sphere(0.022, coat, { at: [0.095, 0.196, dz], scale: [1.6, 0.55, 0.7], segments: 10, name: 'blade' }),
    ),
  );
  group.add(sphere(0.05, pale, { at: [-0.02, 0.098, 0], scale: [2.2, 0.32, 0.8], name: 'belly' }));

  // Short low neck: the head barely clears the shoulder in a stalk.
  group.add(...chain([[0.15, 0.17, 0], [0.21, 0.215, 0]], [0.042, 0.036], coat, 'neck'));

  group.add(sphere(0.045, coat, { at: [0.24, 0.233, 0], scale: [1, 0.95, 0.92], name: 'skull' }));
  group.add(...mirrored(0.024, (dz) => sphere(0.021, coat, { at: [0.264, 0.214, dz], segments: 8, name: 'cheek' })));
  group.add(...chain([[0.262, 0.222, 0], [0.292, 0.207, 0]], [0.032, 0.024], coat, 'muzzle'));
  group.add(sphere(0.0085, material('fur', '#d98d96'), { at: [0.2985, 0.205, 0], segments: 8, name: 'nose' }));
  group.add(...eyes(0.268, 0.239, 0.026, 0.0085, dark, material('fur', '#080d14')));

  // Small triangular ears, barely swept.
  group.add(...mirrored(0.026, (dz) => ear([0.224, 0.298, dz], 0.026, 0.066, 0.16, 0.3, coat, 3, 0.5)));
  group.add(...mirrored(0.024, (dz) => ear([0.228, 0.293, dz], 0.017, 0.046, 0.16, 0.3, dark, 3, 0.36)));

  // Tail: back and level off the croup, then a long curl up over the spine.
  group.add(
    ...chain(
      [
        [-0.16, 0.15, 0],
        [-0.235, 0.148, 0],
        [-0.29, 0.175, 0],
        [-0.31, 0.23, 0],
        [-0.298, 0.288, 0],
        [-0.272, 0.34, 0],
      ],
      [0.017, 0.015, 0.014, 0.013, 0.012, 0.01],
      coat,
      'tail',
    ),
  );

  // Slow walk: near pair advanced half a stride, hind legs folded at the hock.
  for (const dz of [0.045, -0.045]) {
    const step = dz > 0 ? 0.018 : -0.018;
    group.add(
      ...chain(
        [
          [-0.12 + step, 0.15, dz],
          [-0.09 + step, 0.098, dz],
          [-0.112 + step, 0.052, dz],
          [-0.096 + step, 0.018, dz],
        ],
        [0.026, 0.02, 0.015, 0.013],
        coat,
        'hindleg',
      ),
    );
    group.add(
      ...chain(
        [[0.123 + step, 0.152, dz], [0.128 + step, 0.08, dz], [0.126 + step, 0.02, dz]],
        [0.023, 0.016, 0.013],
        coat,
        'foreleg',
      ),
    );
    group.add(...paw(-0.094 + step, dz, 0.036, 0.014, 3, coat, dark));
    group.add(...paw(0.13 + step, dz, 0.036, 0.014, 3, coat, dark));
  }

  return group;
}

/* ------------------------------------------------------------------- deer */

/** Short barrel over long legs, haunch riding higher than the withers. */
const DEER_RIBS: readonly Rib[] = [
  { x: -0.53, y: 0.7325, ry: 0.1725, rz: 0.135, rx: 0.09 },
  { x: -0.44, y: 0.725, ry: 0.205, rz: 0.15 },
  { x: -0.3, y: 0.6875, ry: 0.2075, rz: 0.145 },
  { x: -0.15, y: 0.665, ry: 0.195, rz: 0.15 },
  { x: 0.0, y: 0.651, ry: 0.189, rz: 0.155 },
  { x: 0.13, y: 0.645, ry: 0.185, rz: 0.15 },
  { x: 0.25, y: 0.65, ry: 0.17, rz: 0.13 },
  { x: 0.33, y: 0.66, ry: 0.14, rz: 0.11, rx: 0.075 },
];

/** A four-point rack, per side: beam sweeping back and out, tines forward. */
function antler(side: number, bone: Mat): Mesh[] {
  const s = (z: number): number => z * side;
  return [
    strut([0.61, 1.39, s(0.045)], [0.6, 1.445, s(0.07)], 0.026, 0.022, bone, 'pedicle'),
    ...chain(
      [
        [0.6, 1.445, s(0.07)],
        [0.52, 1.53, s(0.13)],
        [0.4, 1.575, s(0.185)],
        [0.3, 1.59, s(0.215)],
      ],
      [0.022, 0.018, 0.014, 0.01],
      bone,
      'beam',
    ),
    strut([0.6, 1.45, s(0.075)], [0.72, 1.49, s(0.115)], 0.015, 0.008, bone, 'brow-tine'),
    strut([0.52, 1.53, s(0.13)], [0.64, 1.585, s(0.155)], 0.016, 0.008, bone, 'tine'),
    strut([0.44, 1.56, s(0.17)], [0.56, 1.612, s(0.2)], 0.014, 0.007, bone, 'tine'),
  ];
}

/**
 * Adult white-tailed deer, braced mid-stride: the reference large animal, the
 * one that dominates real animal-strike statistics and the only actor here tall
 * enough to sit in a windscreen rather than under a bumper. Everything about it
 * is leg — a short barrel with the haunch above the withers, an arched neck,
 * cloven hooves, a pale rump and a four-point rack.
 */
export function buildDeer(params: AnimalParams = { color: '#9c7b52' }): Group {
  const group = new Group();
  const coat = material('fur', params.color);
  const pale = material('fur', PALE);
  const dark = material('fur', DARK);
  const bone = material('fur', ANTLER);

  group.add(...loft(DEER_RIBS, coat));
  group.add(sphere(0.13, pale, { at: [-0.575, 0.755, 0], scale: [0.55, 1, 0.85], name: 'rump-patch' }));
  group.add(sphere(0.12, pale, { at: [0.05, 0.475, 0], scale: [2.6, 0.22, 0.9], name: 'belly' }));

  // Short tail, flicked up over the rump patch.
  group.add(
    ...chain(
      [[-0.56, 0.84, 0], [-0.66, 0.905, 0], [-0.79, 0.955, 0]],
      [0.04, 0.028, 0.014],
      coat,
      'tail',
    ),
  );
  group.add(sphere(0.028, pale, { at: [-0.755, 0.925, 0], scale: [1.4, 0.8, 0.7], name: 'tail-flag' }));

  // Long neck, arched forward off the shoulder.
  group.add(
    ...chain(
      [[0.3, 0.76, 0], [0.4, 0.96, 0], [0.5, 1.15, 0], [0.58, 1.29, 0]],
      [0.12, 0.105, 0.09, 0.076],
      coat,
      'neck',
    ),
  );

  // Long face carried down off the poll.
  group.add(sphere(0.086, coat, { at: [0.63, 1.335, 0], scale: [1.05, 1, 0.82], name: 'skull' }));
  group.add(...chain([[0.66, 1.29, 0], [0.835, 1.1, 0]], [0.062, 0.044], coat, 'muzzle'));
  group.add(sphere(0.04, pale, { at: [0.805, 1.13, 0], scale: [1.1, 0.7, 0.9], name: 'muzzle-band' }));
  group.add(sphere(0.028, dark, { at: [0.845, 1.09, 0], scale: [1, 0.9, 0.95], name: 'nose' }));
  group.add(...eyes(0.675, 1.36, 0.062, 0.019, dark, material('fur', '#080d14')));

  // Broad ears cupped out off the crown, then the rack. Swept flat against the
  // beams they vanish into the antlers, so they carry more flare than sweep.
  group.add(...mirrored(0.1, (dz) => ear([0.555, 1.375, dz], 0.058, 0.175, 0.88, 0.72, coat, 5, 0.45)));
  group.add(...mirrored(0.095, (dz) => ear([0.561, 1.369, dz], 0.039, 0.125, 0.88, 0.72, dark, 5, 0.32)));
  group.add(...antler(1, bone), ...antler(-1, bone));

  // Long straight legs, the off pair half a stride behind. Stifle and hock are
  // separate bends on the hind leg: that zigzag is the deer's whole back end.
  for (const dz of [0.115, -0.115]) {
    const step = dz > 0 ? 0 : -0.13;
    group.add(
      ...chain(
        [
          [0.2 + step, 0.66, dz],
          [0.18 + step, 0.47, dz],
          [0.19 + step, 0.23, dz],
          [0.2 + step, 0.115, dz],
          [0.196 + step, 0.058, dz],
        ],
        [0.058, 0.04, 0.028, 0.024, 0.021],
        coat,
        'foreleg',
      ),
    );
    group.add(
      ...chain(
        [
          [-0.56 + step, 0.72, dz],
          [-0.59 + step, 0.53, dz],
          [-0.64 + step, 0.34, dz],
          [-0.595 + step, 0.14, dz],
          [-0.6 + step, 0.06, dz],
        ],
        [0.068, 0.05, 0.032, 0.026, 0.022],
        coat,
        'hindleg',
      ),
    );
    group.add(...hoof(0.198 + step, dz, 0.058, 0.034, dark));
    group.add(...hoof(-0.602 + step, dz, 0.058, 0.034, dark));
  }

  return group;
}

/* ---------------------------------------------------------------- raccoon */

/** Hunched spine: the arch peaks over the hips and falls away forward. */
const COON_RIBS: readonly Rib[] = [
  { x: -0.1, y: 0.21, ry: 0.08, rz: 0.08, rx: 0.055 },
  { x: -0.05, y: 0.235, ry: 0.12, rz: 0.102 },
  { x: 0.01, y: 0.2455, ry: 0.13, rz: 0.1124 },
  { x: 0.08, y: 0.232, ry: 0.126, rz: 0.11 },
  { x: 0.15, y: 0.213, ry: 0.113, rz: 0.102 },
  { x: 0.215, y: 0.198, ry: 0.094, rz: 0.0877, rx: 0.055 },
];

/** Ringed club of a tail, drooping behind the hips; six sections, five bands. */
const COON_TAIL: readonly Vec3[] = [
  [-0.1, 0.238, 0],
  [-0.155, 0.225, 0],
  [-0.21, 0.211, 0],
  [-0.265, 0.196, 0],
  [-0.32, 0.18, 0],
  [-0.37, 0.167, 0],
  [-0.4, 0.16, 0],
];

/** Fur radius at each tail station: bushy off the hips, tapering to the tip. */
const COON_TAIL_R = [0.05, 0.058, 0.058, 0.055, 0.048, 0.038, 0.026];

/**
 * Low hunched raccoon: the classic night hazard at the kerb line, and the
 * lowest-slung actor in the set — seven centimetres of shin under a back that
 * only stands at 0.38 m, so its legs are a fifth of its height where a deer's
 * are nearly half. The identity kit is the bandit mask, the plantigrade paws
 * and the banded club of a tail.
 */
export function buildRaccoon(params: AnimalParams = { color: '#666b70' }): Group {
  const group = new Group();
  const coat = material('fur', params.color);
  const pale = material('fur', PALE);
  const dark = material('fur', DARK);
  const mask = material('fur', MASK);

  group.add(...loft(COON_RIBS, coat));
  group.add(sphere(0.09, dark, { at: [0.06, 0.108, 0], scale: [1.6, 0.22, 0.85], name: 'belly' }));

  // Barely any neck: the head sits straight onto the shoulders.
  group.add(...chain([[0.215, 0.24, 0], [0.262, 0.28, 0]], [0.078, 0.068], coat, 'neck'));

  group.add(sphere(0.072, coat, { at: [0.295, 0.312, 0], scale: [1, 0.95, 0.9], name: 'skull' }));
  // Short blunt muzzle carried low, the way a raccoon forages.
  group.add(...chain([[0.332, 0.282, 0], [0.386, 0.234, 0]], [0.05, 0.028], coat, 'muzzle'));
  group.add(sphere(0.015, dark, { at: [0.394, 0.228, 0], segments: 8, name: 'nose' }));

  // Pale brow, then the bandit mask running down across each eye, then the
  // pale snout ridge: three bands stacked down the face, as on the tile.
  group.add(
    ...mirrored(0.035, (dz) =>
      sphere(0.022, pale, { at: [0.32, 0.354, dz], scale: [1.1, 0.42, 1], segments: 8, name: 'brow' }),
    ),
  );
  group.add(
    ...mirrored(0.043, (dz) =>
      sphere(0.03, mask, {
        at: [0.331, 0.306, dz],
        scale: [0.85, 1.25, 0.62],
        rot: [0, 0, -0.45],
        segments: 10,
        name: 'mask',
      }),
    ),
  );
  group.add(sphere(0.019, pale, { at: [0.372, 0.25, 0], scale: [1.5, 0.5, 0.9], name: 'snout-ridge' }));
  group.add(...eyes(0.348, 0.306, 0.042, 0.01, material('fur', '#e9e1cf'), material('fur', '#080d14')));

  // Rounded ears: flat discs turned out off the crown, not balls, and tall
  // enough to reach down into the skull — tangent to it they read as paddles
  // on stalks.
  group.add(
    ...mirrored(0.04, (dz) =>
      sphere(0.045, coat, {
        at: [0.288, 0.406, dz],
        scale: [0.55, 0.845, 1],
        rot: [0, dz > 0 ? 0.5 : -0.5, 0],
        segments: 10,
        name: 'ear',
      }),
    ),
  );
  group.add(
    ...mirrored(0.045, (dz) =>
      sphere(0.026, pale, {
        at: [0.293, 0.404, dz],
        scale: [0.5, 0.845, 1],
        rot: [0, dz > 0 ? 0.5 : -0.5, 0],
        segments: 8,
        name: 'ear-inner',
      }),
    ),
  );

  // Bushy tail held low. The bands are rings of their own, standing a little
  // proud of the coat: sunk inside the fur radius they read as nothing.
  group.add(...chain(COON_TAIL, COON_TAIL_R, coat, 'tail'));
  group.add(sphere(0.026, coat, { at: [-0.41, 0.158, 0], segments: 8, name: 'tail-tip' }));
  COON_TAIL.slice(1, 6).forEach((point, index) => {
    const next = COON_TAIL[index + 2]!;
    const dir: Vec3 = [next[0] - point[0], next[1] - point[1], 0];
    group.add(band(point, dir, COON_TAIL_R[index + 1]! - 0.002, 0.011, mask, 'tail-ring'));
  });

  // Plantigrade: long flat paws, almost no shin, the off pair a step behind.
  for (const dz of [0.06, -0.06]) {
    const step = dz > 0 ? 0 : -0.022;
    group.add(
      ...chain(
        [[0.2 + step, 0.15, dz], [0.208 + step, 0.078, dz], [0.205 + step, 0.034, dz]],
        [0.032, 0.025, 0.021],
        coat,
        'foreleg',
      ),
    );
    group.add(
      ...chain(
        [[-0.045 + step, 0.168, dz], [-0.022 + step, 0.082, dz], [-0.035 + step, 0.034, dz]],
        [0.04, 0.03, 0.023],
        coat,
        'hindleg',
      ),
    );
    group.add(...paw(0.218 + step, dz, 0.07, 0.024, 3, dark, coat));
    group.add(...paw(-0.028 + step, dz, 0.07, 0.024, 3, dark, coat));
  }

  return group;
}

/* ------------------------------------------------------------------ goose */

/** Deep bulky body, breast forward, carried high on short scaled legs. */
const GOOSE_RIBS: readonly Rib[] = [
  { x: -0.27, y: 0.2425, ry: 0.0575, rz: 0.085, rx: 0.055 },
  { x: -0.215, y: 0.255, ry: 0.105, rz: 0.13 },
  { x: -0.14, y: 0.2625, ry: 0.1475, rz: 0.165 },
  { x: -0.05, y: 0.269, ry: 0.171, rz: 0.183 },
  { x: 0.04, y: 0.2735, ry: 0.1735, rz: 0.185 },
  { x: 0.12, y: 0.28, ry: 0.15, rz: 0.16 },
  { x: 0.17, y: 0.285, ry: 0.11, rz: 0.12, rx: 0.05 },
];

/**
 * Folded wing over one flank: a scapular plate high on the back, the greater
 * covert stepped out below it, the fold seam along their lower edge and three
 * primaries laid back over the flank. The step and the seam are what make a
 * wing read — one plate in coat colour disappears into the flank at every
 * angle, and anything with a point on it reads as a spike, not a feather.
 */
function wing(side: number, coat: Mat, seam: Mat): Mesh[] {
  const z = (v: number): number => v * side;
  /** One laid-back primary: a flat blade, because a cone reads as a spike. */
  const primary = (x: number, y: number, at: number, length: number, tilt: number): Mesh =>
    sphere(1, seam, {
      at: [x, y, z(at)],
      scale: [length, 0.019, 0.013],
      rot: [0, 0, tilt],
      segments: 10,
      name: 'primary',
    });
  return [
    sphere(1, coat, { at: [0.005, 0.305, z(0.198)], scale: [0.14, 0.062, 0.03], segments: 12, name: 'scapular' }),
    sphere(1, coat, { at: [-0.04, 0.25, z(0.214)], scale: [0.155, 0.068, 0.038], segments: 12, name: 'covert' }),
    sphere(1, coat, { at: [0.09, 0.29, z(0.185)], scale: [0.07, 0.055, 0.03], segments: 10, name: 'shoulder' }),
    strut([0.105, 0.24, z(0.212)], [-0.175, 0.196, z(0.206)], 0.013, 0.01, seam, 'wing-fold'),
    primary(-0.185, 0.206, 0.2, 0.088, 0.2),
    primary(-0.175, 0.242, 0.206, 0.084, 0.16),
    primary(-0.165, 0.278, 0.202, 0.08, 0.12),
  ];
}

/** One webbed foot: a splayed web with three toes laid over it. */
function web(x: number, z: number, mat: Mat): Mesh[] {
  return [
    profile(
      [
        [-0.025, -0.022],
        [0.078, -0.046],
        [0.086, 0.0],
        [0.078, 0.046],
        [-0.025, 0.022],
      ],
      0.01,
      mat,
      { at: [x, 0.005, z], rot: [Math.PI / 2, 0, 0], bevel: 0.002, radius: 0.006, name: 'web' },
    ),
    ...[0.04, 0, -0.04].map((dz) =>
      strut([x - 0.012, 0.011, z], [x + 0.072, 0.012, z + dz], 0.009, 0.005, mat, 'toe'),
    ),
  ];
}

/**
 * Standing goose: the flock-crossing hazard near parks, ponds and campuses,
 * and the only biped in the set. A bulky body carried high on two short scaled
 * legs, the S-curve of the neck, a folded wing over each flank, a layered tail
 * cocked off the rump and the dark head with the pale chin strap that says
 * which goose this is.
 */
export function buildGoose(params: AnimalParams = { color: '#d8d8cf' }): Group {
  const group = new Group();
  const feather = material('fur', params.color);
  const dark = material('skin', GOOSE_DARK);
  const strap = material('fur', GOOSE_PALE);
  const seam = material('fur', '#b4b1a8');
  const scaled = material('rim');

  group.add(...loft(GOOSE_RIBS, feather));
  group.add(sphere(0.075, strap, { at: [0.14, 0.25, 0], scale: [0.9, 1.1, 0.75], name: 'breast' }));
  group.add(...wing(1, feather, seam), ...wing(-1, feather, seam));

  // Layered tail feathers cocked up off the rump. Broad and thick enough to be
  // feathers: thin them and the whole stack reads as a handful of spikes.
  const tail: readonly [number, number, number, number][] = [
    [-0.355, 0.343, 0.155, 1.01],
    [-0.345, 0.3, 0.15, 1.2],
    [-0.335, 0.257, 0.145, 1.38],
  ];
  for (const [x, y, length, sweep] of tail) {
    group.add(
      cone(0.052, length, feather, {
        at: [x, y, 0],
        rot: [0, 0, sweep],
        scale: [1, 1, 0.34],
        segments: 4,
        name: 'tail-feather',
      }),
    );
  }

  // The S-curve: up off the shoulder almost vertically, then forward.
  group.add(
    ...chain(
      [
        [0.09, 0.32, 0],
        [0.1, 0.45, 0],
        [0.118, 0.565, 0],
        [0.16, 0.66, 0],
        [0.215, 0.725, 0],
      ],
      [0.078, 0.062, 0.052, 0.048, 0.046],
      feather,
      'neck',
    ),
  );

  // Dark head, chin strap, flat spatulate bill.
  group.add(sphere(0.058, dark, { at: [0.248, 0.792, 0], scale: [1.15, 1, 0.85], name: 'head' }));
  group.add(
    ...mirrored(0.04, (dz) =>
      sphere(0.02, strap, { at: [0.232, 0.762, dz], scale: [0.8, 1.4, 0.5], segments: 8, name: 'chin-strap' }),
    ),
  );
  group.add(...eyes(0.272, 0.8, 0.043, 0.009, strap, material('fur', '#080d14')));
  group.add(
    profile(
      [
        [0.0, 0.015],
        [0.1, 0.011],
        [0.115, 0.0],
        [0.1, -0.013],
        [0.0, -0.017],
      ],
      0.046,
      dark,
      { at: [0.3, 0.762, 0], rot: [0, 0, -0.1], bevel: 0.006, radius: 0.004, name: 'bill' },
    ),
  );

  // Two legs, splayed a little, with the far one a step back.
  for (const dz of [0.062, -0.062]) {
    const step = dz > 0 ? 0.01 : -0.026;
    group.add(
      ...chain(
        [[0.012 + step, 0.125, dz], [-0.008 + step, 0.045, dz], [-0.006 + step, 0.02, dz]],
        [0.021, 0.017, 0.015],
        scaled,
        'tarsus',
      ),
    );
    group.add(...web(-0.008 + step, dz, scaled));
  }

  return group;
}
