/**
 * `matchAnchor(anchor, mapIndex) -> MatchedSite[]`.
 *
 * The pipeline is exactly the one in `docs/research/retargeting.md` § Matcher:
 *
 * ```
 * selectivity-ordered candidate generation   (rarest clause first, usually
 *                                             junction class, from FactIndex)
 *   -> frame construction                    (straightest continuation; genuine
 *                                             ambiguity ⇒ both candidates)
 *   -> clause evaluation                     (worst value over the s-interval)
 *   -> aggregate score                       (required pass/fail; preferred and
 *                                             cosmetic weighted)
 *   -> repairs + degradation report
 *   -> diversity dedup                       ("which lane" is a parameter)
 *   -> stable sort by (-score, siteId)
 * ```
 *
 * The function is **pure**: no clock, no RNG, no ambient state, and every
 * fan-out is iterated in sorted order.
 */

import { aggregateScore, evaluateAnchor, laneCountTransitions, sampleCorridor } from './clauses.js';
import { bindRoles } from './bind.js';
import { crossSectionAt } from './cross-section.js';
import { degrade } from './degradation.js';
import { buildCorridorFrame, buildJunctionFrames } from './frame.js';
import { mirrorAnchor, mirrorRoleBindings } from './mirror.js';
import { nearMissScore } from './scoring.js';
import { computeSiteId } from './site-id.js';
import { MATCH_SEMANTICS_VERSION } from './version.js';
import { originFeature, resolvePolicy } from './types/anchor.js';
import type { AnchorFeature, JunctionControl, LogicalAnchor } from './types/anchor.js';
import type { DerivedMapIndex, LaneRsl } from './types/map-index.js';
import type { RoleBinding } from './types/roles.js';
import type { AnchorFrame, MatchReport, MatchStats, MatchedSite } from './types/site.js';

/**
 * Corridor segments are indexed from their head, while merge/lane-drop and
 * work-zone templates state actor poses relative to a physical feature.
 * Recenter those structural origins before evaluating runway and role bindings. This makes
 * `s=0` mean the mechanism site (as it already does for junction anchors), and
 * keeps the segment id as the stable map feature used by catalog closure.
 */
function recenterStructuralCorridor(
  index: DerivedMapIndex,
  anchor: LogicalAnchor,
  frame: AnchorFrame,
): AnchorFrame {
  if (frame.origin.kind !== 'corridor') return frame;
  const origin = originFeature(anchor);
  let shift: number;
  if (!origin) {
    // A featureless corridor template still needs a meaningful zero station:
    // place it after the requested approach runway so negative actor poses are
    // genuine drivable positions rather than falling before the segment head.
    shift = anchor.corridor?.runwayUpstreamM?.value ?? 0;
    if (shift <= frame.sRange[0] || shift >= frame.sRange[1]) return frame;
  } else if (origin.kind === 'merge' || origin.kind === 'lane_drop') {
    const transitions = laneCountTransitions(index, sampleCorridor(index, frame, frame.sRange[0], frame.sRange[1]), frame)
      .filter((transition) => transition.kind === origin.kind);
    const selected = transitions.sort((left, right) => left.s - right.s)[0];
    if (!selected) return frame;
    shift = selected.s;
  } else if (origin.kind === 'work_zone_suitable') {
    const wantedAt = (origin.atM.value[0] + origin.atM.value[1]) / 2;
    const pathLanes = new Set(frame.referencePath.map((span) => span.laneRsl));
    const candidates = index.pointFeatures
      .filter((feature) => feature.kind === 'work_zone_suitable' && pathLanes.has(feature.laneRsl))
      .map((feature) => {
        const span = frame.referencePath.find((candidate) => candidate.laneRsl === feature.laneRsl)!;
        const featureS = span.sStart + Math.max(0, Math.min(span.lengthM, feature.s));
        return { feature, featureS, shift: featureS - wantedAt };
      })
      .filter((candidate) => candidate.shift > frame.sRange[0] && candidate.shift < frame.sRange[1])
      .sort((left, right) => left.featureS - right.featureS || left.feature.id.localeCompare(right.feature.id));
    const selected = candidates[0];
    if (!selected) return frame;
    shift = selected.shift;
  } else {
    return frame;
  }
  const originSpan = frame.referencePath.find((span) => shift >= span.sStart && shift <= span.sEnd);
  const originLane = originSpan ? index.lanes[originSpan.laneRsl] : undefined;
  const localS = originSpan ? Math.max(0, Math.min(originSpan.lengthM, shift - originSpan.sStart)) : 0;
  const crossSection = originLane ? crossSectionAt(index.lanes, originLane.rsl, localS) : null;
  const lateralLanes: Record<number, LaneRsl> = {};
  if (crossSection) {
    for (const [k, rsl] of [...crossSection.sameDirDriving.entries()].sort((a, b) => a[0] - b[0])) {
      lateralLanes[k] = rsl;
    }
  }

  return {
    ...frame,
    referencePath: frame.referencePath.map((span) => ({
      ...span,
      sStart: span.sStart - shift,
      sEnd: span.sEnd - shift,
    })),
    sOfLane: Object.fromEntries(
      Object.entries(frame.sOfLane).map(([rsl, s]) => [rsl, s - shift]),
    ),
    sRange: [frame.sRange[0] - shift, frame.sRange[1] - shift],
    lateralLanes: crossSection ? lateralLanes : frame.lateralLanes,
    opposingLanes: crossSection ? [...crossSection.opposingDriving] : frame.opposingLanes,
    runwayUpstreamM: shift - frame.sRange[0],
    runwayDownstreamM: frame.sRange[1] - shift,
  };
}

export interface MatchOptions {
  /** Roles to bind structurally at each site. Optional: clauses alone still match. */
  roles?: RoleBinding[];
  /** Hard cap on candidate frames, as a guard against pathological anchors. */
  maxFrames?: number;
}

const DEFAULT_MAX_FRAMES = 4000;

interface CandidateSelector {
  path: string;
  ids: string[];
}

const ALL_CONTROLS: JunctionControl[] = [
  'signalized',
  'all_way_stop',
  'minor_stop',
  'yield',
  'uncontrolled',
  'roundabout',
];

/**
 * Junction candidates from the FactIndex, driven by the rarest usable clause.
 *
 * Near-miss classes are admitted **even for a `required` clause**, and the
 * degradation pass rejects them. Generating them costs almost nothing and it is
 * the difference between the site picker saying *"nothing matched"* and saying
 * *"this junction is an all-way stop, and you required a signal"*.
 */
function junctionCandidates(
  index: DerivedMapIndex,
  feature: AnchorFeature,
): { ids: string[]; selectivityOrder: string[] } {
  const selectors: CandidateSelector[] = [];
  const jp = feature.junction;

  if (jp?.control) {
    const wanted = new Set<string>(jp.control.value);
    for (const control of ALL_CONTROLS) {
      if ([...jp.control.value].some((w) => nearMissScore(control, w) > 0)) wanted.add(control);
    }
    const ids = new Set<string>();
    for (const control of [...wanted].sort()) {
      for (const id of index.factIndex.junctionsByControl[control] ?? []) ids.add(id);
    }
    selectors.push({ path: 'junction.control', ids: [...ids].sort() });
  }

  if (jp?.arms) {
    const [lo, hi] = jp.arms.value;
    // ±1 arm is the near-miss band (`4way↔3way 0.4`), for the same reason.
    const slack = 1;
    const ids = new Set<string>();
    for (const key of Object.keys(index.factIndex.junctionsByArms).sort()) {
      const arms = Number(key);
      if (arms >= lo - slack && arms <= hi + slack) {
        for (const id of index.factIndex.junctionsByArms[key] ?? []) ids.add(id);
      }
    }
    selectors.push({ path: 'junction.arms', ids: [...ids].sort() });
  }

  if (jp?.egoTurn) {
    const ids = index.factIndex.junctionsByTurnOption[jp.egoTurn.value] ?? [];
    selectors.push({ path: 'junction.egoTurn', ids: [...ids].sort() });
  }

  const all = Object.keys(index.junctionDescriptors).sort();
  if (selectors.length === 0) return { ids: all, selectivityOrder: [] };

  // Selectivity order: rarest first. Intersecting is cheap at this scale, but
  // the order is what we report (and what a future lazy generator would use).
  selectors.sort((a, b) => a.ids.length - b.ids.length || (a.path < b.path ? -1 : 1));
  let ids = selectors[0]!.ids;
  for (const selector of selectors.slice(1)) {
    const set = new Set(selector.ids);
    ids = ids.filter((id) => set.has(id));
  }
  return { ids, selectivityOrder: selectors.map((s) => `${s.path}(${s.ids.length})`) };
}

/** Segment candidates for a corridor-only anchor. */
function segmentCandidates(
  index: DerivedMapIndex,
  anchor: LogicalAnchor,
): { ids: string[]; selectivityOrder: string[] } {
  const clause = anchor.corridor?.throughLanesSameDir;
  if (!clause) return { ids: index.segments.map((s) => s.id), selectivityOrder: [] };
  const [lo, hi] = clause.value;
  const slack = clause.essentiality === 'required' ? 0 : 1;
  const ids = new Set<string>();
  for (const key of Object.keys(index.factIndex.segmentsByLaneCount).sort()) {
    const n = Number(key);
    if (n >= lo - slack && n <= hi + slack) {
      for (const id of index.factIndex.segmentsByLaneCount[key] ?? []) ids.add(id);
    }
  }
  const sorted = [...ids].sort();
  return {
    ids: sorted,
    selectivityOrder: [`corridor.throughLanesSameDir(${sorted.length})`],
  };
}

/** Approach lanes of a junction, from its gates (sorted, driving only). */
function approachLanesOf(index: DerivedMapIndex, junctionId: string): LaneRsl[] {
  const set = new Set<LaneRsl>();
  for (const gate of index.gates) {
    if (gate.junctionId !== junctionId) continue;
    const lane = index.lanes[gate.approachLaneRsl];
    if (lane && lane.laneType === 'driving') set.add(gate.approachLaneRsl);
  }
  return [...set].sort();
}

interface ScoredFrame {
  site: MatchedSite;
  mirrored: boolean;
}

function evaluateFrame(
  index: DerivedMapIndex,
  anchor: LogicalAnchor,
  roles: RoleBinding[],
  frame: AnchorFrame,
): MatchedSite {
  frame = recenterStructuralCorridor(index, anchor, frame);
  const evaluation = evaluateAnchor({ index, frame, anchor });
  const bindings = bindRoles(index, frame, roles, evaluation.featureMatches);
  const { score: softScore, failedRequired } = aggregateScore(evaluation.clauses);
  const { report, score } = degrade({
    anchor,
    roles,
    clauses: evaluation.clauses,
    bindings,
    softScore,
    failedRequiredClauses: failedRequired,
  });

  const entryLane = index.lanes[frame.entryLaneRsl];
  const originS = frame.origin.kind === 'corridor' ? 0 : (entryLane?.lengthM ?? 0);
  const siteId = computeSiteId({
    anchorId: anchor.id,
    mapId: index.mapId,
    topologyDigest: index.topologyDigest,
    originFeatureId: frame.origin.mapFeatureId,
    entryLaneRsl: frame.entryLaneRsl,
    originS,
  });

  const matchedReasons = [...evaluation.reasons];
  for (const binding of bindings) {
    for (const note of binding.notes) matchedReasons.push(`${binding.role}: ${note}`);
  }
  if (frame.mirrored) matchedReasons.push('matched in mirror (policy.allowMirror)');
  if (frame.referencePath.some((s) => !s.contiguous)) {
    matchedReasons.push('warning: the reference path contains a non-contiguous lane link');
  }

  return {
    siteId,
    mapId: index.mapId,
    topologyDigest: index.topologyDigest,
    matchSemanticsVersion: MATCH_SEMANTICS_VERSION,
    anchorId: anchor.id,
    score,
    frame,
    clauses: evaluation.clauses,
    bindings,
    featureMatches: evaluation.featureMatches,
    degradation: report,
    matchedReasons,
    alternateFrames: 0,
  };
}

/**
 * Resolve one persisted corridor origin without enumerating unrelated map
 * segments. This is for deterministic replay of a previously audited site;
 * it still runs the ordinary frame evaluation and role binding pipeline.
 */
export function resolveExactCorridorSite(
  anchor: LogicalAnchor,
  index: DerivedMapIndex,
  segmentId: string,
  options: Pick<MatchOptions, 'roles'> = {},
): MatchedSite | null {
  const origin = originFeature(anchor);
  if (origin?.kind === 'junction') return null;
  const downstreamNeed = anchor.corridor?.runwayDownstreamM?.value;
  const frameDownstreamNeed = downstreamNeed === undefined
    ? undefined
    : downstreamNeed + (anchor.corridor?.runwayUpstreamM?.value ?? 0);
  const frame = buildCorridorFrame(index, segmentId, {
    anchorFeatureId: origin?.id ?? 'corridor',
    ...(frameDownstreamNeed === undefined ? {} : { runwayDownstreamM: frameDownstreamNeed }),
  });
  return frame === null ? null : evaluateFrame(index, anchor, options.roles ?? [], frame);
}

function diversityKey(
  site: MatchedSite,
  index: DerivedMapIndex,
  diversity: 'junction' | 'road_direction' | 'none',
): string {
  if (diversity === 'none') return site.siteId;
  if (diversity === 'junction') return site.frame.origin.mapFeatureId;
  const lane = index.lanes[site.frame.entryLaneRsl];
  if (!lane) return site.frame.entryLaneRsl;
  return `${lane.roadId}:${lane.laneId >= 0 ? 'pos' : 'neg'}`;
}

/** Full matcher output, including the sites that were rejected and why. */
export function matchAnchorReport(
  anchor: LogicalAnchor,
  index: DerivedMapIndex,
  options: MatchOptions = {},
): MatchReport {
  const policy = resolvePolicy(anchor);
  const roles = options.roles ?? [];
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  const warnings: string[] = [];

  const origin = originFeature(anchor);
  const stats: MatchStats = {
    candidatesConsidered: 0,
    framesBuilt: 0,
    sitesScored: 0,
    sitesInfeasible: 0,
    sitesBelowMinScore: 0,
    sitesDroppedByDiversity: 0,
    selectivityOrder: [],
  };

  // --- 1. candidate generation ------------------------------------------
  const frames: AnchorFrame[] = [];
  const mirroredAnchor = policy.allowMirror ? mirrorAnchor(anchor) : null;
  const mirroredRoles = policy.allowMirror ? mirrorRoleBindings(roles) : roles;
  const mirroredOrigin = mirroredAnchor ? originFeature(mirroredAnchor) : undefined;
  const mirroredFrames: AnchorFrame[] = [];

  if (origin && origin.kind === 'junction') {
    const { ids, selectivityOrder } = junctionCandidates(index, origin);
    stats.selectivityOrder = selectivityOrder;
    stats.candidatesConsidered = ids.length;
    const upstreamNeed = anchor.corridor?.runwayUpstreamM?.value;
    const downstreamNeed = anchor.corridor?.runwayDownstreamM?.value;
    for (const junctionId of ids) {
      for (const laneRsl of approachLanesOf(index, junctionId)) {
        if (frames.length >= maxFrames) break;
        const build = (turn: AnchorFeature['junction'], mirrored: boolean): AnchorFrame[] =>
          buildJunctionFrames(index, junctionId, laneRsl, {
            ...(turn?.egoTurn ? { egoTurn: turn.egoTurn.value } : {}),
            ...(upstreamNeed !== undefined ? { runwayUpstreamM: upstreamNeed } : {}),
            ...(downstreamNeed !== undefined ? { runwayDownstreamM: downstreamNeed } : {}),
            anchorFeatureId: origin.id,
            mirrored,
          });
        frames.push(...build(origin.junction, false));
        if (mirroredOrigin) mirroredFrames.push(...build(mirroredOrigin.junction, true));
      }
    }
  } else {
    const { ids, selectivityOrder } = segmentCandidates(index, anchor);
    stats.selectivityOrder = selectivityOrder;
    stats.candidatesConsidered = ids.length;
    const anchorFeatureId = origin?.id ?? 'corridor';
    for (const segmentId of ids) {
      if (frames.length >= maxFrames) break;
      const downstreamNeed = anchor.corridor?.runwayDownstreamM?.value;
      // Corridor frames are initially built from the segment head and only
      // then recentered on the authored structural zero. Reserve the approach
      // distance as well, otherwise a featureless `100 m upstream + 180 m
      // downstream` anchor is built as 180 m total and necessarily loses its
      // downstream runway when shifted by 100 m.
      const frameDownstreamNeed = downstreamNeed === undefined
        ? undefined
        : downstreamNeed + (anchor.corridor?.runwayUpstreamM?.value ?? 0);
      const frame = buildCorridorFrame(index, segmentId, {
        anchorFeatureId,
        ...(frameDownstreamNeed !== undefined ? { runwayDownstreamM: frameDownstreamNeed } : {}),
      });
      if (frame) frames.push(frame);
      if (mirroredAnchor) {
        const mirroredFrame = buildCorridorFrame(index, segmentId, {
          anchorFeatureId,
          ...(frameDownstreamNeed !== undefined ? { runwayDownstreamM: frameDownstreamNeed } : {}),
          mirrored: true,
        });
        if (mirroredFrame) mirroredFrames.push(mirroredFrame);
      }
    }
  }
  stats.framesBuilt = frames.length + mirroredFrames.length;

  // --- 2-4. frame evaluation, scoring, degradation -----------------------
  const scored: ScoredFrame[] = [];
  for (const frame of frames) {
    scored.push({ site: evaluateFrame(index, anchor, roles, frame), mirrored: false });
  }
  if (mirroredAnchor) {
    for (const frame of mirroredFrames) {
      scored.push({
        site: evaluateFrame(index, mirroredAnchor, mirroredRoles, frame),
        mirrored: true,
      });
    }
  }
  stats.sitesScored = scored.length;

  // --- 5. collapse frames that resolved to the same site -----------------
  const bySiteId = new Map<string, { best: ScoredFrame; alternates: number }>();
  for (const candidate of [...scored].sort((a, b) =>
    a.site.siteId < b.site.siteId ? -1 : a.site.siteId > b.site.siteId ? 1 : 0,
  )) {
    const existing = bySiteId.get(candidate.site.siteId);
    if (!existing) {
      bySiteId.set(candidate.site.siteId, { best: candidate, alternates: 0 });
      continue;
    }
    existing.alternates += 1;
    const better =
      candidate.site.score > existing.best.site.score ||
      (candidate.site.score === existing.best.site.score &&
        !candidate.mirrored &&
        existing.best.mirrored);
    if (better) existing.best = candidate;
  }

  const collapsed: MatchedSite[] = [...bySiteId.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, entry]) => ({ ...entry.best.site, alternateFrames: entry.alternates }));

  // --- 6. feasibility, minScore, diversity -------------------------------
  const rejected: MatchedSite[] = [];
  const feasible: MatchedSite[] = [];
  for (const site of collapsed) {
    if (site.degradation.verdict === 'infeasible') {
      stats.sitesInfeasible += 1;
      rejected.push(site);
    } else if (site.score < policy.minScore) {
      stats.sitesBelowMinScore += 1;
      rejected.push(site);
    } else {
      feasible.push(site);
    }
  }

  // Stable sort by (-score, siteId) before dedup, so "best per junction" is
  // deterministic regardless of candidate order.
  feasible.sort((a, b) => b.score - a.score || (a.siteId < b.siteId ? -1 : 1));

  const seen = new Set<string>();
  const diverse: MatchedSite[] = [];
  for (const site of feasible) {
    const key = diversityKey(site, index, policy.diversity);
    if (seen.has(key)) {
      stats.sitesDroppedByDiversity += 1;
      rejected.push(site);
      continue;
    }
    seen.add(key);
    diverse.push(site);
  }

  let sites = diverse.slice(0, policy.maxSitesPerMap);

  // --- 7. pin escape hatch ----------------------------------------------
  if (anchor.pin) {
    if (anchor.pin.mapId !== index.mapId) {
      sites = [];
      warnings.push(
        `anchor is pinned to map "${anchor.pin.mapId}" but was matched against "${index.mapId}"`,
      );
    } else {
      const pinned = [...sites, ...rejected].filter((s) => s.siteId === anchor.pin?.siteId);
      if (pinned.length === 0) {
        warnings.push(`pinned site "${anchor.pin.siteId}" was not produced on this map`);
      }
      sites = pinned.filter((s) => s.degradation.verdict !== 'infeasible');
    }
  }

  // --- capability warnings ----------------------------------------------
  if (!index.capabilities.junctionControl) {
    warnings.push('map index carries no junction control: control clauses cannot be answered');
  }
  if (!index.capabilities.crossings) {
    warnings.push('map index carries no crossing layer: crossing features and on_crossing roles cannot bind');
  }
  if (!index.capabilities.workZones && anchor.features.some((feature) => feature.kind === 'work_zone_suitable')) {
    warnings.push('map index carries no work-zone suitability layer: rebuild locations with work-zone densification');
  }
  if (!index.capabilities.occlusionZones && anchor.features.some((feature) => feature.kind === 'occlusion_zone')) {
    warnings.push('map index carries no occlusion-zone layer: provide catalog sight-line/occluder evidence');
  }

  return {
    sites,
    rejected: rejected.sort((a, b) => b.score - a.score || (a.siteId < b.siteId ? -1 : 1)),
    stats,
    failureSummary: sites.length > 0 ? '' : summarizeFailure(collapsed, stats, policy.minScore),
    warnings,
  };
}

function summarizeFailure(
  collapsed: MatchedSite[],
  stats: MatchStats,
  minScore: number,
): string {
  if (stats.candidatesConsidered === 0) {
    return 'No candidate structure on this map satisfied the anchor\'s indexed clauses (junction class / lane count), so no site was even considered.';
  }
  if (collapsed.length === 0) {
    return `Considered ${stats.candidatesConsidered} candidate(s) but no anchor frame could be constructed — typically no approach offers the requested ego movement.`;
  }
  const counts = new Map<string, number>();
  for (const site of collapsed) {
    for (const path of site.degradation.failedRequiredClauses) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return `All ${collapsed.length} site(s) scored below the minimum ${minScore}. Best score was ${Math.max(
      ...collapsed.map((s) => s.score),
    ).toFixed(2)}.`;
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const worst = ranked
    .slice(0, 3)
    .map(([path, count]) => `${path} (failed at ${count}/${collapsed.length} sites)`)
    .join(', ');
  const example = collapsed.find((s) => s.degradation.failedRequiredClauses.length > 0);
  return `No feasible site. Required clauses that failed most often: ${worst}. Example: ${
    example?.degradation.summary ?? ''
  }`;
}

/** Ranked, feasible sites for this anchor on this map. */
export function matchAnchor(
  anchor: LogicalAnchor,
  index: DerivedMapIndex,
  options: MatchOptions = {},
): MatchedSite[] {
  return matchAnchorReport(anchor, index, options).sites;
}
