/**
 * `AnchorFrame` construction — the coordinate system every pose is expressed
 * in.
 *
 * Per `docs/research/retargeting.md` § AnchorFrame + § Matcher:
 *
 * > frame construction (walk predecessors/successors preferring straightest
 * > continuation; genuine ambiguity ⇒ emit both candidates)
 *
 * `s = 0` sits at the origin feature (for a junction anchor: the stop line, i.e.
 * the travel-end of the entry lane). Upstream is negative, downstream positive.
 */

import { angleDiff, dist, headingAtS } from './geometry.js';
import { crossSectionAt } from './cross-section.js';
import { LINK_TOLERANCE_M } from './derive.js';
import type { Turn } from './types/anchor.js';
import type { DerivedLane, DerivedMapIndex, LaneRsl } from './types/map-index.js';
import type { AnchorFrame, ReferenceSpan } from './types/site.js';

/** Two continuations within this angle are *genuinely* ambiguous. */
export const AMBIGUITY_EPS_RAD = (10 * Math.PI) / 180;
/** Hard cap on frames emitted per (junction, approach) candidate. */
export const MAX_FRAMES_PER_CANDIDATE = 4;
/** Default walk distances when the anchor states no runway requirement. */
export const DEFAULT_RUNWAY_UPSTREAM_M = 150;
export const DEFAULT_RUNWAY_DOWNSTREAM_M = 150;

interface Chain {
  lanes: LaneRsl[];
  lengthM: number;
  last: LaneRsl;
  visited: Set<LaneRsl>;
  /** False once a link in the chain was not physically contiguous. */
  contiguous: boolean[];
}

function neighborsSorted(
  index: DerivedMapIndex,
  laneRsl: LaneRsl,
  dir: 'forward' | 'backward',
): LaneRsl[] {
  const lane = index.lanes[laneRsl];
  if (!lane) return [];
  const raw = dir === 'forward' ? lane.successors : lane.predecessors;
  const drivable = raw.filter((r) => {
    const other = index.lanes[r];
    return !!other && other.laneType === 'driving' && other.polyline.length >= 2;
  });
  const straightness = (other: LaneRsl): number => {
    const o = index.lanes[other];
    if (!o) return Math.PI;
    if (dir === 'forward') {
      return Math.abs(angleDiff(headingAtS(o.polyline, 0), headingAtS(lane.polyline, lane.lengthM)));
    }
    return Math.abs(angleDiff(headingAtS(lane.polyline, 0), headingAtS(o.polyline, o.lengthM)));
  };
  return drivable
    .map((r) => ({ r, m: straightness(r) }))
    .sort((a, b) => a.m - b.m || (a.r < b.r ? -1 : 1))
    .map((e) => e.r);
}

function linkContiguous(
  index: DerivedMapIndex,
  from: LaneRsl,
  to: LaneRsl,
  dir: 'forward' | 'backward',
): boolean {
  const a = index.lanes[dir === 'forward' ? from : to];
  const b = index.lanes[dir === 'forward' ? to : from];
  if (!a || !b || a.polyline.length < 2 || b.polyline.length < 2) return false;
  return dist(a.polyline[a.polyline.length - 1]!, b.polyline[0]!) <= LINK_TOLERANCE_M;
}

/**
 * Enumerate lane chains away from `startRsl`, preferring the straightest
 * continuation and branching only where two continuations are genuinely
 * ambiguous.
 */
export function enumerateChains(
  index: DerivedMapIndex,
  startRsl: LaneRsl,
  needM: number,
  dir: 'forward' | 'backward',
  cap = MAX_FRAMES_PER_CANDIDATE,
): Array<{ lanes: LaneRsl[]; lengthM: number; contiguous: boolean[] }> {
  let open: Chain[] = [
    { lanes: [], lengthM: 0, last: startRsl, visited: new Set([startRsl]), contiguous: [] },
  ];
  const done: Chain[] = [];
  for (let step = 0; step < 64 && open.length > 0; step += 1) {
    const next: Chain[] = [];
    for (const chain of open) {
      if (chain.lengthM >= needM) {
        done.push(chain);
        continue;
      }
      const candidates = neighborsSorted(index, chain.last, dir).filter((r) => !chain.visited.has(r));
      if (candidates.length === 0) {
        done.push(chain);
        continue;
      }
      const lane = index.lanes[chain.last]!;
      const angleOf = (other: LaneRsl): number => {
        const o = index.lanes[other]!;
        return dir === 'forward'
          ? Math.abs(angleDiff(headingAtS(o.polyline, 0), headingAtS(lane.polyline, lane.lengthM)))
          : Math.abs(angleDiff(headingAtS(lane.polyline, 0), headingAtS(o.polyline, o.lengthM)));
      };
      const best = candidates[0] as LaneRsl;
      const options: LaneRsl[] = [best];
      const second = candidates[1];
      if (second && Math.abs(angleOf(second) - angleOf(best)) < AMBIGUITY_EPS_RAD) {
        options.push(second);
      }
      for (const opt of options) {
        const optLane = index.lanes[opt]!;
        next.push({
          lanes: dir === 'forward' ? [...chain.lanes, opt] : [opt, ...chain.lanes],
          lengthM: chain.lengthM + optLane.lengthM,
          last: opt,
          visited: new Set([...chain.visited, opt]),
          contiguous:
            dir === 'forward'
              ? [...chain.contiguous, linkContiguous(index, chain.last, opt, dir)]
              : [linkContiguous(index, chain.last, opt, dir), ...chain.contiguous],
        });
      }
    }
    // Deterministic breadth cap: keep the longest, then lexicographically first.
    next.sort(
      (a, b) => b.lengthM - a.lengthM || (a.lanes.join('>') < b.lanes.join('>') ? -1 : 1),
    );
    open = next.slice(0, cap);
    if (done.length >= cap) break;
  }
  const all = [...done, ...open];
  const unique = new Map<string, Chain>();
  for (const chain of all) {
    const key = chain.lanes.join('>');
    const existing = unique.get(key);
    if (!existing || chain.lengthM > existing.lengthM) unique.set(key, chain);
  }
  return [...unique.values()]
    .sort((a, b) => b.lengthM - a.lengthM || (a.lanes.join('>') < b.lanes.join('>') ? -1 : 1))
    .slice(0, cap)
    .map((c) => ({ lanes: c.lanes, lengthM: c.lengthM, contiguous: c.contiguous }));
}

export interface JunctionFrameOptions {
  egoTurn?: Turn;
  runwayUpstreamM?: number;
  runwayDownstreamM?: number;
  /** Anchor feature id that the origin corresponds to. */
  anchorFeatureId: string;
  mirrored?: boolean;
}

function buildSpansAndS(
  index: DerivedMapIndex,
  upstream: { lanes: LaneRsl[]; contiguous: boolean[] },
  entryRsl: LaneRsl,
  downstream: { lanes: LaneRsl[]; contiguous: boolean[] },
): { spans: ReferenceSpan[]; sOfLane: Record<LaneRsl, number>; sRange: [number, number] } {
  const ordered: Array<{ rsl: LaneRsl; contiguous: boolean }> = [];
  upstream.lanes.forEach((rsl, i) => ordered.push({ rsl, contiguous: upstream.contiguous[i] ?? true }));
  ordered.push({ rsl: entryRsl, contiguous: true });
  downstream.lanes.forEach((rsl, i) =>
    ordered.push({ rsl, contiguous: downstream.contiguous[i] ?? true }),
  );

  const entryLane = index.lanes[entryRsl];
  const upstreamLength = upstream.lanes.reduce((acc, r) => acc + (index.lanes[r]?.lengthM ?? 0), 0);
  let cursor = -(upstreamLength + (entryLane?.lengthM ?? 0));

  const spans: ReferenceSpan[] = [];
  const sOfLane: Record<LaneRsl, number> = {};
  for (const entry of ordered) {
    const lane = index.lanes[entry.rsl];
    if (!lane) continue;
    const sStart = cursor;
    const sEnd = cursor + lane.lengthM;
    spans.push({
      laneRsl: entry.rsl,
      sStart,
      sEnd,
      lengthM: lane.lengthM,
      isJunction: lane.isJunction,
      contiguous: entry.contiguous,
    });
    sOfLane[entry.rsl] = sStart;
    cursor = sEnd;
  }
  const first = spans[0];
  const last = spans[spans.length - 1];
  return {
    spans,
    sOfLane,
    sRange: [first?.sStart ?? 0, last?.sEnd ?? 0],
  };
}

/**
 * Lateral lanes at the origin cross-section.
 *
 * Note what this does **not** do: it does not flip `k` for a mirrored frame.
 * Mirroring is applied once, to the anchor and the role list (`mirror.ts`), so
 * frames, poses and lane maps all stay in *map* space and agree with each
 * other. `frame.mirrored` is the flag that tells the UI the template was
 * reflected to get here; flipping the lane map as well would double-apply it.
 */
function lateralAtOrigin(
  index: DerivedMapIndex,
  entryLane: DerivedLane,
): { lateralLanes: Record<number, LaneRsl>; opposingLanes: LaneRsl[] } {
  const cs = crossSectionAt(index.lanes, entryLane.rsl, Math.max(0, entryLane.lengthM - 0.5));
  const lateralLanes: Record<number, LaneRsl> = {};
  if (cs) {
    for (const [k, rsl] of [...cs.sameDirDriving.entries()].sort((a, b) => a[0] - b[0])) {
      lateralLanes[k] = rsl;
    }
  }
  return { lateralLanes, opposingLanes: cs ? [...cs.opposingDriving] : [] };
}

/**
 * Build the frames for one (junction, entry lane) candidate.
 *
 * Genuine ambiguity — several gates with the requested turn, or several equally
 * straight continuations — yields several frames. They collapse to one
 * `MatchedSite` later (same site id); the best-scoring frame wins and the
 * losers are counted in `alternateFrames`.
 */
export function buildJunctionFrames(
  index: DerivedMapIndex,
  junctionId: string,
  entryLaneRsl: LaneRsl,
  options: JunctionFrameOptions,
): AnchorFrame[] {
  const entryLane = index.lanes[entryLaneRsl];
  if (!entryLane || entryLane.laneType !== 'driving') return [];

  const gates = index.gates
    .filter((g) => g.junctionId === junctionId && g.approachLaneRsl === entryLaneRsl)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (gates.length === 0) return [];

  let chosenGates = gates;
  if (options.egoTurn) {
    chosenGates = gates.filter((g) => g.turnRelation === options.egoTurn);
    if (chosenGates.length === 0) return [];
  } else {
    // No turn requested: prefer the straightest movement, keeping ties.
    const straightness = gates
      .map((g) => ({ g, m: Math.abs(g.headingChangeRad) }))
      .sort((a, b) => a.m - b.m || (a.g.id < b.g.id ? -1 : 1));
    const bestM = straightness[0]?.m ?? 0;
    chosenGates = straightness
      .filter((e) => Math.abs(e.m - bestM) < AMBIGUITY_EPS_RAD)
      .map((e) => e.g);
  }

  const upNeed = options.runwayUpstreamM ?? DEFAULT_RUNWAY_UPSTREAM_M;
  const downNeed = options.runwayDownstreamM ?? DEFAULT_RUNWAY_DOWNSTREAM_M;
  const upstreamChains = enumerateChains(index, entryLaneRsl, upNeed, 'backward');
  const upstream = upstreamChains[0] ?? { lanes: [], lengthM: 0, contiguous: [] };

  const frames: AnchorFrame[] = [];
  for (const gate of chosenGates.slice(0, MAX_FRAMES_PER_CANDIDATE)) {
    const connecting = index.lanes[gate.connectingLaneRsl];
    if (!connecting) continue;
    const exitChains = enumerateChains(
      index,
      gate.connectingLaneRsl,
      Math.max(0, downNeed - connecting.lengthM),
      'forward',
      2,
    );
    for (const exit of exitChains.slice(0, 2)) {
      const downstream = {
        lanes: [gate.connectingLaneRsl, ...exit.lanes],
        lengthM: connecting.lengthM + exit.lengthM,
        contiguous: [
          linkContiguous(index, entryLaneRsl, gate.connectingLaneRsl, 'forward'),
          ...exit.contiguous,
        ],
      };
      const { spans, sOfLane, sRange } = buildSpansAndS(index, upstream, entryLaneRsl, downstream);
      const { lateralLanes, opposingLanes } = lateralAtOrigin(index, entryLane);
      frames.push({
        origin: {
          anchorFeatureId: options.anchorFeatureId,
          kind: 'junction',
          mapFeatureId: `junction:${junctionId}`,
        },
        entryLaneRsl,
        referencePath: spans,
        sOfLane,
        sRange,
        lateralLanes,
        opposingLanes,
        handedness: index.handedness,
        mirrored: options.mirrored ?? false,
        egoGateId: gate.id,
        egoTurn: gate.turnRelation,
        runwayUpstreamM: upstream.lengthM + entryLane.lengthM,
        runwayDownstreamM: downstream.lengthM,
      });
      if (frames.length >= MAX_FRAMES_PER_CANDIDATE) return frames;
    }
  }
  return frames;
}

/**
 * Frame for a corridor-only anchor (no junction feature): the origin is the
 * head of a segment, which keeps `s` meaningful and the site id stable.
 */
export function buildCorridorFrame(
  index: DerivedMapIndex,
  segmentId: string,
  options: { anchorFeatureId: string; runwayDownstreamM?: number; mirrored?: boolean },
): AnchorFrame | null {
  const segment = index.segments.find((s) => s.id === segmentId);
  const entryRsl = segment?.laneRsls[0];
  if (!segment || !entryRsl) return null;
  const entryLane = index.lanes[entryRsl];
  if (!entryLane) return null;

  const downNeed = Math.max(0, (options.runwayDownstreamM ?? DEFAULT_RUNWAY_DOWNSTREAM_M) - segment.lengthM);
  const tail = segment.laneRsls[segment.laneRsls.length - 1] as LaneRsl;
  const forward = enumerateChains(index, tail, downNeed, 'forward', 1)[0] ?? {
    lanes: [],
    lengthM: 0,
    contiguous: [],
  };
  const rest = segment.laneRsls.slice(1);
  const downstream = {
    lanes: [...rest, ...forward.lanes],
    lengthM: segment.lengthM - entryLane.lengthM + forward.lengthM,
    contiguous: [...rest.map(() => true), ...forward.contiguous],
  };
  // The corridor origin is the *head* of the segment, so there is no upstream
  // span inside the frame; `s = 0` is the entry lane's start.
  const { spans, sOfLane, sRange } = buildSpansAndS(
    index,
    { lanes: [], contiguous: [] },
    entryRsl,
    downstream,
  );
  const shift = entryLane.lengthM;
  const shifted = spans.map((s) => ({ ...s, sStart: s.sStart + shift, sEnd: s.sEnd + shift }));
  const shiftedS: Record<LaneRsl, number> = {};
  for (const key of Object.keys(sOfLane).sort()) shiftedS[key] = (sOfLane[key] as number) + shift;

  const { lateralLanes, opposingLanes } = lateralAtOrigin(index, entryLane);
  return {
    origin: {
      anchorFeatureId: options.anchorFeatureId,
      kind: 'corridor',
      mapFeatureId: segment.id,
    },
    entryLaneRsl: entryRsl,
    referencePath: shifted,
    sOfLane: shiftedS,
    sRange: [sRange[0] + shift, sRange[1] + shift],
    lateralLanes,
    opposingLanes,
    handedness: index.handedness,
    mirrored: options.mirrored ?? false,
    runwayUpstreamM: 0,
    runwayDownstreamM: downstream.lengthM + entryLane.lengthM,
  };
}

/** Lane occupying arc length `s` on the reference path, with the local offset. */
export function laneAtS(
  frame: AnchorFrame,
  s: number,
): { span: ReferenceSpan; sInLane: number } | null {
  for (const span of frame.referencePath) {
    if (s >= span.sStart && s <= span.sEnd) {
      return { span, sInLane: s - span.sStart };
    }
  }
  return null;
}
