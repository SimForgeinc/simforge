import { Group, type Mesh, type MeshStandardMaterial } from 'three';

import { box, cyl, type Point2, profile, sphere, torus, type Vec3 } from '../geometry';
import { material } from '../materials';

/**
 * Multirotors: delivery quadcopter, camera quadcopter, emergency responder.
 *
 * These are transcribed from the same 96x48 tiles as the road vehicles, but
 * two things about a multirotor change the arithmetic, so both are spelled out
 * here rather than rediscovered per builder:
 *
 *  1. The catalogued `l`/`w` are the *rotor span*, not the fuselage. The span
 *     is therefore built exactly — `armOffset + discRadius = span / 2` on both
 *     axes — and the fuselage is scaled off the tile separately, using the
 *     tile's own unit as read from its near-side prop discs (delivery 87 tile
 *     units across, camera 80.4, emergency 93). That is where the hull outlines
 *     below come from: `x = (iconX - hullCentre) * k`, `y = (iconBelly - iconY) * k`,
 *     authored with the belly at y = 0 so the hull can be dropped onto its
 *     mounting height with one `at`.
 *  2. The tiles draw these airborne and nose-down, with the skids stopping
 *     short of the shadow. The editor parks them, so the pose here is level and
 *     the landing gear is the only thing on y = 0: every slung payload — parcel,
 *     gimbal ball, horn mouth, flood pod — is placed to hang clear of it.
 *
 * A spinning prop reads as a disc, so that is what it is: a thin plate with a
 * tip ring, never blades. Rotor count and payload are what separate the three —
 * 4 rotors and a parcel bay, 4 folding arms and a gimbal, 6 rotors and the
 * responder kit.
 */

export interface DroneParams {
  color?: string;
}

/* ------------------------------------------------------------------ kit */

/** Straight boom between two points: arms and legs are mass, not strokes. */
function strut(
  a: Vec3,
  b: Vec3,
  w: number,
  h: number,
  mat: MeshStandardMaterial,
  name?: string,
): Mesh {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz) || 0.001;
  return box([len, h, w], mat, {
    at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    rot: [0, Math.atan2(-dz, dx), Math.asin(dy / len)],
    name,
  });
}

interface RotorSpec {
  /** Top face of the arm the motor bolts to. */
  at: Vec3;
  /** Disc radius. With the arm offset this is what sets the catalogued span. */
  disc: number;
  /** Arm-tip navigation light: red aft, white forward. */
  nav?: 'taillight' | 'headlight';
  name: string;
}

/**
 * One rotor: brushless can, bell, shaft, spinning disc and tip ring.
 *
 * The disc is translucent and the tip ring is not: that is the whole trick. A
 * solid plate the size of a prop hides the machine it is bolted to, whereas a
 * blur plate under a crisp tip circle reads as a turning rotor and still lets
 * the airframe through — the same call the tile art makes with a 10% fill and
 * a struck outline.
 *
 * The tip ring is also the outermost geometry, sized so its outer edge lands
 * exactly on `disc`: the span tolerance is 10% and the arms have spent it.
 */
function rotor(group: Group, spec: RotorSpec): void {
  const [x, y, z] = spec.at;
  const canR = spec.disc * 0.19;
  const canH = canR * 1.25;
  const metal = material('metal');
  const chrome = material('chrome');
  const dark = material('plastic');
  const t = Math.max(0.006, spec.disc * 0.03);
  const hubY = y + canH * 1.28;

  group.add(
    cyl(canR, canH, metal, { at: [x, y + canH / 2, z], segments: 14, name: `${spec.name}-can` }),
  );
  group.add(
    cyl(canR * 0.94, canH * 0.18, chrome, {
      at: [x, y + canH * 1.03, z],
      segments: 14,
      name: `${spec.name}-bell`,
    }),
  );
  group.add(
    cyl(canR * 0.3, canH * 0.42, chrome, {
      at: [x, y + canH * 1.16, z],
      segments: 8,
      name: `${spec.name}-shaft`,
    }),
  );
  group.add(
    cyl(spec.disc * 0.95, t * 0.6, material('chainlink', '#5b626c'), {
      at: [x, hubY, z],
      segments: 24,
      name: `${spec.name}-disc`,
    }),
  );
  group.add(
    torus(spec.disc * 0.975, spec.disc * 0.025, dark, {
      at: [x, hubY, z],
      rot: [Math.PI / 2, 0, 0],
      segments: 24,
      name: `${spec.name}-tip-ring`,
    }),
  );
  group.add(
    cyl(canR * 0.55, t * 1.8, metal, {
      at: [x, hubY + t, z],
      segments: 10,
      name: `${spec.name}-hub`,
    }),
  );
  if (spec.nav) {
    group.add(
      sphere(canR * 0.4, material(spec.nav), {
        at: [x, y + canH * 0.2, z],
        segments: 8,
        name: `${spec.name}-nav`,
      }),
    );
  }
}

interface GearSpec {
  /** |Z| of the skid tubes. */
  z: number;
  /** Fore-aft length of a skid tube. */
  length: number;
  tubeR: number;
  /** Leg feet, by X. Each is mirrored across Z. */
  feet: readonly number[];
  /** Belly height the legs are bolted to. */
  attachY: number;
  /** |Z| where the legs meet the belly — smaller than `z`, so the gear splays. */
  attachZ: number;
  /** Chrome wear strip along the top of each tube. */
  strip?: boolean;
}

/**
 * Skid landing gear. The tubes sit on y = 0 — on a parked multirotor this is
 * the whole of the ground contact, so nothing else may reach below them.
 */
function landingGear(group: Group, spec: GearSpec): void {
  const dark = material('plastic');
  const rim = material('rim');
  const chrome = material('chrome');
  const half = spec.length / 2;

  for (const sz of [1, -1] as const) {
    const z = sz * spec.z;
    group.add(
      cyl(spec.tubeR, spec.length, rim, {
        axis: 'x',
        at: [0, spec.tubeR, z],
        segments: 12,
        name: 'skid-tube',
      }),
    );
    for (const sx of [1, -1] as const) {
      group.add(
        sphere(spec.tubeR, rim, { at: [sx * half, spec.tubeR, z], segments: 8, name: 'skid-cap' }),
      );
    }
    if (spec.strip) {
      group.add(
        box([spec.length * 0.86, spec.tubeR * 0.32, spec.tubeR * 0.7], chrome, {
          at: [0, spec.tubeR * 1.75, z],
          name: 'skid-wear-strip',
        }),
      );
    }
    for (const x of spec.feet) {
      group.add(
        strut(
          [x * 0.68, spec.attachY, sz * spec.attachZ],
          [x, spec.tubeR * 1.6, z],
          spec.tubeR * 1.15,
          spec.tubeR * 1.15,
          dark,
          'landing-leg',
        ),
      );
    }
  }
}

/* ------------------------------------------------- delivery quadcopter */

/**
 * Deep parcel-bay fuselage: flat battery deck on top, open belly below, nose
 * sloped away under the avionics window. Tile `DELIVERY_BODY` at k = 0.0126.
 */
const DELIVERY_HULL: readonly Point2[] = [
  [-0.215, 0.103],
  [-0.172, 0.141],
  [0.089, 0.141],
  [0.137, 0.141],
  [0.2, 0.078],
  [0.215, 0.05],
  [0.196, 0.011],
  [0.104, 0.0],
  [-0.167, 0.003],
  [-0.215, 0.042],
];

/** Avionics window over the nose shoulder. */
const DELIVERY_CANOPY: readonly Point2[] = [
  [0.038, 0.123],
  [0.131, 0.097],
  [0.154, 0.062],
  [0.051, 0.062],
  [0.025, 0.1],
];

export function buildDeliveryDrone(params: DroneParams = {}): Group {
  const group = new Group();
  const paint = material('paint', params.color ?? '#444c57');
  const dark = material('plastic');
  const chrome = material('chrome');
  const metal = material('metal');
  const card = material('cardboard');

  const HULL_W = 0.2;
  const BELLY = 0.245;
  const DECK = BELLY + 0.141;
  const DISC = 0.235;
  const ARM = 0.315; // ARM + DISC = 0.55 = span / 2 on both axes.

  /* Fuselage: hull, deck panel, side window, seams and cooling louvres. */
  group.add(
    profile(DELIVERY_HULL, HULL_W, paint, {
      radius: 0.02,
      bevel: 0.014,
      at: [0, BELLY, 0],
      name: 'fuselage',
    }),
  );
  group.add(box([0.3, 0.007, 0.176], dark, { at: [-0.02, DECK, 0], name: 'deck-panel' }));
  group.add(
    profile(DELIVERY_CANOPY, HULL_W + 0.005, material('glass'), {
      radius: 0.012,
      bevel: 0.004,
      at: [0, BELLY, 0],
      name: 'avionics-window',
    }),
  );
  group.add(
    cyl(0.015, 0.024, dark, { axis: 'x', at: [0.216, 0.298, 0], segments: 10, name: 'nose-sensor' }),
  );
  group.add(
    cyl(0.011, 0.005, material('glass'), {
      axis: 'x',
      at: [0.229, 0.298, 0],
      segments: 10,
      name: 'nose-lens',
    }),
  );
  for (const sz of [1, -1] as const) {
    const z = sz * (HULL_W / 2 + 0.001);
    group.add(box([0.28, 0.004, 0.005], dark, { at: [-0.03, 0.3, z], name: 'hull-seam' }));
    group.add(box([0.005, 0.05, 0.005], dark, { at: [-0.06, 0.325, z], name: 'hatch-seam' }));
    for (let i = 0; i < 3; i++) {
      group.add(
        box([0.008, 0.028, 0.005], material('steel'), {
          at: [-0.145 + i * 0.017, 0.32, z],
          name: 'louvre',
        }),
      );
    }
  }

  /* Slide-in battery brick — the tallest thing on the airframe, as in the tile. */
  group.add(box([0.243, 0.061, 0.13], paint, { at: [-0.015, DECK + 0.0305, 0], name: 'battery' }));
  group.add(
    box([0.014, 0.05, 0.116], chrome, { at: [0.099, DECK + 0.03, 0], name: 'battery-latch' }),
  );
  for (let i = 0; i < 3; i++) {
    group.add(
      box([0.004, 0.055, 0.118], dark, {
        at: [-0.085 + i * 0.05, DECK + 0.031, 0],
        name: 'battery-seam',
      }),
    );
  }
  group.add(
    box([0.026, 0.012, 0.01], material('lamp'), {
      at: [0.085, DECK + 0.045, 0.062],
      name: 'battery-led',
    }),
  );
  group.add(
    cyl(0.028, 0.009, dark, { at: [-0.175, DECK + 0.008, 0], segments: 12, name: 'gps-puck' }),
  );
  group.add(
    cyl(0.011, 0.004, chrome, { at: [-0.175, DECK + 0.014, 0], segments: 8, name: 'gps-dome' }),
  );

  /* Four arms out to the corners, rising slightly to the motor mounts. */
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      const root: Vec3 = [sx * 0.14, 0.325, sz * 0.098];
      const tip: Vec3 = [sx * ARM, 0.345, sz * ARM];
      group.add(strut(root, tip, 0.026, 0.022, metal, 'rotor-arm'));
      group.add(
        box([0.055, 0.05, 0.05], paint, {
          at: [sx * 0.15, 0.325, sz * 0.095],
          name: 'arm-root-fairing',
        }),
      );
      rotor(group, {
        at: tip,
        disc: DISC,
        nav: sx > 0 ? 'headlight' : 'taillight',
        name: 'rotor',
      });
    }
  }

  /* Winch bay in the belly: side plates, drum, line and hook. */
  for (const sz of [1, -1] as const) {
    group.add(
      box([0.16, 0.055, 0.008], paint, { at: [0.005, 0.222, sz * 0.075], name: 'bay-wall' }),
    );
  }
  group.add(box([0.008, 0.055, 0.15], paint, { at: [-0.08, 0.222, 0], name: 'bay-bulkhead' }));
  group.add(
    cyl(0.026, 0.058, metal, { axis: 'z', at: [0.005, 0.222, 0], segments: 12, name: 'winch-drum' }),
  );
  group.add(
    cyl(0.012, 0.062, chrome, { axis: 'z', at: [0.005, 0.222, 0], segments: 8, name: 'winch-hub' }),
  );
  group.add(cyl(0.004, 0.09, chrome, { at: [0.005, 0.208, 0], segments: 6, name: 'winch-line' }));
  group.add(box([0.03, 0.008, 0.008], chrome, { at: [0.005, 0.168, 0], name: 'winch-hook' }));

  /* Slung parcel: cardboard is this drone's one identity colour. */
  group.add(box([0.22, 0.105, 0.2], card, { at: [0.005, 0.11, 0], name: 'parcel' }));
  group.add(
    box([0.222, 0.024, 0.202], material('cardboard', '#d8c39d'), {
      at: [0.005, 0.151, 0],
      name: 'parcel-lid',
    }),
  );
  group.add(
    box([0.226, 0.005, 0.05], material('fabric'), { at: [0.005, 0.163, 0], name: 'parcel-tape' }),
  );
  group.add(
    box([0.07, 0.003, 0.048], material('signWhite'), {
      at: [-0.05, 0.164, 0.055],
      name: 'parcel-label',
    }),
  );

  /* Sling cradle: a U under the parcel on each side, up into the bay. */
  for (const sz of [1, -1] as const) {
    const z = sz * 0.085;
    group.add(box([0.25, 0.012, 0.015], chrome, { at: [0.005, 0.047, z], name: 'cradle-base' }));
    for (const sx of [1, -1] as const) {
      group.add(
        box([0.013, 0.2, 0.015], chrome, { at: [0.005 + sx * 0.12, 0.148, z], name: 'cradle-strap' }),
      );
    }
  }

  landingGear(group, {
    z: 0.235,
    length: 0.42,
    tubeR: 0.019,
    feet: [0.185, -0.185],
    attachY: 0.25,
    attachZ: 0.1,
    strip: true,
  });

  return group;
}

/* --------------------------------------------------- camera quadcopter */

/** Slim wedge shell, a third the depth of the delivery pod. Tile `CAMERA_BODY`. */
const CAMERA_HULL: readonly Point2[] = [
  [-0.1125, 0.047],
  [-0.0937, 0.062],
  [0.0204, 0.062],
  [0.0818, 0.0505],
  [0.1014, 0.031],
  [0.1125, 0.0204],
  [0.0937, 0.0106],
  [0.0136, 0.0],
  [-0.0937, 0.002],
  [-0.1125, 0.0168],
];

/** Cabin glazing across the shoulder. */
const CAMERA_CANOPY: readonly Point2[] = [
  [-0.0835, 0.0514],
  [0.0051, 0.0514],
  [0.0511, 0.0425],
  [0.0665, 0.0292],
  [-0.0682, 0.0292],
];

export function buildCameraDrone(params: DroneParams = {}): Group {
  const group = new Group();
  const paint = material('paint', params.color ?? '#343a42');
  const dark = material('plastic');
  const chrome = material('chrome');
  const metal = material('metal');

  const HULL_W = 0.115;
  const BELLY = 0.152;
  const DECK = BELLY + 0.062;
  const DISC = 0.105;
  const ARM = 0.22; // ARM + DISC = 0.325 = span / 2.

  /* Slim fuselage. */
  group.add(
    profile(CAMERA_HULL, HULL_W, paint, {
      radius: 0.012,
      bevel: 0.008,
      at: [0, BELLY, 0],
      name: 'fuselage',
    }),
  );
  group.add(box([0.14, 0.005, 0.09], dark, { at: [-0.02, DECK, 0], name: 'deck-panel' }));
  group.add(
    profile(CAMERA_CANOPY, HULL_W + 0.004, material('glass'), {
      radius: 0.008,
      bevel: 0.003,
      at: [0, BELLY, 0],
      name: 'canopy',
    }),
  );
  for (const sz of [1, -1] as const) {
    const z = sz * (HULL_W / 2 + 0.001);
    group.add(box([0.15, 0.003, 0.004], dark, { at: [-0.01, 0.185, z], name: 'hull-seam' }));
  }
  group.add(box([0.004, 0.03, 0.09], dark, { at: [-0.008, 0.19, 0], name: 'shell-split' }));

  /* Forward obstacle-avoidance pair and the tail status LED. */
  group.add(
    box([0.016, 0.02, 0.036], material('glass'), { at: [0.114, 0.178, 0], name: 'sensor-block' }),
  );
  for (const sz of [1, -1] as const) {
    group.add(
      sphere(0.005, chrome, { at: [0.122, 0.178, sz * 0.011], segments: 6, name: 'sensor-eye' }),
    );
  }
  group.add(
    sphere(0.009, material('taillight', '#3f7fd6'), {
      at: [-0.108, 0.166, 0],
      segments: 8,
      name: 'status-led',
    }),
  );

  /* Folding arms: inner segment, hinge knuckle, swept outer segment. */
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      const root: Vec3 = [sx * 0.075, 0.185, sz * 0.052];
      const knuckle: Vec3 = [sx * 0.135, 0.19, sz * 0.085];
      const tip: Vec3 = [sx * ARM, 0.2, sz * ARM];
      group.add(strut(root, knuckle, 0.02, 0.016, paint, 'arm-inner'));
      group.add(
        cyl(0.015, 0.026, metal, { at: knuckle, segments: 10, name: 'arm-hinge' }),
      );
      group.add(strut(knuckle, tip, 0.016, 0.013, dark, 'arm-outer'));
      rotor(group, {
        at: tip,
        disc: DISC,
        nav: sx > 0 ? 'headlight' : 'taillight',
        name: 'rotor',
      });
    }
  }

  /* Whip antenna pair, swept back off the tail deck — the highest point. */
  for (const sz of [1, -1] as const) {
    const z = sz * 0.035;
    group.add(
      strut([-0.09, DECK, z], [-0.185, 0.305, z], 0.006, 0.006, chrome, 'antenna'),
    );
    group.add(sphere(0.007, dark, { at: [-0.185, 0.308, z], segments: 6, name: 'antenna-tip' }));
  }

  /* Gimbal: yoke legs and roll pivots, ball, wide lens. */
  for (const sx of [1, -1] as const) {
    const x = 0.11 + sx * 0.036;
    group.add(box([0.009, 0.078, 0.009], chrome, { at: [x, 0.115, 0], name: 'gimbal-yoke-leg' }));
    group.add(
      cyl(0.008, 0.012, chrome, { axis: 'x', at: [x, 0.078, 0], segments: 8, name: 'gimbal-pivot' }),
    );
  }
  group.add(box([0.082, 0.009, 0.024], chrome, { at: [0.11, 0.152, 0], name: 'gimbal-yoke-top' }));
  group.add(sphere(0.032, dark, { at: [0.11, 0.072, 0], segments: 14, name: 'gimbal-ball' }));
  group.add(
    cyl(0.019, 0.012, material('glass'), {
      axis: 'x',
      at: [0.138, 0.066, 0],
      segments: 14,
      name: 'gimbal-lens',
    }),
  );
  group.add(
    cyl(0.022, 0.005, chrome, {
      axis: 'x',
      at: [0.133, 0.066, 0],
      segments: 14,
      name: 'gimbal-lens-ring',
    }),
  );

  landingGear(group, {
    z: 0.088,
    length: 0.16,
    tubeR: 0.012,
    feet: [0.065, -0.065],
    attachY: 0.155,
    attachZ: 0.04,
  });

  return group;
}

/* --------------------------------------------------- emergency responder */

/** Heavy-lift hull: 0.66 long, 0.19 deep. Tile `EMERGENCY_BODY` at k = 0.0149. */
const EMERGENCY_HULL: readonly Point2[] = [
  [-0.33, 0.14],
  [-0.2585, 0.19],
  [0.1278, 0.19],
  [0.2051, 0.158],
  [0.3092, 0.107],
  [0.33, 0.076],
  [0.3003, 0.024],
  [0.1902, 0.002],
  [-0.2199, 0.0],
  [-0.33, 0.0665],
];

/** Cockpit glazing over the nose shoulder. */
const EMERGENCY_CANOPY: readonly Point2[] = [
  [0.1872, 0.1425],
  [0.2704, 0.1069],
  [0.2912, 0.0736],
  [0.1991, 0.0784],
  [0.1723, 0.1211],
];

export function buildEmergencyDrone(params: DroneParams = {}): Group {
  const group = new Group();
  const paint = material('paint', params.color ?? '#e9edf2');
  const dark = material('plastic');
  const chrome = material('chrome');
  const metal = material('metal');
  const hivis = material('signOrange');

  const HULL_W = 0.3;
  const BELLY = 0.215;
  const DECK = BELLY + 0.19;
  const DISC = 0.255; // corner rotors: 0.45 + 0.255 = 0.705 = length / 2
  const MID_DISC = 0.22; // mid rotors: 0.48 + 0.22 = 0.70 = width / 2

  /* Hull, deck, glazing. */
  group.add(
    profile(EMERGENCY_HULL, HULL_W, paint, {
      radius: 0.03,
      bevel: 0.018,
      at: [0, BELLY, 0],
      name: 'fuselage',
    }),
  );
  group.add(box([0.22, 0.008, 0.15], dark, { at: [-0.09, DECK, 0], name: 'avionics-hatch' }));
  for (const sx of [1, -1] as const) {
    group.add(
      box([0.06, 0.006, 0.26], hivis, { at: [sx * 0.155 - 0.06, DECK + 0.003, 0], name: 'deck-flash' }),
    );
  }
  group.add(box([0.4, 0.004, 0.005], dark, { at: [-0.05, DECK + 0.005, 0], name: 'deck-seam' }));
  group.add(box([0.2, 0.03, 0.24], paint, { at: [0.02, BELLY - 0.012, 0], name: 'payload-chin' }));
  group.add(
    profile(EMERGENCY_CANOPY, HULL_W + 0.006, material('glass'), {
      radius: 0.016,
      bevel: 0.006,
      at: [0, BELLY, 0],
      name: 'cockpit-glazing',
    }),
  );

  /* Hi-vis band with chevrons, held inside the hull sides. */
  for (const sz of [1, -1] as const) {
    const z = sz * (HULL_W / 2 + 0.001);
    group.add(box([0.52, 0.045, 0.006], hivis, { at: [-0.02, 0.3, z], name: 'hi-vis-band' }));
    for (const x of [-0.16, 0.06]) {
      group.add(
        box([0.03, 0.03, 0.005], dark, {
          at: [x, 0.3, sz * (HULL_W / 2 + 0.003)],
          rot: [0, 0, 0.6],
          name: 'chevron',
        }),
      );
    }
    group.add(box([0.44, 0.004, 0.005], dark, { at: [-0.03, 0.245, z], name: 'hull-seam' }));
    for (let i = 0; i < 2; i++) {
      group.add(
        box([0.01, 0.036, 0.005], material('steel'), {
          at: [-0.24 + i * 0.022, 0.355, z],
          name: 'louvre',
        }),
      );
    }
  }

  /* Deck: strobe domes, GPS puck. */
  group.add(cyl(0.05, 0.014, dark, { at: [-0.16, DECK + 0.005, 0], segments: 12, name: 'strobe-base' }));
  group.add(
    sphere(0.045, material('taillight', '#3f7fd6'), {
      at: [-0.16, DECK + 0.006, 0],
      segments: 12,
      name: 'strobe-blue',
    }),
  );
  group.add(cyl(0.05, 0.014, dark, { at: [0.14, DECK + 0.005, 0], segments: 12, name: 'strobe-base' }));
  group.add(
    sphere(0.045, material('taillight'), {
      at: [0.14, DECK + 0.006, 0],
      segments: 12,
      name: 'strobe-red',
    }),
  );
  group.add(cyl(0.038, 0.014, metal, { at: [-0.01, DECK + 0.007, 0], segments: 12, name: 'gps-puck' }));
  group.add(cyl(0.014, 0.006, chrome, { at: [-0.01, DECK + 0.016, 0], segments: 8, name: 'gps-dome' }));

  /* Four corner rotors on long booms. */
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      const root: Vec3 = [sx * 0.25, 0.35, sz * 0.13];
      const tip: Vec3 = [sx * 0.45, 0.372, sz * 0.28];
      group.add(strut(root, tip, 0.034, 0.028, metal, 'rotor-boom'));
      group.add(
        box([0.07, 0.06, 0.06], paint, { at: [sx * 0.25, 0.35, sz * 0.125], name: 'boom-root' }),
      );
      rotor(group, { at: tip, disc: DISC, nav: sx > 0 ? 'headlight' : 'taillight', name: 'rotor' });
    }
  }

  /* Two mid rotors on raised lateral stubs — the widest point of the machine. */
  for (const sz of [1, -1] as const) {
    const root: Vec3 = [0, 0.3, sz * 0.13];
    const tip: Vec3 = [0, 0.412, sz * 0.48];
    group.add(strut(root, tip, 0.03, 0.026, metal, 'rotor-stub'));
    group.add(box([0.07, 0.07, 0.06], paint, { at: [0, 0.31, sz * 0.125], name: 'stub-root' }));
    rotor(group, { at: tip, disc: MID_DISC, name: 'rotor-mid' });
  }

  /* Public-address horn, aft belly: throat forward, mouth aft and tilted down. */
  group.add(
    cyl(0.03, 0.15, paint, {
      axis: 'x',
      rTop: 0.075,
      at: [-0.24, 0.145, 0],
      rot: [0, 0, 0.2],
      segments: 16,
      name: 'horn',
    }),
  );
  group.add(
    cyl(0.076, 0.012, chrome, {
      axis: 'x',
      rTop: 0.08,
      at: [-0.313, 0.13, 0],
      rot: [0, 0, 0.2],
      segments: 16,
      name: 'horn-lip',
    }),
  );
  group.add(
    cyl(0.062, 0.008, dark, {
      axis: 'x',
      at: [-0.305, 0.132, 0],
      rot: [0, 0, 0.2],
      segments: 16,
      name: 'horn-throat',
    }),
  );
  group.add(box([0.03, 0.05, 0.04], dark, { at: [-0.19, 0.185, 0], name: 'horn-mount' }));

  /* Thermal turret: collar, ball, daylight lens and thermal window. */
  group.add(box([0.11, 0.03, 0.09], paint, { at: [0.02, 0.198, 0], name: 'turret-collar' }));
  group.add(sphere(0.055, dark, { at: [0.02, 0.145, 0], segments: 14, name: 'turret-ball' }));
  group.add(
    cyl(0.026, 0.014, material('glass'), {
      axis: 'x',
      at: [0.068, 0.135, 0.016],
      segments: 12,
      name: 'turret-lens',
    }),
  );
  group.add(
    cyl(0.03, 0.006, chrome, {
      axis: 'x',
      at: [0.061, 0.135, 0.016],
      segments: 12,
      name: 'turret-lens-ring',
    }),
  );
  group.add(
    cyl(0.017, 0.012, material('lamp'), {
      axis: 'x',
      at: [0.066, 0.14, -0.03],
      segments: 10,
      name: 'thermal-window',
    }),
  );

  /* Floodlight pod under the nose. */
  group.add(box([0.13, 0.055, 0.1], paint, { at: [0.26, 0.165, 0], name: 'flood-pod' }));
  group.add(box([0.024, 0.05, 0.06], dark, { at: [0.23, 0.2, 0], name: 'flood-bracket' }));
  for (const z of [-0.032, 0, 0.032]) {
    group.add(
      cyl(0.022, 0.022, chrome, {
        axis: 'x',
        rTop: 0.026,
        at: [0.328, 0.157, z],
        rot: [0, 0, -0.25],
        segments: 12,
        name: 'flood-cup',
      }),
    );
    group.add(
      cyl(0.023, 0.006, material('headlight'), {
        axis: 'x',
        at: [0.338, 0.154, z],
        rot: [0, 0, -0.25],
        segments: 12,
        name: 'flood-lens',
      }),
    );
  }

  landingGear(group, {
    z: 0.3,
    length: 0.46,
    tubeR: 0.022,
    feet: [0.2, -0.2],
    attachY: 0.225,
    attachZ: 0.14,
    strip: true,
  });

  return group;
}
