import { Group, type Mesh, type MeshStandardMaterial } from 'three';

import { box, cyl, mirrored, type Point2, profile, sphere, type Vec3 } from '../geometry';
import { material } from '../materials';

/**
 * Shared body vocabulary for road vehicles.
 *
 * The catalog's 2D tile artwork and these meshes are the same drawing at two
 * fidelities, so they are authored the same way: a side-view outline extruded
 * across the width, a separate glazing outline, then the kit that identifies
 * the vehicle. Transcribing an icon is therefore mechanical — the tile art uses
 * a 96x48 viewBox with the ground at y = 41, so
 *
 *     metresX = (iconX - 48) / 96 * length      (icon nose at high x -> +X)
 *     metresY = (41 - iconY) / 41 * <icon body height in metres>
 *
 * and the outline you get out is the outline to extrude. Keep the silhouette;
 * drop anything that only existed to read at 50 px.
 *
 * Hard rules, all enforced by `__tests__/builders.test.ts`:
 *   - the built bounding box matches the catalog dims within 10%
 *   - the lowest point sits on y = 0 (wheels touch the ground, nothing sinks)
 *   - the box is centred on x = 0 and z = 0 within ~15%
 */

export interface VehicleParams {
  /** Paint colour, any CSS hex string. */
  color: string;
}

export const DEFAULT_COLOR = '#4a6b8a';

/* -------------------------------------------------------------- wheels */

export interface WheelOptions {
  radius: number;
  width: number;
  /** Axle centre X positions. */
  xs: readonly number[];
  /** Outer face of the tyre, |Z|. */
  z: number;
  /** Axles (by index into `xs`) that carry dual tyres. */
  dual?: readonly number[];
  segments?: number;
  /** Brake disc behind the rim. Reads on anything with an open wheel. */
  disc?: boolean;
}

/**
 * Road wheels. A wheel is a tyre, a dished rim and — where the arch leaves it
 * visible — a brake disc; the rim is inset so the tyre keeps its sidewall.
 */
export function addWheels(group: Group, opts: WheelOptions): void {
  const { radius, width } = opts;
  const tire = material('tire');
  const rim = material('rim');
  const steel = material('steel');
  const segments = opts.segments ?? 18;
  opts.xs.forEach((x, index) => {
    const isDual = opts.dual?.includes(index) ?? false;
    const offsets = isDual ? [opts.z - width / 2, opts.z - width * 1.55] : [opts.z - width / 2];
    for (const off of offsets) {
      for (const sign of [1, -1]) {
        const z = off * sign;
        group.add(cyl(radius, width, tire, { axis: 'z', at: [x, radius, z], segments }));
        group.add(
          cyl(radius * 0.52, width * 0.55, rim, {
            axis: 'z',
            at: [x, radius, z + sign * width * 0.26],
            segments: Math.round(segments * 0.6),
          }),
        );
        if (opts.disc) {
          group.add(
            cyl(radius * 0.62, width * 0.12, steel, {
              axis: 'z',
              at: [x, radius, z - sign * width * 0.18],
              segments: Math.round(segments * 0.6),
            }),
          );
        }
      }
    }
  });
}

/**
 * Plastic arch flare over a wheel — the cue that a body sits over its tyres.
 *
 * Built as a fan of tangent blocks over the upper half of the arc, not a torus:
 * a full ring dips below y = 0 (bottom = wheelRadius - (r + tube), negative for
 * any flare wider than the tyre) and, laid in the wrong plane, extends the
 * body's Z by a whole radius. Both break the catalog-dimension and ground-plane
 * tests, which is how the first version of this helper was caught.
 */
export function archFlare(
  x: number,
  radius: number,
  width: number,
  mat: MeshStandardMaterial = material('plastic'),
): Mesh[] {
  const steps = 7;
  const thickness = radius * 0.13;
  const parts: Mesh[] = [];
  for (const sign of [1, -1]) {
    const z = sign * (width / 2 - 0.02);
    for (let i = 0; i < steps; i += 1) {
      // Sweep the upper arc only: 10° above the axle to 170°.
      const angle = Math.PI * (0.06 + (0.88 * (i + 0.5)) / steps);
      const segment = (Math.PI * 0.88 * radius) / steps;
      parts.push(
        box([segment * 1.12, thickness, thickness * 1.6], mat, {
          at: [x + Math.cos(angle) * radius, radius + Math.sin(angle) * radius, z],
          rot: [0, 0, angle - Math.PI / 2],
        }),
      );
    }
  }
  return parts;
}

/* ------------------------------------------------------------- car shell */

export interface CarSpec {
  length: number;
  width: number;
  height: number;
  wheelRadius: number;
  wheelWidth: number;
  /** Axle centres, front first. Three or more for heavy chassis. */
  axles: readonly number[];
  /** Axles carrying duals, by index. */
  dualAxles?: readonly number[];
  /** Painted hull, side view (X = length, Y = height). */
  hull: readonly Point2[];
  hullRadius?: number;
  /** Glass cabin, side view. Omit for a vehicle with no glazing. */
  glass?: readonly Point2[];
  glassRadius?: number;
  /** Painted roof cap laid over the glass: [xBack, xFront, thickness]. */
  roof?: readonly [number, number, number];
  headlight?: { x: number; y: number; z: number; w: number; h: number };
  taillight?: { x: number; y: number; z: number; w: number; h: number };
  mirror?: { x: number; y: number };
  /** Dark bumper / valance strip at each end. */
  bumper?: { y: number; h: number };
  /** Arch flares at these axle X positions. */
  flares?: readonly number[];
  /** Sill / rocker strip: [y, height]. */
  sill?: readonly [number, number];
  /** Radiator grille block at the nose: [y, height]. */
  grille?: readonly [number, number];
  /** Exhaust tip X/Y/Z, drawn as a short chrome tube. */
  exhaust?: { x: number; y: number; z: number; r?: number };
  discBrakes?: boolean;
}

/**
 * The common road-vehicle shell: hull, glazing, roof cap, lamps, bumpers,
 * arches and wheels. Everything that makes one model *that* model — light bars,
 * ladders, drums, booms, spare wheels — is the caller's job.
 */
export function carShell(spec: CarSpec, params: VehicleParams): Group {
  const group = new Group();
  const paint = material('paint', params.color);
  const plastic = material('plastic');

  group.add(profile(spec.hull, spec.width, paint, { radius: spec.hullRadius ?? 0.12, bevel: 0.09 }));

  if (spec.glass) {
    group.add(
      profile(spec.glass, spec.width - 0.16, material('glass'), {
        radius: spec.glassRadius ?? 0.13,
        bevel: 0.05,
      }),
    );
  }

  if (spec.roof) {
    const [back, front, thickness] = spec.roof;
    group.add(
      box([front - back, thickness, spec.width - 0.1], paint, {
        at: [(back + front) / 2, spec.height - thickness / 2, 0],
      }),
    );
  }

  if (spec.headlight) {
    const hl = spec.headlight;
    group.add(
      ...mirrored(hl.z, (z) => box([0.14, hl.h, hl.w], material('headlight'), { at: [hl.x, hl.y, z] })),
    );
  }
  if (spec.taillight) {
    const tl = spec.taillight;
    group.add(
      ...mirrored(tl.z, (z) => box([0.12, tl.h, tl.w], material('taillight'), { at: [tl.x, tl.y, z] })),
    );
  }

  if (spec.bumper) {
    const { y, h } = spec.bumper;
    const front = spec.length / 2 - 0.06;
    group.add(box([0.14, h, spec.width - 0.16], plastic, { at: [front, y, 0] }));
    group.add(box([0.14, h, spec.width - 0.16], plastic, { at: [-front, y, 0] }));
  }

  if (spec.sill) {
    const [y, h] = spec.sill;
    group.add(
      ...mirrored(spec.width / 2 - 0.01, (z) =>
        box([spec.length * 0.52, h, 0.05], plastic, { at: [0, y, z] }),
      ),
    );
  }

  if (spec.grille) {
    const [y, h] = spec.grille;
    group.add(
      box([0.08, h, spec.width * 0.62], material('steel'), { at: [spec.length / 2 - 0.04, y, 0] }),
    );
  }

  if (spec.mirror) {
    const { x, y } = spec.mirror;
    group.add(
      ...mirrored(spec.width / 2 - 0.045, (z) => box([0.09, 0.1, 0.09], plastic, { at: [x, y, z] })),
    );
  }

  if (spec.exhaust) {
    const { x, y, z, r = 0.045 } = spec.exhaust;
    group.add(cyl(r, 0.16, material('chrome'), { axis: 'x', at: [x, y, z], segments: 10 }));
  }

  for (const x of spec.flares ?? []) {
    group.add(...archFlare(x, spec.wheelRadius * 1.28, spec.width));
  }

  addWheels(group, {
    radius: spec.wheelRadius,
    width: spec.wheelWidth,
    xs: spec.axles,
    z: spec.width / 2 - 0.015,
    dual: spec.dualAxles,
    disc: spec.discBrakes,
  });

  return group;
}

/* ------------------------------------------------------------------ kit */

/** Emergency light bar. Two-tone unless `solid` names one material key. */
export function lightBar(
  at: Vec3,
  size: readonly [number, number, number],
  solid?: 'taillight' | 'headlight' | 'lamp',
): Mesh[] {
  const [l, h, w] = size;
  const clear = material('chrome');
  if (solid) {
    return [
      box([l, h, w], material(solid), { at }),
      box([l * 0.9, h * 0.3, w * 1.01], clear, { at: [at[0], at[1] + h * 0.4, at[2]] }),
    ];
  }
  const half = w / 2;
  return [
    box([l, h, half], material('taillight'), { at: [at[0], at[1], at[2] + half / 2] }),
    box([l, h, half], material('headlight'), { at: [at[0], at[1], at[2] - half / 2] }),
    box([l * 0.9, h * 0.3, w * 1.01], clear, { at: [at[0], at[1] + h * 0.4, at[2]] }),
  ];
}

/** Single rotating beacon on a short base. */
export function beacon(at: Vec3, r = 0.09, h = 0.14, key: 'lamp' | 'taillight' = 'lamp'): Mesh[] {
  return [
    cyl(r * 1.15, h * 0.25, material('plastic'), { at: [at[0], at[1] - h * 0.4, at[2]], segments: 12 }),
    cyl(r, h, material(key), { at, segments: 12 }),
  ];
}

/** Ladder: two stiles and `rungs` rungs, running along X. */
export function ladder(
  at: Vec3,
  length: number,
  width: number,
  rungs = 6,
  mat: MeshStandardMaterial = material('chrome'),
): Mesh[] {
  const parts: Mesh[] = [];
  for (const sign of [1, -1]) {
    parts.push(box([length, 0.045, 0.045], mat, { at: [at[0], at[1], at[2] + (sign * width) / 2] }));
  }
  for (let i = 0; i < rungs; i += 1) {
    const x = at[0] - length / 2 + (length * (i + 0.5)) / rungs;
    parts.push(box([0.035, 0.035, width], mat, { at: [x, at[1], at[2]] }));
  }
  return parts;
}

/** Handrail / stanchion run along X at height `at[1]`. */
export function handrail(at: Vec3, length: number, posts = 3, height = 0.28): Mesh[] {
  const steel = material('steel');
  const parts: Mesh[] = [box([length, 0.035, 0.035], steel, { at: [at[0], at[1] + height, at[2]] })];
  for (let i = 0; i < posts; i += 1) {
    const x = at[0] - length / 2 + (length * (i + 0.5)) / posts;
    parts.push(box([0.035, height, 0.035], steel, { at: [x, at[1] + height / 2, at[2]] }));
  }
  return parts;
}

/** Louvred equipment shutter / vent panel in the XZ face at `at`. */
export function shutter(
  at: Vec3,
  size: readonly [number, number],
  slats = 5,
  mat: MeshStandardMaterial = material('steel'),
): Mesh[] {
  const [l, h] = size;
  const parts: Mesh[] = [box([l, h, 0.03], mat, { at })];
  for (let i = 0; i < slats; i += 1) {
    const y = at[1] - h / 2 + (h * (i + 0.5)) / slats;
    parts.push(box([l * 0.94, h / (slats * 3), 0.045], material('plastic'), { at: [at[0], y, at[2]] }));
  }
  return parts;
}

/** Spare wheel hung on a tailgate or bed side. */
export function spareWheel(at: Vec3, radius: number, width: number): Mesh[] {
  return [
    cyl(radius, width, material('tire'), { axis: 'x', at, segments: 16 }),
    cyl(radius * 0.5, width * 1.1, material('rim'), { axis: 'x', at, segments: 12 }),
  ];
}

/** Exhaust stack standing behind a truck cab. */
export function exhaustStack(at: Vec3, height: number, r = 0.055): Mesh[] {
  return [
    cyl(r, height, material('chrome'), { at: [at[0], at[1] + height / 2, at[2]], segments: 12 }),
    cyl(r * 1.25, height * 0.12, material('steel'), { at: [at[0], at[1] + height, at[2]], segments: 12 }),
  ];
}

/** Rider head + torso for open vehicles (bike, scooter). */
export function rider(at: Vec3, scale = 1): Mesh[] {
  const skin = material('skin');
  const fabric = material('fabric');
  return [
    sphere(0.115 * scale, skin, { at: [at[0], at[1] + 0.62 * scale, at[2]], segments: 12 }),
    box([0.26 * scale, 0.46 * scale, 0.34 * scale], fabric, { at: [at[0], at[1] + 0.28 * scale, at[2]] }),
  ];
}
