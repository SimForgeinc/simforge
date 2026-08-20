import { Group, type Mesh, type MeshStandardMaterial, type Object3D } from 'three';

import { box, cyl, mirrored, type Point2, profile, sphere } from '../geometry';
import { material } from '../materials';
import { carShell, shutter, type VehicleParams } from './shell';

/**
 * Transit and commercial slice: three buses that must not share a nose, an
 * articulated tram that runs on rail, a liveried saloon taxi and a step-in
 * parcel van.
 *
 * Every silhouette here is transcribed from its 2D tile with `tile()` below,
 * so the icon numbers in the source are the icon numbers in the artwork and the
 * two fidelities cannot drift apart. Livery colours are the only hues that
 * escape `params.color`: school-bus yellow, taxi yellow and the taxi chequer
 * *are* the identity, so they are painted as inset panels and the class tint
 * still reads along every roof, pillar and sill.
 */

const LIVERY = {
  schoolYellow: '#f0bd22',
  taxiYellow: '#f7c62b',
} as const;

/* -------------------------------------------------------------- tile maths */

interface TileSpec {
  /** Catalogued length and height, in metres. */
  l: number;
  h: number;
  /** Icon columns the finished build spans — bumper to bumper, not body only. */
  x0: number;
  x1: number;
  /** Icon row of the highest point of the finished build. */
  top: number;
  /** Icon row the vehicle stands on. 41 on the road; the tram stands on rail. */
  ground?: number;
}

interface Tile {
  /** Icon column → metres along X. The nose is at high icon X, so it is +X. */
  x(iconX: number): number;
  /** Icon row → metres above the ground plane. */
  y(iconY: number): number;
  /** Icon column span → metres. */
  dx(span: number): number;
  /** Icon row span → metres. */
  dy(span: number): number;
}

/**
 * The shell's icon→metres rule, fitted to a vehicle: `[x0, x1]` and `top` name
 * the extremities of the drawing, so the built bounding box lands on the
 * catalogued length and height by construction rather than by fudging.
 *
 * The tiles are not isotropic — a 96x48 viewBox flatters a 12 m bus — so only
 * positions come across this map. Radii (wheels, tubes, lamps) are authored in
 * metres from the real thing.
 */
function tile(spec: TileSpec): Tile {
  const ground = spec.ground ?? 41;
  const sx = spec.l / (spec.x1 - spec.x0);
  const sy = spec.h / (ground - spec.top);
  const cx = (spec.x0 + spec.x1) / 2;
  return {
    x: (iconX) => (iconX - cx) * sx,
    y: (iconY) => (ground - iconY) * sy,
    dx: (span) => span * sx,
    dy: (span) => span * sy,
  };
}

/* ----------------------------------------------------------- flank fittings */

/** Glazing thickness. One value for the whole slice so panes read as a set. */
const PANE = 0.05;
/** Trim / livery panel thickness: proud enough to catch a highlight. */
const TRIM = 0.035;

/**
 * A run of window bays down one flank: one pane per bay, and the pillars are
 * simply the gaps left between them. `xs` are pane centres.
 */
function bays(
  xs: readonly number[],
  y: number,
  w: number,
  h: number,
  z: number,
  mat: MeshStandardMaterial = material('glass'),
): Mesh[] {
  return xs.map((x) => box([w, h, PANE], mat, { at: [x, y, z] }));
}

/** Trim strip, livery panel or rub rail, repeated on both flanks. */
function band(
  x: number,
  y: number,
  len: number,
  h: number,
  z: number,
  mat: MeshStandardMaterial,
  t = TRIM,
): Object3D[] {
  return mirrored(z, (zz) => box([len, h, t], mat, { at: [x, y, zz] }));
}

/**
 * Double-leaf passenger door in a flank: recessed frame, two glazed leaves and
 * the centre split. One side only — buses and trams load from the kerb.
 */
function passengerDoor(
  x: number,
  z: number,
  w: number,
  top: number,
  bottom: number,
  glassTop: number,
  glassBottom: number,
): Mesh[] {
  const frame = material('plastic');
  const leaf = (w - 0.11) / 2;
  const glassH = glassTop - glassBottom;
  const glassY = (glassTop + glassBottom) / 2;
  // Leaves and split stand proud of the frame on whichever flank the door is cut
  // into: a fixed +Z offset pushed them in behind the frame on an offside door.
  const out = z + Math.sign(z) * 0.012;
  return [
    box([w, top - bottom, 0.04], frame, { at: [x, (top + bottom) / 2, z] }),
    box([leaf, glassH, PANE], material('glass'), { at: [x - (leaf + 0.06) / 2, glassY, out] }),
    box([leaf, glassH, PANE], material('glass'), { at: [x + (leaf + 0.06) / 2, glassY, out] }),
    box([0.05, top - bottom - 0.08, 0.05], material('steel'), { at: [x, (top + bottom) / 2, out] }),
  ];
}

/**
 * A panel laid on a raked face — windscreen, cowl glass, destination blind.
 * List the two side-view corners so that turning `a → b` a quarter turn
 * anticlockwise points out of the body; the panel is then offset along that
 * normal so it sits proud of the hull instead of fighting it. `lift` raises it
 * further, for a panel that lies on another panel rather than on the hull.
 */
function rakedPanel(
  a: Point2,
  b: Point2,
  width: number,
  mat: MeshStandardMaterial = material('glass'),
  t = PANE,
  lift = 0,
): Mesh {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const off = t / 2 + 0.005 + lift;
  return box([len, t, width], mat, {
    at: [(a[0] + b[0]) / 2 - (dy / len) * off, (a[1] + b[1]) / 2 + (dx / len) * off, 0],
    rot: [0, 0, Math.atan2(dy, dx)],
  });
}

/**
 * Where a fitting must sit to stand *on* a raked face instead of in it: the
 * centre of the face pushed `depth / 2 + stand` out along its normal, plus the
 * rotation that lays the fitting flat on it. Corner convention is `rakedPanel`'s
 * — turn `a → b` a quarter turn anticlockwise and you point out of the body.
 */
function onRake(
  a: Point2,
  b: Point2,
  depth: number,
  stand = 0.02,
): { x: number; y: number; rot: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const off = depth / 2 + stand;
  return {
    x: (a[0] + b[0]) / 2 - (dy / len) * off,
    y: (a[1] + b[1]) / 2 + (dx / len) * off,
    rot: Math.atan2(dy, dx),
  };
}

/** Roof pod — HVAC hump or vent — as a rounded profile with side louvres. */
function roofPod(
  x0: number,
  x1: number,
  base: number,
  topY: number,
  width: number,
  paint: MeshStandardMaterial,
  louvres = 3,
): Object3D[] {
  const inset = Math.min(0.34, (x1 - x0) * 0.09);
  const pod: Object3D[] = [
    profile(
      [
        [x0, base],
        [x0 + inset, topY],
        [x1 - inset, topY],
        [x1, base],
      ],
      width,
      paint,
      { radius: 0.09, bevel: 0.05 },
    ),
  ];
  const h = topY - base;
  for (let i = 0; i < louvres; i += 1) {
    const x = x0 + inset + ((x1 - x0 - 2 * inset) * (i + 0.5)) / louvres;
    pod.push(
      ...mirrored(width / 2, (z) =>
        box([(x1 - x0) * 0.1, h * 0.34, 0.03], material('steel'), { at: [x, base + h * 0.45, z] }),
      ),
    );
  }
  return pod;
}

/** A `shutter` panel turned onto a vehicle's end face, thin along X. */
function endShutter(x: number, y: number, spanZ: number, h: number, slats: number): Group {
  const panel = new Group();
  panel.add(...shutter([0, 0, 0], [spanZ, h], slats));
  panel.rotation.y = Math.PI / 2;
  panel.position.set(x, y, 0);
  return panel;
}

/* -------------------------------------------------------------- transit bus */

/**
 * Flat-front low-floor city bus: flat front and rear, window bays split by
 * pillars, two kerb-side doors with a ramp lip at the centre one, destination
 * blind over the screen and the HVAC hump that owns the roof.
 */
export function buildBus(params: VehicleParams = { color: '#2f5b45' }): Group {
  const t = tile({ l: 12.2, h: 3.2, x0: 4, x1: 92, top: 4.6 });
  const width = 2.55;
  const front = t.x(68);
  const rear = t.x(22);
  const surf = width / 2;
  const roof = t.y(7.6);

  const group = carShell(
    {
      length: 12.2,
      width,
      height: 3.2,
      wheelRadius: 0.51,
      wheelWidth: 0.3,
      axles: [front, rear],
      dualAxles: [1],
      hull: [
        [t.x(4), t.y(36)],
        [t.x(4), t.y(11.2)],
        [t.x(7.6), roof],
        [t.x(88.4), roof],
        [t.x(92), t.y(11.2)],
        [t.x(92), t.y(33.4)],
        [t.x(89.6), t.y(36)],
      ],
      hullRadius: 0.22,
      headlight: { x: t.x(92) - 0.05, y: t.y(31.25), z: 0.94, w: 0.3, h: 0.26 },
      taillight: { x: t.x(4) + 0.05, y: t.y(30.95), z: 0.98, w: 0.28, h: 0.24 },
      bumper: { y: t.y(34.6), h: 0.26 },
      flares: [front, rear],
    },
    params,
  );

  const paint = material('paint', params.color);
  const dark = material('plastic');
  const glass = material('glass');
  const chrome = material('chrome');

  // Roof: HVAC hump, and the only thing in the catalogue that reaches 3.2 m.
  group.add(...roofPod(t.x(25), t.x(52), roof, t.y(4.6), width - 0.7, paint));
  // Fan grilles stand on the hump's skin, not in it.
  for (const x of [t.x(31), t.x(45)]) {
    group.add(cyl(0.26, 0.05, material('steel'), { at: [x, t.y(4.6) + 0.015, 0], segments: 14 }));
  }

  // Glazing. The kerb side (+Z) loses two bays to the doors; the offside runs
  // continuous bays, as a one-door-per-side city bus does.
  const bayY = t.y(18.3);
  const bayW = t.dx(7.6);
  const bayH = t.dy(11.8);
  const kerbBays = [11.2, 20.2, 29.2, 47.8, 56.8, 65.8].map((ix) => t.x(ix));
  group.add(...bays(kerbBays, bayY, bayW, bayH, surf + 0.005));
  group.add(...bays(kerbBays, bayY, bayW, bayH, -surf - 0.005));
  group.add(
    ...bays([t.x(37.6), t.x(73.6)], t.y(19.3), t.dx(8), t.dy(13.8), -surf - 0.005),
  );
  // Driver's quarter pane, both sides.
  group.add(...bays([t.x(80.5)], t.y(16.8), t.dx(3.4), t.dy(8.4), surf + 0.005));
  group.add(...bays([t.x(80.5)], t.y(16.8), t.dx(3.4), t.dy(8.4), -surf - 0.005));
  // Deep windscreen on the flat front, engine louvre on the flat rear.
  group.add(box([0.07, t.dy(11.0), width - 0.34], glass, { at: [t.x(92) + 0.01, t.y(19.4), 0] }));
  group.add(endShutter(t.x(4) - 0.005, t.y(28), width - 0.9, 0.7, 5));

  // Destination blind on the raked front cap: a dark surround laid on the cap and
  // the amber blind laid on the surround. Both take the cap's own rake, so the
  // blind cannot skew back inside the panel it is mounted on.
  const capBack: Point2 = [t.x(88.4), roof];
  const capNose: Point2 = [t.x(92), t.y(11.2)];
  const capRun: Point2 = [capNose[0] - capBack[0], capNose[1] - capBack[1]];
  group.add(rakedPanel(capBack, capNose, width - 0.5, dark, 0.06));
  group.add(
    rakedPanel(
      [capBack[0] + capRun[0] * 0.12, capBack[1] + capRun[1] * 0.12],
      [capBack[0] + capRun[0] * 0.88, capBack[1] + capRun[1] * 0.88],
      width - 0.9,
      material('lamp'),
      0.05,
      0.045,
    ),
  );

  // Two kerb-side doors; the ramp lip under the centre one is the low-floor cue.
  for (const ix of [37.6, 73.6]) {
    group.add(
      ...passengerDoor(
        t.x(ix),
        surf - 0.01,
        t.dx(8.8),
        t.y(12),
        t.y(34.2),
        t.y(12.6),
        t.y(33.4),
      ),
    );
  }
  group.add(
    box([t.dx(8.6), t.dy(1.6), 0.12], chrome, { at: [t.x(37.7), t.y(35.2), surf + 0.02] }),
  );

  // Skirt, beltline and roof seam: the flank is 10 m long and needs the rhythm.
  group.add(...band(0, t.y(33.9), t.dx(84), t.dy(2.6), surf - 0.005, dark, 0.04));
  group.add(...band(t.x(44), t.y(26.6), t.dx(75.4), 0.05, surf + 0.01, dark, 0.04));
  group.add(...band(t.x(44.6), t.y(11.2), t.dx(74.4), 0.04, surf + 0.01, dark, 0.04));

  // Rear roof marker lamps, standing on the rear cap rake. Rotated against the
  // rake they stabbed through the cap instead of lying on it.
  const marker = onRake([t.x(4), t.y(11.2)], [t.x(7.6), roof], 0.09);
  group.add(
    ...mirrored(0.66, (z) =>
      box([0.16, 0.09, 0.13], material('lamp'), {
        at: [marker.x, marker.y, z],
        rot: [0, 0, marker.rot],
      }),
    ),
  );

  // Bus mirrors: big, on stalks, ahead of the screen.
  group.add(
    ...mirrored(surf - 0.03, (z) => box([0.05, 0.05, 0.24], chrome, { at: [t.x(92) - 0.2, t.y(12.6), z] })),
  );
  group.add(
    ...mirrored(surf + 0.02, (z) => box([0.07, 0.44, 0.11], dark, { at: [t.x(92) - 0.16, t.y(14.6), z] })),
  );

  return group;
}

/* --------------------------------------------------------------- school bus */

/**
 * Conventional bonneted Type C school bus: a narrow hood standing ahead of the
 * raked cowl, yellow flanks with black rub rails, the stop arm folded on the
 * traffic side, a crossing gate at the nose and warning lamps at four corners.
 */
export function buildSchoolBus(params: VehicleParams = { color: '#e8b51b' }): Group {
  const t = tile({ l: 10.7, h: 3.2, x0: 4, x1: 91.2, top: 7.6 });
  const width = 2.55;
  const surf = width / 2;
  const front = t.x(73);
  const rear = t.x(24);
  const roof = t.y(7.6);
  const cowl = t.x(77.6);
  const hoodTop = t.y(20.4);
  const hoodWidth = 2.15;

  const group = carShell(
    {
      length: 10.7,
      width,
      height: 3.2,
      wheelRadius: 0.556,
      wheelWidth: 0.3,
      axles: [front, rear],
      dualAxles: [1],
      hull: [
        [t.x(5), t.y(34)],
        [t.x(5), t.y(10.2)],
        [t.x(8), roof],
        [t.x(69), roof],
        [t.x(71.4), t.y(10.4)],
        [cowl, hoodTop],
        [cowl, t.y(34)],
      ],
      hullRadius: 0.2,
      headlight: { x: t.x(91) - 0.04, y: t.y(30.65), z: 0.78, w: 0.26, h: 0.24 },
      taillight: { x: t.x(5) + 0.05, y: t.y(30.05), z: 0.95, w: 0.26, h: 0.26 },
      flares: [front, rear],
    },
    params,
  );

  const paint = material('paint', params.color);
  const yellow = material('paint', LIVERY.schoolYellow);
  const dark = material('plastic');
  const steel = material('steel');
  const chrome = material('chrome');

  // The hood: narrower than the body, so the front fenders read as fenders.
  group.add(
    profile(
      [
        [cowl - 0.08, 0.8],
        [cowl - 0.08, hoodTop],
        [t.x(88.2), hoodTop],
        [t.x(91), t.y(23.4)],
        [t.x(91), t.y(32.2)],
        [t.x(88.6), 0.8],
      ],
      hoodWidth,
      paint,
      { radius: 0.12, bevel: 0.07 },
    ),
  );
  // Radiator grille and its bars, on the hood's front face.
  group.add(box([0.07, t.dy(4.6), 1.34], dark, { at: [t.x(91) + 0.015, t.y(25.1), 0] }));
  for (let i = 0; i < 3; i += 1) {
    group.add(
      box([0.05, 0.035, 1.24], steel, { at: [t.x(91) + 0.04, t.y(23.95 + i * 1.15), 0] }),
    );
  }

  // Raked cowl windscreen, and the cab side glass just behind it.
  group.add(rakedPanel([t.x(71.4), t.y(10.4)], [cowl, hoodTop], width - 0.34));
  group.add(...bays([t.x(67.8)], t.y(15.2), t.dx(6.8), t.dy(6.8), surf + 0.005));
  group.add(...bays([t.x(67.8)], t.y(15.2), t.dx(6.8), t.dy(6.8), -surf - 0.005));

  // Yellow livery: flanks and hood sides. Roof, sills and pillars keep the tint.
  const flankX = t.x(38.2);
  const flankL = t.dx(62.8);
  group.add(...band(flankX, t.y(28.1), flankL, t.dy(9), surf - 0.005, yellow, 0.03));
  group.add(...band(flankX, t.y(10.8), flankL, t.dy(2.4), surf - 0.005, yellow, 0.03));
  group.add(
    ...band(t.x(84.1), t.y(26.6), t.dx(11), t.dy(9.6), hoodWidth / 2 - 0.005, yellow, 0.03),
  );
  // Black rub rails.
  for (const iy of [27, 31.2]) {
    group.add(...band(flankX, t.y(iy), flankL, 0.09, surf + 0.01, dark, 0.04));
  }

  // Five passenger bays; the offside carries a sixth where the door is.
  const bayXs = [12.4, 21.4, 30.4, 39.4, 48.4].map((ix) => t.x(ix));
  const bayW = t.dx(7.6);
  group.add(...bays(bayXs, t.y(17.8), bayW, t.dy(11.6), surf + 0.005));
  group.add(...bays(bayXs, t.y(17.8), bayW, t.dy(11.6), -surf - 0.005));
  group.add(...bays([t.x(58.6)], t.y(18.9), bayW, t.dy(14.2), -surf - 0.005));
  // Entrance door, kerb side, just behind the cowl.
  group.add(
    ...passengerDoor(t.x(58.6), surf - 0.01, t.dx(8), t.y(11.8), t.y(34), t.y(12.4), t.y(33.4)),
  );

  // Stop arm, folded against the traffic side.
  const armZ = -surf - 0.02;
  group.add(box([t.dx(4.4), 0.05, 0.06], steel, { at: [t.x(33.6), t.y(28.9), armZ] }));
  group.add(box([0.09, 0.16, 0.1], dark, { at: [t.x(31.2), t.y(28.9), armZ] }));
  group.add(
    cyl(0.24, 0.04, material('taillight'), {
      axis: 'z',
      at: [t.x(38.1), t.y(28.6), armZ - 0.03],
      segments: 8,
    }),
  );
  group.add(
    cyl(0.17, 0.03, material('safetyWhite'), {
      axis: 'z',
      at: [t.x(38.1), t.y(28.6), armZ - 0.06],
      segments: 8,
    }),
  );

  // Crossing gate, folded back along the kerb side of the front bumper.
  const gateY = t.y(35.8);
  group.add(cyl(0.06, 0.18, dark, { at: [t.x(90.8), gateY + 0.02, 0.98], segments: 10 }));
  group.add(
    cyl(0.035, t.dx(11.4), chrome, { axis: 'x', at: [t.x(85.1), gateY, 1.02], segments: 8 }),
  );
  for (const ix of [82.7, 87.5]) {
    group.add(
      cyl(0.048, t.dx(2.6), material('taillight'), {
        axis: 'x',
        at: [t.x(ix), gateY, 1.02],
        segments: 8,
      }),
    );
  }

  // Warning lamps: red outboard, amber inboard, standing on the front and rear
  // roof caps where a Type C bus carries them. Set at the cap's own numbers they
  // sat under the roof skin, so each cluster rides out along the cap's normal.
  for (const [a, b] of [
    [[t.x(69), roof], [t.x(71.4), t.y(10.4)]],
    [[t.x(5), t.y(10.2)], [t.x(8), roof]],
  ] as const) {
    const cap = onRake(a, b, 0.1);
    for (const [z, key] of [
      [0.95, 'taillight'],
      [0.45, 'lamp'],
    ] as const) {
      group.add(
        ...mirrored(z, (zz) =>
          box([0.15, 0.1, 0.15], material(key), { at: [cap.x, cap.y, zz], rot: [0, 0, cap.rot] }),
        ),
      );
    }
  }

  // Wrap-around bumpers, front and rear.
  for (const [x, ret] of [
    [t.x(91.2) - 0.1, cowl + 0.1],
    [t.x(4) + 0.1, t.x(16)],
  ] as const) {
    group.add(box([0.2, 0.25, width - 0.06], dark, { at: [x, t.y(33.1), 0] }));
    group.add(
      ...mirrored(surf - 0.09, (z) =>
        box([Math.abs(ret - x), 0.24, 0.09], dark, { at: [(x + ret) / 2, t.y(33.1), z] }),
      ),
    );
  }

  // Cab mirrors on the cowl.
  group.add(
    ...mirrored(surf + 0.03, (z) => box([0.07, 0.34, 0.09], dark, { at: [t.x(72), t.y(14.5), z] })),
  );
  group.add(
    ...mirrored(surf - 0.06, (z) => box([0.05, 0.05, 0.16], chrome, { at: [t.x(71.6), t.y(13.4), z] })),
  );

  return group;
}

/* -------------------------------------------------------------- shuttle bus */

/**
 * Cutaway shuttle: a van nose and short bonnet stepping up to a taller boxy
 * cabin, with the wheelchair lift door and its platform lip on the kerb side,
 * a roof vent over the cabin and a luggage line along the skirt.
 */
export function buildShuttleBus(params: VehicleParams = { color: '#e2e8f0' }): Group {
  const t = tile({ l: 7.4, h: 2.8, x0: 5, x1: 91.4, top: 4.6 });
  const width = 2.3;
  const surf = width / 2;
  const front = t.x(74.5);
  const rear = t.x(26);
  const cabinRoof = t.y(8);
  const cabRoof = t.y(13.4);

  const group = carShell(
    {
      length: 7.4,
      width,
      height: 2.8,
      wheelRadius: 0.43,
      wheelWidth: 0.26,
      axles: [front, rear],
      dualAxles: [1],
      hull: [
        [t.x(5), t.y(35)],
        [t.x(5), t.y(10.4)],
        [t.x(7.6), cabinRoof],
        [t.x(60), cabinRoof],
        [t.x(60), cabRoof],
        [t.x(70.4), cabRoof],
        [t.x(77), t.y(20.4)],
        [t.x(85), t.y(20.4)],
        [t.x(89.6), t.y(23.2)],
        [t.x(91.4), t.y(26.8)],
        [t.x(91.4), t.y(32.8)],
        [t.x(89), t.y(35)],
      ],
      hullRadius: 0.14,
      headlight: { x: t.x(91.4) - 0.05, y: t.y(28.575), z: 0.72, w: 0.24, h: 0.22 },
      taillight: { x: t.x(5) + 0.05, y: t.y(29.575), z: 0.86, w: 0.24, h: 0.24 },
      bumper: { y: t.y(33.6), h: 0.24 },
      grille: [t.y(26.4), t.dy(4)],
      flares: [front, rear],
    },
    params,
  );

  const paint = material('paint', params.color);
  const dark = material('plastic');
  const chrome = material('chrome');

  // Roof vent over the cabin — the tallest thing on the vehicle.
  group.add(...roofPod(t.x(27), t.x(38.2), cabinRoof, t.y(4.6), width - 0.8, paint, 2));

  // Four passenger bays, then the lift door. Offside runs a bay in its place.
  const bayXs = [12.6, 21.6, 30.6, 39.6].map((ix) => t.x(ix));
  const bayW = t.dx(7.6);
  group.add(...bays(bayXs, t.y(17.4), bayW, t.dy(10.4), surf + 0.005));
  group.add(...bays(bayXs, t.y(17.4), bayW, t.dy(10.4), -surf - 0.005));
  group.add(...bays([t.x(51.4)], t.y(16.7), t.dx(11.2), t.dy(9), -surf - 0.005));
  // Cab side glass, both sides, and the raked screen over the bonnet.
  group.add(...bays([t.x(65.6)], t.y(17.8), t.dx(6.4), t.dy(6.4), surf + 0.005));
  group.add(...bays([t.x(65.6)], t.y(17.8), t.dx(6.4), t.dy(6.4), -surf - 0.005));
  group.add(rakedPanel([t.x(70.4), cabRoof], [t.x(77), t.y(20.4)], width - 0.3));

  // Wheelchair lift: wide recessed door, split glazing, and the platform lip.
  group.add(
    ...passengerDoor(t.x(51.4), surf - 0.01, t.dx(13.6), t.y(11.2), t.y(33.4), t.y(12.2), t.y(21.2)),
  );
  group.add(box([t.dx(14.2), t.dy(1.8), 0.12], dark, { at: [t.x(51.3), t.y(33.9), surf + 0.03] }));
  group.add(
    box([t.dx(11.4), 0.04, 0.1], chrome, { at: [t.x(51.3), t.y(33.9) + 0.06, surf + 0.04] }),
  );

  // Luggage line: locker door on each flank plus the seam that runs it aft.
  group.add(...band(t.x(19.7), t.y(31.7), t.dx(17.4), t.dy(4.2), surf - 0.005, dark, 0.03));
  for (const ix of [11, 28.4]) {
    group.add(...band(t.x(ix), t.y(31.7), 0.04, t.dy(4.4), surf + 0.01, chrome, 0.04));
  }
  group.add(...band(t.x(19.7), t.y(31.7), t.dx(4), 0.05, surf + 0.02, chrome, 0.05));
  group.add(...band(t.x(32.9), t.y(29.4), t.dx(52.6), 0.05, surf + 0.01, dark, 0.04));
  group.add(...band(t.x(33), t.y(22.8), t.dx(53), 0.04, surf + 0.01, dark, 0.04));

  // Rear cap marker lamps.
  const lamp = material('lamp');
  for (const z of [0.6, 0, -0.6]) {
    group.add(box([0.06, 0.08, 0.12], lamp, { at: [t.x(5) - 0.015, t.y(10.2), z] }));
  }

  // Cab mirror on the A-pillar.
  group.add(
    ...mirrored(surf - 0.04, (z) => box([0.05, 0.05, 0.16], chrome, { at: [t.x(69.6), t.y(15.4), z] })),
  );
  group.add(
    ...mirrored(surf + 0.02, (z) => box([0.06, 0.28, 0.08], dark, { at: [t.x(68.4), t.y(15.8), z] })),
  );

  return group;
}

/* --------------------------------------------------------------------- tram */

/**
 * Articulated light-rail vehicle. Raked cab faces at both ends, a folded
 * single-arm pantograph with its knuckle, HVAC pods, bellows at the
 * articulation, doors between the bays, and three bogies on small flanged
 * steel wheels standing on their own rails — never a road tyre.
 */
export function buildTram(params: VehicleParams = { color: '#d9e2e8' }): Group {
  // The tile stands this one on rail, so its ground row is the rail foot.
  const t = tile({ l: 30, h: 3.5, x0: 0.4, x1: 95.6, top: 0.8, ground: 43.4 });
  const group = new Group();
  const width = 2.65;
  const surf = width / 2;
  const paint = material('paint', params.color);
  const dark = material('plastic');
  const steel = material('steel');
  const chrome = material('chrome');
  const glass = material('glass');

  const floor = t.y(33.4);
  const roof = t.y(6.2);
  const capTop = t.y(7.4);
  const capBase = t.y(14.8);
  const nose = t.x(93.4);
  const bellowsBack = t.x(45);
  const bellowsFront = t.x(51);

  // Two car bodies, raked at the outer ends, square at the articulation.
  group.add(
    profile(
      [
        [-nose, floor],
        [-nose, capBase],
        [t.x(8.6), capTop],
        [t.x(11.6), roof],
        [bellowsBack, roof],
        [bellowsBack, floor],
      ],
      width,
      paint,
      { radius: 0.18, bevel: 0.1 },
    ),
  );
  group.add(
    profile(
      [
        [bellowsFront, floor],
        [bellowsFront, roof],
        [t.x(84.6), roof],
        [t.x(87.6), capTop],
        [nose, capBase],
        [nose, floor],
      ],
      width,
      paint,
      { radius: 0.18, bevel: 0.1 },
    ),
  );

  // Articulation bellows: a narrower core with ribs, standing in the gap.
  const bellowsY = (t.y(6.6) + t.y(33.2)) / 2;
  const bellowsH = t.y(6.6) - t.y(33.2);
  group.add(
    box([bellowsFront - bellowsBack + 0.06, bellowsH, width - 0.34], dark, {
      at: [(bellowsBack + bellowsFront) / 2, bellowsY, 0],
    }),
  );
  for (let i = 0; i < 5; i += 1) {
    const x = bellowsBack + ((bellowsFront - bellowsBack) * (i + 0.5)) / 5;
    group.add(box([0.1, bellowsH - 0.04, width - 0.16], steel, { at: [x, bellowsY, 0] }));
  }

  // Roof pods.
  group.add(...roofPod(t.x(16), t.x(30.4), roof, t.y(3.8), width - 0.8, paint));
  group.add(...roofPod(t.x(58), t.x(73.4), roof, t.y(3.8), width - 0.8, paint));

  // Folded single-arm pantograph: base rails on insulators, lower arm rising to
  // the knuckle, short upper arm, and the transverse pan head with its horns.
  const baseY = t.y(5.5);
  group.add(
    ...mirrored(0.62, (z) => box([t.dx(13.2), 0.07, 0.11], steel, { at: [t.x(38.7), baseY, z] })),
  );
  for (const ix of [33.5, 44.5]) {
    group.add(
      ...mirrored(0.62, (z) => cyl(0.05, baseY - roof, chrome, { at: [t.x(ix), (baseY + roof) / 2, z], segments: 10 })),
    );
  }
  const knuckle: Point2 = [t.x(44.6), t.y(2.7)];
  const armFoot: Point2 = [t.x(33.4), baseY + 0.05];
  const lower = Math.hypot(knuckle[0] - armFoot[0], knuckle[1] - armFoot[1]);
  group.add(
    ...mirrored(0.55, (z) =>
      cyl(0.035, lower, chrome, {
        axis: 'x',
        at: [(armFoot[0] + knuckle[0]) / 2, (armFoot[1] + knuckle[1]) / 2, z],
        rot: [0, 0, Math.atan2(knuckle[1] - armFoot[1], knuckle[0] - armFoot[0])],
        segments: 8,
      }),
    ),
  );
  const upper: Point2 = [t.x(37.2), t.y(1.8)];
  const upperLen = Math.hypot(knuckle[0] - upper[0], knuckle[1] - upper[1]);
  group.add(
    ...mirrored(0.55, (z) =>
      cyl(0.03, upperLen, chrome, {
        axis: 'x',
        at: [(upper[0] + knuckle[0]) / 2, (upper[1] + knuckle[1]) / 2, z],
        rot: [0, 0, Math.atan2(upper[1] - knuckle[1], upper[0] - knuckle[0])],
        segments: 8,
      }),
    ),
  );
  group.add(box([0.14, 0.12, 1.24], steel, { at: [knuckle[0], knuckle[1], 0] }));
  const panX = t.x(38.7);
  group.add(box([0.13, 0.08, 1.9], steel, { at: [panX, t.y(2.3), 0] }));
  group.add(box([0.06, 0.03, 1.76], chrome, { at: [panX, t.y(0.9), 0] }));
  group.add(
    ...mirrored(0.98, (z) => box([0.1, 0.12, 0.16], steel, { at: [panX, t.y(2.6), z], rot: [0.5, 0, 0] })),
  );

  // Cab screens: the raked corner and the flat face below it, at both ends.
  for (const sign of [1, -1]) {
    group.add(
      rakedPanel(
        sign > 0 ? [t.x(87.6), capTop] : [-nose, capBase],
        sign > 0 ? [nose, capBase] : [t.x(-87.6 + 96), capTop],
        width - 0.34,
      ),
    );
    group.add(
      box([0.06, capBase - t.y(21.6), width - 0.4], glass, {
        at: [sign * (nose + 0.01), (capBase + t.y(21.6)) / 2, 0],
      }),
    );
    group.add(
      ...mirrored(surf + 0.005, (z) =>
        box([t.dx(6), t.dy(6.4), PANE], glass, { at: [sign * t.x(89.2), t.y(18.4), z] }),
      ),
    );
  }

  // Window bays either side of the articulation, both flanks.
  const bayXs = [17.3, 25.7, 34.1, 56.1, 64.5, 72.9].map((ix) => t.x(ix));
  const bayY = t.y(16.5);
  const bayW = t.dx(7.4);
  const bayH = t.dy(9.8);
  group.add(...bays(bayXs, bayY, bayW, bayH, surf + 0.005));
  group.add(...bays(bayXs, bayY, bayW, bayH, -surf - 0.005));

  // Doors between the bays, both flanks — a tram loads from either side.
  for (const ix of [41.6, 80.6]) {
    for (const z of [surf - 0.01, -surf + 0.01]) {
      group.add(
        ...passengerDoor(t.x(ix), z, t.dx(6), t.y(11.2), t.y(33), t.y(11.6), t.y(25)),
      );
    }
  }

  // Skirt band and beltline.
  group.add(...band(0, t.y(31.9), t.dx(89.2), t.dy(3), surf - 0.005, dark, 0.04));
  for (const x of [t.x(24.3), t.x(71.7)]) {
    group.add(...band(x, t.y(23.4), t.dx(40.6), 0.05, surf + 0.01, dark, 0.04));
  }

  // Lamps and couplers at both ends.
  for (const sign of [1, -1]) {
    group.add(
      ...mirrored(0.92, (z) =>
        box([0.08, t.dy(3.9), 0.26], material('headlight'), { at: [sign * (nose - 0.02), t.y(26.55), z] }),
      ),
    );
    group.add(
      ...mirrored(0.56, (z) =>
        box([0.07, t.dy(3), 0.2], material('taillight'), { at: [sign * (nose - 0.02), t.y(26.9), z] }),
      ),
    );
    group.add(box([t.dx(3.4), t.dy(2.8), 0.5], dark, { at: [sign * t.x(94), t.y(32.6), 0] }));
    group.add(box([0.22, 0.3, 0.34], steel, { at: [sign * t.x(95.4), t.y(32.6), 0] }));
  }

  // Running gear. Rail wheels are small, steel and flanged, and they stand on
  // their own track — the one vehicle in the catalogue with no road stance.
  const gauge = 1.435;
  const sleeperH = 0.1;
  const railH = 0.09;
  const railTop = sleeperH + railH;
  for (let i = 0; i < 5; i += 1) {
    group.add(
      box([0.26, sleeperH, 2.1], material('wood'), {
        at: [-12 + i * 6, sleeperH / 2, 0],
      }),
    );
  }
  group.add(
    ...mirrored(gauge / 2, (z) => box([30, railH, 0.075], steel, { at: [0, sleeperH + railH / 2, z] })),
  );
  for (const x of [t.x(15), t.x(48), t.x(81)]) {
    group.add(...bogie(x, railTop, gauge));
  }

  return group;
}

/**
 * Rail bogie: side frames under the floor, two axles, four small flanged
 * wheels. The flange hangs inside the railhead, as a flange does.
 */
function bogie(x: number, railTop: number, gauge: number): Object3D[] {
  const steel = material('steel');
  const wheel = material('metal');
  const r = 0.3;
  const axleY = railTop + r;
  const wheelbase = 1.9;
  const parts: Object3D[] = [
    ...mirrored(gauge / 2 + 0.16, (z) => box([2.5, 0.18, 0.11], steel, { at: [x, axleY + 0.22, z] })),
    box([0.62, 0.14, gauge + 0.44], steel, { at: [x, axleY + 0.24, 0] }),
  ];
  for (const ax of [x - wheelbase / 2, x + wheelbase / 2]) {
    parts.push(cyl(0.07, gauge - 0.12, steel, { axis: 'z', at: [ax, axleY, 0], segments: 8 }));
    parts.push(...mirrored(gauge / 2, (z) => cyl(r, 0.09, wheel, { axis: 'z', at: [ax, axleY, z], segments: 16 })));
    parts.push(
      ...mirrored(gauge / 2 - 0.06, (z) => cyl(r * 1.09, 0.03, wheel, { axis: 'z', at: [ax, axleY, z], segments: 16 })),
    );
  }
  return parts;
}

/* --------------------------------------------------------------------- taxi */

/**
 * Liveried saloon taxi: three-box body with an upright greenhouse, roof sign,
 * chequer band along the sill, a decal panel on the rear door and the meter
 * aerial on the roof. Yellow is the identity, so yellow is painted on.
 */
export function buildTaxi(params: VehicleParams = { color: '#f0c419' }): Group {
  // Fitted to the body roof; the sign and aerial then stack up to 1.55 m.
  const t = tile({ l: 4.9, h: 1.4, x0: 6.6, x1: 92, top: 13.4 });
  const width = 1.85;
  const surf = width / 2;
  const front = t.x(76);
  const rear = t.x(24);
  const roof = t.y(13.4);
  const belt = t.y(23.4);

  const group = carShell(
    {
      length: 4.9,
      width,
      height: roof,
      wheelRadius: 0.32,
      wheelWidth: 0.22,
      axles: [front, rear],
      hull: [
        [t.x(6.6), t.y(34)],
        [t.x(6.6), t.y(26.6)],
        [t.x(10), t.y(24.6)],
        [t.x(20), belt],
        [t.x(68.6), t.y(23.6)],
        [t.x(85.6), t.y(24.6)],
        [t.x(90), t.y(26.6)],
        [t.x(92), t.y(29.6)],
        [t.x(92), t.y(32.4)],
        [t.x(90), t.y(34)],
      ],
      hullRadius: 0.13,
      glass: [
        [t.x(22.8), t.y(23.2)],
        [t.x(31.6), t.y(15.4)],
        [t.x(58.6), t.y(15.4)],
        [t.x(67.2), t.y(23.2)],
      ],
      glassRadius: 0.12,
      roof: [t.x(31.4), t.x(56.6), 0.11],
      headlight: { x: t.x(92) - 0.05, y: t.y(29.45), z: 0.62, w: 0.3, h: 0.16 },
      taillight: { x: t.x(6.6) + 0.05, y: t.y(29.35), z: 0.64, w: 0.28, h: 0.15 },
      mirror: { x: t.x(60.6), y: t.y(17.8) },
      bumper: { y: t.y(31.6), h: 0.2 },
      sill: [t.y(32.6), 0.09],
      grille: [t.y(31.2), t.dy(3.2)],
      exhaust: { x: t.x(6.6) - 0.06, y: t.y(32.9), z: 0.46 },
      flares: [front, rear],
      discBrakes: true,
    },
    params,
  );

  const yellow = material('paint', LIVERY.taxiYellow);
  const dark = material('plastic');
  const light = material('safetyWhite');
  const chrome = material('chrome');

  // Yellow below the beltline: flanks, plus the boot and bonnet lower faces.
  group.add(...band(t.x(48.8), t.y(29.3), t.dx(81.6), t.dy(5), surf - 0.004, yellow, 0.03));
  group.add(box([0.07, t.dy(4), width - 0.42], yellow, { at: [t.x(92) + 0.01, t.y(30.6), 0] }));
  group.add(box([0.07, t.dy(4.4), width - 0.42], yellow, { at: [t.x(6.6) - 0.01, t.y(30.4), 0] }));

  // B-pillar splitting the glazing.
  group.add(
    ...mirrored((width - 0.16) / 2, (z) =>
      box([t.dx(2.2), roof - belt, 0.05], dark, { at: [t.x(45.5), (roof + belt) / 2 - 0.02, z] }),
    ),
  );

  // Chequer band: a light strip with dark squares laid over it.
  const chequerY = t.y(29.9);
  const square = t.dx(3.6);
  group.add(...band(t.x(38.2), chequerY, t.dx(32.4), square * 0.62, surf + 0.008, light, 0.04));
  for (let i = 0; i < 4; i += 1) {
    group.add(
      ...band(t.x(23.8 + i * 7.2), chequerY, square, square * 0.62, surf + 0.014, dark, 0.04),
    );
  }
  // Rear-door decal panel and the door cuts, handles and crease above it.
  group.add(...band(t.x(37.8), t.y(26.7), t.dx(15.6), t.dy(2.6), surf + 0.008, light, 0.03));
  for (const ix of [29.4, 52]) {
    group.add(...band(t.x(ix), t.y(28.9), 0.035, t.dy(9), surf + 0.012, dark, 0.04));
  }
  for (const ix of [37.2, 57.2]) {
    group.add(...band(t.x(ix), t.y(24.4), t.dx(3.2), 0.04, surf + 0.016, chrome, 0.05));
  }
  group.add(...band(t.x(44.2), belt + 0.02, t.dx(46.4), 0.025, surf + 0.008, dark, 0.035));

  // Roof sign, its feet, and the meter aerial. These take the taxi to 1.55 m.
  const signY = roof + 0.065;
  group.add(box([t.dx(13.6), 0.13, 0.44], yellow, { at: [t.x(45.8), signY, 0] }));
  group.add(
    ...mirrored(0.222, (z) => box([t.dx(10.4), 0.07, 0.02], dark, { at: [t.x(45.8), signY, z] })),
  );
  group.add(
    ...mirrored(0.14, (z) => box([t.dx(2), 0.05, 0.08], dark, { at: [t.x(45.8), roof + 0.01, z] })),
  );
  group.add(cyl(0.012, 0.12, chrome, { at: [t.x(32.4), roof + 0.06, 0.26], segments: 8 }));
  group.add(sphere(0.022, chrome, { at: [t.x(32.4), roof + 0.128, 0.26], segments: 10 }));

  return group;
}

/* ------------------------------------------------------------- delivery van */

/**
 * Step-in parcel van: tall boxy cargo body on a snub nose, roll-up shutter at
 * the rear, the sliding cab doorway standing open over its step plate, and a
 * roof rack over the cargo box.
 */
export function buildDeliveryVan(params: VehicleParams = { color: '#8b5e3c' }): Group {
  const t = tile({ l: 6, h: 2.65, x0: 3.6, x1: 92.2, top: 4.4 });
  const width = 2.05;
  const surf = width / 2;
  const front = t.x(76.5);
  const rear = t.x(24);
  const roof = t.y(6.4);
  const tail = t.x(4);

  const group = carShell(
    {
      length: 6,
      width,
      height: 2.65,
      wheelRadius: 0.4,
      wheelWidth: 0.24,
      axles: [front, rear],
      dualAxles: [1],
      hull: [
        [tail, t.y(35)],
        [tail, t.y(9)],
        [t.x(6.8), roof],
        [t.x(79.2), roof],
        [t.x(81.6), t.y(7.6)],
        [t.x(88.4), t.y(18.4)],
        [t.x(90.4), t.y(20.3)],
        [t.x(92.2), t.y(23.6)],
        [t.x(92.2), t.y(32.6)],
        [t.x(89.8), t.y(35)],
      ],
      hullRadius: 0.13,
      headlight: { x: t.x(92.2) - 0.05, y: t.y(30.575), z: 0.68, w: 0.24, h: 0.2 },
      taillight: { x: tail + 0.05, y: t.y(30.465), z: 0.72, w: 0.24, h: 0.24 },
      flares: [front, rear],
    },
    params,
  );

  const paint = material('paint', params.color);
  const dark = material('plastic');
  const chrome = material('chrome');
  const steel = material('steel');

  // Roof rack: two rails on legs, over the cargo box only.
  group.add(
    ...mirrored(surf - 0.28, (z) => box([t.dx(48), 0.05, 0.05], chrome, { at: [t.x(36), t.y(4.8), z] })),
  );
  for (const ix of [17, 29, 41, 53]) {
    group.add(
      ...mirrored(surf - 0.28, (z) =>
        box([0.05, t.y(4.8) - roof, 0.04], chrome, { at: [t.x(ix), (t.y(4.8) + roof) / 2, z] }),
      ),
    );
  }
  group.add(box([0.05, 0.04, width - 0.5], chrome, { at: [t.x(35), t.y(4.9), 0] }));

  // Roll-up rear door, its pull handle and the step bumper below it.
  group.add(endShutter(tail - 0.005, t.y(21.5), width - 0.2, t.dy(23.4), 8));
  group.add(box([0.1, t.dy(1.1), 0.34], chrome, { at: [tail + 0.02, t.y(32.35), 0] }));
  group.add(box([t.dx(11.4), t.dy(2.4), width - 0.24], dark, { at: [t.x(9.3), t.y(34.6), 0] }));
  const lamp = material('lamp');
  for (const z of [0.6, 0, -0.6]) {
    group.add(box([0.06, 0.08, 0.12], lamp, { at: [tail - 0.015, t.y(8.6), z] }));
  }

  // Blank flank: panel seams, waist line, black rub rail and the filler cap.
  for (const ix of [20, 36, 52]) {
    group.add(...band(t.x(ix), t.y(20.8), 0.035, t.dy(24.4), surf + 0.008, dark, 0.03));
  }
  group.add(...band(t.x(33), t.y(20), t.dx(54), 0.04, surf + 0.01, dark, 0.04));
  group.add(...band(t.x(33), t.y(27.6), t.dx(54), 0.08, surf + 0.012, dark, 0.045));
  group.add(
    ...mirrored(surf + 0.01, (z) => cyl(0.075, 0.03, steel, { axis: 'z', at: [t.x(45), t.y(30.6), z], segments: 10 })),
  );

  // Open sliding cab doorway with its step plate — kerb side only.
  const doorX = t.x(65.2);
  const doorW = t.dx(8.4);
  const doorTop = t.y(12.4);
  const doorBottom = t.y(33.2);
  group.add(
    box([doorW + 0.08, doorTop - doorBottom + 0.08, 0.05], dark, {
      at: [doorX, (doorTop + doorBottom) / 2, surf - 0.01],
    }),
  );
  group.add(
    box([t.dx(5.6), t.dy(18.2), 0.36], material('asphalt'), {
      at: [doorX, (doorTop + doorBottom) / 2 - 0.02, surf - 0.2],
    }),
  );
  group.add(box([0.05, doorTop - doorBottom, 0.06], chrome, { at: [t.x(69.3), (doorTop + doorBottom) / 2, surf + 0.01] }));
  group.add(box([doorW + 0.12, 0.05, 0.06], dark, { at: [doorX, doorTop + 0.03, surf + 0.01] }));
  group.add(box([t.dx(9.4), t.dy(1.8), 0.13], steel, { at: [t.x(65.3), t.y(33.9), surf + 0.02] }));

  // Cab glazing: side pane both sides, deeply raked screen on the snub nose.
  group.add(...bays([t.x(74.9)], t.y(14.1), t.dx(5.8), t.dy(7.4), surf + 0.005));
  group.add(...bays([t.x(74.9)], t.y(14.1), t.dx(5.8), t.dy(7.4), -surf - 0.005));
  group.add(rakedPanel([t.x(81.6), t.y(7.6)], [t.x(88.4), t.y(18.4)], width - 0.24));
  group.add(rakedPanel([t.x(79.6), roof], [t.x(81.6), t.y(7.4)], width - 0.18, paint, 0.06));

  // Step-van mirrors, carried well forward of the screen.
  group.add(
    ...mirrored(surf + 0.015, (z) => box([0.3, 0.05, 0.05], chrome, { at: [t.x(89.4), t.y(15.6), z] })),
  );
  group.add(
    ...mirrored(surf + 0.015, (z) => box([0.06, 0.36, 0.08], dark, { at: [t.x(90.4), t.y(14.7), z] })),
  );

  // Radiator grille on the snub nose. The shell's own grille block lands at
  // exactly length/2, which on this hull *is* the nose plane, so it came out
  // coplanar with the paint; this one stands 2 cm clear of it.
  group.add(box([0.08, t.dy(3.6), width * 0.62], steel, { at: [t.x(92.2) - 0.02, t.y(26.2), 0] }));

  // Front bumper: the snub nose needs the valance to finish it.
  group.add(box([t.dx(2.4), 0.24, width - 0.16], dark, { at: [t.x(91.4), t.y(33.4), 0] }));

  return group;
}
