import { Group, type Mesh, type MeshStandardMaterial, type Object3D } from 'three';

import { box, cyl, mirrored, type Point2, profile, sphere } from '../geometry';
import { material } from '../materials';
import { addWheels, carShell, DEFAULT_COLOR, spareWheel, type VehicleParams } from './shell';

/**
 * The seven branded road cars.
 *
 * Each one is a transcription of its 2D tile (`vehicle-art/branded-cars.tsx`)
 * under the rule at the top of `shell.ts`: a 96x48 side elevation with the
 * ground at y = 41 and the nose at high x. Rather than pre-multiplying every
 * coordinate by hand, the tile numbers stay in the source and `iconFrame` does
 * the conversion, so a point here can be diffed against the SVG path it came
 * from. The frame derives its own scale from the points it is given, which is
 * what keeps the built bounding box on the catalogued length and height.
 *
 * Every car is authored as three curves, again straight off the tile:
 *
 *   belt    the painted body's upper edge, rear -> front, ending at the cowl
 *   lower   the rest of the outline, front -> rear: hood, nose, floor, tail
 *   roof    the crown over the cabin, rear -> front, meeting `belt` at both ends
 *
 * Hull is `belt + lower`; the glazing is the region between the belt and the
 * roof, inset from the roof along its own normal; the painted roof skin is that
 * same inset strip. One authored roofline therefore produces the Civic's
 * fastback, the Camry's notch, the Model 3's unbroken canopy, the Corvette's
 * buttressed cabin and the Wrangler's flat hardtop without any special cases.
 *
 * Two conventions keep the kit attached to the body rather than floating beside
 * it. Pillars and window trim sit on the glazing surface (`zGlass`), because the
 * cabin is 0.16 m narrower than the paint and anything left at the hull's flank
 * hangs in the air above the beltline. Seams, creases and handles sit at the
 * hull flank, but only over the doors: the hull is an extrusion with a chamfered
 * edge, so a strip that runs on past the tapering nose leaves the paint behind.
 *
 * Width is the other half of the identity. Where a car's widest point is its
 * rear haunch rather than its doors — Corvette, 911, Mustang — the hull is
 * extruded narrow and `haunch` puts the missing width back over the rear wheel,
 * so the shape reads from above as well as in elevation.
 */

/** Tile ground line. */
const GROUND_Y = 41;

/** Detail (seams, creases, handles) sits this far inside the painted flank. */
const FLANK = 0.02;

/** Icon space mapped onto one model's catalogued dimensions. */
interface IconFrame {
  /** Icon point -> metres. */
  at: (x: number, y: number) => Point2;
  /** Icon x -> metres along the car. */
  x: (x: number) => number;
  /** Icon y -> metres above the ground. */
  y: (y: number) => number;
  /** Icon length along x -> metres. */
  dx: (u: number) => number;
  /** Icon length along y -> metres. */
  dy: (u: number) => number;
  /** Icon radius -> metres. Circles take the x scale so tyres stay round. */
  r: (u: number) => number;
  /** A whole authored curve. */
  line: (curve: readonly Point2[]) => Point2[];
}

/**
 * Icon space -> metres for one model.
 *
 * `length` maps onto the x span of every point handed in and `height` onto the
 * crest, so the caller cannot get the scale wrong: pass the outlines plus any
 * kit that sticks out past the paint (the Wrangler's spare) and the model comes
 * out on its catalogued dimensions.
 */
function iconFrame(
  length: number,
  height: number,
  ...icon: readonly (readonly Point2[])[]
): IconFrame {
  const points = icon.flat();
  const xs = points.map((p) => p[0]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const crest = Math.min(...points.map((p) => p[1]));
  const sx = length / (x1 - x0);
  const sy = height / (GROUND_Y - crest);
  const midX = (x0 + x1) / 2;
  const at = (x: number, y: number): Point2 => [(x - midX) * sx, (GROUND_Y - y) * sy];
  return {
    at,
    x: (x: number) => (x - midX) * sx,
    y: (y: number) => (GROUND_Y - y) * sy,
    dx: (u: number) => u * sx,
    dy: (u: number) => u * sy,
    r: (u: number) => u * sx,
    line: (curve: readonly Point2[]) => curve.map(([x, y]) => at(x, y)),
  };
}

/**
 * Offset an open polyline into the body.
 *
 * The line is authored rear -> front, so the body interior is on its right;
 * offsetting along the averaged segment normal (rather than straight down)
 * is what lets a near-vertical windscreen and a flat roof share one rule.
 */
function inset(line: readonly Point2[], d: number): Point2[] {
  return line.map((point, i) => {
    const prev = line[Math.max(i - 1, 0)] as Point2;
    const next = line[Math.min(i + 1, line.length - 1)] as Point2;
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    return [point[0] + (dy / len) * d, point[1] - (dx / len) * d] as Point2;
  });
}

/** Glazing: everything between the beltline and the underside of the roof skin. */
function glazing(belt: readonly Point2[], roof: readonly Point2[], skin: number): Point2[] {
  return [...belt, ...inset(roof, skin).reverse()];
}

/** Painted roof skin — the strip the glazing tucks under. */
function roofSkin(
  roof: readonly Point2[],
  thickness: number,
  width: number,
  mat: MeshStandardMaterial,
  radius = 0.03,
): Mesh {
  return profile([...roof, ...inset(roof, thickness).reverse()], width, mat, {
    radius,
    bevel: 0.02,
  });
}

/** Door shut line: a dark inset in both flanks. */
function seam(x: number, yLow: number, yHigh: number, z: number, rake = 0): Object3D[] {
  return mirrored(z, (zz) =>
    box([0.024, yHigh - yLow, 0.05], material('plastic'), {
      at: [x, (yLow + yHigh) / 2, zz],
      rot: [0, 0, rake],
    }),
  );
}

/** Body-side crease or trim strip running along both flanks. */
function crease(
  x0: number,
  x1: number,
  y: number,
  z: number,
  mat: MeshStandardMaterial,
  h = 0.028,
): Object3D[] {
  return mirrored(z, (zz) => box([x1 - x0, h, 0.05], mat, { at: [(x0 + x1) / 2, y, zz] }));
}

/** Bar between two side-view points, on both flanks: pillars, rails, carriers. */
function strut(
  a: Point2,
  b: Point2,
  z: number,
  thick: number,
  depth: number,
  mat: MeshStandardMaterial,
): Object3D[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return mirrored(z, (zz) =>
    box([Math.hypot(dx, dy), thick, depth], mat, {
      at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, zz],
      rot: [0, 0, Math.atan2(dy, dx)],
    }),
  );
}

/** Door pull. `flush` draws the Model 3's near-hidden slot. */
function handle(x: number, y: number, z: number, len: number, flush = false): Object3D[] {
  return mirrored(z, (zz) =>
    box([len, flush ? 0.02 : 0.034, flush ? 0.016 : 0.028], material('chrome'), { at: [x, y, zz] }),
  );
}

/** Louvred lid — slats lying along the lid's slope, across the car's centre. */
function louvres(
  centre: Point2,
  span: number,
  width: number,
  count: number,
  rake: number,
): Object3D[] {
  const [cx, cy] = centre;
  const parts: Object3D[] = [
    box([span, 0.022, width], material('plastic'), { at: [cx, cy, 0], rot: [0, 0, rake] }),
  ];
  for (let i = 0; i < count; i += 1) {
    const t = (i + 0.5) / count - 0.5;
    parts.push(
      box([span / (count * 1.9), 0.03, width * 0.96], material('steel'), {
        at: [cx + t * span * Math.cos(rake), cy + t * span * Math.sin(rake) + 0.016, 0],
        rot: [0, 0, rake],
      }),
    );
  }
  return parts;
}

/** Round headlamp: chrome rim and lens, as the 911 and Wrangler wear them. */
function roundLamp(x: number, y: number, z: number, r: number): Object3D[] {
  return [
    ...mirrored(z, (zz) =>
      cyl(r, 0.05, material('chrome'), { axis: 'x', at: [x - 0.035, y, zz], segments: 14 }),
    ),
    ...mirrored(z, (zz) =>
      cyl(r * 0.76, 0.05, material('headlight'), {
        axis: 'x',
        at: [x - 0.012, y, zz],
        segments: 14,
      }),
    ),
  ];
}

/**
 * Cooling mouth in the flank: shaded throat with a lit leading lip. `outerZ` is
 * where the lip lands, so a scoop never pushes the body past its own width.
 */
function sideIntake(
  x: number,
  y: number,
  len: number,
  h: number,
  outerZ: number,
  rake = 0,
): Object3D[] {
  const depth = 0.1;
  return [
    ...mirrored(outerZ - depth / 2 - 0.015, (zz) =>
      box([len, h, depth], material('plastic'), { at: [x, y, zz], rot: [0, 0, rake] }),
    ),
    ...mirrored(outerZ - depth / 2, (zz) =>
      box([len * 0.94, 0.022, depth], material('chrome'), {
        at: [x, y + h / 2, zz],
        rot: [0, 0, rake],
      }),
    ),
  ];
}

/**
 * Painted rear haunch, both flanks.
 *
 * Not a pod bolted to the door: it runs from the tail forward past the rear
 * arch, its underside buried behind the sill and its crown at the beltline, and
 * its leading edge falls away into the flank so the shoulder dies out over the
 * door instead of ending in a panel joint. What is left to see is a body that is
 * simply wider at the back, which is what a Mustang, a 911 and a Corvette are.
 * `outerZ` is where the outboard face lands, and therefore how such a car
 * reaches its catalogued width.
 */
function haunch(
  xBack: number,
  xFront: number,
  yLow: number,
  yHigh: number,
  outerZ: number,
  depth: number,
  mat: MeshStandardMaterial,
): Object3D[] {
  const crown = xBack + (xFront - xBack) * 0.45;
  const outline: Point2[] = [
    [xBack, yLow],
    [xBack, yHigh],
    [crown, yHigh],
    [xFront, yLow + (yHigh - yLow) * 0.3],
    [xFront, yLow],
  ];
  return mirrored(outerZ - depth / 2, (zz) =>
    profile(outline, depth, mat, {
      radius: Math.min((xFront - xBack) * 0.22, (yHigh - yLow) * 0.7),
      bevel: depth * 0.3,
      at: [0, 0, zz],
    }),
  );
}

/**
 * Wheel-arch lip: a fan of tangent blocks over the upper arc, both flanks.
 *
 * An arch is only ever the top half of a circle, so this walks the arc about the
 * axle: it cannot reach below the ground plane or out past the paint the way a
 * swept full torus does.
 */
function archLip(
  x: number,
  axleY: number,
  radius: number,
  outerZ: number,
  mat: MeshStandardMaterial,
  depth = 0.055,
): Object3D[] {
  const parts: Object3D[] = [];
  const span = 2.6;
  const steps = 4;
  const step = span / steps;
  const chord = 2 * radius * Math.sin(step / 2) * 1.2;
  for (let i = 0; i < steps; i += 1) {
    const a = Math.PI / 2 - span / 2 + (i + 0.5) * step;
    parts.push(
      ...mirrored(outerZ - depth / 2, (zz) =>
        box([chord, radius * 0.1, depth], mat, {
          at: [x + radius * Math.cos(a), axleY + radius * Math.sin(a), zz],
          rot: [0, 0, a + Math.PI / 2],
        }),
      ),
    );
  }
  return parts;
}

/** Chrome tailpipe tips. */
function pipes(x: number, y: number, z: number, r = 0.042, len = 0.18): Object3D[] {
  return mirrored(z, (zz) =>
    cyl(r, len, material('chrome'), { axis: 'x', at: [x, y, zz], segments: 10 }),
  );
}

/** Full-width tail light bar, with the lit strip along its top. */
function tailBar(x: number, y: number, width: number, h: number): Object3D[] {
  return [
    box([0.07, h, width], material('taillight'), { at: [x, y, 0] }),
    box([0.055, h * 0.3, width * 0.98], material('chrome'), { at: [x - 0.008, y + h * 0.33, 0] }),
  ];
}

/** Number plate. */
function plate(x: number, y: number, w = 0.42, h = 0.12): Mesh {
  return box([0.022, h, w], material('signWhite'), { at: [x, y, 0] });
}

/** Wiper pair lying across the cowl. */
function wipers(x: number, y: number, z: number, len: number): Object3D[] {
  return mirrored(z, (zz) =>
    box([0.035, 0.02, len], material('plastic'), { at: [x, y, zz], rot: [0, 0, 0.16] }),
  );
}

/** Mirror glass on the outboard face of `carShell`'s mirror block. */
function mirrorGlass(x: number, y: number, z: number): Object3D[] {
  return mirrored(z, (zz) => box([0.02, 0.07, 0.075], material('glass'), { at: [x - 0.045, y, zz] }));
}

/* ------------------------------------------------------------------ Civic */

/**
 * Compact fastback: the roofline peaks early and runs all the way back into a
 * short deck, and the tail wears the wing-shaped lamp that names the model.
 */
export function buildHondaCivic(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  const L = 4.67;
  const W = 1.8;
  const H = 1.42;
  const belt: Point2[] = [
    [15.0, 25.1],
    [24.5, 22.3],
    [30.0, 20.9],
    [47.5, 21.0],
    [63.6, 20.5],
    [68.4, 19.7],
  ];
  const roof: Point2[] = [
    [15.0, 25.1],
    [20.4, 21.7],
    [26.3, 18.3],
    [32.4, 15.2],
    [39.0, 13.0],
    [49.9, 11.8],
    [60.4, 12.7],
    [65.2, 15.4],
    [68.4, 19.7],
  ];
  const lower: Point2[] = [
    [74.0, 20.7],
    [82.9, 22.6],
    [89.6, 26.8],
    [90.7, 29.4],
    [90.1, 32.2],
    [84.4, 33.8],
    [16.4, 34.4],
    [9.4, 33.2],
    [8.7, 29.8],
    [10.2, 26.4],
  ];
  const f = iconFrame(L, H, belt, roof, lower);
  const paint = material('paint', params.color);
  const chrome = material('chrome');
  const dark = material('plastic');
  const roofline = f.line(roof);
  const hullWidth = W - 0.03;
  const zBody = hullWidth / 2 - FLANK;
  const zGlass = (hullWidth - 0.16) / 2;
  const wheelR = f.r(5.2);

  const group = carShell(
    {
      length: L,
      width: hullWidth,
      height: H,
      wheelRadius: wheelR,
      wheelWidth: 0.235,
      axles: [f.x(73.4), f.x(24.0)],
      hull: [...f.line(belt), ...f.line(lower)],
      hullRadius: 0.11,
      glass: glazing(f.line(belt), roofline, 0.085),
      glassRadius: 0.1,
      headlight: { x: f.x(87.0), y: f.y(26.3), z: 0.6, w: 0.34, h: f.dy(2.2) },
      taillight: { x: f.x(10.0), y: f.y(29.6), z: 0.68, w: 0.2, h: f.dy(3.0) },
      mirror: { x: f.x(67.0), y: f.y(20.2) },
      bumper: { y: f.y(32.6), h: f.dy(2.6) },
      sill: [f.y(33.9), 0.075],
      grille: [f.y(30.6), f.dy(2.6)],
      exhaust: { x: -L / 2 + 0.09, y: f.y(33.0), z: 0.42 },
    },
    params,
  );

  group.add(roofSkin(roofline, 0.085, zGlass * 2 + 0.06, paint));
  group.add(...archLip(f.x(24.0), wheelR, f.r(6.7), W / 2, paint));
  group.add(...archLip(f.x(73.4), wheelR, f.r(6.7), W / 2, paint));

  // A, B and the long raked C pillar: the fastback's own signature.
  group.add(...strut(f.at(67.8, 19.9), f.at(61.2, 13.8), zGlass, 0.075, 0.07, paint));
  group.add(...strut(f.at(48.2, 20.8), f.at(47.4, 14.6), zGlass, 0.06, 0.07, paint));
  group.add(...strut(f.at(29.6, 20.5), f.at(37.2, 16.2), zGlass, 0.08, 0.07, paint));

  group.add(...seam(f.x(47.6), f.y(34.0), f.y(21.0), zBody));
  group.add(...seam(f.x(29.8), f.y(34.2), f.y(20.8), zBody));
  group.add(...seam(f.x(63.8), f.y(33.6), f.y(20.6), zBody));
  group.add(...crease(f.x(20.0), f.x(80.0), f.y(27.7), zBody, paint, 0.026));
  group.add(...crease(f.x(30.0), f.x(66.0), f.y(21.4), zGlass + 0.02, chrome, 0.024));
  group.add(...handle(f.x(44.6), f.y(22.2), zBody, f.dx(3.2)));
  group.add(...handle(f.x(58.2), f.y(22.1), zBody, f.dx(3.2)));

  // Wing tail lamp: a full-width bar with the inboard block turning up the tail.
  group.add(...tailBar(f.x(9.3), f.y(27.8), hullWidth * 0.84, f.dy(2.0)));
  group.add(box([0.05, f.dy(1.6), hullWidth * 0.7], paint, { at: [f.x(11.6), f.y(31.6), 0] }));
  group.add(plate(f.x(11.0), f.y(31.4), 0.4, 0.11));
  group.add(plate(f.x(90.0), f.y(31.6), 0.4, 0.11));

  // Slim swept lamp over a wide lower intake.
  group.add(...strut(f.at(84.4, 25.0), f.at(88.8, 26.8), zBody - 0.05, 0.03, 0.05, chrome));
  group.add(box([0.1, f.dy(1.6), hullWidth * 0.66], dark, { at: [f.x(89.0), f.y(33.0), 0] }));
  group.add(...wipers(f.x(70.6), f.y(20.3), 0.36, 0.5));
  group.add(...mirrorGlass(f.x(67.0), f.y(20.2), hullWidth / 2 - 0.045));
  group.add(
    box([0.13, 0.045, 0.035], dark, { at: [f.x(33.0), f.y(15.9), 0], rot: [0, 0, -0.42] }),
  );
  return group;
}

/* ------------------------------------------------------------------ Camry */

/**
 * Upright three-box saloon: taller cabin, notched deck and the chrome window
 * surround that separates it from the Civic at a glance.
 */
export function buildToyotaCamry(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  const L = 4.88;
  const W = 1.84;
  const H = 1.45;
  const belt: Point2[] = [
    [22.4, 23.3],
    [27.4, 21.6],
    [35.6, 20.8],
    [48.2, 20.5],
    [64.4, 20.3],
    [69.6, 19.4],
  ];
  const roof: Point2[] = [
    [22.4, 23.2],
    [27.6, 19.2],
    [32.6, 14.6],
    [38.4, 12.2],
    [50.9, 10.7],
    [62.4, 11.6],
    [66.4, 15.0],
    [69.6, 19.4],
  ];
  const lower: Point2[] = [
    [75.0, 20.4],
    [83.9, 22.2],
    [90.4, 26.0],
    [91.3, 29.0],
    [90.8, 31.8],
    [85.0, 33.6],
    [15.0, 34.6],
    [8.4, 32.8],
    [7.8, 29.0],
    [9.6, 26.1],
    [12.4, 25.3],
  ];
  const f = iconFrame(L, H, belt, roof, lower);
  const paint = material('paint', params.color);
  const chrome = material('chrome');
  const dark = material('plastic');
  const roofline = f.line(roof);
  const hullWidth = W - 0.03;
  const zBody = hullWidth / 2 - FLANK;
  const zGlass = (hullWidth - 0.16) / 2;
  const wheelR = f.r(5.3);

  const group = carShell(
    {
      length: L,
      width: hullWidth,
      height: H,
      wheelRadius: wheelR,
      wheelWidth: 0.24,
      axles: [f.x(74.0), f.x(23.5)],
      hull: [...f.line(belt), ...f.line(lower)],
      hullRadius: 0.12,
      glass: glazing(f.line(belt), roofline, 0.08),
      glassRadius: 0.09,
      headlight: { x: f.x(85.6), y: f.y(24.4), z: 0.6, w: 0.36, h: f.dy(2.4) },
      taillight: { x: f.x(9.0), y: f.y(28.5), z: 0.66, w: 0.26, h: f.dy(3.2) },
      mirror: { x: f.x(68.4), y: f.y(20.0) },
      bumper: { y: f.y(32.6), h: f.dy(2.8) },
      sill: [f.y(34.1), 0.08],
      grille: [f.y(30.8), f.dy(2.6)],
    },
    params,
  );

  group.add(roofSkin(roofline, 0.08, zGlass * 2 + 0.06, paint));
  group.add(...archLip(f.x(23.5), wheelR, f.r(6.9), W / 2, paint));
  group.add(...archLip(f.x(74.0), wheelR, f.r(6.9), W / 2, paint));

  // Upright pillars — the Camry's cabin is a box, not a wedge.
  group.add(...strut(f.at(68.8, 19.6), f.at(62.9, 12.0), zGlass, 0.08, 0.07, paint));
  group.add(...strut(f.at(48.2, 20.4), f.at(47.6, 12.4), zGlass, 0.06, 0.07, paint));
  group.add(...strut(f.at(35.6, 20.6), f.at(38.0, 13.0), zGlass, 0.07, 0.07, paint));

  // Chrome window surround: sill strip, both pillars, drip rail.
  group.add(...crease(f.x(35.4), f.x(65.0), f.y(20.4), zGlass + 0.02, chrome, 0.026));
  group.add(...strut(f.at(38.2, 12.6), f.at(62.6, 12.0), zGlass + 0.02, 0.026, 0.05, chrome));
  group.add(...strut(f.at(62.9, 12.2), f.at(68.4, 19.4), zGlass + 0.02, 0.026, 0.05, chrome));
  group.add(...strut(f.at(38.0, 12.8), f.at(35.4, 20.4), zGlass + 0.02, 0.026, 0.05, chrome));
  group.add(...crease(f.x(13.4), f.x(21.6), f.y(24.8), zBody, chrome, 0.026));

  group.add(...seam(f.x(48.2), f.y(34.2), f.y(20.6), zBody));
  group.add(...seam(f.x(35.8), f.y(34.4), f.y(20.8), zBody));
  group.add(...seam(f.x(64.6), f.y(33.8), f.y(20.4), zBody));
  group.add(...crease(f.x(18.0), f.x(82.0), f.y(26.8), zBody, paint, 0.026));
  group.add(...crease(f.x(20.0), f.x(80.0), f.y(30.6), zBody, paint, 0.024));
  group.add(...handle(f.x(45.0), f.y(21.9), zBody, f.dx(3.2)));
  group.add(...handle(f.x(59.0), f.y(21.7), zBody, f.dx(3.2)));

  // Deep upright grille in two chrome-edged tiers, then the long flat deck.
  group.add(box([0.09, f.dy(3.8), W * 0.5], dark, { at: [f.x(87.0), f.y(26.7), 0] }));
  group.add(box([0.1, 0.026, W * 0.52], chrome, { at: [f.x(87.0), f.y(24.9), 0] }));
  group.add(box([0.1, f.dy(2.4), W * 0.62], dark, { at: [f.x(88.4), f.y(32.6), 0] }));
  group.add(plate(f.x(89.6), f.y(30.4)));
  group.add(plate(f.x(11.2), f.y(31.0)));
  group.add(box([0.05, f.dy(1.4), hullWidth * 0.72], paint, { at: [f.x(12.6), f.y(30.6), 0] }));
  group.add(...pipes(f.x(13.4), f.y(33.0), 0.28));
  group.add(...wipers(f.x(72.0), f.y(20.1), 0.38, 0.52));
  group.add(...mirrorGlass(f.x(68.4), f.y(20.0), hullWidth / 2 - 0.045));
  group.add(
    box([0.13, 0.045, 0.035], dark, { at: [f.x(31.0), f.y(15.4), 0], rot: [0, 0, -0.6] }),
  );
  return group;
}

/* --------------------------------------------------------------- Model 3 */

/**
 * Cab-forward, grille-less, and roofed in one continuous pane: the canopy runs
 * from the cowl over the crest and down to the deck without a painted break,
 * which is the whole silhouette. Handles are flush and the charge port sits on
 * the left rear quarter.
 */
export function buildTeslaModel3(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  const L = 4.72;
  const W = 1.85;
  const H = 1.44;
  const belt: Point2[] = [
    [15.6, 24.4],
    [24.4, 23.6],
    [33.0, 21.4],
    [41.0, 20.7],
    [54.0, 20.4],
    [68.6, 20.1],
    [74.2, 19.4],
  ];
  const roof: Point2[] = [
    [15.6, 24.4],
    [22.0, 20.8],
    [28.6, 17.2],
    [35.4, 14.2],
    [42.4, 12.0],
    [54.0, 10.95],
    [64.4, 12.3],
    [70.3, 15.2],
    [74.2, 19.3],
  ];
  const lower: Point2[] = [
    [79.0, 20.4],
    [85.7, 22.8],
    [90.6, 26.6],
    [91.2, 29.2],
    [90.6, 31.8],
    [85.0, 33.4],
    [16.6, 34.2],
    [10.0, 32.6],
    [9.4, 28.8],
    [11.2, 25.8],
  ];
  const f = iconFrame(L, H, belt, roof, lower);
  const paint = material('paint', params.color);
  const chrome = material('chrome');
  const dark = material('plastic');
  const roofline = f.line(roof);
  const hullWidth = W - 0.03;
  const zBody = hullWidth / 2 - FLANK;
  const zGlass = (hullWidth - 0.16) / 2;
  const wheelR = f.r(5.3);

  const group = carShell(
    {
      length: L,
      width: hullWidth,
      height: H,
      wheelRadius: wheelR,
      wheelWidth: 0.245,
      axles: [f.x(75.0), f.x(23.0)],
      hull: [...f.line(belt), ...f.line(lower)],
      hullRadius: 0.12,
      // No skin: the glass reaches the crest, so the canopy is unbroken.
      glass: [...f.line(belt), ...roofline.slice().reverse()],
      glassRadius: 0.1,
      headlight: { x: f.x(86.6), y: f.y(26.2), z: 0.6, w: 0.34, h: f.dy(2.2) },
      taillight: { x: f.x(9.8), y: f.y(28.0), z: 0.66, w: 0.26, h: f.dy(2.8) },
      mirror: { x: f.x(72.6), y: f.y(20.3) },
      bumper: { y: f.y(32.4), h: f.dy(2.6) },
      sill: [f.y(33.8), 0.075],
    },
    params,
  );

  // Roof trim instead of a roof panel: two slim rails along the glass edges.
  group.add(...strut(f.at(30.0, 16.6), f.at(50.0, 11.6), zGlass, 0.03, 0.06, dark));
  group.add(...strut(f.at(50.0, 11.6), f.at(66.0, 12.9), zGlass, 0.03, 0.06, dark));
  group.add(...archLip(f.x(23.0), wheelR, f.r(6.9), W / 2, paint));
  group.add(...archLip(f.x(75.0), wheelR, f.r(6.9), W / 2, paint));

  // Pillars drawn over the canopy rather than breaking it.
  group.add(...strut(f.at(73.6, 19.6), f.at(65.0, 12.8), zGlass, 0.07, 0.07, paint));
  group.add(...strut(f.at(49.2, 20.5), f.at(49.0, 11.5), zGlass, 0.055, 0.07, paint));
  group.add(...strut(f.at(32.8, 20.9), f.at(36.6, 14.4), zGlass, 0.06, 0.07, paint));

  group.add(...seam(f.x(49.2), f.y(34.0), f.y(20.7), zBody));
  group.add(...seam(f.x(33.0), f.y(34.1), f.y(20.9), zBody));
  group.add(...seam(f.x(69.2), f.y(33.5), f.y(20.3), zBody));
  group.add(...crease(f.x(20.0), f.x(80.0), f.y(28.0), zBody, paint, 0.024));
  group.add(...handle(f.x(43.2), f.y(22.0), zBody, f.dx(3.2), true));
  group.add(...handle(f.x(58.6), f.y(21.8), zBody, f.dx(3.2), true));

  // Charge port, left rear quarter only — the tile draws one, so does the car.
  group.add(
    cyl(f.dx(1.7), 0.03, dark, { axis: 'z', at: [f.x(17.6), f.y(28.4), -zBody], segments: 12 }),
  );
  group.add(
    cyl(f.dx(0.6), 0.05, chrome, {
      axis: 'z',
      at: [f.x(17.6), f.y(28.4), -zBody - 0.01],
      segments: 10,
    }),
  );

  // Grille-less nose: one cooling slot low in the bumper and nothing above it.
  group.add(box([0.1, f.dy(1.5), hullWidth * 0.6], dark, { at: [f.x(88.4), f.y(31.2), 0] }));
  group.add(...strut(f.at(84.2, 24.8), f.at(88.8, 26.6), zBody - 0.05, 0.028, 0.05, chrome));
  group.add(...tailBar(f.x(9.4), f.y(27.4), hullWidth * 0.8, f.dy(1.5)));
  group.add(plate(f.x(11.0), f.y(31.2), 0.4, 0.11));
  group.add(plate(f.x(89.6), f.y(30.8), 0.4, 0.11));
  group.add(...wipers(f.x(76.4), f.y(20.2), 0.38, 0.54));
  group.add(...mirrorGlass(f.x(72.6), f.y(20.3), hullWidth / 2 - 0.045));
  return group;
}

/* --------------------------------------------------------------- Mustang */

/**
 * Long hood, short notch deck, fastback roof. The hood carries two power domes,
 * the rear quarter a scoop, the tail three-bar lamps and four pipes.
 */
export function buildFordMustang(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  const L = 4.81;
  const W = 1.92;
  const H = 1.4;
  const belt: Point2[] = [
    [17.6, 23.6],
    [24.0, 21.8],
    [29.5, 20.5],
    [40.0, 20.2],
    [52.0, 20.0],
    [57.4, 18.7],
  ];
  const roof: Point2[] = [
    [17.6, 23.6],
    [22.0, 20.7],
    [26.2, 17.8],
    [30.2, 15.3],
    [34.4, 13.3],
    [42.9, 12.0],
    [50.8, 12.5],
    [54.5, 14.6],
    [57.4, 18.7],
  ];
  const lower: Point2[] = [
    [62.4, 19.7],
    [75.0, 20.9],
    [87.0, 23.5],
    [90.5, 26.4],
    [90.9, 28.5],
    [90.2, 32.0],
    [84.6, 33.6],
    [16.0, 34.4],
    [9.4, 32.6],
    [8.7, 28.4],
    [10.2, 24.4],
    [13.6, 22.8],
  ];
  const f = iconFrame(L, H, belt, roof, lower);
  const paint = material('paint', params.color);
  const chrome = material('chrome');
  const dark = material('plastic');
  const roofline = f.line(roof);
  const hullWidth = W - 0.12;
  const zBody = hullWidth / 2 - FLANK;
  const zGlass = (hullWidth - 0.16) / 2;
  const wheelR = f.r(5.9);

  const group = carShell(
    {
      length: L,
      width: hullWidth,
      height: H,
      wheelRadius: wheelR,
      wheelWidth: 0.27,
      axles: [f.x(73.6), f.x(22.8)],
      hull: [...f.line(belt), ...f.line(lower)],
      hullRadius: 0.11,
      glass: glazing(f.line(belt), roofline, 0.08),
      glassRadius: 0.09,
      headlight: { x: f.x(84.6), y: f.y(25.2), z: 0.62, w: 0.32, h: f.dy(2.6) },
      mirror: { x: f.x(61.2), y: f.y(20.0) },
      sill: [f.y(33.8), 0.08],
      grille: [f.y(28.0), f.dy(4.8)],
      discBrakes: true,
    },
    params,
  );

  group.add(roofSkin(roofline, 0.08, zGlass * 2 + 0.06, paint));

  // Hips: the widest part of a Mustang stands over its rear tyres.
  group.add(...haunch(f.x(10.0), f.x(36.0), f.y(33.8), f.y(24.6), W / 2, 0.13, paint));
  group.add(...archLip(f.x(22.8), wheelR, f.r(7.4), W / 2, paint));
  group.add(...archLip(f.x(73.6), wheelR, f.r(7.4), hullWidth / 2, paint));

  group.add(...strut(f.at(61.0, 19.6), f.at(51.6, 13.2), zGlass, 0.085, 0.07, paint));
  group.add(...strut(f.at(39.8, 20.3), f.at(38.6, 14.6), zGlass, 0.06, 0.07, paint));
  group.add(...seam(f.x(40.0), f.y(34.2), f.y(20.4), zBody));
  group.add(...seam(f.x(57.4), f.y(33.8), f.y(20.0), zBody));
  group.add(...handle(f.x(53.4), f.y(21.6), zBody, f.dx(3.2)));

  // Twin power domes lying along the long hood.
  group.add(...strut(f.at(65.0, 20.0), f.at(85.0, 22.6), 0.24, 0.055, 0.2, paint));
  group.add(...crease(f.x(66.0), f.x(82.0), f.y(23.4), zBody, paint, 0.026));

  // Quarter scoop ahead of the rear arch.
  group.add(...sideIntake(f.x(33.4), f.y(27.6), f.dx(7.0), f.dy(2.6), W / 2 - 0.02, 0.08));

  // Three bars per side marching inboard across the tail, quad pipes below.
  for (const [i, tz] of [0.74, 0.58, 0.42].entries()) {
    group.add(
      ...mirrored(tz, (zz) =>
        box([0.07, f.dy(4.2), f.dx(1.3)], material('taillight'), {
          at: [f.x(10.2) + i * 0.035, f.y(26.6), zz],
        }),
      ),
    );
  }
  group.add(...pipes(f.x(15.0), f.y(33.0), 0.2, 0.05));
  group.add(...pipes(f.x(15.0), f.y(33.0), 0.36, 0.05));
  group.add(box([0.05, f.dy(1.6), hullWidth * 0.6], paint, { at: [f.x(14.6), f.y(31.0), 0] }));
  group.add(plate(f.x(13.0), f.y(31.6), 0.4, 0.11));
  group.add(plate(f.x(89.8), f.y(31.0), 0.4, 0.11));
  // Valances rather than `carShell`'s bumper strip: on a body this low and this
  // pointed, a full-width strip at the very tip stands off the corners.
  group.add(box([0.14, f.dy(2.6), hullWidth * 0.7], dark, { at: [f.x(89.4), f.y(32.6), 0] }));
  group.add(box([0.14, f.dy(2.6), hullWidth * 0.7], dark, { at: [f.x(11.4), f.y(33.0), 0] }));
  group.add(...strut(f.at(82.2, 24.0), f.at(86.8, 25.6), zBody - 0.05, 0.03, 0.05, chrome));
  group.add(...wipers(f.x(60.0), f.y(19.5), 0.36, 0.5));
  group.add(...mirrorGlass(f.x(61.2), f.y(20.0), hullWidth / 2 - 0.045));
  return group;
}

/* -------------------------------------------------------------- Corvette */

/**
 * Mid-engine wedge: low nose, cabin shoved forward under flying buttresses, and
 * a rear deck that stands higher than the cowl. Side intakes feed the engine
 * bay, the lid is louvred, the lamps are quad and the exhaust exits at centre.
 */
export function buildChevroletCorvette(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  const L = 4.63;
  const W = 1.93;
  const H = 1.23;
  const belt: Point2[] = [
    [14.6, 21.2],
    [18.6, 22.4],
    [26.0, 21.8],
    [35.6, 19.9],
    [45.0, 19.0],
    [52.0, 18.2],
    [55.8, 22.4],
    [66.0, 22.6],
    [70.0, 23.4],
    [73.6, 24.4],
  ];
  const roof: Point2[] = [
    [52.0, 18.2],
    [57.4, 14.9],
    [62.5, 15.1],
    [66.6, 16.4],
    [70.4, 20.3],
    [73.6, 24.4],
  ];
  const lower: Point2[] = [
    [78.6, 25.2],
    [82.9, 24.8],
    [86.6, 26.0],
    [90.4, 29.2],
    [90.2, 32.6],
    [89.4, 34.6],
    [15.4, 35.2],
    [8.6, 30.4],
    [7.4, 26.2],
    [9.8, 22.6],
  ];
  const f = iconFrame(L, H, belt, roof, lower);
  const paint = material('paint', params.color);
  const chrome = material('chrome');
  const dark = material('plastic');
  const roofline = f.line(roof);
  const hullWidth = W - 0.16;
  const zBody = hullWidth / 2 - FLANK;
  const zGlass = (hullWidth - 0.16) / 2;
  const rearR = f.r(5.9);

  const group = carShell(
    {
      length: L,
      width: hullWidth,
      height: H,
      wheelRadius: f.r(5.5),
      wheelWidth: 0.27,
      // Front axle only: the rear runs a taller, wider tyre, added below.
      axles: [f.x(75.2)],
      hull: [...f.line(belt), ...f.line(lower)],
      hullRadius: 0.1,
      glass: glazing(f.line(belt).slice(5), roofline, 0.07),
      glassRadius: 0.08,
      headlight: { x: f.x(86.0), y: f.y(28.4), z: 0.62, w: 0.3, h: f.dy(2.0) },
      mirror: { x: f.x(72.6), y: f.y(24.2) },
      sill: [f.y(34.6), 0.08],
      discBrakes: true,
    },
    params,
  );
  addWheels(group, {
    radius: rearR,
    width: 0.3,
    xs: [f.x(26.0)],
    z: W / 2 - 0.05,
    disc: true,
  });

  group.add(roofSkin(roofline, 0.07, zGlass * 2 + 0.06, paint));

  // The haunch is the widest thing on the car and stands over the rear tyre.
  group.add(...haunch(f.x(11.0), f.x(40.0), f.y(34.8), f.y(21.4), W / 2, 0.17, paint));
  group.add(...archLip(f.x(26.0), rearR, f.r(7.6), W / 2, paint));
  group.add(...archLip(f.x(75.2), f.r(5.5), f.r(7.2), hullWidth / 2, paint));

  // Flying buttress each side of the rear screen, then the louvred lid.
  group.add(...strut(f.at(52.4, 18.8), f.at(43.0, 20.6), zGlass + 0.02, 0.11, 0.09, paint));
  group.add(...strut(f.at(72.4, 24.2), f.at(66.4, 17.2), zGlass, 0.085, 0.07, paint));
  group.add(...strut(f.at(66.0, 22.7), f.at(61.0, 15.9), zGlass, 0.055, 0.07, paint));
  group.add(...louvres(f.at(24.7, 22.4), f.dx(7.4), W * 0.44, 4, 0.21));

  // Side intake into the engine bay, with the crease that leads into it.
  group.add(...sideIntake(f.x(42.0), f.y(26.8), f.dx(8.6), f.dy(3.0), W / 2 - 0.06, 0.06));
  group.add(...crease(f.x(50.0), f.x(68.0), f.y(28.6), zBody, paint, 0.026));
  group.add(...seam(f.x(56.2), f.y(34.7), f.y(22.6), zBody));
  group.add(...seam(f.x(67.2), f.y(34.5), f.y(22.8), zBody));
  group.add(...handle(f.x(60.4), f.y(23.7), zBody, f.dx(2.8)));

  // Quad lamps: an inboard and an outboard block each side of the tail.
  for (const ty of [24.5, 27.5]) {
    group.add(
      ...mirrored(0.44, (zz) =>
        box([0.07, f.dy(2.2), f.dx(2.4)], material('taillight'), { at: [f.x(8.9), f.y(ty), zz] }),
      ),
    );
  }

  // Centre-exit quad tips and the front splitter blade.
  group.add(...pipes(f.x(15.4), f.y(32.1), 0.1, 0.048));
  group.add(...pipes(f.x(15.4), f.y(32.1), 0.24, 0.048));
  group.add(box([f.dx(7.4), 0.035, hullWidth * 0.78], dark, { at: [f.x(86.2), f.y(33.8), 0] }));
  group.add(box([0.14, f.dy(2.4), hullWidth * 0.7], dark, { at: [f.x(11.0), f.y(33.8), 0] }));
  group.add(...strut(f.at(82.6, 27.2), f.at(87.8, 28.8), zBody - 0.05, 0.03, 0.05, chrome));
  group.add(plate(f.x(11.2), f.y(31.4), 0.38, 0.1));
  group.add(...wipers(f.x(76.0), f.y(25.1), 0.34, 0.46));
  group.add(...mirrorGlass(f.x(72.6), f.y(24.2), hullWidth / 2 - 0.045));
  return group;
}

/* ------------------------------------------------------------------- 911 */

/**
 * Rear-engine fastback: rolled shoulders, a roofline that falls in one unbroken
 * curve from the crest to the ducktail, round lamps standing high on the wings
 * and a full-width bar across the tail.
 */
export function buildPorsche911(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  const L = 4.52;
  const W = 1.85;
  const H = 1.3;
  const belt: Point2[] = [
    [11.0, 24.4],
    [16.2, 22.1],
    [20.4, 23.6],
    [28.0, 25.0],
    [36.0, 23.6],
    [43.0, 21.6],
    [52.0, 20.6],
    [59.2, 20.2],
    [63.4, 19.4],
  ];
  const roof: Point2[] = [
    [20.4, 23.4],
    [25.2, 21.8],
    [30.2, 19.9],
    [35.2, 17.8],
    [40.2, 15.6],
    [47.3, 13.5],
    [53.0, 12.9],
    [58.6, 14.8],
    [63.4, 19.4],
  ];
  const lower: Point2[] = [
    [68.6, 21.4],
    [81.6, 21.4],
    [86.9, 24.3],
    [89.7, 28.6],
    [89.1, 31.2],
    [86.8, 32.9],
    [16.0, 33.6],
    [11.6, 30.2],
    [10.4, 27.3],
  ];
  const f = iconFrame(L, H, belt, roof, lower);
  const paint = material('paint', params.color);
  const chrome = material('chrome');
  const dark = material('plastic');
  const roofline = f.line(roof);
  const hullWidth = W - 0.16;
  const zBody = hullWidth / 2 - FLANK;
  const zGlass = (hullWidth - 0.16) / 2;
  const wheelR = f.r(5.5);

  const group = carShell(
    {
      length: L,
      width: hullWidth,
      height: H,
      wheelRadius: wheelR,
      wheelWidth: 0.26,
      axles: [f.x(73.0), f.x(26.0)],
      hull: [...f.line(belt), ...f.line(lower)],
      hullRadius: 0.13,
      glass: glazing(f.line(belt).slice(2), roofline, 0.075),
      glassRadius: 0.1,
      taillight: { x: f.x(11.0), y: f.y(27.6), z: 0.62, w: 0.22, h: f.dy(2.0) },
      mirror: { x: f.x(62.6), y: f.y(20.4) },
      sill: [f.y(33.0), 0.075],
      grille: [f.y(30.4), f.dy(2.4)],
      discBrakes: true,
    },
    params,
  );

  group.add(roofSkin(roofline, 0.075, zGlass * 2 + 0.06, paint));

  // Rolled shoulders: the rear haunches carry the car's full width and leave
  // the engine lid sitting in the valley between them.
  group.add(...haunch(f.x(12.0), f.x(41.0), f.y(33.2), f.y(22.4), W / 2, 0.16, paint));
  group.add(...archLip(f.x(26.0), wheelR, f.r(7.4), W / 2, paint));
  group.add(...archLip(f.x(73.0), wheelR, f.r(7.2), hullWidth / 2, paint));

  group.add(...strut(f.at(62.6, 19.8), f.at(57.6, 14.6), zGlass, 0.08, 0.07, paint));
  group.add(...strut(f.at(59.2, 20.4), f.at(54.4, 13.9), zGlass, 0.05, 0.07, paint));
  group.add(...strut(f.at(43.0, 21.6), f.at(41.0, 16.6), zGlass, 0.055, 0.07, paint));
  group.add(...seam(f.x(43.2), f.y(33.4), f.y(21.8), zBody));
  group.add(...seam(f.x(60.0), f.y(33.2), f.y(20.6), zBody));
  group.add(...handle(f.x(48.0), f.y(22.6), zBody, f.dx(2.8)));

  // Engine-lid louvres lying along the slope, ducktail lip over the tail edge.
  group.add(...louvres(f.at(24.0, 24.6), f.dx(7.6), W * 0.4, 4, 0.34));
  group.add(
    box([f.dx(5.6), 0.05, hullWidth * 0.78], paint, {
      at: [f.x(15.4), f.y(22.6), 0],
      rot: [0, 0, 0.2],
    }),
  );

  // Round lamps standing high on the wings, flanking a dipped front lid.
  group.add(...roundLamp(f.x(86.0), f.y(24.4), 0.58, f.r(2.4)));
  group.add(box([f.dx(10.0), 0.04, hullWidth * 0.44], paint, { at: [f.x(76.0), f.y(21.8), 0] }));
  group.add(...crease(f.x(24.0), f.x(80.0), f.y(27.4), zBody, paint, 0.026));

  // Full-width tail bar low on the tail, twin pipes below it.
  group.add(...tailBar(f.x(10.8), f.y(27.4), hullWidth * 0.88, f.dy(2.0)));
  group.add(...pipes(f.x(14.0), f.y(31.0), 0.17, 0.05));
  group.add(plate(f.x(12.6), f.y(30.4), 0.36, 0.1));
  group.add(plate(f.x(88.4), f.y(31.0), 0.36, 0.1));
  group.add(box([0.14, f.dy(2.4), hullWidth * 0.72], dark, { at: [f.x(88.0), f.y(32.4), 0] }));
  group.add(box([0.14, f.dy(2.4), hullWidth * 0.72], dark, { at: [f.x(13.0), f.y(32.6), 0] }));
  group.add(...wipers(f.x(66.6), f.y(20.9), 0.34, 0.46));
  group.add(...mirrorGlass(f.x(62.6), f.y(20.4), hullWidth / 2 - 0.045));
  return group;
}

/* -------------------------------------------------------------- Wrangler */

/**
 * All verticals: a flat upright windscreen in a painted frame, slab sides,
 * square flares, round lamps beside a slotted grille, steel bumpers at both
 * ends, axles slung under the floor and the spare bolted to the swing gate.
 */
export function buildJeepWrangler(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  const L = 4.79;
  const W = 1.88;
  const H = 1.87;
  const belt: Point2[] = [
    [22.4, 20.2],
    [27.0, 19.6],
    [44.4, 19.4],
    [59.8, 19.3],
    [63.6, 19.6],
  ];
  const roof: Point2[] = [
    [26.8, 8.4],
    [27.8, 7.4],
    [62.4, 7.0],
    [63.4, 7.6],
  ];
  const lower: Point2[] = [
    [85.0, 19.0],
    [86.4, 25.8],
    [87.6, 28.2],
    [84.0, 30.2],
    [24.6, 31.6],
    [22.6, 30.6],
  ];
  /** The spare hangs past the tailgate; it is part of the catalogued length. */
  const spare: Point2[] = [[15.5, 24.0]];
  const f = iconFrame(L, H, belt, roof, lower, spare);
  const paint = material('paint', params.color);
  const chrome = material('chrome');
  const steel = material('steel');
  const dark = material('plastic');
  const roofline = f.line(roof);
  const hullWidth = W - 0.14;
  const zBody = hullWidth / 2 - FLANK;
  const zGlass = (hullWidth - 0.16) / 2;
  const wheelR = f.r(6.0);

  const group = carShell(
    {
      length: L,
      width: hullWidth,
      height: H,
      wheelRadius: wheelR,
      wheelWidth: 0.29,
      axles: [f.x(74.0), f.x(34.6)],
      hull: [...f.line(belt), ...f.line(lower)],
      hullRadius: 0.05,
      glass: glazing(f.line(belt).slice(1), roofline, 0.08),
      glassRadius: 0.03,
      taillight: { x: f.x(23.0), y: f.y(15.5), z: 0.7, w: f.dx(2.4), h: f.dy(3.4) },
      mirror: { x: f.x(62.6), y: f.y(12.8) },
      discBrakes: true,
    },
    params,
  );

  // Hardtop: a flat roof panel and the closed rear quarter beneath it.
  group.add(roofSkin(roofline, 0.09, hullWidth - 0.04, paint, 0.02));
  group.add(
    profile(
      f.line([
        [22.6, 8.6],
        [27.6, 7.6],
        [27.6, 19.8],
        [22.6, 20.2],
      ]),
      hullWidth - 0.04,
      paint,
      { radius: 0.04, bevel: 0.03 },
    ),
  );

  // Windscreen frame and hardtop joints: a Wrangler's glass is bolted into
  // painted steel, and the screen stands up dead vertical.
  group.add(...strut(f.at(63.5, 19.6), f.at(63.2, 7.8), zGlass, 0.08, 0.08, paint));
  group.add(box([f.dx(1.6), 0.07, hullWidth - 0.1], paint, { at: [f.x(63.3), f.y(8.2), 0] }));
  group.add(...strut(f.at(59.9, 19.4), f.at(59.9, 8.2), zGlass, 0.06, 0.08, paint));
  group.add(...strut(f.at(44.5, 19.4), f.at(44.5, 8.4), zGlass, 0.05, 0.08, paint));
  group.add(...strut(f.at(27.8, 9.4), f.at(62.4, 9.0), zBody, 0.03, 0.05, dark));

  // Square flares — a Wrangler's arches are corners, not curves.
  for (const cx of [34.6, 74.0]) {
    group.add(
      ...mirrored(W / 2 - 0.035, (zz) =>
        profile(
          f.line([
            [cx - 7.4, 31.8],
            [cx - 6.8, 26.4],
            [cx + 6.8, 26.0],
            [cx + 7.4, 31.4],
            [cx + 5.4, 31.4],
            [cx + 5.0, 28.0],
            [cx - 5.0, 28.4],
            [cx - 5.4, 31.8],
          ]),
          0.07,
          dark,
          { radius: 0.03, bevel: 0.02, at: [0, 0, zz] },
        ),
      ),
    );
  }

  group.add(...seam(f.x(44.5), f.y(31.2), f.y(19.4), zBody));
  group.add(...seam(f.x(60.2), f.y(30.8), f.y(19.3), zBody));
  group.add(...handle(f.x(48.6), f.y(20.8), zBody, f.dx(3.2)));
  group.add(...handle(f.x(31.6), f.y(21.0), zBody, f.dx(3.2)));
  group.add(...crease(f.x(28.0), f.x(80.0), f.y(23.6), zBody, dark, 0.022));

  // Exposed hinges down the door edges and the screen frame.
  for (const [hx, hy] of [
    [60.5, 11.4],
    [60.7, 16.6],
    [63.5, 20.1],
  ] as const) {
    group.add(
      ...mirrored(zBody, (zz) => box([0.05, 0.07, 0.05], chrome, { at: [f.x(hx), f.y(hy), zz] })),
    );
  }

  // Rock rails on two brackets, not a rocker slab.
  group.add(
    ...mirrored(hullWidth / 2 + 0.02, (zz) =>
      cyl(0.05, f.dx(22.0), steel, { axis: 'x', at: [f.x(54.0), f.y(31.9), zz], segments: 10 }),
    ),
  );
  for (const bx of [46.0, 62.0]) {
    group.add(
      ...mirrored(hullWidth / 2 - 0.03, (zz) =>
        box([0.05, 0.13, 0.09], steel, { at: [f.x(bx), f.y(31.0), zz] }),
      ),
    );
  }

  // Live axles slung under the floor: the ground clearance is the point.
  for (const ax of [34.6, 74.0]) {
    group.add(
      cyl(0.045, hullWidth * 0.92, steel, { axis: 'z', at: [f.x(ax), wheelR, 0], segments: 10 }),
    );
    group.add(sphere(0.11, steel, { at: [f.x(ax), wheelR, -0.1], segments: 10 }));
  }
  group.add(box([f.dx(30.0), 0.07, 0.3], steel, { at: [f.x(54.0), wheelR * 0.85, 0] }));

  // Steel bumpers, front and rear, tow eyes on the front.
  group.add(box([f.dx(6.4), f.dy(2.8), hullWidth + 0.06], steel, { at: [f.x(84.6), f.y(28.0), 0] }));
  group.add(box([f.dx(4.0), f.dy(2.6), hullWidth + 0.04], steel, { at: [f.x(23.4), f.y(29.0), 0] }));
  group.add(
    ...mirrored(0.4, (zz) => box([0.06, 0.07, 0.05], chrome, { at: [f.x(87.2), f.y(29.2), zz] })),
  );

  // Round lamps standing on the front of the wings beside the slotted grille.
  group.add(...roundLamp(f.x(85.9), f.y(22.0), 0.66, f.r(2.6)));
  group.add(box([0.07, f.dy(6.4), W * 0.42], dark, { at: [f.x(86.2), f.y(22.4), 0] }));
  for (let i = 0; i < 7; i += 1) {
    group.add(
      box([0.1, f.dy(5.4), W * 0.036], paint, {
        at: [f.x(86.3), f.y(22.4), (i - 3) * W * 0.058],
      }),
    );
  }
  group.add(
    ...mirrored(0.34, (zz) => box([0.05, 0.05, 0.06], chrome, { at: [f.x(66.6), f.y(20.4), zz] })),
  );

  // Full-size spare on the swing gate, carrier arm and all.
  group.add(...spareWheel([f.x(19.6), f.y(24.0), 0], f.r(6.1), 0.3));
  group.add(box([0.28, f.dy(1.6), 0.1], steel, { at: [f.x(22.0), f.y(24.0), 0] }));
  group.add(box([0.05, f.dy(1.2), 0.36], steel, { at: [f.x(22.4), f.y(19.0), 0] }));
  group.add(plate(f.x(87.6), f.y(29.4), 0.4, 0.11));
  group.add(...wipers(f.x(65.6), f.y(19.6), 0.42, 0.6));
  group.add(...mirrorGlass(f.x(62.6), f.y(12.8), hullWidth / 2 - 0.045));
  return group;
}
