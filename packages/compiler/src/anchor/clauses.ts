/**
 * Clause evaluation.
 *
 * Two rules from `docs/research/retargeting.md` drive everything here:
 *
 * 1. **Worst value over the s-interval, not mean.** A corridor that is 3 lanes
 *    for 90 m and 1 lane for 10 m is not a 3-lane corridor.
 * 2. **Every clause emits a `ClauseResult`** with required/actual/score/slack,
 *    so the UI, the CLI and the `.xosc` provenance block can all explain the
 *    match without re-deriving anything.
 *
 * A clause the derived index cannot answer is marked `supported: false`. If it
 * was `required`, that is a *failure*, not a free pass — silently scoring 1.0
 * for a fact we never checked is exactly how a scenario ends up testing
 * something it does not test.
 */

import { curvatureDegPer10mAt, pointAtS, projectPoint } from './geometry.js';
import { adjacentKinds, crossSectionAt, type CrossSection } from './cross-section.js';
import { laneAtS } from './frame.js';
import {
  armCountNearMiss,
  passesRequired,
  scoreBool,
  scoreRange,
  scoreSet,
  toleranceFor,
} from './scoring.js';
import type {
  AnchorFeature,
  Clause,
  LogicalAnchor,
  Range,
  ToleranceOverrides,
} from './types/anchor.js';
import { clauseWeight, originFeature } from './types/anchor.js';
import type { DerivedMapIndex, JunctionDescriptor, LaneRsl, PointFeature } from './types/map-index.js';
import type { AnchorFrame, ClauseResult, MatchedSite } from './types/site.js';

/** Sampling stride for worst-over-interval evaluation. */
export const SAMPLE_STRIDE_M = 10;
/** Corridor extent used when the anchor states no runway requirement. */
export const DEFAULT_CORRIDOR_M = 100;

export interface CorridorSample {
  s: number;
  laneRsl: LaneRsl;
  sInLane: number;
  isJunction: boolean;
  cs: CrossSection;
  curvatureDegPer10m: number;
}

/**
 * Sample the corridor.
 *
 * Junction-internal spans are skipped for *corridor* clauses: lane counts and
 * widths inside a junction describe the junction, not the road, and including
 * them would make every junction-anchored corridor score 1 lane.
 */
export function sampleCorridor(
  index: DerivedMapIndex,
  frame: AnchorFrame,
  sFrom: number,
  sTo: number,
  stride = SAMPLE_STRIDE_M,
): CorridorSample[] {
  const out: CorridorSample[] = [];
  const lo = Math.max(sFrom, frame.sRange[0]);
  const hi = Math.min(sTo, frame.sRange[1]);
  for (let s = lo; s <= hi + 1e-9; s += stride) {
    const at = laneAtS(frame, s);
    if (!at) continue;
    const lane = index.lanes[at.span.laneRsl];
    if (!lane || lane.isJunction) continue;
    const cs = crossSectionAt(index.lanes, at.span.laneRsl, at.sInLane);
    if (!cs) continue;
    out.push({
      s,
      laneRsl: at.span.laneRsl,
      sInLane: at.sInLane,
      isJunction: at.span.isJunction,
      cs,
      curvatureDegPer10m: curvatureDegPer10mAt(lane.polyline, at.sInLane),
    });
  }
  return out;
}

interface Collector {
  results: ClauseResult[];
  reasons: string[];
}

function push(collector: Collector, result: ClauseResult): void {
  collector.results.push(result);
}

function unsupported(
  path: string,
  c: Clause<unknown>,
  reason: string,
): ClauseResult {
  return {
    path,
    essentiality: c.essentiality,
    required: c.value,
    actual: null,
    // A required clause we cannot check is a failure; a soft one is skipped.
    score: c.essentiality === 'required' ? 0 : 1,
    slack: c.essentiality === 'required' ? 1 : 0,
    weight: c.essentiality === 'required' ? clauseWeight(c) : 0,
    supported: false,
    reason,
  };
}

function factValue(
  feature: PointFeature,
  keys: readonly string[],
): string | number | boolean | readonly string[] | undefined {
  for (const key of keys) {
    const value = feature.facts?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Evaluate a parking-zone feature's authored predicates against map evidence.
 *
 * Every clause here was previously deleted by the adapter before matching, so
 * four parking archetypes bound arterials, a freeway and a 1.14 m stub at score
 * 1.00. `occupancy` is deliberately left unsupported rather than faked: no
 * map-intel fact says how full a bay row is.
 */
function evaluateParkingPredicates(
  feature: AnchorFeature,
  candidate: PointFeature,
  path: string,
  anchor: LogicalAnchor,
): ClauseResult[] {
  if (feature.kind !== 'parking_zone' || !feature.parking) return [];
  const out: ClauseResult[] = [];
  const p = feature.parking;

  if (p.orientation) {
    const raw = factValue(candidate, ['parking_orientation', 'orientation']);
    const parallel = factValue(candidate, ['is_parallel_parking']);
    const actual =
      typeof raw === 'string' && (raw === 'parallel' || raw === 'angled' || raw === 'perpendicular')
        ? raw
        : typeof parallel === 'boolean'
          ? parallel ? 'parallel' : 'angled'
          : undefined;
    if (!actual) {
      out.push(unsupported(`${path}.orientation`, p.orientation, `${candidate.id} carries no parking-orientation evidence`));
    } else {
      const matches = actual === p.orientation.value;
      out.push({
        path: `${path}.orientation`, essentiality: p.orientation.essentiality,
        required: p.orientation.value, actual, score: matches ? 1 : 0, slack: matches ? 0 : 1,
        weight: clauseWeight(p.orientation), supported: true,
        reason: `${candidate.id} is ${actual} parking`,
      });
    }
  }

  if (p.capacity) {
    const raw = factValue(candidate, ['space_count', 'capacity', 'stall_count']);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      out.push(unsupported(`${path}.capacity`, p.capacity, `${candidate.id} carries no counted parking capacity`));
    } else {
      const scored = scoreRange(raw, p.capacity.value, 'countLanes', anchor.toleranceOverrides, p.capacity.tolerance);
      out.push({
        path: `${path}.capacity`, essentiality: p.capacity.essentiality,
        required: p.capacity.value, actual: raw, score: scored.score, slack: scored.slack,
        weight: clauseWeight(p.capacity), supported: true,
        reason: `${candidate.id} holds ${raw} space(s)`,
      });
    }
  }

  if (p.lengthM) {
    const raw = factValue(candidate, ['parking_length_m', 'length_m', 'parking_extent_length_m', 'stall_length_m']);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      out.push(unsupported(`${path}.lengthM`, p.lengthM, `${candidate.id} carries no measured parking-zone length`));
    } else {
      const scored = scoreRange(raw, p.lengthM.value, 'distanceM', anchor.toleranceOverrides, p.lengthM.tolerance);
      out.push({
        path: `${path}.lengthM`, essentiality: p.lengthM.essentiality,
        required: p.lengthM.value, actual: round(raw), score: scored.score, slack: scored.slack,
        weight: clauseWeight(p.lengthM), supported: true,
        reason: `${candidate.id} spans ${round(raw)} m of kerb`,
      });
    }
  }

  if (p.occupancy) {
    out.push(unsupported(
      `${path}.occupancy`,
      p.occupancy,
      'no map-intel fact reports parking occupancy; set it as a scenario parameter, not an anchor clause',
    ));
  }

  return out;
}

/**
 * Honour the location's own `supported_scenario_templates` whitelist.
 *
 * map-intel already decided which scenario templates each occlusion zone was
 * built for. Reading it is the difference between a
 * `pedestrian_emerging_around_bus` brief binding one of the 5 bus occluders and
 * it binding one of the 267 parked-car ones.
 */
function evaluateSupportsScenario(
  feature: AnchorFeature,
  candidate: PointFeature,
  path: string,
): ClauseResult[] {
  const c = feature.supportsScenario;
  if (!c) return [];
  const raw = factValue(candidate, ['supported_scenario_templates', 'supportedScenarioTemplates']);
  const listed = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? [...raw] : null;
  if (!listed || listed.length === 0) {
    return [unsupported(
      `${path}.supportsScenario`,
      c,
      `${candidate.id} publishes no supported_scenario_templates whitelist`,
    )];
  }
  const hit = c.value.find((wanted) => listed.includes(wanted));
  return [{
    path: `${path}.supportsScenario`,
    essentiality: c.essentiality,
    required: c.value,
    actual: listed,
    score: hit ? 1 : 0,
    slack: hit ? 0 : 1,
    weight: clauseWeight(c),
    supported: true,
    reason: hit
      ? `${candidate.id} was built for "${hit}"`
      : `${candidate.id} supports ${listed.join('|')}, none of ${c.value.join('|')}`,
  }];
}

/** Evaluate authored crossing semantics only from normalized map evidence. */
function evaluateCrossingPredicates(
  feature: AnchorFeature,
  candidate: PointFeature,
  path: string,
  anchor: LogicalAnchor,
): ClauseResult[] {
  if (feature.kind !== 'crossing' || !feature.crossing) return [];
  const out: ClauseResult[] = [];
  const booleanClause = (
    key: 'marked' | 'controlled',
    aliases: readonly string[],
    label: string,
  ): void => {
    const clause = feature.crossing?.[key] as Clause<boolean> | undefined;
    if (!clause) return;
    const raw = factValue(candidate, aliases);
    if (typeof raw !== 'boolean') {
      out.push(unsupported(`${path}.${key}`, clause, `${candidate.id} carries no map evidence for ${label}`));
      return;
    }
    const scored = scoreBool(raw, clause.value);
    out.push({
      path: `${path}.${key}`,
      essentiality: clause.essentiality,
      required: clause.value,
      actual: raw,
      score: scored.score,
      slack: scored.slack,
      weight: clauseWeight(clause),
      supported: true,
      reason: `${candidate.id} is ${raw ? '' : 'not '}${label}`,
    });
  };
  booleanClause('marked', ['is_marked', 'marked'], 'marked');
  booleanClause('controlled', ['is_signalized', 'is_controlled', 'controlled'], 'signal-controlled');

  const lengthClause = feature.crossing.lengthM;
  if (lengthClause) {
    const raw = factValue(candidate, ['crossing_length_m', 'length_m', 'lengthM']);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      out.push(unsupported(`${path}.lengthM`, lengthClause, `${candidate.id} carries no measured crossing length`));
    } else {
      const scored = scoreRange(raw, lengthClause.value, 'distanceM', anchor.toleranceOverrides, lengthClause.tolerance);
      out.push({
        path: `${path}.lengthM`, essentiality: lengthClause.essentiality,
        required: lengthClause.value, actual: round(raw), score: scored.score, slack: scored.slack,
        weight: clauseWeight(lengthClause), supported: true,
        reason: `${candidate.id} crossing envelope is ${round(raw)} m long`,
      });
    }
  }

  const placementClause = feature.crossing.placement;
  if (placementClause) {
    const isMidblock = factValue(candidate, ['is_midblock']);
    const isNearJunction = factValue(candidate, ['is_near_junction']);
    const actual = typeof isMidblock === 'boolean'
      ? (isMidblock ? 'midblock' : 'junction_leg')
      : candidate.junctionId || isNearJunction === true
        ? 'junction_leg'
        : isNearJunction === false
          ? 'midblock'
          : undefined;
    if (!actual) {
      out.push(unsupported(`${path}.placement`, placementClause, `${candidate.id} carries no junction-leg or midblock evidence`));
    } else {
      const matches = placementClause.value === 'either' || placementClause.value === actual;
      out.push({
        path: `${path}.placement`, essentiality: placementClause.essentiality,
        required: placementClause.value, actual, score: matches ? 1 : 0, slack: matches ? 0 : 1,
        weight: clauseWeight(placementClause), supported: true,
        reason: `${candidate.id} is a ${actual === 'junction_leg' ? 'junction-leg' : 'midblock'} crossing`,
      });
    }
  }
  return out;
}

/** Worst (lowest-scoring) sample wins — never the mean. */
function worstOverSamples<T>(
  samples: CorridorSample[],
  evaluate: (sample: CorridorSample) => { value: T; score: number; slack: number },
): { value: T; score: number; slack: number; atS: number } | null {
  let best: { value: T; score: number; slack: number; atS: number } | null = null;
  for (const sample of samples) {
    const r = evaluate(sample);
    if (!best || r.score < best.score) best = { ...r, atS: sample.s };
  }
  return best;
}

function rangeClause(
  collector: Collector,
  path: string,
  c: Clause<Range> | undefined,
  samples: CorridorSample[],
  kind: Parameters<typeof scoreRange>[2],
  read: (sample: CorridorSample) => number,
  overrides: ToleranceOverrides | undefined,
): void {
  if (!c) return;
  if (samples.length === 0) {
    push(collector, unsupported(path, c, 'no drivable corridor samples available'));
    return;
  }
  const worst = worstOverSamples(samples, (sample) => {
    const value = read(sample);
    const { score, slack } = scoreRange(value, c.value, kind, overrides, c.tolerance);
    return { value, score, slack };
  });
  if (!worst) return;
  push(collector, {
    path,
    essentiality: c.essentiality,
    required: c.value,
    actual: worst.value,
    score: worst.score,
    slack: worst.slack,
    weight: clauseWeight(c),
    supported: true,
    worstAtS: worst.atS,
    reason:
      worst.score >= 1
        ? `${path} holds over the whole interval (worst ${round(worst.value)})`
        : `${path} worst value ${round(worst.value)} at s=${round(worst.atS)} m, wanted [${c.value[0]}, ${c.value[1]}]`,
  });
}

const round = (v: number): number => Math.round(v * 100) / 100;

function adjacentReferenceLane(index: DerivedMapIndex, frame: AnchorFrame, laneRsl: LaneRsl): LaneRsl | null {
  if (frame.sOfLane[laneRsl] !== undefined) return laneRsl;
  const refs = Object.keys(frame.sOfLane).sort();
  for (const ref of refs) {
    const refLane = index.lanes[ref];
    if (!refLane) continue;
    for (const side of ['left', 'right'] as const) {
      const adj = refLane.adjacentLanes[side];
      if (adj.laneRsl === laneRsl) return ref;
    }
    const lane = index.lanes[laneRsl];
    if (lane) {
      for (const side of ['left', 'right'] as const) {
        const adj = lane.adjacentLanes[side];
        if (adj.laneRsl === ref) return ref;
      }
    }
  }
  return null;
}

/** Geometry-only fallback for legacy points whose source lane is unavailable. */
const POINT_FEATURE_GEOMETRIC_FALLBACK_M = 6;

function pointFeatureWorldPoint(index: DerivedMapIndex, feature: PointFeature) {
  if (feature.point) return feature.point;
  const lane = index.lanes[feature.laneRsl];
  if (!lane || lane.polyline.length < 2) return null;
  return pointAtS(lane.polyline, feature.s);
}

function pointFeatureS(
  index: DerivedMapIndex,
  frame: AnchorFrame,
  feature: PointFeature,
): { s: number; adjacent: boolean; source: 'point-same-road' | 'point-nearby' | 'lane-adjacent'; distanceM: number; side: 'left' | 'right' | 'both' } | null {
  const point = pointFeatureWorldPoint(index, feature);
  if (point) {
    const sourceLane = index.lanes[feature.laneRsl];
    let bestSemantic: { s: number; adjacent: boolean; distanceM: number; side: 'left' | 'right' | 'both' } | null = null;
    let bestNearby: { s: number; adjacent: boolean; distanceM: number; side: 'left' | 'right' | 'both' } | null = null;
    for (const span of frame.referencePath) {
      const lane = index.lanes[span.laneRsl];
      if (!lane || lane.polyline.length < 2) continue;
      const projected = projectPoint(lane.polyline, point);
      const frameS = (frame.sOfLane[span.laneRsl] as number | undefined) ?? span.sStart;
      const candidate = {
        s: frameS + projected.s,
        adjacent: span.laneRsl !== feature.laneRsl,
        distanceM: projected.distance,
        side: projected.distance < 0.25 ? ('both' as const) : projected.side > 0 ? ('left' as const) : ('right' as const),
      };
      const semantic = sourceLane && lane.roadId === sourceLane.roadId && lane.section === sourceLane.section;
      const best = semantic ? bestSemantic : bestNearby;
      if (!best || candidate.distanceM < best.distanceM || (candidate.distanceM === best.distanceM && candidate.s < best.s)) {
        if (semantic) bestSemantic = candidate;
        else bestNearby = candidate;
      }
    }
    // Same OpenDRIVE road+section is the semantic proof for large legal
    // offsets such as a sidewalk stop beyond four lanes. Only data with no
    // usable source lane may use the deliberately small geometry fallback.
    if (bestSemantic) return { ...bestSemantic, source: 'point-same-road' };
    if (bestNearby && bestNearby.distanceM <= POINT_FEATURE_GEOMETRIC_FALLBACK_M) {
      return { ...bestNearby, source: 'point-nearby' };
    }
    return null;
  }

  // Legacy self-derived fixtures may only know a lane+s anchor. Use adjacency
  // only in that data-poor path; real location-catalog features carry a point
  // and bind by projecting that point onto the reference polyline above.
  const ref = adjacentReferenceLane(index, frame, feature.laneRsl);
  if (!ref) return null;
  return {
    s: (frame.sOfLane[ref] as number) + feature.s,
    adjacent: ref !== feature.laneRsl,
    source: 'lane-adjacent',
    distanceM: 0,
    side: feature.side ?? 'both',
  };
}

function featureSideMatches(actual: 'left' | 'right' | 'both', wanted: string): boolean {
  if (wanted === 'either') return actual === 'left' || actual === 'right';
  if (wanted === 'both') return actual === 'both';
  return actual === wanted || actual === 'both';
}

function evaluateCorridor(
  collector: Collector,
  anchor: LogicalAnchor,
  index: DerivedMapIndex,
  frame: AnchorFrame,
  samples: CorridorSample[],
): void {
  const corridor = anchor.corridor;
  if (!corridor) return;
  const tol = anchor.toleranceOverrides;

  rangeClause(collector, 'corridor.throughLanesSameDir', corridor.throughLanesSameDir, samples, 'countLanes', (s) => s.cs.sameDirDriving.size, tol);
  rangeClause(collector, 'corridor.throughLanesOpposing', corridor.throughLanesOpposing, samples, 'countLanes', (s) => s.cs.opposingDriving.length, tol);
  rangeClause(collector, 'corridor.laneWidthM', corridor.laneWidthM, samples, 'widthM', (s) => s.cs.laneWidthM, tol);
  rangeClause(collector, 'corridor.speedLimitKph', corridor.speedLimitKph, samples, 'speedKph', (s) => s.cs.speedLimitKph, tol);
  rangeClause(collector, 'corridor.curvatureDegPer10m', corridor.curvatureDegPer10m, samples, 'curvatureDegPer10m', (s) => s.curvatureDegPer10m, tol);

  if (corridor.gradePct) {
    push(
      collector,
      index.capabilities.grade
        ? unsupported('corridor.gradePct', corridor.gradePct, 'grade capability declared but not implemented by this index')
        : unsupported('corridor.gradePct', corridor.gradePct, 'lane polylines are 2-D: grade is not derivable from this map index'),
    );
  }

  for (const [path, clause, available] of [
    ['corridor.runwayUpstreamM', corridor.runwayUpstreamM, frame.runwayUpstreamM],
    ['corridor.runwayDownstreamM', corridor.runwayDownstreamM, frame.runwayDownstreamM],
  ] as const) {
    if (!clause) continue;
    const wanted = clause.value;
    const range: Range = [wanted, Number.POSITIVE_INFINITY];
    const tolerance = clause.tolerance ?? Math.max(10, 0.25 * wanted);
    const slack = Math.max(0, wanted - available);
    const score = slack === 0 ? 1 : Math.max(0, 1 - slack / tolerance);
    push(collector, {
      path,
      essentiality: clause.essentiality,
      required: range[0],
      actual: round(available),
      score,
      slack,
      weight: clauseWeight(clause),
      supported: true,
      reason:
        score >= 1
          ? `${round(available)} m of runway available, ${wanted} m needed`
          : `only ${round(available)} m of runway, ${wanted} m needed (short by ${round(slack)} m)`,
    });
  }

  if (corridor.requiresAdjacent) {
    const wanted = [...corridor.requiresAdjacent.value].sort();
    const worst = worstOverSamples(samples, (sample) => {
      const kinds = adjacentKinds(sample.cs);
      const missing = wanted.filter((w) => !kinds.includes(w));
      return {
        value: kinds,
        score: missing.length === 0 ? 1 : 0,
        slack: missing.length,
      };
    });
    if (worst) {
      push(collector, {
        path: 'corridor.requiresAdjacent',
        essentiality: corridor.requiresAdjacent.essentiality,
        required: wanted,
        actual: worst.value,
        score: worst.score,
        slack: worst.slack,
        weight: clauseWeight(corridor.requiresAdjacent),
        supported: true,
        worstAtS: worst.atS,
        reason:
          worst.score >= 1
            ? `every required adjacency present along the corridor`
            : `missing adjacency at s=${round(worst.atS)} m (found ${worst.value.join(', ') || 'none'})`,
      });
    }
  }

  if (corridor.forbidsAdjacent) {
    const forbidden = [...corridor.forbidsAdjacent.value].sort();
    const worst = worstOverSamples(samples, (sample) => {
      const kinds = adjacentKinds(sample.cs);
      const hits = forbidden.filter((f) => kinds.includes(f));
      return { value: hits, score: hits.length === 0 ? 1 : 0, slack: hits.length };
    });
    if (worst) {
      push(collector, {
        path: 'corridor.forbidsAdjacent',
        essentiality: corridor.forbidsAdjacent.essentiality,
        required: `none of ${forbidden.join(', ')}`,
        actual: worst.value,
        score: worst.score,
        slack: worst.slack,
        weight: clauseWeight(corridor.forbidsAdjacent),
        supported: true,
        worstAtS: worst.atS,
        reason:
          worst.score >= 1
            ? 'no forbidden adjacency along the corridor'
            : `forbidden adjacency ${worst.value.join(', ')} at s=${round(worst.atS)} m`,
      });
    }
  }

  if (corridor.laneChangeLegal) {
    const { side, sRange } = corridor.laneChangeLegal.value;
    const relevant = samples.filter((s) => s.s >= sRange[0] && s.s <= sRange[1]);
    if (relevant.length === 0) {
      push(collector, unsupported('corridor.laneChangeLegal', corridor.laneChangeLegal, `no corridor samples inside s∈[${sRange[0]}, ${sRange[1]}]`));
    } else {
      const worst = worstOverSamples(relevant, (sample) => {
        const lane = index.lanes[sample.laneRsl];
        const perms = lane?.laneChangePermissions ?? [];
        const wanted = side === 'either' || side === 'both' ? ['left', 'right'] : [side];
        const covering = perms.filter(
          (p) => wanted.includes(p.side) && sample.sInLane >= p.startS && sample.sInLane <= p.endS,
        );
        if (covering.length === 0) {
          // No marking data. If there is nowhere to change into, that is a real
          // "no"; if there is a neighbour but no marking, we only half-believe it.
          const hasNeighbour = sample.cs.sameDirDriving.size > 1;
          return {
            value: hasNeighbour ? 'no marking data' : 'no adjacent lane',
            score: hasNeighbour ? 0.5 : 0,
            slack: 1,
          };
        }
        const allowed =
          side === 'both'
            ? wanted.every((w) => covering.some((p) => p.side === w && p.allowed))
            : covering.some((p) => p.allowed);
        return { value: allowed ? 'allowed' : 'forbidden', score: allowed ? 1 : 0, slack: allowed ? 0 : 1 };
      });
      if (worst) {
        push(collector, {
          path: 'corridor.laneChangeLegal',
          essentiality: corridor.laneChangeLegal.essentiality,
          required: `${side} lane change legal over s∈[${sRange[0]}, ${sRange[1]}]`,
          actual: worst.value,
          score: worst.score,
          slack: worst.slack,
          weight: clauseWeight(corridor.laneChangeLegal),
          supported: true,
          worstAtS: worst.atS,
          reason: `lane-change legality worst case "${String(worst.value)}" at s=${round(worst.atS)} m`,
        });
      }
    }
  }
}

/** Where the reference path enters each junction, in frame `s`. */
export function junctionsAlongPath(
  index: DerivedMapIndex,
  frame: AnchorFrame,
): Array<{ junctionId: string; s: number }> {
  const out: Array<{ junctionId: string; s: number }> = [];
  let previous: string | null = null;
  for (const span of frame.referencePath) {
    const lane = index.lanes[span.laneRsl];
    const junctionId = lane?.junctionId ?? null;
    if (junctionId && junctionId !== previous) out.push({ junctionId, s: span.sStart });
    previous = junctionId;
  }
  return out;
}

/** Lane-count transitions along the corridor, used for `merge` / `lane_drop`. */
export function laneCountTransitions(
  index: DerivedMapIndex,
  samples: CorridorSample[],
  frame?: AnchorFrame,
): Array<{ kind: 'merge' | 'lane_drop'; s: number; from: number; to: number; laneRsl?: LaneRsl }> {
  const out: Array<{ kind: 'merge' | 'lane_drop'; s: number; from: number; to: number; laneRsl?: LaneRsl }> = [];
  const physicalLanes = (sample: CorridorSample): LaneRsl[] => {
    const raw = [...sample.cs.sameDirDriving.values()].sort();
    const remaining = new Set(raw);
    const components: LaneRsl[][] = [];
    while (remaining.size > 0) {
      const seed = [...remaining].sort()[0]!;
      remaining.delete(seed);
      const component = [seed];
      for (let cursor = 0; cursor < component.length; cursor += 1) {
        const lane = index.lanes[component[cursor]!]!;
        for (const linked of [...lane.predecessors, ...lane.successors].sort()) {
          if (!remaining.has(linked)) continue;
          remaining.delete(linked);
          component.push(linked);
        }
      }
      components.push(component);
    }
    const reference = index.lanes[sample.laneRsl];
    const point = reference ? pointAtS(reference.polyline, sample.sInLane) : null;
    return components.map((component) => component
      .map((rsl) => {
        const lane = index.lanes[rsl];
        const projection = lane && point ? projectPoint(lane.polyline, point) : null;
        const endpointPenalty = projection && lane
          ? Math.min(projection.s, Math.max(0, lane.lengthM - projection.s))
          : -1;
        return { rsl, distance: projection?.distance ?? Number.POSITIVE_INFINITY, endpointPenalty };
      })
      .sort((a, b) => a.distance - b.distance || b.endpointPenalty - a.endpointPenalty || a.rsl.localeCompare(b.rsl))[0]!.rsl)
      .sort();
  };
  const reaches = (start: LaneRsl, targets: ReadonlySet<LaneRsl>): boolean => {
    if (targets.has(start)) return true;
    let open = [start];
    const seen = new Set(open);
    for (let depth = 0; depth < 4 && open.length > 0; depth += 1) {
      const next: LaneRsl[] = [];
      for (const rsl of open) {
        for (const successor of index.lanes[rsl]?.successors ?? []) {
          if (targets.has(successor)) return true;
          if (!seen.has(successor)) {
            seen.add(successor);
            next.push(successor);
          }
        }
      }
      open = next.sort();
    }
    return false;
  };
  const reachesWithoutJunction = (start: LaneRsl, target: LaneRsl): boolean => {
    if (start === target) return true;
    let open = [start];
    const seen = new Set(open);
    for (let depth = 0; depth < 4 && open.length > 0; depth += 1) {
      const next: LaneRsl[] = [];
      for (const rsl of open) {
        for (const successor of index.lanes[rsl]?.successors ?? []) {
          if (index.lanes[successor]?.isJunction) continue;
          if (successor === target) return true;
          if (!seen.has(successor)) {
            seen.add(successor);
            next.push(successor);
          }
        }
      }
      open = next.sort();
    }
    return false;
  };
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    // Sampling omits junction-internal spans. Opposite sides of a junction may
    // differ in lane count, but that is a junction funnel, not a road taper.
    if (!reachesWithoutJunction(prev.laneRsl, cur.laneRsl)) continue;
    const previous = physicalLanes(prev);
    const current = physicalLanes(cur);
    const from = previous.length;
    const to = current.length;
    if (to < from) {
      // Pick exactly one upstream continuation for each downstream lane. Two
      // upstream lanes commonly both name the same downstream successor at a
      // merge; treating both as survivors erases the disappearing lane. An
      // unchanged RSL is authoritative, otherwise the closest aligned lane end
      // wins deterministically.
      const survivors = new Set<LaneRsl>();
      for (const target of current) {
        const targetLane = index.lanes[target];
        const candidates = previous
          .filter((rsl) => !survivors.has(rsl) && reaches(rsl, new Set([target])))
          .map((rsl) => {
            const lane = index.lanes[rsl];
            const end = lane?.polyline[lane.polyline.length - 1];
            const start = targetLane?.polyline[0];
            const gap = end && start ? Math.hypot(end.x - start.x, end.y - start.y) : Number.POSITIVE_INFINITY;
            return { rsl, unchanged: rsl === target, gap };
          })
          .sort((a, b) => Number(b.unchanged) - Number(a.unchanged) || a.gap - b.gap || a.rsl.localeCompare(b.rsl));
        if (candidates[0]) survivors.add(candidates[0].rsl);
      }
      const terminating = previous.filter((rsl) => !survivors.has(rsl)).sort();
      // A converging entry lane has a directed continuation into one of the
      // surviving downstream lanes: that is a merge. A lane with no such
      // continuation genuinely terminates and is a lane drop. Both reduce the
      // cross-section count, so lane count alone cannot distinguish them.
      // One physical disappearing lane is one feature identity. A 3→1 taper
      // therefore yields two deterministic candidates rather than an ambiguous
      // comma-joined pseudo-id.
      const currentSet = new Set(current);
      for (const laneRsl of terminating) {
        out.push({
          kind: reaches(laneRsl, currentSet) ? 'merge' : 'lane_drop',
          s: cur.s,
          from,
          to,
          laneRsl,
        });
      }
      // In data too sparse to name the lane, retain the transition as an
      // unsupported identity; feature-bound roles will fail hard rather than
      // silently attaching to the reference lane.
      if (terminating.length === 0) out.push({ kind: 'lane_drop', s: cur.s, from, to });
    }
    // A same-direction count increase is a split/diverge, not a merge. There
    // is no structural feature kind for it yet, so do not fabricate one.
  }

  // A real taper can be shorter than the corridor sampling stride. Derive
  // those directly from the directed lane topology: a lane ends, an adjacent
  // same-direction sibling continues, and the ending lane explicitly permits
  // the lateral move. This also excludes junction funnels by construction.
  if (frame) {
    const pathLanes = new Set(frame.referencePath.map((span) => span.laneRsl));
    for (const terminating of Object.values(index.lanes).sort((a, b) => a.rsl.localeCompare(b.rsl))) {
      if (terminating.isJunction || terminating.laneType !== 'driving' || terminating.successors.length > 0) continue;
      const cs = crossSectionAt(index.lanes, terminating.rsl, Math.max(0, terminating.lengthM - 0.5));
      if (!cs) continue;
      for (const [k, siblingRsl] of [...cs.sameDirDriving.entries()].sort((a, b) => a[0] - b[0])) {
        if (k === 0) continue;
        const sibling = index.lanes[siblingRsl];
        if (!sibling || sibling.isJunction || sibling.laneType !== 'driving' || sibling.successors.length === 0) continue;
        const side = k > 0 ? 'left' : 'right';
        const allowed = terminating.laneChangePermissions.some(
          (permission) => permission.side === side && permission.allowed &&
            permission.endS >= Math.max(0, terminating.lengthM - 30),
        );
        if (!allowed) continue;
        const endpoint = terminating.polyline[terminating.polyline.length - 1];
        if (!endpoint) continue;
        const siblingAt = projectPoint(sibling.polyline, endpoint);
        let continuationM = Math.max(0, sibling.lengthM - siblingAt.s);
        let cursor = sibling;
        const visited = new Set([sibling.rsl]);
        for (let hop = 0; hop < 4 && continuationM < 20; hop += 1) {
          const nextRsl = [...cursor.successors].sort()[0];
          const next = nextRsl ? index.lanes[nextRsl] : undefined;
          if (!next || next.isJunction || visited.has(next.rsl)) break;
          visited.add(next.rsl);
          continuationM += next.lengthM;
          cursor = next;
        }
        if (continuationM < 20) continue;
        const survivorTouchesPath = pathLanes.has(siblingRsl) ||
          sibling.successors.some((rsl) => pathLanes.has(rsl)) ||
          sibling.predecessors.some((rsl) => pathLanes.has(rsl));
        if (!survivorTouchesPath) continue;
        let best: { s: number; distance: number } | null = null;
        for (const span of frame.referencePath) {
          const lane = index.lanes[span.laneRsl];
          if (!lane || lane.isJunction) continue;
          const projected = projectPoint(lane.polyline, endpoint);
          const candidate = { s: span.sStart + projected.s, distance: projected.distance };
          if (!best || candidate.distance < best.distance ||
            (candidate.distance === best.distance && candidate.s < best.s)) best = candidate;
        }
        if (!best || best.distance > 8 || best.s < frame.sRange[0] || best.s > frame.sRange[1]) continue;
        out.push({ kind: 'lane_drop', s: best.s, from: cs.sameDirDriving.size, to: cs.sameDirDriving.size - 1, laneRsl: terminating.rsl });
      }
    }
  }
  const unique = new Map<string, (typeof out)[number]>();
  for (const transition of out) {
    const key = `${transition.kind}:${transition.laneRsl ?? ''}@${Math.round(transition.s * 100)}`;
    if (!unique.has(key)) unique.set(key, transition);
  }
  return [...unique.values()].sort((a, b) => a.s - b.s || (a.laneRsl ?? '').localeCompare(b.laneRsl ?? ''));
}

export interface FeatureEvaluation {
  featureMatches: MatchedSite['featureMatches'];
}

function evaluateJunctionPredicates(
  collector: Collector,
  feature: AnchorFeature,
  descriptor: JunctionDescriptor | undefined,
  frame: AnchorFrame,
  index: DerivedMapIndex,
  anchor: LogicalAnchor,
  isOrigin: boolean,
): void {
  const jp = feature.junction;
  if (!jp) return;
  const base = `features.${feature.id}.junction`;
  if (!descriptor) {
    for (const [key, clause] of Object.entries(jp)) {
      if (clause) push(collector, unsupported(`${base}.${key}`, clause as Clause<unknown>, 'no junction descriptor for the matched feature'));
    }
    return;
  }

  if (jp.arms) {
    const [lo, hi] = jp.arms.value;
    const actual = descriptor.arms;
    const inside = actual >= lo && actual <= hi;
    const nearest = actual < lo ? lo : hi;
    const score = inside ? 1 : armCountNearMiss(actual, nearest);
    push(collector, {
      path: `${base}.arms`,
      essentiality: jp.arms.essentiality,
      required: jp.arms.value,
      actual,
      score,
      slack: inside ? 0 : Math.abs(actual - nearest),
      weight: clauseWeight(jp.arms),
      supported: true,
      reason: inside
        ? `${actual}-arm junction`
        : `${actual}-arm junction, wanted ${lo === hi ? lo : `${lo}-${hi}`} (near-miss ${score})`,
    });
  }

  if (jp.control) {
    if (!index.capabilities.junctionControl || descriptor.control === 'unknown') {
      push(collector, unsupported(`${base}.control`, jp.control, 'junction control is not available in this map index'));
    } else {
      const { score, closest } = scoreSet(descriptor.control, jp.control.value);
      push(collector, {
        path: `${base}.control`,
        essentiality: jp.control.essentiality,
        required: jp.control.value,
        actual: descriptor.control,
        score,
        slack: score >= 1 ? 0 : 1 - score,
        weight: clauseWeight(jp.control),
        supported: true,
        reason:
          score >= 1
            ? `${descriptor.control} junction as requested`
            : `${descriptor.control} junction, wanted ${jp.control.value.join('|')}${closest ? ` (nearest ${closest}, near-miss ${score})` : ''}`,
      });
    }
  }

  if (jp.egoTurn) {
    const actual = isOrigin ? frame.egoTurn ?? 'straight' : 'straight';
    const { score, slack } = scoreBool(actual === jp.egoTurn.value, true);
    push(collector, {
      path: `${base}.egoTurn`,
      essentiality: jp.egoTurn.essentiality,
      required: jp.egoTurn.value,
      actual,
      score,
      slack,
      weight: clauseWeight(jp.egoTurn),
      supported: isOrigin,
      reason:
        score >= 1
          ? `reference path turns ${actual}`
          : `reference path turns ${actual}, wanted ${jp.egoTurn.value}`,
    });
  }

  if (jp.conflictingApproach) {
    const wanted = jp.conflictingApproach.value;
    const egoGateId = frame.egoGateId;
    const gateById = new Map(index.gates.map((g) => [g.id, g]));
    const matches = egoGateId
      ? descriptor.conflictPairs
          .filter((p) => p.gateA === egoGateId || p.gateB === egoGateId)
          .map((p) => {
            const otherId = p.gateA === egoGateId ? p.gateB : p.gateA;
            // `relation` is stored ego-first; flip when ego is the B side.
            const relation =
              p.gateA === egoGateId
                ? p.relation
                : p.relation === 'from_left'
                  ? 'from_right'
                  : p.relation === 'from_right'
                    ? 'from_left'
                    : p.relation;
            return { pair: p, other: gateById.get(otherId), relation };
          })
          .filter((m) => !!m.other)
      : [];
    const movementMatches = matches.filter(
      (m) => m.relation === wanted.from && m.other?.turnRelation === wanted.turn,
    );
    const hit = movementMatches.find((m) => {
      if (!wanted.crossingAngleDeg) return true;
      const [lo, hi] = wanted.crossingAngleDeg;
      return m.pair.crossingAngleDeg >= lo && m.pair.crossingAngleDeg <= hi;
    });
    const relationOnly = matches.filter((m) => m.relation === wanted.from);
    const score = hit ? 1 : 0;
    push(collector, {
      path: `${base}.conflictingApproach`,
      essentiality: jp.conflictingApproach.essentiality,
      required: wanted,
      actual: hit
        ? { from: hit.relation, turn: hit.other?.turnRelation, crossingAngleDeg: round(hit.pair.crossingAngleDeg) }
        : {
            conflictsFound: matches.length,
            matchingRelation: relationOnly.length,
            matchingMovement: movementMatches.length,
            ...(wanted.crossingAngleDeg
              ? { crossingAnglesDeg: movementMatches.map((m) => round(m.pair.crossingAngleDeg)).sort((a, b) => a - b) }
              : {}),
          },
      score,
      slack: score >= 1 ? 0 : 1,
      weight: clauseWeight(jp.conflictingApproach),
      supported: !!egoGateId,
      reason: hit
        ? `conflicting ${wanted.from} ${wanted.turn} movement crosses the ego path at ${round(hit.pair.crossingAngleDeg)}°`
        : wanted.crossingAngleDeg && movementMatches.length > 0
          ? `${wanted.from} ${wanted.turn} movement angle is outside [${wanted.crossingAngleDeg.join(', ')}]°`
          : `no ${wanted.from} ${wanted.turn} movement crosses the ego path (${matches.length} conflicts at this junction)`,
    });
  }

  if (jp.sizeM) {
    const { score, slack } = scoreRange(descriptor.sizeM, jp.sizeM.value, 'distanceM', anchor.toleranceOverrides, jp.sizeM.tolerance);
    push(collector, {
      path: `${base}.sizeM`,
      essentiality: jp.sizeM.essentiality,
      required: jp.sizeM.value,
      actual: round(descriptor.sizeM),
      score,
      slack,
      weight: clauseWeight(jp.sizeM),
      supported: true,
      reason: `junction spans ${round(descriptor.sizeM)} m`,
    });
  }

  if (jp.hasCrossingOnLeg) {
    if (!index.capabilities.crossings) {
      push(collector, unsupported(`${base}.hasCrossingOnLeg`, jp.hasCrossingOnLeg, 'this map index carries no crossing layer'));
    } else {
      const actual = Object.values(descriptor.crossingsByApproach).some((c) => c.length > 0);
      const { score, slack } = scoreBool(actual, jp.hasCrossingOnLeg.value);
      push(collector, {
        path: `${base}.hasCrossingOnLeg`,
        essentiality: jp.hasCrossingOnLeg.essentiality,
        required: jp.hasCrossingOnLeg.value,
        actual,
        score,
        slack,
        weight: clauseWeight(jp.hasCrossingOnLeg),
        supported: true,
        reason: actual ? 'junction has a marked crossing' : 'junction has no marked crossing',
      });
    }
  }
}

export interface EvaluateOptions {
  index: DerivedMapIndex;
  frame: AnchorFrame;
  anchor: LogicalAnchor;
}

export interface EvaluationResult {
  clauses: ClauseResult[];
  featureMatches: MatchedSite['featureMatches'];
  reasons: string[];
  samples: CorridorSample[];
}

/** Evaluate every clause of an anchor against one frame. */
export function evaluateAnchor(options: EvaluateOptions): EvaluationResult {
  const { index, frame, anchor } = options;
  const collector: Collector = { results: [], reasons: [] };
  const featureMatches: MatchedSite['featureMatches'] = {};

  // Which interval do corridor clauses describe? For a junction-anchored
  // template ("3-lane arterial *approaching* a signalized 4-way") it is the
  // approach: sampling past the stop line would judge the corridor by the
  // cross street the ego turns onto. An author who means "and the exit too"
  // says so with `runwayDownstreamM`.
  const origin = originFeature(anchor);
  const upstreamNeed = anchor.corridor?.runwayUpstreamM?.value ?? DEFAULT_CORRIDOR_M;
  const downstreamDefault = origin && origin.kind === 'junction' ? 0 : DEFAULT_CORRIDOR_M;
  const downstreamNeed = anchor.corridor?.runwayDownstreamM?.value ?? downstreamDefault;
  const featureReachUp = anchor.features.reduce((acc, f) => Math.max(acc, -f.atM.value[0], 0), 0);
  const featureReachDown = anchor.features.reduce((acc, f) => Math.max(acc, f.atM.value[1], 0), 0);
  const samples = sampleCorridor(
    index,
    frame,
    -Math.max(upstreamNeed, featureReachUp),
    Math.max(downstreamNeed, featureReachDown),
  );

  evaluateCorridor(collector, anchor, index, frame, samples);

  const junctions = junctionsAlongPath(index, frame);
  const transitions = laneCountTransitions(index, samples, frame);

  for (const feature of anchor.features) {
    // `originFeature()` returns `features[0]`, but a **corridor** frame's origin
    // is a segment head, not that feature: only a junction-kind origin actually
    // establishes the frame. Treating a leading `crossing` / `parking_zone`
    // feature as the origin bound it to the *segment id* and made every
    // `on_crossing` / `in_parking_zone` role unbindable on corridor anchors —
    // which is exactly the shape `scenario-model` v2 emits, since v2 has no
    // `originFeatureId` field to redirect with.
    const isOrigin = !!origin && feature.id === origin.id && frame.origin.kind !== 'corridor';
    const path = `features.${feature.id}`;

    if (isOrigin) {
      const originJunctionId = frame.origin.mapFeatureId.startsWith('junction:')
        ? frame.origin.mapFeatureId.slice('junction:'.length)
        : null;
      featureMatches[feature.id] = {
        mapFeatureId: frame.origin.mapFeatureId,
        s: 0,
        kind: feature.kind,
      };
      const { score, slack } = scoreRange(0, feature.atM.value, 'distanceM', anchor.toleranceOverrides, feature.atM.tolerance);
      push(collector, {
        path: `${path}.atM`,
        essentiality: feature.atM.essentiality,
        required: feature.atM.value,
        actual: 0,
        score,
        slack,
        weight: clauseWeight(feature.atM),
        supported: true,
        reason: 'origin feature sits at s = 0 by construction',
      });
      evaluateJunctionPredicates(
        collector,
        feature,
        originJunctionId ? index.junctionDescriptors[originJunctionId] : undefined,
        frame,
        index,
        anchor,
        true,
      );
      continue;
    }

    // Non-origin features: find the best candidate of the right kind along the path.
    if (feature.kind === 'junction') {
      const candidates = junctions.filter((j) => `junction:${j.junctionId}` !== frame.origin.mapFeatureId);
      const scored = candidates
        .map((j) => ({
          j,
          ...scoreRange(j.s, feature.atM.value, 'distanceM', anchor.toleranceOverrides, feature.atM.tolerance),
        }))
        .sort((a, b) => b.score - a.score || (a.j.junctionId < b.j.junctionId ? -1 : 1));
      const best = scored[0];
      if (!best) {
        push(collector, unsupported(`${path}.atM`, feature.atM, 'no further junction along the reference path'));
        continue;
      }
      featureMatches[feature.id] = {
        mapFeatureId: `junction:${best.j.junctionId}`,
        s: best.j.s,
        kind: 'junction',
      };
      push(collector, {
        path: `${path}.atM`,
        essentiality: feature.atM.essentiality,
        required: feature.atM.value,
        actual: round(best.j.s),
        score: best.score,
        slack: best.slack,
        weight: clauseWeight(feature.atM),
        supported: true,
        worstAtS: best.j.s,
        reason: `junction ${best.j.junctionId} at s=${round(best.j.s)} m`,
      });
      evaluateJunctionPredicates(
        collector,
        feature,
        index.junctionDescriptors[best.j.junctionId],
        frame,
        index,
        anchor,
        false,
      );
      continue;
    }

    if (feature.kind === 'merge' || feature.kind === 'lane_drop') {
      const candidates = transitions.filter((t) => t.kind === feature.kind);
      const scored = candidates
        .map((t) => ({ t, ...scoreRange(t.s, feature.atM.value, 'distanceM', anchor.toleranceOverrides, feature.atM.tolerance) }))
        .sort((a, b) => b.score - a.score || a.t.s - b.t.s);
      const best = scored[0];
      if (!best) {
        push(collector, unsupported(`${path}.atM`, feature.atM, `no ${feature.kind} along the reference path`));
        continue;
      }
      featureMatches[feature.id] = {
        mapFeatureId: `${feature.kind}:${best.t.laneRsl ?? frame.entryLaneRsl}@${round(best.t.s)}`,
        s: best.t.s,
        kind: feature.kind,
      };
      push(collector, {
        path: `${path}.atM`,
        essentiality: feature.atM.essentiality,
        required: feature.atM.value,
        actual: round(best.t.s),
        score: best.score,
        slack: best.slack,
        weight: clauseWeight(feature.atM),
        supported: true,
        worstAtS: best.t.s,
        reason: `${feature.kind} ${best.t.from}→${best.t.to} lanes at s=${round(best.t.s)} m`,
      });
      continue;
    }

    // crossing / parking_zone / bus_stop / driveway come from the location catalog.
    const kindAvailable =
      feature.kind === 'crossing'
        ? index.capabilities.crossings
        : feature.kind === 'parking_zone'
          ? index.capabilities.parkingZones
          : feature.kind === 'work_zone_suitable'
            ? index.capabilities.workZones
            : feature.kind === 'occlusion_zone'
              ? index.capabilities.occlusionZones
              : index.pointFeatures.some((p) => p.kind === feature.kind);
    if (!kindAvailable) {
      push(collector, unsupported(`${path}.atM`, feature.atM, `this map index carries no ${feature.kind} layer`));
      continue;
    }
    const onPath = index.pointFeatures
      .filter((p) => p.kind === feature.kind)
      .map((p) => {
        const located = pointFeatureS(index, frame, p);
        return located ? { p, ...located } : null;
      })
      .filter((e): e is { p: PointFeature; s: number; adjacent: boolean; source: 'point-same-road' | 'point-nearby' | 'lane-adjacent'; distanceM: number; side: 'left' | 'right' | 'both' } => e !== null)
      .map((e) => ({
        ...e,
        // Every kind-specific predicate the authored feature carries, scored
        // against *this* candidate, so the ranking below prefers a candidate
        // that satisfies them over one that merely sits at the right station.
        pointClauses: [
          ...evaluateCrossingPredicates(feature, e.p, path, anchor),
          ...evaluateParkingPredicates(feature, e.p, path, anchor),
          ...evaluateSupportsScenario(feature, e.p, path),
        ],
        sideScore: feature.side ? (featureSideMatches(e.side, feature.side.value) ? 1 : 0) : 1,
        sameRoadScore: feature.sameRoad
          ? (feature.sameRoad.value === (e.source === 'point-same-road') ? 1 : 0)
          : 1,
        lateral: feature.lateralDistanceM
          ? scoreRange(
              e.distanceM,
              feature.lateralDistanceM.value,
              'distanceM',
              anchor.toleranceOverrides,
              feature.lateralDistanceM.tolerance,
            )
          : { score: 1, slack: 0 },
        ...scoreRange(e.s, feature.atM.value, 'distanceM', anchor.toleranceOverrides, feature.atM.tolerance),
      }))
      .sort((a, b) =>
        Number(
          (feature.atM.essentiality !== 'required' || b.score === 1) &&
          (feature.lateralDistanceM?.essentiality !== 'required' || b.lateral.score === 1) &&
          (feature.sameRoad?.essentiality !== 'required' || b.sameRoadScore === 1) &&
          (feature.side?.essentiality !== 'required' || b.sideScore === 1) &&
          b.pointClauses.every((clause) => clause.essentiality !== 'required' || (clause.supported && passesRequired(clause.score))),
        ) - Number(
          (feature.atM.essentiality !== 'required' || a.score === 1) &&
          (feature.lateralDistanceM?.essentiality !== 'required' || a.lateral.score === 1) &&
          (feature.sameRoad?.essentiality !== 'required' || a.sameRoadScore === 1) &&
          (feature.side?.essentiality !== 'required' || a.sideScore === 1) &&
          a.pointClauses.every((clause) => clause.essentiality !== 'required' || (clause.supported && passesRequired(clause.score))),
        ) ||
        b.pointClauses.reduce((sum, clause) => sum + clause.score * clause.weight, 0) -
          a.pointClauses.reduce((sum, clause) => sum + clause.score * clause.weight, 0) ||
        b.score - a.score ||
        b.lateral.score - a.lateral.score ||
        b.sameRoadScore - a.sameRoadScore ||
        b.sideScore - a.sideScore ||
        a.distanceM - b.distanceM ||
        (a.adjacent === b.adjacent ? 0 : a.adjacent ? 1 : -1) ||
        (a.p.id < b.p.id ? -1 : 1),
      );
    const best = onPath[0];
    if (!best) {
      push(collector, unsupported(`${path}.atM`, feature.atM, `no ${feature.kind} on the reference path`));
      continue;
    }
    featureMatches[feature.id] = { mapFeatureId: best.p.id, s: best.s, kind: feature.kind };
    push(collector, {
      path: `${path}.atM`,
      essentiality: feature.atM.essentiality,
      required: feature.atM.value,
      actual: round(best.s),
      score: best.score,
      slack: best.slack,
      weight: clauseWeight(feature.atM),
      supported: true,
      worstAtS: best.s,
      reason: `${feature.kind} ${best.p.id} at s=${round(best.s)} m${best.source === 'point-same-road' ? ` (same-road station, ${round(best.distanceM)} m lateral)` : best.source === 'point-nearby' ? ` (projected ${round(best.distanceM)} m from feature point)` : best.adjacent ? ' on an adjacent lane' : ''}`,
    });
    if (feature.lateralDistanceM) {
      push(collector, {
        path: `${path}.lateralDistanceM`,
        essentiality: feature.lateralDistanceM.essentiality,
        required: feature.lateralDistanceM.value,
        actual: round(best.distanceM),
        score: best.lateral.score,
        slack: best.lateral.slack,
        weight: clauseWeight(feature.lateralDistanceM),
        supported: true,
        worstAtS: best.s,
        reason: `${feature.kind} ${best.p.id} is ${round(best.distanceM)} m laterally from the reference path`,
      });
    }
    if (feature.sameRoad) {
      const actual = best.source === 'point-same-road';
      const matches = feature.sameRoad.value === actual;
      push(collector, {
        path: `${path}.sameRoad`,
        essentiality: feature.sameRoad.essentiality,
        required: feature.sameRoad.value,
        actual,
        score: matches ? 1 : 0,
        slack: matches ? 0 : 1,
        weight: clauseWeight(feature.sameRoad),
        supported: true,
        worstAtS: best.s,
        reason: actual
          ? `${feature.kind} ${best.p.id} shares the reference OpenDRIVE road and section`
          : `${feature.kind} ${best.p.id} is only geometrically near the reference path`,
      });
    }
    if (feature.side) {
      const matches = featureSideMatches(best.side, feature.side.value);
      push(collector, {
        path: `${path}.side`,
        essentiality: feature.side.essentiality,
        required: feature.side.value,
        actual: best.side,
        score: matches ? 1 : 0,
        slack: matches ? 0 : 1,
        weight: clauseWeight(feature.side),
        supported: true,
        worstAtS: best.s,
        reason: matches
          ? `${feature.kind} ${best.p.id} is on the ${best.side} side of travel`
          : `${feature.kind} ${best.p.id} is on the ${best.side} side of travel, wanted ${feature.side.value}`,
      });
    }
    for (const clause of best.pointClauses) push(collector, clause);
  }

  collector.results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const reasons = collector.results
    .filter((r) => r.score >= 1 && r.supported)
    .map((r) => r.reason);

  return { clauses: collector.results, featureMatches, reasons, samples };
}

/** Weighted score over the soft clauses; required clauses are pass/fail. */
export function aggregateScore(clauses: ClauseResult[]): {
  score: number;
  failedRequired: string[];
} {
  const failedRequired = clauses
    .filter((c) => c.essentiality === 'required' && !passesRequired(c.score))
    .map((c) => c.path);
  let weighted = 0;
  let total = 0;
  for (const c of clauses) {
    if (c.essentiality === 'required') continue;
    if (!c.supported) continue;
    weighted += c.score * c.weight;
    total += c.weight;
  }
  const soft = total === 0 ? 1 : weighted / total;
  return { score: soft, failedRequired };
}

export { toleranceFor };
