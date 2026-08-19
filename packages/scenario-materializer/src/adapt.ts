/**
 * The browser-safe template → matcher adapter.
 *
 * `scenario-model` v2 and `anchor-matcher` each declare their own
 * `LogicalAnchor` / `RoleBinding`. That duplication was deliberate (see the
 * header of `anchor-matcher/src/types/anchor.ts`) — it kept two in-flight lanes
 * from serialising on each other — and this module is the seam where it is paid
 * back. Nothing else in the CLI knows both vocabularies.
 *
 * Every place the two shapes genuinely differ is handled here rather than by
 * changing a shipped package, because the two shapes differ *on purpose*: the
 * authored document is richer (open ranges, expressions, per-kind feature
 * predicates) than the matcher's evaluation vocabulary. Where the authored
 * document says something the matcher cannot evaluate, this module drops the
 * clause and records a `note` — never silently, because a dropped `required`
 * clause is a scenario testing something it no longer tests.
 *
 * | authored (v2) | matcher | how |
 * |---|---|---|
 * | `Range = [number\|null, number\|null]` | `[number, number]` | open ends become ±`OPEN_END_M` |
 * | `runway*M: Range` | `runway*M: number` | the range's lower bound is the requirement |
 * | feature kinds hoisted per union member | `{kind, junction?}` | junction predicates are re-nested |
 * | `egoTurn: Turn[]` | `egoTurn: Turn` | first entry; a note when more were offered |
 * | `from: 'same'` | (absent) | mapped to `merge` with a note |
 * | `adjacent: 'bike'\|'bus'\|'rail'\|'none'` | `'biking'\|'opposing'\|…` | `bike`→`biking`; `bus`/`rail`/`none` dropped |
 * | `policy.diversity: strict\|moderate\|off` | `junction\|road_direction\|none` | positional map |
 * | `pose.s: number \| Expr` | `dsM: number \| Expr` | carried through: only the matcher knows the site facts a station may read |
 * | `direction: near_to_far` | `left_to_right` | positional map |
 */

import {
  evaluateExpr,
  paramDefault,
  type Expr,
  type ExprScope,
  type NumberOrExpr,
  type Range as V2Range,
  type ScenarioTemplateV2,
  type AnchorFeature as V2Feature,
  type RoleBinding as V2Role,
} from '@uniscenarios/scenario-model';
import {
  type AdjacentKind as MAdjacentKind,
  type ApproachRelation as MApproachRelation,
  type Clause as MClause,
  type FeatureKind as MFeatureKind,
  type LogicalAnchor as MAnchor,
  type MatchPolicy as MPolicy,
  type Range as MRange,
  type RoleBinding as MRole,
  type Turn as MTurn,
} from '@uniscenarios/anchor-matcher';

/**
 * Sentinel for an open range end. The matcher's `Range` is a closed
 * `[min, max]`; 1e9 m is unreachable on any map and keeps the tuple numeric
 * (an `Infinity` would survive zod but poison every `slack` arithmetic).
 */
export const OPEN_END_M = 1e9;

/**
 * How much a discarded clause matters.
 *
 * `note` is genuine information — "I mapped `same` onto `merge`", "no `sRange`
 * given so I checked the whole approach". `error` means the adapter **threw
 * away a stated requirement**: the author said the scenario needs something,
 * the matcher cannot express it, and every site it then binds is unchecked
 * against that requirement while still reporting score 1.00 / `exact`.
 */
export type AdaptSeverity = 'note' | 'error';

export interface AdaptNote {
  readonly path: string;
  readonly reason: string;
  /** Defaults to `note`. `error` is a discarded requirement. */
  readonly severity?: AdaptSeverity;
  /** Stable machine code, present on every `error`. */
  readonly code?: string;
}

/**
 * The one code every "the matcher cannot express this" failure carries.
 *
 * Deliberately in the style of `lane_offset_unavailable`: a lane the site does
 * not have, and a clause the matcher does not have, are the same defect seen
 * from two ends — a scenario measuring something it never described.
 */
export const CLAUSE_UNMATCHABLE = 'clause_unmatchable';

/**
 * Should discarding this clause be fatal?
 *
 * `cosmetic` is the escape hatch, and it is the one the schema already ships:
 * `EssentialitySchema` defines `cosmetic` as "freely relaxable", so an author
 * who genuinely means "nice to have, drop it if you must" already has a word
 * for that and does not need a new flag. `required` and `preferred` both make a
 * claim about the site — `required` pass/fail, `preferred` weighted into the
 * score — and silently deleting either one inflates the score of a site that
 * was never checked.
 */
function dropSeverity(essentiality: 'required' | 'preferred' | 'cosmetic'): AdaptSeverity {
  return essentiality === 'cosmetic' ? 'note' : 'error';
}

/** Record a discarded requirement: loud unless the author marked it cosmetic. */
function dropped(
  notes: AdaptNote[],
  path: string,
  essentiality: 'required' | 'preferred' | 'cosmetic',
  reason: string,
): void {
  const severity = dropSeverity(essentiality);
  notes.push({
    path,
    reason:
      severity === 'error'
        ? `${reason} — this ${essentiality} clause is unmatchable, so no site can be checked against it`
        : reason,
    severity,
    ...(severity === 'error' ? { code: CLAUSE_UNMATCHABLE } : {}),
  });
}

/** The discarded-requirement subset of an adaptation's notes. */
export function unmatchableNotes(notes: readonly AdaptNote[]): AdaptNote[] {
  return notes.filter((n) => n.severity === 'error');
}

export interface AdaptedAnchor {
  readonly anchor: MAnchor;
  readonly roles: MRole[];
  /**
   * Non-site values the roles' station expressions read: parameters at their
   * declared defaults, and the clip length. Hand it to `matchAnchorReport` with
   * the roles — a station like `-(0.8 * lane.speedLimitKph / 3.6) * 8` is
   * resolved by the matcher against each candidate site, and cannot be resolved
   * here.
   */
  readonly scope: ExprScope;
  readonly notes: AdaptNote[];
}

/** Scope used to turn authored expressions into the numbers the matcher wants. */
export function templateStaticScope(template: ScenarioTemplateV2): ExprScope {
  const params: Record<string, number> = {};
  for (const decl of template.params.declarations) {
    const value = paramDefault(decl);
    if (value !== undefined) params[decl.id] = value;
  }
  return { params, clip: { seconds: template.choreography.clipSeconds } };
}

/**
 * Best-effort numeric value of an authored `number | Expr`.
 *
 * Site-dependent expressions (`lane.speedLimitKph`, `junction.sizeM`) are
 * genuinely unknowable before a site exists, so they fall back to `fallback`
 * *for the structural pass only*. `materialize.ts` re-evaluates every one of
 * them against the bound site, which is where the number actually matters.
 */
export function numberish(
  value: NumberOrExpr | undefined,
  scope: ExprScope,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  try {
    return evaluateExpr(value as Expr | number, scope);
  } catch {
    return fallback;
  }
}

function closeRange(range: V2Range): MRange {
  const [lo, hi] = range;
  return [lo ?? -OPEN_END_M, hi ?? OPEN_END_M];
}

interface V2Clause<T> {
  value: T;
  essentiality: 'required' | 'preferred' | 'cosmetic';
  weight?: number | undefined;
}

function clauseOf<A, B>(
  clause: V2Clause<A> | undefined,
  map: (value: A) => B,
): MClause<B> | undefined {
  if (!clause) return undefined;
  return {
    value: map(clause.value),
    essentiality: clause.essentiality,
    ...(clause.weight === undefined ? {} : { weight: clause.weight }),
  };
}

const ADJACENT_MAP: Record<string, MAdjacentKind | null> = {
  parking: 'parking',
  bike: 'biking',
  sidewalk: 'sidewalk',
  shoulder: 'shoulder',
  median: 'median',
  bus: null,
  rail: null,
  none: null,
};

const DIVERSITY_MAP: Record<string, MPolicy['diversity']> = {
  strict: 'junction',
  moderate: 'road_direction',
  off: 'none',
};

/** Feature kinds the matcher can actually look for along a reference path. */
const FEATURE_KIND_MAP: Record<string, MFeatureKind | null> = {
  junction: 'junction',
  crossing: 'crossing',
  parking_zone: 'parking_zone',
  merge: 'merge',
  lane_drop: 'lane_drop',
  driveway: 'driveway',
  bus_stop: 'bus_stop',
  diverge: null,
  school_zone: 'school_zone',
  work_zone_suitable: 'work_zone_suitable',
  occlusion_zone: 'occlusion_zone',
  // map-intel publishes `crest_present` on a driving corridor, so the matcher
  // can find one. There is no `sag_present` / `trough` fact anywhere in the
  // catalog, and `curve` / `rail_crossing` have no location layer either, so
  // those three stay unmatchable — and now say so loudly.
  crest: 'crest',
  curve: null,
  rail_crossing: null,
};

function approachRelation(
  from: string,
  path: string,
  notes: AdaptNote[],
): MApproachRelation {
  if (from === 'same') {
    notes.push({
      path,
      reason: "approach relation 'same' has no matcher equivalent; matched as 'merge'",
    });
    return 'merge';
  }
  return from as MApproachRelation;
}

function adaptCorridor(
  template: ScenarioTemplateV2,
  notes: AdaptNote[],
): MAnchor['corridor'] {
  const c = template.anchor.corridor;
  if (!c) return undefined;

  const adjacent = (
    clause: V2Clause<readonly string[]> | undefined,
    path: string,
  ): MClause<MAdjacentKind[]> | undefined => {
    if (!clause) return undefined;
    const kept: MAdjacentKind[] = [];
    for (const kind of clause.value) {
      const mapped = ADJACENT_MAP[kind];
      if (mapped) kept.push(mapped);
      else dropped(notes, path, clause.essentiality, `adjacent kind "${kind}" is not evaluable by the matcher`);
    }
    if (kept.length === 0) return undefined;
    return {
      value: kept.sort(),
      essentiality: clause.essentiality,
      ...(clause.weight === undefined ? {} : { weight: clause.weight }),
    };
  };

  const runway = (
    clause: V2Clause<V2Range> | undefined,
    path: string,
  ): MClause<number> | undefined => {
    if (!clause) return undefined;
    const [lo] = clause.value;
    if (lo === null) {
      dropped(notes, path, clause.essentiality, 'an open-ended runway range states no minimum, and a minimum is the only thing the matcher can check');
      return undefined;
    }
    return {
      value: lo,
      essentiality: clause.essentiality,
      ...(clause.weight === undefined ? {} : { weight: clause.weight }),
    };
  };

  const laneChangeLegal = c.laneChangeLegal
    ? {
        value: {
          side: c.laneChangeLegal.value.side,
          sRange: c.laneChangeLegal.value.sRange
            ? closeRange(c.laneChangeLegal.value.sRange)
            : ([-OPEN_END_M, 0] as MRange),
        },
        essentiality: c.laneChangeLegal.essentiality,
        ...(c.laneChangeLegal.weight === undefined ? {} : { weight: c.laneChangeLegal.weight }),
      }
    : undefined;
  if (c.laneChangeLegal && !c.laneChangeLegal.value.sRange) {
    notes.push({
      path: 'anchor.corridor.laneChangeLegal',
      reason: 'no sRange given; checked over the whole approach',
    });
  }

  return {
    ...(clauseOf(c.throughLanesSameDir, closeRange) === undefined
      ? {}
      : { throughLanesSameDir: clauseOf(c.throughLanesSameDir, closeRange) }),
    ...(clauseOf(c.throughLanesOpposing, closeRange) === undefined
      ? {}
      : { throughLanesOpposing: clauseOf(c.throughLanesOpposing, closeRange) }),
    ...(clauseOf(c.laneWidthM, closeRange) === undefined
      ? {}
      : { laneWidthM: clauseOf(c.laneWidthM, closeRange) }),
    ...(clauseOf(c.speedLimitKph, closeRange) === undefined
      ? {}
      : { speedLimitKph: clauseOf(c.speedLimitKph, closeRange) }),
    ...(clauseOf(c.curvatureDegPer10m, closeRange) === undefined
      ? {}
      : { curvatureDegPer10m: clauseOf(c.curvatureDegPer10m, closeRange) }),
    ...(clauseOf(c.gradePct, closeRange) === undefined
      ? {}
      : { gradePct: clauseOf(c.gradePct, closeRange) }),
    ...(runway(c.runwayUpstreamM, 'anchor.corridor.runwayUpstreamM') === undefined
      ? {}
      : { runwayUpstreamM: runway(c.runwayUpstreamM, 'anchor.corridor.runwayUpstreamM') }),
    ...(runway(c.runwayDownstreamM, 'anchor.corridor.runwayDownstreamM') === undefined
      ? {}
      : { runwayDownstreamM: runway(c.runwayDownstreamM, 'anchor.corridor.runwayDownstreamM') }),
    ...(adjacent(c.requiresAdjacent, 'anchor.corridor.requiresAdjacent') === undefined
      ? {}
      : { requiresAdjacent: adjacent(c.requiresAdjacent, 'anchor.corridor.requiresAdjacent') }),
    ...(adjacent(c.forbidsAdjacent, 'anchor.corridor.forbidsAdjacent') === undefined
      ? {}
      : { forbidsAdjacent: adjacent(c.forbidsAdjacent, 'anchor.corridor.forbidsAdjacent') }),
    ...(laneChangeLegal === undefined ? {} : { laneChangeLegal }),
  };
}

/**
 * The crossing angle a `conflicting_gate` role should be ranked against, when
 * the author expressed it as a range on the anchor feature.
 */
export function templateCrossingAngle(
  template: ScenarioTemplateV2,
  featureId: string,
): number | undefined {
  const feature = template.anchor.features.find((f) => f.id === featureId);
  if (!feature || feature.kind !== 'junction') return undefined;
  const range = feature.conflictingApproach?.value.crossingAngleDeg;
  if (!range) return undefined;
  const [lo, hi] = range;
  if (lo === null && hi === null) return undefined;
  if (lo === null) return hi as number;
  if (hi === null) return lo;
  return (lo + hi) / 2;
}

function adaptFeature(
  feature: V2Feature,
  isOrigin: boolean,
  notes: AdaptNote[],
): MAnchor['features'][number] | null {
  const path = `anchor.features.${feature.id}`;
  const kind = FEATURE_KIND_MAP[feature.kind];
  if (!kind) {
    dropped(
      notes,
      path,
      feature.essentiality,
      `feature kind "${feature.kind}" is not matchable; the whole feature is dropped`,
    );
    return null;
  }

  // `atM` is optional in the authored document and mandatory in the matcher.
  // The origin sits at s = 0 by construction; everything else defaults to
  // "anywhere on the reference path", which is what "unconstrained" means.
  const atM: MClause<MRange> = feature.atM
    ? {
        value: closeRange(feature.atM.value),
        essentiality: feature.atM.essentiality,
        ...(feature.atM.weight === undefined ? {} : { weight: feature.atM.weight }),
      }
    : {
        value: isOrigin ? [0, 0] : [-OPEN_END_M, OPEN_END_M],
        essentiality: isOrigin ? 'required' : 'cosmetic',
      };

  const out: MAnchor['features'][number] = {
    id: feature.id,
    kind,
    atM,
    ...(feature.lateralDistanceM
      ? {
          lateralDistanceM: {
            value: closeRange(feature.lateralDistanceM.value),
            essentiality: feature.lateralDistanceM.essentiality,
            ...(feature.lateralDistanceM.weight === undefined ? {} : { weight: feature.lateralDistanceM.weight }),
          },
        }
      : {}),
    ...(feature.sameRoad
      ? {
          sameRoad: {
            value: feature.sameRoad.value,
            essentiality: feature.sameRoad.essentiality,
            ...(feature.sameRoad.weight === undefined ? {} : { weight: feature.sameRoad.weight }),
          },
        }
      : {}),
    ...(feature.side
      ? {
          side: {
            value: feature.side.value,
            essentiality: feature.side.essentiality,
            ...(feature.side.weight === undefined ? {} : { weight: feature.side.weight }),
          },
        }
      : {}),
  };

  if (feature.kind === 'junction') {
    const junction: NonNullable<MAnchor['features'][number]['junction']> = {};
    const arms = clauseOf(feature.arms, closeRange);
    if (arms) junction.arms = arms;
    const control = clauseOf(feature.control, (v) => [...v]);
    if (control) junction.control = control;
    if (feature.egoTurn) {
      const turns = feature.egoTurn.value;
      if (turns.length > 1) {
        notes.push({
          path: `${path}.egoTurn`,
          reason: `the matcher evaluates one ego turn; kept "${turns[0]}" and dropped ${turns.slice(1).join(', ')}`,
        });
      }
      junction.egoTurn = {
        value: turns[0] as MTurn,
        essentiality: feature.egoTurn.essentiality,
        ...(feature.egoTurn.weight === undefined ? {} : { weight: feature.egoTurn.weight }),
      };
    }
    if (feature.conflictingApproach) {
      junction.conflictingApproach = {
        value: {
          from: approachRelation(
            feature.conflictingApproach.value.from,
            `${path}.conflictingApproach.from`,
            notes,
          ),
          turn: feature.conflictingApproach.value.turn as MTurn,
          ...(feature.conflictingApproach.value.crossingAngleDeg === undefined
            ? {}
            : { crossingAngleDeg: closeRange(feature.conflictingApproach.value.crossingAngleDeg) }),
        },
        essentiality: feature.conflictingApproach.essentiality,
        ...(feature.conflictingApproach.weight === undefined
          ? {}
          : { weight: feature.conflictingApproach.weight }),
      };
    }
    const sizeM = clauseOf(feature.sizeM, closeRange);
    if (sizeM) junction.sizeM = sizeM;
    const hasCrossingOnLeg = clauseOf(feature.hasCrossingOnLeg, (v) => v);
    if (hasCrossingOnLeg) junction.hasCrossingOnLeg = hasCrossingOnLeg;
    if (Object.keys(junction).length > 0) out.junction = junction;
  } else if (feature.kind === 'crossing') {
    const crossing: NonNullable<MAnchor['features'][number]['crossing']> = {};
    if (feature.marked) crossing.marked = { ...feature.marked };
    if (feature.controlled) crossing.controlled = { ...feature.controlled };
    const lengthM = clauseOf(feature.lengthM, closeRange);
    if (lengthM) crossing.lengthM = lengthM;
    if (feature.placement) crossing.placement = { ...feature.placement };
    if (Object.keys(crossing).length > 0) out.crossing = crossing;
  } else if (feature.kind === 'parking_zone') {
    // These four used to be deleted here with the note "the matcher has no
    // parking-zone predicates". It does now, for the three map-intel can
    // answer; `occupancy` is passed through so the matcher can say
    // `supported: false` about it against a *named candidate*, which is a more
    // useful failure than a note on the document.
    const parking: NonNullable<MAnchor['features'][number]['parking']> = {};
    const orientation = clauseOf(feature.orientation, (v) => v);
    if (orientation) parking.orientation = orientation;
    const capacity = clauseOf(feature.capacity, closeRange);
    if (capacity) parking.capacity = capacity;
    const occupancy = clauseOf(feature.occupancy, closeRange);
    if (occupancy) parking.occupancy = occupancy;
    const parkingLengthM = clauseOf(feature.lengthM, closeRange);
    if (parkingLengthM) parking.lengthM = parkingLengthM;
    if (Object.keys(parking).length > 0) out.parking = parking;
  }

  if ('supportsScenario' in feature && feature.supportsScenario) {
    out.supportsScenario = {
      value: [...feature.supportsScenario.value],
      essentiality: feature.supportsScenario.essentiality,
      ...(feature.supportsScenario.weight === undefined ? {} : { weight: feature.supportsScenario.weight }),
    };
  }

  return out;
}

/**
 * The lane index an authored role actually names, or 0.
 *
 * `lane_offset` states it as `k` and the schema says `pose.laneOffset` is
 * ignored for that kind, so `k` wins there. Every other posed kind states it
 * only through `pose.laneOffset`. `relative_to`, `on_crossing` and
 * `in_parking_zone` carry no `FramePose` at all, and `scene_absolute`'s pose is
 * in world coordinates rather than frame coordinates — neither has a lane index
 * to read.
 */
function authoredLaneOffset(role: V2Role): number {
  if (role.kind === 'lane_offset') return role.k;
  if (role.kind === 'scene_absolute') return 0;
  if (role.kind === 'conflicting_gate') return role.fallbackPose?.laneOffset ?? 0;
  return 'pose' in role ? role.pose.laneOffset : 0;
}

function adaptRole(
  role: V2Role,
  template: ScenarioTemplateV2,
  scope: ExprScope,
  notes: AdaptNote[],
): MRole | null {
  const path = `roles.${role.id}`;
  const base = {
    role: role.id,
    essentiality: role.essentiality,
    ...(role.requiredSameSegmentAs === undefined ? {} : { requiredSameSegmentAs: role.requiredSameSegmentAs }),
    ...(role.requiredSameRoadSectionAs === undefined ? {} : { requiredSameRoadSectionAs: role.requiredSameRoadSectionAs }),
    ...(role.requiredHeadingRelation === undefined
      ? {}
      : { requiredHeadingRelation: { ...role.requiredHeadingRelation } }),
  } as const;

  // `pose.laneOffset` is part of every `FramePose`, so it is authorable on
  // every posed role kind, but only `lane_offset` has somewhere to put it. It
  // used to be dropped here in silence, which is the worst possible outcome:
  // the document validates, the matcher binds `k = 0`, and the actor the author
  // asked for "one lane over" spawns inside the reference actor. See
  // `authoredLaneOffset`.
  const authoredK = authoredLaneOffset(role);
  if (authoredK !== 0 && role.kind !== 'on_reference' && role.kind !== 'lane_offset') {
    // The remaining kinds resolve their lane structurally — from a gate, a
    // taper, a crossing, a parking zone, the opposing carriageway. An offset
    // cannot be applied on top of that without contradicting the binding, so
    // say so rather than let the author believe it moved the actor.
    notes.push({
      path: `${path}.pose.laneOffset`,
      reason:
        `laneOffset ${authoredK} is not applied: a "${role.kind}" role's lane is resolved ` +
        'structurally by the matcher; use kind "lane_offset" to name a lane index',
    });
  }

  switch (role.kind) {
    case 'on_reference': {
      if (authoredK !== 0) {
        // The author described a lane, not the reference lane. Carry it into
        // the one binding that can express a lane index, and resolve it
        // strictly: a site without that lane is the wrong site, not an excuse
        // to re-park the actor.
        notes.push({
          path: `${path}.pose.laneOffset`,
          reason:
            `on_reference carries laneOffset ${authoredK}, which names a lane rather than the ` +
            `reference lane; bound as lane_offset k=${authoredK} with onMissing: "fail"`,
        });
        return {
          ...base,
          kind: 'lane_offset',
          k: authoredK,
          onMissing: 'fail',
          dsM: role.pose.s,
          tFrac: numberish(role.pose.tFrac, scope, 0),
        };
      }
      return {
        ...base,
        kind: 'on_reference',
        dsM: role.pose.s,
        tFrac: numberish(role.pose.tFrac, scope, 0),
      };
    }
    case 'lane_offset':
      return {
        ...base,
        kind: 'lane_offset',
        k: role.k,
        onMissing: role.onMissing,
        dsM: role.pose.s,
        tFrac: numberish(role.pose.tFrac, scope, 0),
      };
    case 'at_lane_drop':
      return {
        ...base,
        kind: 'at_lane_drop',
        feature: role.feature,
        lane: role.lane,
        dsM: role.pose.s,
        tFrac: numberish(role.pose.tFrac, scope, 0),
      };
    case 'opposing':
      return {
        ...base,
        kind: 'opposing',
        index: role.k,
        dsM: role.pose.s,
        tFrac: numberish(role.pose.tFrac, scope, 0),
      };
    case 'conflicting_gate': {
      const angle = templateCrossingAngle(template, role.feature);
      return {
        ...base,
        kind: 'conflicting_gate',
        feature: role.feature,
        from: approachRelation(role.from, `${path}.from`, notes),
        turn: role.turn as MTurn,
        ...(angle === undefined ? {} : { templateCrossingAngleDeg: angle }),
        ...(role.arriveAtConflict
          ? {
              arriveAtConflict: {
                relativeTo: role.arriveAtConflict.relativeTo,
                deltaT: numberish(role.arriveAtConflict.deltaT, scope, 0),
              },
            }
          : {}),
        ...(role.requiredUpstreamRunwayM === undefined
          ? {}
          : { minUpstreamRunwayM: numberish(role.requiredUpstreamRunwayM, scope, 0) }),
      };
    }
    case 'on_crossing':
      return {
        ...base,
        kind: 'on_crossing',
        feature: role.feature,
        startFrac: role.startFrac,
        // The two vocabularies name the same two directions differently; the
        // mapping is positional and the materializer only uses the sign.
        direction: role.direction === 'near_to_far' ? 'left_to_right' : 'right_to_left',
      };
    case 'in_parking_zone': {
      let slotIndex = 0;
      if (typeof role.slot === 'number') slotIndex = role.slot;
      else if (role.slot === 'last') {
        notes.push({
          path: `${path}.slot`,
          reason: 'the matcher binds a parking zone as a point, so "last" resolves to the zone itself',
        });
      }
      const feature = template.anchor.features.find((f) => f.id === role.feature);
      const side = feature?.side?.value === 'left' ? 'left' : 'right';
      return { ...base, kind: 'in_parking_zone', feature: role.feature, side, slotIndex };
    }
    case 'relative_to':
      return {
        ...base,
        kind: 'relative_to',
        ref: role.ref,
        dLane: role.dLane,
        // v2 has no `onMissing` on this kind, so the adapter has to pick one,
        // and the one thing it must not pick is the old silent clamp: on a
        // one-lane corridor that resolves `dLane: -1` to the reference actor's
        // own lane. A `required` actor whose lane is absent means the site is
        // wrong; a non-required one is honestly absent rather than misplaced.
        onMissing: role.essentiality === 'required' ? 'fail' : 'drop',
        dsM: role.dsM,
        tFrac: role.tFrac,
      };
    case 'scene_absolute':
      notes.push({
        path,
        reason: 'scene_absolute roles are not portable and cannot be matched; role dropped',
      });
      return null;
  }
}

/** Adapt a parsed v2 template onto the matcher's anchor + role vocabulary. */
export function adaptTemplate(template: ScenarioTemplateV2): AdaptedAnchor {
  const notes: AdaptNote[] = [];
  const scope = templateStaticScope(template);

  // The origin is `features[0]` in both vocabularies (v2 has no
  // `originFeatureId`; the matcher defaults to the first feature).
  const originId = template.anchor.features[0]?.id;
  const features: MAnchor['features'] = [];
  for (const feature of template.anchor.features) {
    const adapted = adaptFeature(feature, feature.id === originId, notes);
    if (adapted) features.push(adapted);
  }

  const policy: Partial<MPolicy> = {
    allowMirror: template.anchor.policy.allowMirror,
    maxSitesPerMap: template.anchor.policy.maxSitesPerMap,
    diversity: DIVERSITY_MAP[template.anchor.policy.diversity] ?? 'junction',
    minScore: template.anchor.policy.minScore,
  };

  let pin: MAnchor['pin'];
  if (template.anchor.pin) {
    if (template.anchor.pin.siteId) {
      pin = { mapId: template.anchor.pin.mapId, siteId: template.anchor.pin.siteId };
    } else {
      notes.push({
        path: 'anchor.pin',
        reason: 'pin carries a map but no siteId (pin_site_unresolved); matching against the clauses instead',
      });
    }
  }

  const corridor = adaptCorridor(template, notes);
  const anchor: MAnchor = {
    id: template.anchor.id ?? 'anchor',
    ...(corridor && Object.keys(corridor).length > 0 ? { corridor } : {}),
    features,
    policy,
    ...(pin ? { pin } : {}),
  };

  const roles: MRole[] = [];
  for (const role of template.roles) {
    const adapted = adaptRole(role, template, scope, notes);
    if (adapted) roles.push(adapted);
  }

  return { anchor, roles, scope, notes };
}
