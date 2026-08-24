/**
 * Localised surface conditions: grip as a *field* over the road rather than one
 * number for the whole scene.
 *
 * `operationalConditions.effects.frictionScale` is scene-wide, and a scene-wide
 * scalar can only express weather. "Black ice on the bend", "a flooded dip",
 * "wet leaves under the trees", "a diesel spill on the roundabout" are all the
 * same shape of thing and none of them is weather: they are a *region* of the
 * corridor whose tyre-road coefficient differs from everywhere else. Making the
 * whole world slippery instead is a different scenario, and usually a much less
 * interesting one — every actor slides, so nothing is localised, nothing is a
 * surprise, and the ego's approach is not the thing under test.
 *
 * Three design points:
 *
 * 1. **A patch is a `Region`.** The engine already has a spatial vocabulary —
 *    `circle | polygon | laneWindow` — that triggers use for `reaches`. Reusing
 *    it means a patch can be authored the same way, an author can trigger on
 *    entering one, and there is exactly one place where "is this actor inside
 *    that shape" is implemented per shape.
 * 2. **`kind` carries the number.** `frictionScale` is optional; ice means
 *    ice. Authors who need the exact value for a criticality study override it,
 *    everyone else names the substance. Same argument as the weather presets.
 * 3. **Edges taper.** A grip discontinuity between two ticks is a step change
 *    in the friction circle, which shows up as an implausible jerk transient.
 *    `edgeTaperM` blends the patch into the surrounding surface over a declared
 *    distance; the default is a genuine hard edge because a sheet of ice does
 *    have one.
 *
 * Nothing here reads the scene-wide scalar directly: the field is constructed
 * *around* a baseline, so `frictionScaleAt` is a total function that already
 * answers "dry asphalt in the rain" when there are no patches at all.
 */

import { pointInPolygon, type Vec2 } from './core/math.js';
import { localFromScene } from './frames.js';
import type { Region } from './schema/input.js';

/**
 * What is on the road. The list is the vocabulary an author picks from, so a
 * renderer and an exporter can each resolve a name rather than reverse a
 * number back into a material.
 */
export const SURFACE_KINDS = [
  'ice',
  'packed_snow',
  'standing_water',
  'wet_leaves',
  'loose_gravel',
  'sand',
  'spilled_oil',
  'polished_asphalt',
  'grit_treated',
] as const;

/** A surface covering. */
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/**
 * Grip multiplier against the surrounding surface, by covering.
 *
 * These are the conventional dry-asphalt-relative tyre-road coefficients:
 * black ice around μ 0.1–0.2, packed snow 0.3, a flooded dip 0.5 (aquaplaning
 * is a speed-dependent effect this does not attempt to model, so the value is
 * the wet-but-contacting figure), wet leaves about the same as loose gravel.
 * `grit_treated` is the one entry above 1: a salted or gritted strip is
 * *better* than the surface around it, which is why the field resolves by
 * largest deviation rather than by minimum.
 */
export const SURFACE_KIND_FRICTION_SCALE: Record<SurfaceKind, number> = {
  ice: 0.15,
  packed_snow: 0.3,
  standing_water: 0.5,
  wet_leaves: 0.45,
  loose_gravel: 0.6,
  sand: 0.5,
  spilled_oil: 0.25,
  polished_asphalt: 0.75,
  grit_treated: 1.15,
};

/** One localised covering. Structurally identical to `surfacePatchSchema`. */
export interface SurfacePatchSpec {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly region: Region;
  /** Overrides {@link SURFACE_KIND_FRICTION_SCALE} for this patch. */
  readonly frictionScale?: number | undefined;
  /** Blend distance at the patch boundary, metres. `0` is a hard edge. */
  readonly edgeTaperM: number;
  readonly label?: string | undefined;
}

/** Where an actor is, in the two terms a region can be expressed in. */
export interface SurfaceQuery {
  readonly position: Vec2;
  /** Lane identity, when the actor has one. `null` for freeform/polyline routes. */
  readonly lane: { readonly rsl: string; readonly laneS: number } | null;
}

/** The resolved surface under one actor on one tick. */
export interface SurfaceSample {
  readonly frictionScale: number;
  /** Patches covering the query point, worst-deviating first. `[]` is the baseline surface. */
  readonly patchIds: readonly string[];
}

/**
 * Signed containment depth, metres: positive inside the region, negative
 * outside, and the magnitude is the distance to the boundary. The taper needs
 * the distance, not just the boolean, and every region kind can answer it.
 */
function containmentDepthM(region: Region, q: SurfaceQuery): number {
  switch (region.kind) {
    case 'circle': {
      const c = localFromScene(region.center);
      return region.radiusM - Math.hypot(q.position.x - c.x, q.position.y - c.y);
    }
    case 'polygon': {
      const poly = region.points.map(localFromScene);
      const inside = pointInPolygon(q.position, poly);
      let nearest = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        nearest = Math.min(nearest, distanceToSegmentM(q.position, a, b));
      }
      return inside ? nearest : -nearest;
    }
    case 'laneWindow': {
      // A lane window is unbounded off its own lane: an actor in the next lane
      // is not "just outside" the ice, it is on a different lane entirely, and
      // tapering across that boundary would leak grip between carriageways.
      if (q.lane === null || q.lane.rsl !== region.rsl) return -Infinity;
      return Math.min(q.lane.laneS - region.sMin, region.sMax - q.lane.laneS);
    }
  }
}

function distanceToSegmentM(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * The grip field for one episode.
 *
 * Overlaps resolve by **largest deviation from the baseline**, tie-broken by
 * the lower friction and then by patch id. That is order-independent (so it
 * cannot depend on authoring order or on a hash iteration order), it makes
 * "ice on an already-wet road" behave as ice, and it lets a `grit_treated`
 * strip through a snowfield behave as grit. Taking the minimum instead would
 * silently discard every grip *improvement* an author could write.
 */
export class SurfaceField {
  private readonly patches: readonly SurfacePatchSpec[];

  constructor(
    /** The scene-wide surface the patches sit in — weather, effectively. */
    readonly baselineFrictionScale: number,
    patches: readonly SurfacePatchSpec[] = [],
  ) {
    this.patches = [...patches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** True when the field is the baseline everywhere and may be short-circuited. */
  get isUniform(): boolean {
    return this.patches.length === 0;
  }

  /** The worst grip anywhere in the field. The friction ceiling a solver must plan against. */
  get worstFrictionScale(): number {
    return this.patches.reduce(
      (worst, patch) => Math.min(worst, this.scaleOf(patch)),
      this.baselineFrictionScale,
    );
  }

  ids(): string[] {
    return this.patches.map((patch) => patch.id);
  }

  private scaleOf(patch: SurfacePatchSpec): number {
    return patch.frictionScale ?? SURFACE_KIND_FRICTION_SCALE[patch.kind];
  }

  /** Full resolution at a query point: the effective scale and what produced it. */
  sampleAt(q: SurfaceQuery): SurfaceSample {
    if (this.patches.length === 0) {
      return { frictionScale: this.baselineFrictionScale, patchIds: [] };
    }
    const covering: Array<{ id: string; scale: number; deviation: number }> = [];
    for (const patch of this.patches) {
      const depth = containmentDepthM(patch.region, q);
      if (depth <= 0) continue;
      const weight = patch.edgeTaperM > 0 ? Math.min(1, depth / patch.edgeTaperM) : 1;
      const scale = this.baselineFrictionScale
        + (this.scaleOf(patch) - this.baselineFrictionScale) * weight;
      covering.push({ id: patch.id, scale, deviation: Math.abs(scale - this.baselineFrictionScale) });
    }
    if (covering.length === 0) {
      return { frictionScale: this.baselineFrictionScale, patchIds: [] };
    }
    covering.sort((a, b) =>
      b.deviation - a.deviation || a.scale - b.scale || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { frictionScale: covering[0]!.scale, patchIds: covering.map((entry) => entry.id) };
  }

  /** The effective grip multiplier at a query point. */
  frictionScaleAt(q: SurfaceQuery): number {
    return this.sampleAt(q).frictionScale;
  }
}
