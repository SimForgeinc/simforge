import { Group, type Mesh, type MeshStandardMaterial, type Object3D, Vector3 } from 'three';

import { box, cyl, type Point2, profile, sphere, type Vec3 } from '../geometry';
import { material, type MaterialKey } from '../materials';

/**
 * People.
 *
 * The seven catalog pedestrians and their 2D tiles are the same drawing at two
 * fidelities, so they are authored the same way: a right-facing figure whose
 * stance is a set of joint positions. That is the whole point of this file —
 * a walking adult, one standing at the kerb and one waiting with a phone are
 * three meshes, not one mesh under three ids.
 *
 * The tiles are a 96x48 side view with the ground at y = 41. An adult stands
 * ~30 icon units tall and a child ~20, so a tile coordinate transcribes as
 *
 *     metresX = (iconX - 48) / units * height
 *     metresY = (41 - iconY) / units * height
 *
 * which is why every number below is a fraction of stature: one pose serves
 * both builds, and adult and child differ by their proportions — an adult's
 * head is a seventh of its height, a child's a fifth — rather than by scale.
 *
 * Hard rules, all enforced by `__tests__/builders.test.ts`:
 *   - the built bounding box matches the catalog dims within 10%
 *   - the lowest point sits on y = 0 (feet on the road, nothing floats)
 *   - the box is centred on x = 0 and z = 0 within ~15%
 *
 * The feet carry the third of those: a shoe rolled onto its heel (heel strike)
 * or its toe (push-off) is rotated *about that contact point*, so a mid-stride
 * figure still touches the ground exactly.
 */

export interface PedestrianParams {
  /** Overall stature, metres. Adults ~1.75, children ~1.20. */
  height: number;
  /** `walking` puts the generic adult/child into its mid-stride pose. */
  pose: 'standing' | 'walking';
  shirtColor?: string;
  pantsColor?: string;
  skinColor?: string;
}

/* ------------------------------------------------------------ proportions */

/** Stature-relative anthropometry. Every length in the file derives from one. */
interface Proportions {
  /** Head radius. 0.068 puts the head at a seventh of height, 0.10 at a fifth. */
  head: number;
  /** Top of the torso slab. */
  neck: number;
  /** Shoulder joint — below the acromion, where the arm actually pivots. */
  shoulder: number;
  /** Widest point of the chest. */
  chest: number;
  hip: number;
  knee: number;
  torsoW: number;
  torsoD: number;
  armR: number;
  legR: number;
  footL: number;
  footW: number;
  footH: number;
  /** Half the distance between the legs. */
  legZ: number;
}

const ADULT: Proportions = {
  head: 0.068,
  neck: 0.815,
  shoulder: 0.785,
  chest: 0.7,
  hip: 0.52,
  knee: 0.285,
  torsoW: 0.185,
  torsoD: 0.135,
  armR: 0.03,
  legR: 0.043,
  footL: 0.15,
  footW: 0.056,
  footH: 0.038,
  legZ: 0.05,
};

/** A child is not a small adult: bigger head, shorter torso, lower shoulders. */
const CHILD: Proportions = {
  head: 0.1,
  neck: 0.755,
  shoulder: 0.725,
  chest: 0.64,
  hip: 0.475,
  knee: 0.3,
  torsoW: 0.185,
  torsoD: 0.115,
  armR: 0.032,
  legR: 0.047,
  footL: 0.155,
  footW: 0.058,
  footH: 0.042,
  legZ: 0.052,
};

/** Proportions resolved to metres for one figure. */
interface Frame {
  h: number;
  headR: number;
  headY: number;
  neckY: number;
  shoulderY: number;
  chestY: number;
  hipY: number;
  kneeY: number;
  ankleY: number;
  torsoW: number;
  torsoD: number;
  armR: number;
  armZ: number;
  legR: number;
  legZ: number;
  footL: number;
  footW: number;
  footH: number;
}

function frameOf(height: number, p: Proportions): Frame {
  const headR = height * p.head;
  return {
    h: height,
    headR,
    // The crown — the top of the hair, not of the skull — is the top of the
    // figure, so the stature a caller asks for is the stature it measures.
    headY: height - headR * 1.02,
    neckY: height * p.neck,
    shoulderY: height * p.shoulder,
    chestY: height * p.chest,
    hipY: height * p.hip,
    kneeY: height * p.knee,
    ankleY: height * (p.footH + p.legR * 0.35),
    torsoW: height * p.torsoW,
    torsoD: height * p.torsoD,
    armR: height * p.armR,
    armZ: height * (p.torsoW / 2 + p.armR * 0.75),
    legR: height * p.legR,
    legZ: height * p.legZ,
    footL: height * p.footL,
    footW: height * p.footW,
    footH: height * p.footH,
  };
}

/* -------------------------------------------------------------------- pose */

/** A leg as the tile draws it: hip to knee to ankle, forward of the hip. */
interface LegPose {
  /** Knee offset, fraction of stature. */
  knee: number;
  /** Ankle offset, fraction of stature. */
  ankle: number;
  /** Knee height, when a stride lifts it off the neutral line. */
  kneeY?: number;
  /** Shoe roll: > 0 lands on the heel (toe up), < 0 pushes off the toe. */
  pitch?: number;
  /** Multiplier on the default leg separation — feet together, or planted wide. */
  spread?: number;
}

/** An arm: shoulder to elbow to hand, `[forward, height]` fractions of stature. */
interface ArmPose {
  elbow: Point2;
  hand: Point2;
  /** Elbow distance from the centreline, as a multiple of the shoulder offset. */
  elbowZ?: number;
  /** Same for the hand: < 1 folds the forearm across the chest, > 1 splays it. */
  handZ?: number;
}

interface Pose {
  /** Near side (+Z, the side facing the viewer in the tile), then far side. */
  legs: readonly [LegPose, LegPose];
  arms: readonly [ArmPose, ArmPose];
  /** Forward pitch of everything above the hips, radians. */
  lean?: number;
  /** Head pitch; > 0 looks down at what the figure is holding. */
  look?: number;
}

/** What the figure is wearing. Clothing colour is the caller's; kit is not. */
interface Wardrobe {
  shirt: MeshStandardMaterial;
  pants: MeshStandardMaterial;
  flesh: MeshStandardMaterial;
  hair: MeshStandardMaterial;
  shoe: 'shoe' | 'sneaker' | 'boot';
  /** Short sleeves and shorts: forearms and shins are bare, as a child's are. */
  bare?: boolean;
}

/* ------------------------------------------------------------------- parts */

const UP = new Vector3(0, 1, 0);

/**
 * Tapered bone between two joints. Oriented in 3D rather than in the side view
 * so an arm can also splay outward — a marshal signalling, a phone held across
 * the chest — instead of staying trapped in the tile's plane.
 */
function bone(
  from: Vec3,
  to: Vec3,
  r: number,
  rTop: number,
  mat: MeshStandardMaterial,
  segments = 10,
): Mesh {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const len = Math.max(Math.hypot(dx, dy, dz), 1e-4);
  const mesh = cyl(r, len, mat, { rTop, segments });
  mesh.quaternion.setFromUnitVectors(UP, new Vector3(dx / len, dy / len, dz / len));
  mesh.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2);
  return mesh;
}

/**
 * One shoe, as a group so it can roll. `pitch` rotates it about whichever end
 * is still on the road — the heel for a heel strike, the toe for a push-off —
 * which is what keeps a striding figure's lowest point exactly on y = 0.
 */
function shoe(f: Frame, ankleX: number, z: number, pitch: number, style: Wardrobe['shoe']): Group {
  const group = new Group();
  const heel = -f.footL * 0.3;
  const toe = f.footL * 0.7;
  const pivot = pitch > 0 ? heel : toe;
  group.position.set(ankleX + pivot, 0, z);
  group.rotation.z = pitch;

  const rubber = material('plastic');
  const cx = (heel + toe) / 2 - pivot;
  const h = f.footH;
  group.add(box([f.footL, h * 0.55, f.footW * 0.94], rubber, { at: [cx, h * 0.275, 0] }));
  group.add(
    box([f.footL * 0.6, h * 0.86, f.footW * 0.84], rubber, {
      at: [cx - f.footL * 0.16, h * 0.66, 0],
    }),
  );
  if (style === 'sneaker') {
    const white = material('safetyWhite');
    group.add(box([f.footL, h * 0.3, f.footW * 0.98], white, { at: [cx, h * 0.15, 0] }));
    group.add(
      box([f.footL * 0.3, h * 0.36, f.footW * 0.9], white, {
        at: [cx + f.footL * 0.33, h * 0.46, 0],
      }),
    );
  }
  if (style === 'boot') {
    group.add(
      box([f.footL * 0.52, h * 3.2, f.footW * 0.94], rubber, {
        at: [cx - f.footL * 0.18, h * 2.2, 0],
      }),
    );
    group.add(
      box([f.footL * 0.56, h * 0.28, f.footW * 0.98], material('steel'), {
        at: [cx - f.footL * 0.16, h * 3.7, 0],
      }),
    );
  }
  return group;
}

/**
 * Head, in its own group so `look` can pitch it on the neck without dragging
 * the shoulders round with it. A nose and two ears cost three meshes and are
 * the only thing that tells you which way a sphere is facing.
 */
function head(f: Frame, w: Wardrobe, look: number): Group {
  const group = new Group();
  const pivotY = f.headY - f.headR * 0.85;
  group.position.set(0, pivotY, 0);
  group.rotation.z = -look;
  const y = f.headR * 0.85;
  const r = f.headR;

  // A child's head is a fifth of its height, so the skull is most of the
  // catalogued front-to-back depth: the hair is a cap that clears the skull by
  // millimetres — set back off the forehead, and just tall enough to be the
  // crown, which `frameOf` has already reserved the stature for.
  group.add(sphere(r, w.flesh, { at: [0, y, 0], scale: [0.92, 1, 0.9], segments: 16 }));
  group.add(
    sphere(r * 1.02, w.hair, {
      at: [-r * 0.1, y + r * 0.24, 0],
      scale: [0.93, 0.765, 0.93],
      segments: 14,
    }),
  );
  group.add(box([r * 0.44, r * 0.3, r * 0.28], w.flesh, { at: [r * 0.76, y - r * 0.1, 0] }));
  for (const side of [1, -1] as const) {
    group.add(
      sphere(r * 0.3, w.flesh, {
        at: [-r * 0.14, y, side * r * 0.8],
        scale: [0.5, 1, 0.55],
        segments: 8,
      }),
    );
  }
  return group;
}

/** Torso, hips and the cloth details that stop a person reading as two slabs. */
function trunk(f: Frame, w: Wardrobe): Object3D[] {
  const front = f.torsoD * 0.5;
  const back = -f.torsoD * 0.5;
  const parts: Object3D[] = [
    profile(
      [
        [back * 0.84, f.hipY - f.h * 0.01],
        [back, f.chestY],
        [back * 0.9, f.neckY],
        [front * 0.86, f.neckY],
        [front, f.chestY],
        [front * 0.9, f.hipY - f.h * 0.01],
      ],
      f.torsoW,
      w.shirt,
      { radius: f.torsoD * 0.34, bevel: f.torsoD * 0.26 },
    ),
    // Shoulder yoke: one cylinder is the difference between shoulders and a box.
    cyl(f.torsoD * 0.44, f.torsoW, w.shirt, {
      axis: 'z',
      at: [0, f.neckY - f.torsoD * 0.34, 0],
      segments: 14,
    }),
    cyl(f.torsoD * 0.33, f.h * 0.022, w.shirt, {
      at: [0, f.neckY + f.h * 0.004, 0],
      segments: 14,
    }),
    // Front closure: a thin dark inset, the cloth equivalent of a door seam.
    box([f.h * 0.004, (f.neckY - f.hipY) * 0.62, f.h * 0.008], material('plastic'), {
      at: [front, (f.neckY + f.hipY) * 0.5 - f.h * 0.02, 0],
    }),
  ];

  const hipTop = f.hipY + f.h * 0.015;
  const hipBottom = f.hipY - f.h * (w.bare ? 0.155 : 0.09);
  // Hips sit *inside* the line of the jacket. Authored the other way round they
  // read as a shelf at the waist, which is how a person turns into two slabs.
  parts.push(
    profile(
      [
        [back * 0.78, hipBottom],
        [back * 0.84, hipTop],
        [front * 0.86, hipTop],
        [front * 0.8, hipBottom],
      ],
      f.torsoW * (w.bare ? 0.9 : 0.86),
      w.pants,
      { radius: f.torsoD * 0.34, bevel: f.torsoD * 0.26 },
    ),
  );
  if (w.bare) {
    // Shorts hem, level with the bottom of the leg openings.
    parts.push(
      box([f.torsoD * 0.84, f.h * 0.009, f.torsoW * 0.88], w.pants, {
        at: [0, hipBottom + f.h * 0.006, 0],
      }),
    );
  } else {
    parts.push(
      box([f.torsoD * 0.92, f.h * 0.013, f.torsoW * 0.82], material('plastic'), {
        at: [0, f.hipY - f.h * 0.004, 0],
      }),
    );
  }
  return parts;
}

/** One arm chain: shoulder cap, upper arm, elbow, forearm, hand. */
function arm(f: Frame, w: Wardrobe, a: ArmPose, side: 1 | -1): Object3D[] {
  const shoulder: Vec3 = [0, f.shoulderY, side * f.armZ];
  const elbow: Vec3 = [a.elbow[0] * f.h, a.elbow[1] * f.h, side * f.armZ * (a.elbowZ ?? 1)];
  const hand: Vec3 = [a.hand[0] * f.h, a.hand[1] * f.h, side * f.armZ * (a.handZ ?? 1)];
  const sleeved = w.bare ? w.flesh : w.shirt;
  const parts: Object3D[] = [
    sphere(f.armR * 1.08, w.shirt, { at: shoulder, segments: 10 }),
    bone(shoulder, elbow, f.armR, f.armR * 0.86, sleeved),
    sphere(f.armR * 0.86, sleeved, { at: elbow, segments: 8 }),
    bone(elbow, hand, f.armR * 0.84, f.armR * 0.68, w.bare ? w.flesh : w.shirt),
  ];
  if (w.bare) {
    // Cap sleeve over the top of a bare arm.
    parts.push(
      bone(
        shoulder,
        [
          shoulder[0] + (elbow[0] - shoulder[0]) * 0.42,
          shoulder[1] + (elbow[1] - shoulder[1]) * 0.42,
          shoulder[2] + (elbow[2] - shoulder[2]) * 0.42,
        ],
        f.armR * 1.12,
        f.armR * 1.02,
        w.shirt,
      ),
    );
  }
  // The pose's hand point is the fingertip end of the limb: the block hangs
  // back off it, so an outstretched arm cannot reach past its own paddle.
  const gripLength = f.armR * 2.2;
  const grip = box([f.armR * 1.5, gripLength, f.armR * 1.8], w.flesh);
  const reach = new Vector3(hand[0] - elbow[0], hand[1] - elbow[1], hand[2] - elbow[2]).normalize();
  grip.quaternion.setFromUnitVectors(UP, reach);
  grip.position
    .set(hand[0], hand[1], hand[2])
    .addScaledVector(reach, -gripLength * 0.5);
  parts.push(grip);
  return parts;
}

/** One leg chain plus its shoe. */
function leg(f: Frame, w: Wardrobe, l: LegPose, side: 1 | -1): Object3D[] {
  const z = side * f.legZ * (l.spread ?? 1);
  const hip: Vec3 = [0, f.hipY, z];
  const knee: Vec3 = [l.knee * f.h, l.kneeY === undefined ? f.kneeY : l.kneeY * f.h, z];
  const ankle: Vec3 = [l.ankle * f.h, f.ankleY, z];
  const lower = w.bare ? w.flesh : w.pants;
  return [
    bone(hip, knee, f.legR, f.legR * 0.82, w.pants),
    sphere(f.legR * 0.82, lower, { at: knee, segments: 10 }),
    bone(knee, ankle, f.legR * 0.8, f.legR * 0.56, lower),
    shoe(f, ankle[0], z, l.pitch ?? 0, w.shoe),
  ];
}

/**
 * Assemble a figure. Everything above the hips goes into one group so `lean`
 * pitches the shoulders ahead of the pelvis; the legs stay planted on the road.
 */
function figure(f: Frame, pose: Pose, w: Wardrobe): Group {
  const group = new Group();
  const upper = new Group();
  for (const part of trunk(f, w)) upper.add(part);
  upper.add(
    bone(
      [0, f.neckY - f.h * 0.01, 0],
      [0, f.headY - f.headR * 0.7, 0],
      f.headR * 0.46,
      f.headR * 0.4,
      w.flesh,
    ),
  );
  upper.add(head(f, w, pose.look ?? 0));
  for (const part of arm(f, w, pose.arms[0], 1)) upper.add(part);
  for (const part of arm(f, w, pose.arms[1], -1)) upper.add(part);
  // The hip is the pivot: drop the assembled upper body onto it, then lean.
  for (const child of upper.children) child.position.y -= f.hipY;
  upper.position.y = f.hipY;
  upper.rotation.z = -(pose.lean ?? 0);
  group.add(upper);

  for (const part of leg(f, w, pose.legs[0], 1)) group.add(part);
  for (const part of leg(f, w, pose.legs[1], -1)) group.add(part);
  return group;
}

/* --------------------------------------------------------------------- kit */

/** Hi-vis waistcoat with two reflective wraps: the flagger and marshal layer. */
function vestOver(f: Frame): Object3D[] {
  const hivis = material('vest');
  const tape = material('safetyWhite');
  const front = f.torsoD * 0.5 + 0.014;
  const bottom = f.hipY + f.h * 0.03;
  const parts: Object3D[] = [
    profile(
      [
        [-front, bottom],
        [-front, f.neckY - f.h * 0.012],
        [front, f.neckY - f.h * 0.012],
        [front, bottom],
      ],
      f.torsoW + 0.036,
      hivis,
      { radius: f.torsoD * 0.28, bevel: f.torsoD * 0.22 },
    ),
  ];
  for (const t of [0.34, 0.68] as const) {
    parts.push(
      box([f.torsoD + 0.036, f.h * 0.02, f.torsoW + 0.05], tape, {
        at: [0, bottom + (f.neckY - bottom) * t, 0],
      }),
    );
  }
  for (const side of [1, -1] as const) {
    parts.push(
      box([f.h * 0.005, (f.neckY - bottom) * 0.92, f.h * 0.018], tape, {
        at: [front + 0.004, (bottom + f.neckY) * 0.5, side * f.torsoW * 0.28],
      }),
    );
  }
  return parts;
}

/** Shoulder bag: strap over the near shoulder, body swinging at the far hip. */
function shoulderBag(f: Frame): Object3D[] {
  const leather = material('fabric', '#8a6a4d');
  const bodyY = f.hipY + f.h * 0.055;
  // Outside the torso, not inside it: a bag hangs off the hip it swings against.
  const bagZ = -(f.torsoW * 0.5 + 0.048);
  const strapTop: Vec3 = [0, f.neckY - f.h * 0.02, f.armZ * 0.62];
  const strapEnd: Vec3 = [-f.torsoD * 0.16, bodyY + f.h * 0.05, bagZ];
  return [
    bone(strapTop, [f.torsoD * 0.42, f.chestY, f.armZ * 0.1], 0.008, 0.008, leather, 6),
    bone([f.torsoD * 0.42, f.chestY, f.armZ * 0.1], strapEnd, 0.008, 0.008, leather, 6),
    bone([0, f.neckY - f.h * 0.02, -f.armZ * 0.1], strapEnd, 0.008, 0.008, leather, 6),
    box([0.108, 0.155, 0.085], leather, { at: [-0.07, bodyY, bagZ] }),
    box([0.112, 0.048, 0.088], leather, { at: [-0.068, bodyY + 0.072, bagZ] }),
    box([0.014, 0.02, 0.022], material('chrome'), { at: [-0.126, bodyY + 0.03, bagZ] }),
  ];
}

/** A child's school pack, worn behind the shoulders. */
function backpack(f: Frame, tilt: number): Object3D[] {
  const cloth = material('fabric', '#c9553f');
  const shade = material('fabric', '#7d2f22');
  const depth = f.h * 0.046;
  const x = -f.torsoD * 0.5 - depth * 0.5;
  const top = f.neckY - f.h * 0.055;
  const height = f.h * 0.2;
  const mid = top - height * 0.5;
  const group = new Group();
  group.position.set(0, mid, 0);
  group.rotation.z = tilt;
  group.add(box([depth, height, f.torsoW * 0.86], cloth, { at: [x, 0, 0] }));
  group.add(box([depth * 1.06, f.h * 0.014, f.torsoW * 0.88], shade, { at: [x, height * 0.1, 0] }));
  // Side pocket, on the flank: behind the pack there is no room left in the
  // catalogued depth once a child's head has taken most of it.
  for (const side of [1, -1] as const) {
    group.add(
      box([depth * 0.82, f.h * 0.05, f.torsoW * 0.1], cloth, {
        at: [x, -height * 0.2, side * f.torsoW * 0.44],
      }),
    );
  }
  group.add(
    cyl(f.h * 0.014, f.torsoW * 0.24, shade, {
      axis: 'z',
      at: [x, height * 0.52, 0],
      segments: 8,
    }),
  );
  for (const side of [1, -1] as const) {
    group.add(
      bone(
        [x + depth * 0.4, height * 0.42, side * f.torsoW * 0.3],
        [f.torsoD * 0.42, -height * 0.5, side * f.torsoW * 0.32],
        f.h * 0.011,
        f.h * 0.011,
        cloth,
        6,
      ),
    );
  }
  return [group];
}

/** Phone held in the hand named by `at`, screen up toward a tilted face. */
function phone(at: Vec3): Object3D[] {
  const body = box([0.011, 0.079, 0.041], material('plastic'), {
    at: [at[0] + 0.026, at[1] + 0.022, at[2]],
    rot: [0, 0, -0.22],
  });
  const screen = box([0.004, 0.066, 0.033], material('glass', '#8fd0ff'), {
    at: [at[0] + 0.033, at[1] + 0.024, at[2]],
    rot: [0, 0, -0.22],
  });
  return [body, screen];
}

/** Hard hat: shell, brim and the crown rib every real one has. */
function hardHat(f: Frame): Object3D[] {
  const shell = material('vest');
  return [
    sphere(f.headR * 1.17, shell, {
      at: [0, f.headY + f.headR * 0.435, 0],
      scale: [1, 0.9, 1],
      segments: 16,
    }),
    cyl(f.headR * 1.25, f.h * 0.011, shell, {
      at: [f.headR * 0.06, f.headY + f.headR * 0.03, 0],
      segments: 18,
    }),
    box([f.headR * 1.9, f.headR * 0.16, f.headR * 0.22], shell, {
      at: [0, f.headY + f.headR * 0.9, 0],
    }),
  ];
}

/** Octagonal outline, the shape of every stop paddle on a US road. */
function octagon(r: number): Point2[] {
  return Array.from({ length: 8 }, (_, i) => {
    const a = (i + 0.5) * (Math.PI / 4);
    return [Math.cos(a) * r, Math.sin(a) * r] as Point2;
  });
}

/** Stop paddle on a short staff, face turned to the traffic the figure faces. */
function stopPaddle(hand: Vec3, r: number): Object3D[] {
  const faceY = hand[1] + r * 0.62 + 0.1;
  const plate: Vec3 = [hand[0] + 0.021, faceY, hand[2]];
  return [
    bone(
      [hand[0] + 0.012, hand[1] - 0.03, hand[2]],
      [plate[0], faceY - r * 0.7, plate[2]],
      0.013,
      0.013,
      material('chrome'),
      8,
    ),
    profile(octagon(r), 0.018, material('taillight'), {
      radius: r * 0.06,
      bevel: 0.004,
      rot: [0, Math.PI / 2, 0],
      at: plate,
    }),
    profile(octagon(r * 0.86), 0.005, material('safetyWhite'), {
      radius: r * 0.05,
      rot: [0, Math.PI / 2, 0],
      at: [plate[0] + 0.011, faceY, plate[2]],
    }),
    profile(octagon(r * 0.72), 0.005, material('taillight'), {
      radius: r * 0.05,
      rot: [0, Math.PI / 2, 0],
      at: [plate[0] + 0.014, faceY, plate[2]],
    }),
  ];
}

/* ------------------------------------------------------------------- poses */

/** Weight on the near leg, arms hanging: the neutral kerbside stand. */
const ADULT_NEUTRAL: Pose = {
  legs: [
    { knee: 0.006, ankle: 0.01 },
    { knee: -0.014, ankle: -0.026 },
  ],
  arms: [
    { elbow: [0.014, 0.615], hand: [0.03, 0.487] },
    { elbow: [-0.012, 0.613], hand: [-0.026, 0.485] },
  ],
};

/** Mid-stride: scissored legs, contralateral arm swing, shoulders leading. */
const ADULT_WALK: Pose = {
  lean: 0.07,
  legs: [
    { knee: -0.06, ankle: -0.175, kneeY: 0.298, pitch: -0.4 },
    { knee: 0.09, ankle: 0.175, kneeY: 0.312, pitch: 0.3 },
  ],
  arms: [
    { elbow: [0.08, 0.628], hand: [0.145, 0.52] },
    { elbow: [-0.08, 0.61], hand: [-0.135, 0.5] },
  ],
};

/** Waiting at the kerb: feet together, phone up, head down over the screen. */
const ADULT_WAIT: Pose = {
  look: 0.18,
  legs: [
    { knee: 0.004, ankle: 0.006, spread: 0.86 },
    { knee: -0.004, ankle: -0.006, spread: 0.86 },
  ],
  arms: [
    // Forearm folded up and across the chest, so the phone is clear of it.
    { elbow: [0.055, 0.6], hand: [0.088, 0.712], handZ: 0.48 },
    { elbow: [-0.012, 0.612], hand: [-0.026, 0.484] },
  ],
};

/** Child neutral: same idea, shorter reach. */
const CHILD_NEUTRAL: Pose = {
  legs: [
    { knee: -0.008, ankle: -0.012 },
    { knee: -0.022, ankle: -0.03 },
  ],
  arms: [
    { elbow: [0.012, 0.575], hand: [0.026, 0.44] },
    { elbow: [-0.01, 0.573], hand: [-0.024, 0.438] },
  ],
};

/** Child mid-stride: shorter stride, arms swinging clear of the pack. */
const CHILD_WALK: Pose = {
  lean: 0.06,
  legs: [
    { knee: -0.055, ankle: -0.17, kneeY: 0.312, pitch: -0.36 },
    { knee: 0.085, ankle: 0.17, kneeY: 0.322, pitch: 0.26 },
  ],
  arms: [
    { elbow: [0.075, 0.585], hand: [0.135, 0.5] },
    { elbow: [-0.072, 0.568], hand: [-0.12, 0.452] },
  ],
};

/** Child waiting: feet together, near hand up where an adult's would be. */
const CHILD_REACH: Pose = {
  look: -0.07,
  legs: [
    { knee: -0.016, ankle: -0.02, spread: 0.84 },
    { knee: -0.026, ankle: -0.032, spread: 0.84 },
  ],
  arms: [
    // Above the crown, not beside the ear: a raised hand has to clear the head
    // from every angle the editor can orbit to.
    { elbow: [0.05, 0.86], hand: [0.07, 1.015], elbowZ: 1.05, handZ: 1.1 },
    { elbow: [-0.01, 0.573], hand: [-0.024, 0.438] },
  ],
};

/** Marshal: planted wide, paddle out into the lane, other palm up and out. */
const MARSHAL_DIRECT: Pose = {
  legs: [
    { knee: 0.04, ankle: 0.058, spread: 1.25 },
    { knee: -0.038, ankle: -0.056, spread: 1.25 },
  ],
  arms: [
    { elbow: [0.155, 0.748], hand: [0.3, 0.752], elbowZ: 1.05, handZ: 1.05 },
    { elbow: [-0.052, 0.688], hand: [-0.016, 0.902], elbowZ: 1.4, handZ: 1.45 },
  ],
};

/* ---------------------------------------------------------------- builders */

function adultWardrobe(params: PedestrianParams): Wardrobe {
  return {
    shirt: material('shirt', params.shirtColor),
    pants: material('pants', params.pantsColor),
    flesh: material('skin', params.skinColor),
    hair: material('hair'),
    shoe: 'shoe',
  };
}

function childWardrobe(params: PedestrianParams): Wardrobe {
  return {
    shirt: material('shirt', params.shirtColor ?? '#c9762a'),
    pants: material('pants', params.pantsColor ?? '#39404a'),
    flesh: material('skin', params.skinColor),
    hair: material('hair', '#6f4a2a'),
    shoe: 'sneaker',
    bare: true,
  };
}

/**
 * Adult pedestrian. `pose: 'walking'` gives the striding figure, so the modern
 * id can be driven from the timeline instead of swapped for another prop.
 */
export function buildAdultPedestrian(
  params: PedestrianParams = { height: 1.75, pose: 'standing' },
): Group {
  if (params.pose === 'walking') return buildAdultWalking(params);
  return figure(frameOf(params.height, ADULT), ADULT_NEUTRAL, adultWardrobe(params));
}

/** Adult waiting at the kerb: feet together, phone at chest height, bag on the hip. */
export function buildAdultStanding(
  params: PedestrianParams = { height: 1.75, pose: 'standing' },
): Group {
  const f = frameOf(params.height, ADULT);
  const group = figure(f, ADULT_WAIT, adultWardrobe(params));
  // The phone rides in whichever hand the pose put it in — anchor off the pose,
  // never off a duplicated constant.
  const near = ADULT_WAIT.arms[0];
  const hand: Vec3 = [near.hand[0] * f.h, near.hand[1] * f.h, f.armZ * (near.handZ ?? 1)];
  for (const part of phone(hand)) group.add(part);
  for (const part of shoulderBag(f)) group.add(part);
  return group;
}

/** Adult mid-stride. */
export function buildAdultWalking(
  params: PedestrianParams = { height: 1.75, pose: 'walking' },
): Group {
  return figure(frameOf(params.height, ADULT), ADULT_WALK, adultWardrobe(params));
}

/** Child pedestrian. `pose: 'walking'` strides, like the adult. */
export function buildChildPedestrian(
  params: PedestrianParams = { height: 1.2, pose: 'standing' },
): Group {
  if (params.pose === 'walking') return buildChildWalking(params);
  const f = frameOf(params.height, CHILD);
  const group = figure(f, CHILD_NEUTRAL, childWardrobe(params));
  for (const part of backpack(f, 0)) group.add(part);
  return group;
}

/** Child standing with a hand up at adult-hand height. */
export function buildChildStanding(
  params: PedestrianParams = { height: 1.2, pose: 'standing' },
): Group {
  const f = frameOf(params.height, CHILD);
  const group = figure(f, CHILD_REACH, childWardrobe(params));
  for (const part of backpack(f, 0)) group.add(part);
  return group;
}

/** Child mid-stride, pack bouncing off the shoulders. */
export function buildChildWalking(
  params: PedestrianParams = { height: 1.2, pose: 'walking' },
): Group {
  const f = frameOf(params.height, CHILD);
  const group = figure(f, CHILD_WALK, childWardrobe(params));
  for (const part of backpack(f, -0.16)) group.add(part);
  return group;
}

/**
 * Traffic marshal: hi-vis vest and bands, hard hat, stop paddle held out into
 * the lane and the free palm up. The raised paddle throws the visual envelope
 * forward, so the assembly is nudged back onto the placement point.
 */
export function buildTrafficMarshal(
  params: PedestrianParams = { height: 1.82, pose: 'standing' },
): Group {
  const f = frameOf(params.height, ADULT);
  const wardrobe: Wardrobe = {
    shirt: material('shirt', '#27384d'),
    pants: material('pants', '#2c333d'),
    flesh: material('skin', params.skinColor),
    hair: material('hair'),
    shoe: 'boot',
  };
  const group = figure(f, MARSHAL_DIRECT, wardrobe);
  for (const part of vestOver(f)) group.add(part);
  for (const part of hardHat(f)) group.add(part);

  const paddleArm = MARSHAL_DIRECT.arms[0];
  const signalArm = MARSHAL_DIRECT.arms[1];
  const paddleHand: Vec3 = [
    paddleArm.hand[0] * f.h,
    paddleArm.hand[1] * f.h,
    f.armZ * (paddleArm.handZ ?? 1),
  ];
  for (const part of stopPaddle(paddleHand, f.h * 0.088)) group.add(part);
  // Open palm turned to the traffic: the other half of the stop signal.
  group.add(
    box([0.022, f.h * 0.062, f.h * 0.05], wardrobe.flesh, {
      at: [
        signalArm.hand[0] * f.h + 0.014,
        signalArm.hand[1] * f.h + f.h * 0.026,
        -f.armZ * (signalArm.handZ ?? 1),
      ],
    }),
  );
  group.position.x = -f.h * 0.05;
  return group;
}

/* ------------------------------------------------------- shared humanoid */

export interface HumanoidOptions {
  height: number;
  pose: 'standing' | 'walking';
  /** Head radius as a fraction of height; children are top-heavy. */
  headRatio?: number;
  shirt?: { key: MaterialKey; color?: string };
  pants?: { key: MaterialKey; color?: string };
  skinColor?: string;
  /** Extra torso layer (hi-vis vest) drawn over the shirt. */
  vest?: boolean;
  /** Right-arm (−Z side) shoulder pitch in radians, for holding things. */
  rightArmPitch?: number;
}

/** Arm chain length the raised-arm anchor is measured against. */
const HELD_ARM = 0.31;

/**
 * The generic figure behind the work-zone flagger.
 *
 * A planted, symmetric stance with an optional raised arm. `rightArmPitch`
 * swings that arm out to a documented anchor — the hand lands at
 * `sin(pitch) · 0.3255 · h` forward, `0.75 · h` up, `−0.116 · h` across — so a
 * caller can hang a paddle off it without knowing anything else about the rig.
 */
export function buildHumanoid(opts: HumanoidOptions): Group {
  const proportions: Proportions = { ...ADULT, head: opts.headRatio ?? ADULT.head };
  const f = frameOf(opts.height, proportions);
  const wardrobe: Wardrobe = {
    shirt: material(opts.shirt?.key ?? 'shirt', opts.shirt?.color),
    pants: material(opts.pants?.key ?? 'pants', opts.pants?.color),
    flesh: material('skin', opts.skinColor),
    hair: material('hair'),
    shoe: 'shoe',
  };

  const walking = opts.pose === 'walking';
  const base = walking ? ADULT_WALK : ADULT_NEUTRAL;
  let arms = base.arms;
  if (opts.rightArmPitch !== undefined) {
    const pitch = opts.rightArmPitch;
    const elbow: Point2 = [
      Math.sin(pitch) * HELD_ARM * 0.55,
      0.803 - Math.cos(pitch) * HELD_ARM * 0.55,
    ];
    arms = [base.arms[0], { elbow, hand: [elbow[0] + Math.sin(pitch) * HELD_ARM * 0.5, elbow[1]] }];
  }
  const group = figure(f, { ...base, arms }, wardrobe);
  if (opts.vest) for (const part of vestOver(f)) group.add(part);
  return group;
}
