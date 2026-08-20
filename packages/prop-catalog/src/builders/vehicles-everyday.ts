import { Group, type Mesh, type MeshStandardMaterial, type Object3D } from 'three';

import { box, cyl, mirrored, type Point2, profile } from '../geometry';
import { material } from '../materials';
import { carShell, type CarSpec, DEFAULT_COLOR, type VehicleParams } from './shell';

/**
 * The six generic body styles: saloon, hatch, SUV, pickup, minivan, panel van.
 *
 * These are the shapes the editor falls back to, so they carry the heaviest
 * read of the whole fleet: one glance has to separate six classes of car. They
 * are transcribed from the 2D tiles in `vehicle-art/everyday-cars.tsx`, and the
 * transcription is kept mechanical — every number below is an icon coordinate
 * from that file, converted by `tile()` using the rule in `shell.ts`:
 *
 *     x -> (iconX - iconMid) * length / iconSpan
 *     y -> (41 - iconY) * height / (41 - iconTop)
 *
 * `iconTop` is the *topmost ink* rather than the roof, because that is what the
 * catalogued height measures: the hatch's spoiler, the SUV's roof rails and the
 * van's bare roof all define their own vehicle's height.
 *
 * Each body is three transcriptions of the same tile:
 *
 *   - the painted lower body, up to the beltline, with the wheel openings cut
 *     into its underside (`bodyHull`);
 *   - the painted greenhouse above the beltline, which is the tile's own body
 *     outline, so the roof, both screen rakes and every pillar come for free
 *     and the 3D silhouette matches the drawing;
 *   - the tile's glass panes laid onto that greenhouse — side windows let into
 *     the flank, screens laid on the rake they belong to.
 *
 * The distinctions are drawn into the envelope, not into the trim:
 *
 *   sedan      three-box, notch deck standing below the cabin beltline
 *   hatchback  shortest of the six, vertical tail, roof spoiler, quarter light
 *   suv        tall greenhouse on roof rails, chunky arch flares, rock rails
 *   pickup     single cab plus a genuinely open bed: floor, walls, rail cap
 *   minivan    one box, deepest glass, sliding-door track along the flank
 *   van        blank flank, cab glazing only, rear door seam, roof ribs
 */

/** Ground line in the tile artwork's 96x48 viewBox. */
const GROUND = 41;

interface TileFrame {
  /** Icon x of the rearmost and the foremost body ink. */
  from: number;
  to: number;
  /** Icon y of the topmost ink — roof, roof rail or spoiler. */
  top: number;
  /** Catalogued length and height the tile is transcribed into. */
  l: number;
  h: number;
}

/** One tile's icon space, converted to metres. */
interface Tile {
  /** Icon x to metres, +X towards the nose. */
  x(iconX: number): number;
  /** Icon y to metres above the ground plane. */
  y(iconY: number): number;
  /** Icon span to metres, along X. */
  dx(span: number): number;
  /** Icon span to metres, along Y. */
  dy(span: number): number;
  /** A whole icon-space outline, in order. */
  path(points: readonly Point2[]): Point2[];
}

/** Icon-space to metres, for one vehicle's tile. */
function tile(frame: TileFrame): Tile {
  const sx = frame.l / (frame.to - frame.from);
  const sy = frame.h / (GROUND - frame.top);
  const mid = (frame.from + frame.to) / 2;
  const x = (iconX: number): number => (iconX - mid) * sx;
  const y = (iconY: number): number => (GROUND - iconY) * sy;
  return {
    x,
    y,
    dx: (span: number): number => span * sx,
    dy: (span: number): number => span * sy,
    path: (points: readonly Point2[]): Point2[] => points.map((p) => [x(p[0]), y(p[1])] as Point2),
  };
}

/** A wheel opening: axle centre in metres, and the radius of the opening. */
interface Arch {
  x: number;
  y: number;
  r: number;
}

/**
 * Half-arc of a wheel opening, rear side to front side, clipped to `baseY`.
 * Both ends land exactly on `baseY`, so the arc drops straight into a body
 * outline as a concave notch.
 */
function archArc(arch: Arch, baseY: number, steps = 9): Point2[] {
  const sin = Math.max(-1, Math.min(1, (baseY - arch.y) / arch.r));
  const edge = Math.asin(sin);
  const points: Point2[] = [];
  for (let index = 0; index <= steps; index++) {
    const angle = Math.PI - edge + ((2 * edge - Math.PI) * index) / steps;
    points.push([arch.x + Math.cos(angle) * arch.r, arch.y + Math.sin(angle) * arch.r]);
  }
  return points;
}

/**
 * Painted body outline in metres, with the wheel openings cut into its lower
 * edge. `outline` is the icon-space silhouette walked from the rear sill corner
 * up and over the top to the front sill corner; the underside comes back the
 * other way through the arches.
 */
function bodyHull(t: Tile, outline: readonly Point2[], arches: readonly Arch[]): Point2[] {
  const last = outline[outline.length - 1];
  if (!last) throw new Error('bodyHull needs an outline');
  const baseY = t.y(last[1]);
  const cuts = [...arches]
    .sort((first, second) => second.x - first.x)
    .flatMap((arch) => archArc(arch, baseY).reverse());
  return [...t.path(outline), ...cuts];
}

/**
 * Arch lip: the band of trim around a wheel opening. A thin dark one on a body
 * that sits low over its tyres, a chunky body-shade one on a body that rides
 * high — the tiles draw exactly this distinction with `ArchCut` vs `Flare`.
 */
function archLip(
  arch: Arch,
  thickness: number,
  halfWidth: number,
  depth: number,
  mat: MeshStandardMaterial,
): Object3D[] {
  const outer = archArc(arch, arch.y);
  const inner = archArc({ ...arch, r: arch.r - thickness }, arch.y).reverse();
  return mirrored(halfWidth - 0.01 + depth / 2, (z) =>
    profile([...outer, ...inner], depth, mat, { radius: 0.012, bevel: 0.008, at: [0, 0, z] }),
  );
}

/**
 * Inner wheel well. The arch is cut clean through the hull, so without a liner
 * you see daylight past the tyre and out the other side.
 */
function archLiner(arch: Arch, baseY: number, width: number): Mesh {
  return profile(archArc(arch, baseY, 11), width, material('plastic'), {
    radius: 0.01,
    bevel: 0.01,
  });
}

/**
 * The painted cabin above the beltline, transcribed from the tile's own body
 * outline: roof, both screen rakes and every pillar in one extrusion. It is
 * narrower than the lower body, which is the tumblehome every car has and the
 * reason a greenhouse reads as a greenhouse rather than as a lid.
 */
function greenhouse(
  t: Tile,
  outline: readonly Point2[],
  width: number,
  paint: MeshStandardMaterial,
): Mesh {
  return profile(t.path(outline), width, paint, { radius: 0.035, bevel: 0.035 });
}

/** Height of the wheel-opening lip at `x`; -Infinity where `x` clears it. */
function archTop(arches: readonly Arch[], x: number): number {
  let top = -Infinity;
  for (const arch of arches) {
    const dx = Math.abs(x - arch.x);
    if (dx >= arch.r) continue;
    top = Math.max(top, arch.y + Math.sqrt(arch.r * arch.r - dx * dx));
  }
  return top;
}

/** Vertical door cut down the flank, stopping at any wheel-opening lip. */
function doorCut(
  x: number,
  from: number,
  to: number,
  halfWidth: number,
  arches: readonly Arch[] = [],
): Object3D[] {
  const bottom = Math.max(from, archTop(arches, x) + 0.02);
  return mirrored(halfWidth - 0.012, (z) =>
    box([0.028, to - bottom, 0.035], material('plastic'), { at: [x, (bottom + to) / 2, z] }),
  );
}

interface FlankLineOptions {
  /** Wheel openings the run must not bridge — trim cannot cross a hole. */
  arches?: readonly Arch[];
  mat?: MeshStandardMaterial;
  depth?: number;
}

/**
 * Horizontal crease, rail or rib along the flank, broken where it would run
 * out over a wheel opening.
 */
function flankLine(
  from: number,
  to: number,
  y: number,
  h: number,
  halfWidth: number,
  opts: FlankLineOptions = {},
): Object3D[] {
  const mat = opts.mat ?? material('plastic');
  const depth = opts.depth ?? 0.035;
  let spans: [number, number][] = [[from, to]];
  for (const arch of opts.arches ?? []) {
    const reach = arch.r + h / 2;
    const rise = y - arch.y;
    if (Math.abs(rise) >= reach) continue;
    const half = Math.sqrt(reach * reach - rise * rise);
    const gapFrom = arch.x - half;
    const gapTo = arch.x + half;
    spans = spans.flatMap(([a, b]): [number, number][] => {
      if (gapTo <= a || gapFrom >= b) return [[a, b]];
      const kept: [number, number][] = [];
      if (gapFrom > a) kept.push([a, gapFrom]);
      if (gapTo < b) kept.push([gapTo, b]);
      return kept;
    });
  }
  return spans
    .filter(([a, b]) => b - a > 0.08)
    .flatMap(([a, b]) =>
      mirrored(halfWidth - 0.012, (z) => box([b - a, h, depth], mat, { at: [(a + b) / 2, y, z] })),
    );
}

/** Door pull. */
function doorHandle(x: number, y: number, halfWidth: number): Object3D[] {
  return mirrored(halfWidth - 0.008, (z) =>
    box([0.15, 0.045, 0.035], material('chrome'), { at: [x, y, z] }),
  );
}

/** Door mirror on a short arm. Deliberately narrow: `w` is a catalogued dim. */
function doorMirrors(x: number, y: number, halfWidth: number, tall = false): Object3D[] {
  const plastic = material('plastic');
  const head: Point2 = tall ? [0.19, 0.055] : [0.13, 0.045];
  return [
    ...mirrored(halfWidth + 0.012, (z) => box([0.05, 0.045, 0.05], plastic, { at: [x, y, z] })),
    ...mirrored(halfWidth + 0.028, (z) =>
      box([0.06, head[0], head[1]], plastic, { at: [x - 0.02, y + head[0] * 0.25, z] }),
    ),
  ];
}

/** Horizontal bars across a radiator grille. */
function grilleBars(x: number, y: number, h: number, count: number, width: number): Object3D[] {
  const chrome = material('chrome');
  const step = h / (count + 1);
  return Array.from({ length: count }, (_unused, index) =>
    box([0.05, step * 0.32, width], chrome, { at: [x, y - h / 2 + step * (index + 1), 0] }),
  );
}

/** Rocker strip, fitted to the gap the two wheel openings leave. */
function rocker(rear: Arch, front: Arch, baseY: number, halfWidth: number): Object3D[] {
  const from = rear.x + rear.r - 0.04;
  const to = front.x - front.r + 0.04;
  return mirrored(halfWidth - 0.005, (z) =>
    box([to - from, 0.1, 0.05], material('plastic'), {
      at: [(from + to) / 2, baseY - 0.012, z],
    }),
  );
}

/** Fuel filler cap on one rear quarter. */
function fuelCap(x: number, y: number, halfWidth: number): Mesh {
  return cyl(0.075, 0.02, material('plastic'), {
    axis: 'z',
    at: [x, y, halfWidth - 0.006],
    segments: 12,
  });
}

/**
 * A screen — windscreen, backlight, tailgate glass — laid on the body rake it
 * belongs to. Pass the icon endpoints in increasing x: the outward normal is
 * the rake direction turned a quarter turn, which then points away from the
 * cabin at both ends of the car.
 */
function rakedGlass(t: Tile, from: Point2, to: Point2, width: number, thickness = 0.05): Mesh {
  const ax = t.x(from[0]);
  const ay = t.y(from[1]);
  const bx = t.x(to[0]);
  const by = t.y(to[1]);
  const length = Math.hypot(bx - ax, by - ay);
  const lift = 0.016;
  return box([length, thickness, width], material('glass'), {
    at: [
      (ax + bx) / 2 - ((by - ay) / length) * lift,
      (ay + by) / 2 + ((bx - ax) / length) * lift,
      0,
    ],
    rot: [0, 0, Math.atan2(by - ay, bx - ax)],
  });
}

/**
 * A side window let into a painted flank. It has to stand a few millimetres
 * proud: recessed into a solid panel, it simply vanishes.
 */
function flankGlass(t: Tile, quad: readonly Point2[], halfWidth: number): Object3D[] {
  const depth = 0.04;
  return mirrored(halfWidth - depth / 2 + 0.006, (z) =>
    profile(t.path(quad), depth, material('glass'), { radius: 0.03, bevel: 0.01, at: [0, 0, z] }),
  );
}

/* ------------------------------------------------------------------- sedan */

export function buildSedan(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  const frame: TileFrame = { from: 8.3, to: 90.4, top: 12.9, l: 4.7, h: 1.45 };
  const t = tile(frame);
  const width = 1.82;
  const half = width / 2;
  const wheelRadius = t.dx(5.4);
  const arches: Arch[] = [
    { x: t.x(24), y: wheelRadius, r: t.dx(7.4) },
    { x: t.x(72), y: wheelRadius, r: t.dx(7.4) },
  ];
  const baseY = t.y(35);

  // Three boxes: boot deck below the cabin beltline, bonnet below it again.
  const spec: CarSpec = {
    length: frame.l,
    width,
    height: frame.h,
    wheelRadius,
    wheelWidth: 0.24,
    axles: [t.x(72), t.x(24)],
    hull: bodyHull(
      t,
      [
        [9.2, 35],
        [8.3, 29.2],
        [9.1, 27.1],
        [11.2, 26.1],
        [27.6, 25.4],
        [29.8, 23.3],
        [66.6, 23.3],
        [69.3, 24],
        [71.8, 25.2],
        [85.4, 25.9],
        [88.5, 27.1],
        [90.1, 29.4],
        [90.4, 32.8],
        [87.8, 35],
      ],
      arches,
    ),
    hullRadius: 0.06,
    headlight: { x: frame.l / 2 - 0.06, y: t.y(28.6), z: 0.62, w: 0.34, h: t.dy(3.1) },
    taillight: { x: -frame.l / 2 + 0.05, y: t.y(29.9), z: 0.66, w: 0.3, h: t.dy(4) },
    bumper: { y: t.y(32.7), h: 0.2 },
    grille: [t.y(28.9), t.dy(2.6)],
    exhaust: { x: t.x(17.7), y: t.y(35.4), z: -0.34 },
    discBrakes: true,
  };

  const group = carShell(spec, params);
  const paint = material('paint', params.color);
  const cabinWidth = width - 0.14;
  const cabinHalf = cabinWidth / 2;

  group.add(
    greenhouse(
      t,
      [
        [28.9, 24.2],
        [36.6, 14.2],
        [37.9, 13.3],
        [40.2, 12.9],
        [60, 12.9],
        [61.9, 13.5],
        [63, 14.8],
        [67.6, 24.2],
      ],
      cabinWidth,
      paint,
    ),
  );
  // Four windows, as drawn: backlight, two door panes, windscreen.
  group.add(rakedGlass(t, [32.4, 23.6], [38.9, 15], cabinWidth - 0.12));
  group.add(rakedGlass(t, [57.6, 15], [62.8, 23.6], cabinWidth - 0.12));
  for (const pane of [
    [
      [35.7, 23.6],
      [42.2, 15],
      [48.6, 15],
      [48.6, 23.6],
    ],
    [
      [50.4, 23.6],
      [50.4, 15],
      [54.2, 15],
      [59.4, 23.6],
    ],
  ] as Point2[][]) {
    group.add(...flankGlass(t, pane, cabinHalf));
  }

  // Boot shutline: across the deck at the cabin, and again at the rear panel.
  group.add(box([0.03, 0.05, width - 0.12], material('plastic'), { at: [t.x(28.2), t.y(25.6), 0] }));
  group.add(box([0.05, 0.03, width - 0.12], material('plastic'), { at: [t.x(11.4), t.y(26.4), 0] }));

  for (const x of [t.x(34.6), t.x(49.5), t.x(60.1)]) {
    group.add(...doorCut(x, t.y(33.6), t.y(24.2), half, arches));
  }
  group.add(...flankLine(t.x(12.2), t.x(85.6), t.y(29.6), 0.028, half, { arches }));
  group.add(...doorHandle(t.x(45.9), t.y(27), half));
  group.add(...doorHandle(t.x(56.3), t.y(27.2), half));
  group.add(...doorMirrors(t.x(61.8), t.y(23.6), half));
  group.add(fuelCap(t.x(20.6), t.y(27), half));
  group.add(...grilleBars(frame.l / 2 - 0.03, t.y(28.9), t.dy(2.6), 2, width * 0.55));
  group.add(...rocker(arches[0] as Arch, arches[1] as Arch, baseY, half));
  for (const arch of arches) {
    group.add(archLiner(arch, baseY, width - 2 * (spec.wheelWidth + 0.03)));
    group.add(...archLip(arch, 0.05, half, 0.05, material('plastic')));
  }
  return group;
}

/* --------------------------------------------------------------- hatchback */

export function buildHatchback(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  // Topmost ink is the roof spoiler, not the roof.
  const frame: TileFrame = { from: 16.2, to: 84.6, top: 10.9, l: 4.05, h: 1.46 };
  const t = tile(frame);
  const width = 1.75;
  const half = width / 2;
  const wheelRadius = t.dx(5.3);
  const arches: Arch[] = [
    { x: t.x(29), y: wheelRadius, r: t.dx(7.2) },
    { x: t.x(69.8), y: wheelRadius, r: t.dx(7.2) },
  ];
  const baseY = t.y(35);

  const spec: CarSpec = {
    length: frame.l,
    width,
    height: frame.h,
    wheelRadius,
    wheelWidth: 0.22,
    axles: [t.x(69.8), t.x(29)],
    hull: bodyHull(
      t,
      [
        // Tail cut off vertically: the rear panel barely leans.
        [17.4, 35],
        [16.2, 27],
        [16.5, 24.9],
        [17.8, 23.8],
        [19.2, 22.3],
        [60.8, 22.3],
        [63.7, 24.3],
        [66.2, 25],
        [78.6, 25.4],
        [82.5, 26.7],
        [84.4, 29],
        [84.6, 32.6],
        [82, 35],
      ],
      arches,
    ),
    hullRadius: 0.06,
    headlight: { x: frame.l / 2 - 0.06, y: t.y(28.4), z: 0.6, w: 0.32, h: t.dy(3.1) },
    taillight: { x: -frame.l / 2 + 0.05, y: t.y(27.3), z: 0.62, w: 0.26, h: t.dy(4.4) },
    bumper: { y: t.y(32.5), h: 0.19 },
    grille: [t.y(28.6), t.dy(2.4)],
    exhaust: { x: t.x(22.1), y: t.y(35.4), z: -0.32 },
    discBrakes: true,
  };

  const group = carShell(spec, params);
  const paint = material('paint', params.color);
  const cabinWidth = width - 0.14;
  const cabinHalf = cabinWidth / 2;

  group.add(
    greenhouse(
      t,
      [
        [17.6, 23.2],
        [21.9, 13.6],
        [23.1, 12.7],
        [25, 12.3],
        [53.4, 12.3],
        [55.4, 12.8],
        [56.8, 14],
        [62, 23.2],
      ],
      cabinWidth,
      paint,
    ),
  );
  // Roof spoiler over the tailgate: the hatch's own silhouette tell, and the
  // highest ink on the tile.
  group.add(
    profile(
      t.path([
        [22.8, 12.7],
        [28.6, 12.4],
        [28.2, 10.9],
        [23.2, 11.2],
      ]),
      cabinWidth - 0.06,
      paint,
      { radius: 0.02, bevel: 0.02 },
    ),
  );
  // Steep tailgate glass and windscreen on their rakes, three panes between.
  group.add(rakedGlass(t, [20.1, 22.6], [23.6, 14.6], cabinWidth - 0.12));
  group.add(rakedGlass(t, [54.1, 14.6], [58.8, 22.6], cabinWidth - 0.12));
  for (const pane of [
    [
      [23.2, 22.6],
      [26.7, 14.6],
      [28.4, 14.6],
      [28.4, 22.6],
    ],
    [
      [30.2, 22.6],
      [30.6, 14.6],
      [41.6, 14.6],
      [41.6, 22.6],
    ],
    [
      [43.4, 22.6],
      [43.4, 14.6],
      [50.7, 14.6],
      [55.4, 22.6],
    ],
  ] as Point2[][]) {
    group.add(...flankGlass(t, pane, cabinHalf));
  }

  for (const x of [t.x(20.4), t.x(29.5), t.x(42.6), t.x(56.1)]) {
    group.add(...doorCut(x, t.y(33.4), t.y(23.2), half, arches));
  }
  group.add(...flankLine(t.x(17.8), t.x(83.6), t.y(29.2), 0.028, half, { arches }));
  group.add(...doorHandle(t.x(36.9), t.y(26.2), half));
  group.add(...doorHandle(t.x(49.3), t.y(26.5), half));
  group.add(...doorMirrors(t.x(58.4), t.y(23), half));
  group.add(fuelCap(t.x(24), t.y(28), half));
  // Tailgate pull, on the rear panel rather than the flank.
  group.add(box([0.05, 0.05, 0.22], material('chrome'), { at: [-frame.l / 2 + 0.03, t.y(30.8), 0] }));
  group.add(...grilleBars(frame.l / 2 - 0.03, t.y(28.6), t.dy(2.4), 2, width * 0.55));
  group.add(...rocker(arches[0] as Arch, arches[1] as Arch, baseY, half));
  for (const arch of arches) {
    group.add(archLiner(arch, baseY, width - 2 * (spec.wheelWidth + 0.03)));
    group.add(...archLip(arch, 0.05, half, 0.05, material('plastic')));
  }
  return group;
}

/* --------------------------------------------------------------------- suv */

export function buildSuv(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  // Topmost ink is the roof rail; the painted roof is 1.5 icon units below it.
  const frame: TileFrame = { from: 9.4, to: 90.6, top: 6.2, l: 4.85, h: 1.78 };
  const t = tile(frame);
  const width = 1.95;
  const half = width / 2;
  const wheelRadius = t.dx(6.2);
  const arches: Arch[] = [
    { x: t.x(24.5), y: wheelRadius, r: t.dx(8.6) },
    { x: t.x(73.5), y: wheelRadius, r: t.dx(8.6) },
  ];
  const baseY = t.y(33.6);
  const roofY = t.y(8.9);

  const spec: CarSpec = {
    length: frame.l,
    width,
    height: frame.h,
    wheelRadius,
    wheelWidth: 0.27,
    axles: [t.x(73.5), t.x(24.5)],
    hull: bodyHull(
      t,
      [
        [10.6, 33.6],
        [9.6, 22.6],
        [10.8, 19.7],
        [65.8, 19.7],
        [67.4, 20.6],
        [69.1, 22],
        [71.6, 22.9],
        [85.6, 24.4],
        [88.8, 25.7],
        [90.4, 28],
        [90.6, 31.4],
        [88, 33.6],
      ],
      arches,
    ),
    hullRadius: 0.07,
    headlight: { x: frame.l / 2 - 0.06, y: t.y(26.75), z: 0.66, w: 0.36, h: t.dy(3.8) },
    // Tall lamp stack up the D-pillar corners.
    taillight: { x: -frame.l / 2 + 0.05, y: t.y(24.6), z: 0.7, w: 0.26, h: t.dy(5.6) },
    bumper: { y: t.y(30.9), h: 0.24 },
    grille: [t.y(26.7), t.dy(3.4)],
    exhaust: { x: t.x(16.4), y: t.y(34.6), z: -0.42 },
    discBrakes: true,
  };

  const group = carShell(spec, params);
  const paint = material('paint', params.color);
  const chrome = material('chrome');
  const plastic = material('plastic');
  const cabinWidth = width - 0.14;
  const cabinHalf = cabinWidth / 2;

  group.add(
    greenhouse(
      t,
      [
        [9.6, 20.4],
        [10.2, 14.4],
        [12.2, 10.4],
        [14.1, 9.3],
        [17, 8.9],
        [57.6, 8.9],
        [59.7, 9.4],
        [61.2, 10.6],
        [67.4, 20.4],
      ],
      cabinWidth,
      paint,
    ),
  );
  // Near-upright tailgate glass, then the three side panes the tile draws.
  group.add(rakedGlass(t, [9.8, 19.6], [11.4, 12.6], cabinWidth - 0.4));
  group.add(rakedGlass(t, [58.1, 10.4], [64.1, 20], cabinWidth - 0.12));
  for (const pane of [
    [
      [11.6, 20],
      [13.6, 10.4],
      [18, 10.4],
      [16, 20],
    ],
    [
      [20.4, 20],
      [21.2, 10.4],
      [39, 10.4],
      [39, 20],
    ],
    [
      [41, 20],
      [41, 10.4],
      [54.4, 10.4],
      [60.4, 20],
    ],
  ] as Point2[][]) {
    group.add(...flankGlass(t, pane, cabinHalf));
  }

  // Roof rails, feet first — they define the catalogued height.
  const railFrom = t.x(17.6);
  const railTo = t.x(54.6);
  const railTop = frame.h;
  for (const z of [0.55, -0.55]) {
    group.add(
      box([railTo - railFrom, 0.055, 0.07], plastic, {
        at: [(railFrom + railTo) / 2, railTop - 0.0275, z],
      }),
    );
    for (const x of [t.x(20), t.x(52)]) {
      group.add(
        box([0.11, railTop - 0.055 - roofY + 0.02, 0.06], plastic, {
          at: [x, (roofY - 0.02 + railTop - 0.055) / 2, z],
        }),
      );
    }
  }

  // Rock rails: the high ride leaves a gap under the sill, so bridge it.
  const rockFrom = t.x(28);
  const rockTo = t.x(70);
  for (const z of [half - 0.045, -(half - 0.045)]) {
    group.add(
      cyl(0.045, rockTo - rockFrom, material('steel'), {
        axis: 'x',
        at: [(rockFrom + rockTo) / 2, t.y(34.4), z],
        segments: 10,
      }),
    );
    for (const x of [rockFrom + 0.25, rockTo - 0.25]) {
      group.add(box([0.06, 0.14, 0.05], plastic, { at: [x, t.y(34.4) + 0.07, z] }));
    }
  }

  for (const x of [t.x(19.4), t.x(40.2), t.x(61)]) {
    group.add(...doorCut(x, t.y(32.7), t.y(19.6), half, arches));
  }
  group.add(...flankLine(t.x(11.4), t.x(70), t.y(22.9), 0.03, half, { arches }));
  // Lower body cladding line: the SUV's plastic-clad flank.
  group.add(...flankLine(t.x(12), t.x(89.4), t.y(30.6), 0.06, half, { arches }));
  group.add(...doorHandle(t.x(33.5), t.y(23.5), half));
  group.add(...doorHandle(t.x(52.9), t.y(24), half));
  group.add(...doorMirrors(t.x(62), t.y(21), half));
  group.add(fuelCap(t.x(17.4), t.y(25.6), half));
  group.add(...grilleBars(frame.l / 2 - 0.03, t.y(26.7), t.dy(3.4), 3, width * 0.55));
  // Skid plate under the grille.
  group.add(box([0.14, 0.07, width * 0.62], chrome, { at: [frame.l / 2 - 0.09, t.y(30.4), 0] }));
  group.add(...rocker(arches[0] as Arch, arches[1] as Arch, baseY, half));
  // Chunky plastic flares, the cue for a body riding high over its tyres.
  for (const arch of arches) {
    group.add(archLiner(arch, baseY, width - 2 * (spec.wheelWidth + 0.03)));
    group.add(...archLip({ ...arch, r: arch.r + 0.035 }, 0.1, half, 0.08, plastic));
  }
  return group;
}

/* ------------------------------------------------------------------ pickup */

export function buildPickup(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  const frame: TileFrame = { from: 5.8, to: 91.6, top: 12.5, l: 5.9, h: 1.95 };
  const t = tile(frame);
  const width = 2.03;
  const half = width / 2;
  const wheelRadius = t.dx(5.8);
  const arches: Arch[] = [
    { x: t.x(20.5), y: wheelRadius, r: t.dx(7.8) },
    { x: t.x(74.5), y: wheelRadius, r: t.dx(7.8) },
  ];
  const baseY = t.y(34.6);
  const bedFloor = t.y(28.6);
  const railTop = t.y(23.4);
  const bedRear = t.x(6.6);
  const bedFront = t.x(37.2);

  // The hull tops out at the bed floor over the bed and at the cab beltline
  // over the cab, so the bed is a real void rather than a filled box.
  const spec: CarSpec = {
    length: frame.l,
    width,
    height: frame.h,
    wheelRadius,
    wheelWidth: 0.3,
    axles: [t.x(74.5), t.x(20.5)],
    hull: bodyHull(
      t,
      [
        [6.6, 34.6],
        [5.8, 29.6],
        [7.4, 28.6],
        [36.4, 28.6],
        [38.4, 21.9],
        [61.6, 21.9],
        [67.4, 22.9],
        [69.1, 23.95],
        [71.6, 24.6],
        [86.4, 25.4],
        [89.7, 26.5],
        [91.4, 28.6],
        [91.6, 32.6],
        [89, 34.6],
      ],
      arches,
    ),
    hullRadius: 0.06,
    headlight: { x: frame.l / 2 - 0.06, y: t.y(28.15), z: 0.72, w: 0.34, h: t.dy(3.6) },
    taillight: { x: -frame.l / 2 + 0.06, y: t.y(27.8), z: 0.84, w: 0.2, h: t.dy(4.2) },
    grille: [t.y(28.2), t.dy(3.6)],
    exhaust: { x: t.x(28.4), y: t.y(35.2), z: -0.55 },
    discBrakes: true,
  };

  const group = carShell(spec, params);
  const paint = material('paint', params.color);
  const plastic = material('plastic');
  const chrome = material('chrome');
  const cabinWidth = width - 0.14;
  const cabinHalf = cabinWidth / 2;

  group.add(
    greenhouse(
      t,
      [
        [37.6, 22.4],
        [38.4, 13.6],
        [39.4, 12.8],
        [41.4, 12.5],
        [58.6, 12.5],
        [60.7, 13],
        [62, 14.2],
        [67.4, 22.4],
      ],
      cabinWidth,
      paint,
    ),
  );
  // Single cab: upright rear window, one door pane, raked windscreen.
  group.add(rakedGlass(t, [37.9, 21.8], [38.7, 14.2], cabinWidth - 0.3));
  group.add(rakedGlass(t, [59.4, 14.2], [64.4, 22.2], cabinWidth - 0.12));
  for (const pane of [
    [
      [39, 22.2],
      [40, 14.2],
      [44, 14.2],
      [43, 22.2],
    ],
    [
      [45, 22.2],
      [45.6, 14.2],
      [56, 14.2],
      [61, 22.2],
    ],
  ] as Point2[][]) {
    group.add(...flankGlass(t, pane, cabinHalf));
  }

  // Bed: outer walls flush with the lower body, an open floor between them,
  // a tailgate at the back and a rail cap along the top of each wall.
  const wallDepth = 0.095;
  const wallZ = half - wallDepth / 2;
  for (const z of [wallZ, -wallZ]) {
    group.add(
      profile(
        [
          [bedRear + 0.02, bedFloor - 0.02],
          [bedRear + 0.02, railTop],
          [bedFront, railTop],
          [bedFront, bedFloor - 0.02],
        ],
        wallDepth,
        paint,
        { radius: 0.03, bevel: 0.02, at: [0, 0, z] },
      ),
    );
    group.add(
      box([bedFront - bedRear, 0.045, wallDepth + 0.03], paint, {
        at: [(bedRear + bedFront) / 2, railTop + 0.022, z],
      }),
    );
  }
  // Tailgate and its cap, then ribs across the bed floor.
  group.add(
    box([0.09, railTop - bedFloor + 0.06, width - 2 * wallDepth], paint, {
      at: [bedRear + 0.065, (bedFloor + railTop) / 2, 0],
    }),
  );
  group.add(box([0.13, 0.045, width - 0.08], paint, { at: [bedRear + 0.055, railTop + 0.022, 0] }));
  for (const x of [-1.05, -1.7, -2.35]) {
    group.add(
      box([0.05, 0.03, width - 2 * wallDepth - 0.04], plastic, { at: [x, bedFloor + 0.015, 0] }),
    );
  }
  // Tailgate seam and pull.
  group.add(...doorCut(t.x(9.2), t.y(32.4), bedFloor, half, arches));
  group.add(box([0.06, 0.06, 0.3], plastic, { at: [bedRear + 0.03, t.y(28) + 0.16, 0] }));
  // Bed side stamping, above the floor line.
  group.add(...flankLine(t.x(11.4), bedFront, t.y(26.6), 0.03, half, { arches }));

  // Step bumper behind, chrome bar in front.
  group.add(box([t.dx(4), t.dy(3.2), 0.95], plastic, { at: [t.x(6.4) - 0.06, t.y(33.2), 0] }));
  group.add(box([t.dx(4.4), 0.035, 0.42], chrome, { at: [t.x(6.4) - 0.06, t.y(31.7), 0] }));
  group.add(box([0.16, t.dy(2.8), width - 0.14], chrome, { at: [frame.l / 2 - 0.07, t.y(32.4), 0] }));

  group.add(...doorCut(t.x(62), t.y(33.4), t.y(22.4), half, arches));
  group.add(...flankLine(t.x(69), t.x(90.6), t.y(28.8), 0.03, half, { arches }));
  group.add(...doorHandle(t.x(51.1), t.y(26), half));
  group.add(...doorMirrors(t.x(64.6), t.y(22.8), half, true));
  group.add(fuelCap(t.x(31.6), t.y(29), half));
  group.add(...grilleBars(frame.l / 2 - 0.03, t.y(28.2), t.dy(3.6), 3, width * 0.55));
  group.add(...rocker(arches[0] as Arch, arches[1] as Arch, baseY, half));
  for (const arch of arches) {
    group.add(archLiner(arch, baseY, width - 2 * (spec.wheelWidth + 0.03)));
    group.add(...archLip(arch, 0.06, half, 0.06, plastic));
  }
  return group;
}

/* ----------------------------------------------------------------- minivan */

export function buildMinivan(params: VehicleParams = { color: DEFAULT_COLOR }): Group {
  const frame: TileFrame = { from: 8.6, to: 89.8, top: 10.3, l: 5.15, h: 1.78 };
  const t = tile(frame);
  const width = 2;
  const half = width / 2;
  const wheelRadius = t.dx(5.4);
  const arches: Arch[] = [
    { x: t.x(24), y: wheelRadius, r: t.dx(7.4) },
    { x: t.x(74), y: wheelRadius, r: t.dx(7.4) },
  ];
  const baseY = t.y(34.9);

  const spec: CarSpec = {
    length: frame.l,
    width,
    height: frame.h,
    wheelRadius,
    wheelWidth: 0.25,
    axles: [t.x(74), t.x(24)],
    hull: bodyHull(
      t,
      [
        // One box: the tail rises in a single sweep to a long flat roof.
        [10, 34.9],
        [8.8, 24.4],
        [10.4, 22.7],
        [64.8, 22.7],
        [67, 23.4],
        [68.6, 24.9],
        [71.2, 25.6],
        [84.6, 26.4],
        [87.9, 27.6],
        [89.6, 29.8],
        [89.8, 32.8],
        [87.2, 34.9],
      ],
      arches,
    ),
    hullRadius: 0.07,
    headlight: { x: frame.l / 2 - 0.06, y: t.y(29.4), z: 0.66, w: 0.32, h: t.dy(3.4) },
    taillight: { x: -frame.l / 2 + 0.05, y: t.y(26.9), z: 0.7, w: 0.28, h: t.dy(4.6) },
    bumper: { y: t.y(32.8), h: 0.22 },
    grille: [t.y(29.3), t.dy(2.6)],
    exhaust: { x: t.x(14.4), y: t.y(35.4), z: -0.4 },
    discBrakes: true,
  };

  const group = carShell(spec, params);
  const paint = material('paint', params.color);
  const cabinWidth = width - 0.14;
  const cabinHalf = cabinWidth / 2;

  group.add(
    greenhouse(
      t,
      [
        [8.8, 23.2],
        [9.6, 15.2],
        [12.4, 11.4],
        [14.7, 10.6],
        [17.8, 10.3],
        [52.6, 10.3],
        [55.4, 10.9],
        [56.8, 12],
        [67, 23.2],
      ],
      cabinWidth,
      paint,
    ),
  );
  // Tailgate glass on the one-box tail, a long windscreen, three side panes.
  group.add(rakedGlass(t, [9.2, 22.4], [11.6, 12.4], cabinWidth - 0.4));
  group.add(rakedGlass(t, [50.9, 11.8], [60.8, 23], cabinWidth - 0.12));
  for (const pane of [
    [
      [11, 23],
      [14.4, 11.8],
      [19.6, 11.8],
      [16.2, 23],
    ],
    [
      [18.4, 23],
      [19, 11.8],
      [38, 11.8],
      [38, 23],
    ],
    [
      [40, 23],
      [40, 11.8],
      [47.4, 11.8],
      [57.3, 23],
    ],
  ] as Point2[][]) {
    group.add(...flankGlass(t, pane, cabinHalf));
  }

  // Sliding-door track along the flank — the minivan's identity kit.
  const trackFrom = t.x(20.4);
  const trackTo = t.x(44.6);
  group.add(...flankLine(trackFrom, trackTo, t.y(25.2), 0.055, half, { arches, depth: 0.05 }));
  for (const x of [trackFrom, trackTo]) {
    group.add(...flankLine(x - 0.05, x + 0.05, t.y(25.2), 0.09, half, { depth: 0.055 }));
  }

  for (const x of [t.x(17.4), t.x(39.2), t.x(58.1)]) {
    group.add(...doorCut(x, t.y(33.5), t.y(22.6), half, arches));
  }
  group.add(...flankLine(t.x(11.6), t.x(88.4), t.y(29.5), 0.028, half, { arches }));
  group.add(...doorHandle(t.x(35.1), t.y(26.5), half));
  group.add(...doorHandle(t.x(51.3), t.y(27.6), half));
  group.add(...doorMirrors(t.x(61), t.y(23.6), half));
  group.add(fuelCap(t.x(16.2), t.y(27.6), half));
  group.add(...grilleBars(frame.l / 2 - 0.03, t.y(29.3), t.dy(2.6), 2, width * 0.55));
  group.add(...rocker(arches[0] as Arch, arches[1] as Arch, baseY, half));
  for (const arch of arches) {
    group.add(archLiner(arch, baseY, width - 2 * (spec.wheelWidth + 0.03)));
    group.add(...archLip(arch, 0.05, half, 0.05, material('plastic')));
  }
  return group;
}

/* --------------------------------------------------------------------- van */

export function buildVan(params: VehicleParams = { color: '#e8e9ea' }): Group {
  const frame: TileFrame = { from: 8.6, to: 90.5, top: 7.8, l: 5.3, h: 2.4 };
  const t = tile(frame);
  const width = 2;
  const half = width / 2;
  const wheelRadius = t.dx(5.6);
  const arches: Arch[] = [
    { x: t.x(23), y: wheelRadius, r: t.dx(7.6) },
    { x: t.x(75), y: wheelRadius, r: t.dx(7.6) },
  ];
  const baseY = t.y(34.2);

  // No greenhouse: the flank behind the cab is one blank painted panel, so the
  // hull carries the roof itself and the glazing is let into its surface.
  const spec: CarSpec = {
    length: frame.l,
    width,
    height: frame.h,
    wheelRadius,
    wheelWidth: 0.26,
    axles: [t.x(75), t.x(23)],
    hull: bodyHull(
      t,
      [
        [9.6, 34.2],
        [8.6, 11.6],
        [9.5, 8.9],
        [12.2, 7.8],
        [64.4, 7.8],
        [66.4, 8.4],
        [67.8, 9.6],
        [73.8, 18.6],
        [75.5, 20.1],
        [78, 20.9],
        [85.8, 21.8],
        [88.7, 23],
        [90.2, 25.2],
        [90.5, 31.8],
        [88, 34.2],
      ],
      arches,
    ),
    hullRadius: 0.07,
    headlight: { x: frame.l / 2 - 0.06, y: t.y(25), z: 0.7, w: 0.3, h: t.dy(2.9) },
    // Full-height rear lamp up the door pillar.
    taillight: { x: -frame.l / 2 + 0.05, y: t.y(26.1), z: 0.8, w: 0.2, h: t.dy(7.4) },
    bumper: { y: t.y(29.7), h: 0.2 },
    grille: [t.y(25.1), t.dy(3)],
    discBrakes: true,
  };

  const group = carShell(spec, params);
  const paint = material('paint', params.color);
  const plastic = material('plastic');

  // Cab glazing only: door glass let into the flank, windscreen on the rake.
  group.add(
    ...flankGlass(
      t,
      [
        [52, 18.2],
        [52, 9.6],
        [61.2, 9.6],
        [67, 18.2],
      ],
      half,
    ),
  );
  group.add(rakedGlass(t, [68.6, 10.2], [73.4, 17.8], width - 0.22));

  // Roof ribs across the cargo roof.
  for (const x of [t.x(20), t.x(34), t.x(48)]) {
    group.add(box([0.07, 0.04, width - 0.12], paint, { at: [x, frame.h - 0.02, 0] }));
  }
  // Pressed flank ribs, the only relief on a blank panel.
  group.add(...flankLine(t.x(14.6), t.x(50), t.y(22.4), 0.035, half, { arches }));
  group.add(...flankLine(t.x(14.6), t.x(66.6), t.y(27.6), 0.035, half, { arches }));

  // Rear doors: the shutline down the flank, two hinges, and the centre split.
  group.add(...doorCut(t.x(12.8), t.y(32.8), t.y(10.4), half, arches));
  for (const y of [t.y(14.4), t.y(29.2)]) {
    group.add(...flankLine(t.x(9.6), t.x(12.4), y, 0.09, half, { mat: plastic, depth: 0.045 }));
  }
  group.add(
    box([0.04, t.y(10.4) - t.y(32.8), 0.05], plastic, {
      at: [-frame.l / 2 + 0.02, (t.y(10.4) + t.y(32.8)) / 2, 0],
    }),
  );

  // Sliding cargo door, its seams and the step below it.
  group.add(...doorCut(t.x(30.4), t.y(33), t.y(19.4), half, arches));
  group.add(...doorCut(t.x(50.2), t.y(33.2), t.y(19), half, arches));
  group.add(...flankLine(t.x(33), t.x(47), t.y(34.35), 0.09, half, { mat: plastic, depth: 0.12 }));

  group.add(...doorHandle(t.x(47.3), t.y(24.6), half));
  group.add(...doorMirrors(t.x(69.2), t.y(17.8), half, true));
  group.add(fuelCap(t.x(34.4), t.y(30.4), half));
  group.add(...grilleBars(frame.l / 2 - 0.03, t.y(25.1), t.dy(3), 2, width * 0.55));
  // Amber marker lamps beside the grille.
  group.add(
    ...mirrored(0.52, (z) =>
      box([0.06, t.dy(1.4), 0.14], material('lamp'), { at: [frame.l / 2 - 0.1, t.y(27.5), z] }),
    ),
  );
  group.add(...rocker(arches[0] as Arch, arches[1] as Arch, baseY, half));
  for (const arch of arches) {
    group.add(archLiner(arch, baseY, width - 2 * (spec.wheelWidth + 0.03)));
    group.add(...archLip(arch, 0.055, half, 0.055, plastic));
  }
  return group;
}
