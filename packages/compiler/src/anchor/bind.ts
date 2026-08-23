/**
 * Role binding — the **structural** pass.
 *
 * The seven `RoleBinding` kinds resolve to a `FeatureBinding` per site: which
 * lane, which gate, which conflict point, which route. What this module
 * deliberately does *not* do is the longitudinal solve — bisection on spawn `s`
 * to hit an arrival invariant is `sim-engine`'s job. This pass hands it the
 * two things it cannot re-derive cheaply: the **conflict point** (with `s` on
 * both routes) and the **route lane chains**.
 */

import { enumerateChains, laneAtS } from './frame.js';
import { crossSectionAt } from './cross-section.js';
import { angleDiff, headingAtS, pointAtS, projectPoint, toDeg } from './geometry.js';
import type { ApproachRelation } from './types/anchor.js';
import type { ConflictPair, DerivedMapIndex, LaneRsl } from './types/map-index.js';
import type { OnMissing, RoleBinding } from './types/roles.js';
import type { AnchorFrame, FeatureBinding, FramePose, MatchedSite } from './types/site.js';

/** How far upstream a conflicting actor's route is walked for run-up. */
export const CONFLICT_RUNUP_M = 150;
/** Fallback template crossing angles per relation, when the role declares none. */
export const DEFAULT_TEMPLATE_ANGLE_DEG: Record<ApproachRelation, number> = {
  opposing: 135,
  from_left: 90,
  from_right: 90,
  merge: 20,
};

function laneRslAtK(frame: AnchorFrame, k: number): LaneRsl | undefined {
  return frame.lateralLanes[k];
}

/**
 * Resolve one signed lane request against a site, honouring `onMissing`.
 *
 * Every lane-indexed binding funnels through here so that "the lane you asked
 * for is not here" has exactly one answer in the matcher rather than one per
 * role kind. The interesting case is the *absence* of a silent branch: a
 * request that cannot be met either fails, drops, or clamps because the author
 * said `clamp` — never because a code path defaulted to the nearest lane.
 * Clamping to the nearest lane on a one-lane corridor yields `k = 0`, which is
 * the reference actor's own lane, so the silent branch used to place a
 * "next lane over" actor inside the ego.
 */
function resolveLaneOffset(
  frame: AnchorFrame,
  k: number,
  onMissing: OnMissing,
  notes: string[],
): { status: FeatureBinding['status']; k: number; laneRsl: LaneRsl | undefined } {
  const direct = laneRslAtK(frame, k);
  if (direct) return { status: 'bound', k, laneRsl: direct };
  if (onMissing === 'fail') {
    notes.push(`lane k=${k} does not exist at this site (onMissing: fail)`);
    return { status: 'failed', k, laneRsl: undefined };
  }
  if (onMissing === 'drop') {
    notes.push(`lane k=${k} does not exist at this site (onMissing: drop)`);
    return { status: 'dropped', k, laneRsl: undefined };
  }
  const clamped = clampK(frame, k);
  if (clamped === null) {
    notes.push('no same-direction lanes to clamp to');
    return { status: 'failed', k, laneRsl: undefined };
  }
  notes.push(`lane k=${k} clamped to k=${clamped}`);
  return { status: 'clamped', k: clamped, laneRsl: laneRslAtK(frame, clamped) };
}

/** Nearest existing lane index to `k` on the same side, for `clamp`. */
function clampK(frame: AnchorFrame, k: number): number | null {
  const available = Object.keys(frame.lateralLanes)
    .map(Number)
    .sort((a, b) => a - b);
  if (available.length === 0) return null;
  const sameSide = available.filter((a) => (k >= 0 ? a >= 0 : a <= 0));
  const pool = sameSide.length > 0 ? sameSide : available;
  let best = pool[0] as number;
  for (const candidate of pool) {
    if (Math.abs(candidate - k) < Math.abs(best - k)) best = candidate;
  }
  return best;
}

function poseAt(k: number, s: number, tFrac: number, headingOffsetRad = 0): FramePose {
  return { k, s, tFrac, headingOffsetRad };
}

function routeFrom(
  index: DerivedMapIndex,
  frame: AnchorFrame,
  laneRsl: LaneRsl | undefined,
  k: number,
): LaneRsl[] {
  if (!laneRsl) return [];
  if (k === 0) {
    // The ego lane already has a route: the reference path from that lane on.
    const idx = frame.referencePath.findIndex((sp) => sp.laneRsl === laneRsl);
    if (idx >= 0) return frame.referencePath.slice(idx).map((sp) => sp.laneRsl);
  }
  const forward = enumerateChains(index, laneRsl, CONFLICT_RUNUP_M, 'forward', 1)[0];
  return [laneRsl, ...(forward?.lanes ?? [])];
}

function routeThrough(index: DerivedMapIndex, laneRsl: LaneRsl): LaneRsl[] {
  const upstream = enumerateChains(index, laneRsl, CONFLICT_RUNUP_M, 'backward', 1)[0];
  const downstream = enumerateChains(index, laneRsl, CONFLICT_RUNUP_M, 'forward', 1)[0];
  return [...(upstream?.lanes ?? []), laneRsl, ...(downstream?.lanes ?? [])];
}

interface LaneDropPair {
  terminatingRsl: LaneRsl;
  terminatingK: number;
  continuingRsl: LaneRsl;
  continuingK: number;
  side: 'left' | 'right';
  stationS: number;
}

/** Resolve the concrete disappearing lane and the only legal adjacent survivor. */
function laneDropPair(ctx: BindContext, feature: string): { pair: LaneDropPair | null; notes: string[] } {
  const notes: string[] = [];
  const match = ctx.featureMatches[feature];
  const parsed = match?.mapFeatureId.match(/^lane_drop:([^@]+)@/);
  const terminatingRsl = parsed?.[1];
  if (!match || !terminatingRsl || !ctx.index.lanes[terminatingRsl]) {
    notes.push(`feature "${feature}" has no exact lane_drop:<terminating-rsl> identity`);
    return { pair: null, notes };
  }

  // The transition sample is just downstream of the taper. Walk back to the
  // nearest cross-section where the disappearing lane still physically exists.
  for (let backM = 0.5; backM <= 30; backM += 0.5) {
    const stationS = match.s - backM;
    const at = laneAtS(ctx.frame, stationS);
    if (!at) continue;
    const cs = crossSectionAt(ctx.index.lanes, at.span.laneRsl, at.sInLane);
    if (!cs) continue;
    const entries = [...cs.sameDirDriving.entries()];
    const terminating = entries.find(([, rsl]) => rsl === terminatingRsl);
    if (!terminating) continue;
    const [terminatingK] = terminating;
    const termLane = ctx.index.lanes[terminatingRsl]!;
    const referenceLane = ctx.index.lanes[at.span.laneRsl]!;
    const point = pointAtS(referenceLane.polyline, at.sInLane);
    const localS = projectPoint(termLane.polyline, point).s;
    const downstreamAt = laneAtS(ctx.frame, Math.min(ctx.frame.sRange[1], match.s + 10));
    const downstreamCs = downstreamAt
      ? crossSectionAt(ctx.index.lanes, downstreamAt.span.laneRsl, downstreamAt.sInLane)
      : null;
    const downstream = new Set(downstreamCs?.sameDirDriving.values() ?? []);

    const candidates = entries
      .filter(([k, rsl]) => Math.abs(k - terminatingK) === 1 && rsl !== terminatingRsl)
      .map(([continuingK, continuingRsl]) => {
        const side: 'left' | 'right' = continuingK > terminatingK ? 'left' : 'right';
        const continuingLane = ctx.index.lanes[continuingRsl];
        const termPoint = pointAtS(termLane.polyline, localS);
        const continuingAt = continuingLane ? projectPoint(continuingLane.polyline, termPoint) : null;
        const lateralSeparationM = continuingAt?.distance ?? 0;
        let continuationM = continuingLane && continuingAt
          ? Math.max(0, continuingLane.lengthM - continuingAt.s)
          : 0;
        let continuationCursor = continuingLane;
        const continuationVisited = new Set(continuingLane ? [continuingLane.rsl] : []);
        for (let hop = 0; continuationCursor && hop < 4 && continuationM < 20; hop += 1) {
          const nextRsl = [...continuationCursor.successors].sort()[0];
          const next = nextRsl ? ctx.index.lanes[nextRsl] : undefined;
          if (!next || next.isJunction || continuationVisited.has(next.rsl)) break;
          continuationVisited.add(next.rsl);
          continuationM += next.lengthM;
          continuationCursor = next;
        }
        const permitted = termLane.laneChangePermissions.some(
          (permission) => permission.side === side && permission.allowed &&
            localS >= permission.startS - 1e-6 && localS <= permission.endS + 1e-6,
        );
        const continues = continuationM >= 20 && (downstream.has(continuingRsl) || termLane.successors.includes(continuingRsl) ||
          ctx.index.lanes[continuingRsl]?.successors.some((rsl) => downstream.has(rsl)) === true || downstream.size === 0);
        return {
          terminatingRsl, terminatingK, continuingRsl, continuingK, side, stationS,
          permitted,
          continues,
          // Sequential road-section aliases sometimes overlap a cross-section
          // at a seam and receive adjacent k values. A real sibling remains a
          // lane-width away immediately upstream of the taper.
          lateralSeparationM,
        };
      })
      .filter((candidate) => candidate.permitted && candidate.continues && candidate.lateralSeparationM >= 1.5)
      .sort((a, b) => a.continuingRsl.localeCompare(b.continuingRsl));
    const chosen = candidates[0];
    if (chosen) return { pair: chosen, notes };
    notes.push(
      `${terminatingRsl} has no immediately adjacent continuing sibling with an explicit allowed lane change at s=${stationS.toFixed(1)} m`,
    );
    return { pair: null, notes };
  }
  notes.push(`terminating lane ${terminatingRsl} is not present immediately upstream of the matched taper`);
  return { pair: null, notes };
}

/** The gate the reference path takes through a given junction, if any. */
export function egoGateForJunction(
  index: DerivedMapIndex,
  frame: AnchorFrame,
  junctionId: string,
): string | undefined {
  if (frame.egoGateId) {
    const gate = index.gates.find((g) => g.id === frame.egoGateId);
    if (gate && gate.junctionId === junctionId) return gate.id;
  }
  for (let i = 1; i < frame.referencePath.length; i += 1) {
    const span = frame.referencePath[i]!;
    const lane = index.lanes[span.laneRsl];
    if (!lane || lane.junctionId !== junctionId) continue;
    const approach = frame.referencePath[i - 1]!;
    const gate = index.gates.find(
      (g) =>
        g.junctionId === junctionId &&
        g.approachLaneRsl === approach.laneRsl &&
        g.connectingLaneRsl === span.laneRsl,
    );
    if (gate) return gate.id;
  }
  return undefined;
}

interface BindContext {
  index: DerivedMapIndex;
  frame: AnchorFrame;
  featureMatches: MatchedSite['featureMatches'];
}

interface LocalRoleGeometry {
  laneRsl: LaneRsl;
  segmentId: string | undefined;
  roadId: number;
  section: number;
  headingRad: number;
}

/** Resolve the lane actually nearest the actor's frame station. This mirrors
 * materialization's world-point projection and catches route chains that turn
 * through a junction before reaching an allegedly local lead/oncoming role. */
function localRoleGeometry(
  index: DerivedMapIndex,
  frame: AnchorFrame,
  binding: FeatureBinding,
): LocalRoleGeometry | null {
  if (!binding.pose) return null;
  const reference = laneAtS(frame, binding.pose.s);
  if (!reference) return null;
  const referenceLane = index.lanes[reference.span.laneRsl];
  if (!referenceLane) return null;
  const worldPoint = pointAtS(referenceLane.polyline, reference.sInLane);
  const candidates = binding.routeLaneChain?.length
    ? binding.routeLaneChain
    : binding.laneRsl
      ? [binding.laneRsl]
      : [];
  let best: { laneRsl: LaneRsl; s: number; distance: number } | null = null;
  for (const laneRsl of candidates) {
    const lane = index.lanes[laneRsl];
    if (!lane?.polyline.length) continue;
    const projected = projectPoint(lane.polyline, worldPoint);
    if (!best || projected.distance < best.distance) {
      best = { laneRsl, s: projected.s, distance: projected.distance };
    }
  }
  if (!best) return null;
  const lane = index.lanes[best.laneRsl]!;
  return {
    laneRsl: best.laneRsl,
    segmentId: index.factIndex.segmentIdsByLane[best.laneRsl],
    roadId: lane.roadId,
    section: lane.section,
    headingRad: headingAtS(lane.polyline, best.s),
  };
}

function enforceLocalRoleSemantics(
  index: DerivedMapIndex,
  frame: AnchorFrame,
  roles: readonly RoleBinding[],
  bindings: readonly FeatureBinding[],
): void {
  const roleById = new Map(roles.map((role) => [role.role, role]));
  const bindingById = new Map(bindings.map((binding) => [binding.role, binding]));
  const geometryById = new Map<string, LocalRoleGeometry | null>();
  const geometry = (roleId: string): LocalRoleGeometry | null => {
    if (geometryById.has(roleId)) return geometryById.get(roleId) ?? null;
    const value = localRoleGeometry(index, frame, bindingById.get(roleId)!);
    geometryById.set(roleId, value);
    return value;
  };

  for (const role of roles) {
    const binding = bindingById.get(role.role);
    if (!binding || binding.status === 'failed' || binding.status === 'dropped') continue;
    if (role.requiredSameSegmentAs) {
      const own = geometry(role.role);
      const ref = geometry(role.requiredSameSegmentAs);
      if (!roleById.has(role.requiredSameSegmentAs) || !own || !ref || !own.segmentId || own.segmentId !== ref.segmentId) {
        binding.status = 'failed';
        binding.notes.push(
          `requires same local segment as ${role.requiredSameSegmentAs}; resolved ${own?.segmentId ?? 'none'} vs ${ref?.segmentId ?? 'none'}`,
        );
      }
    }
    if (role.requiredSameRoadSectionAs && binding.status !== 'failed') {
      const own = geometry(role.role);
      const ref = geometry(role.requiredSameRoadSectionAs);
      if (
        !roleById.has(role.requiredSameRoadSectionAs) || !own || !ref ||
        own.roadId !== ref.roadId || own.section !== ref.section
      ) {
        binding.status = 'failed';
        binding.notes.push(
          `requires same road section as ${role.requiredSameRoadSectionAs}; resolved ` +
          `${own ? `${own.roadId}:${own.section}` : 'none'} vs ${ref ? `${ref.roadId}:${ref.section}` : 'none'}`,
        );
      }
    }
    if (role.requiredHeadingRelation && binding.status !== 'failed') {
      const own = geometry(role.role);
      const ref = geometry(role.requiredHeadingRelation.role);
      if (!roleById.has(role.requiredHeadingRelation.role) || !own || !ref) {
        binding.status = 'failed';
        binding.notes.push(`cannot resolve local heading relative to ${role.requiredHeadingRelation.role}`);
        continue;
      }
      const separation = Math.abs(angleDiff(own.headingRad, ref.headingRad));
      const errorRad = role.requiredHeadingRelation.relation === 'parallel'
        ? separation
        : Math.abs(Math.PI - separation);
      const errorDeg = toDeg(errorRad);
      if (errorDeg > role.requiredHeadingRelation.maxErrorDeg + 1e-9) {
        binding.status = 'failed';
        binding.notes.push(
          `${role.requiredHeadingRelation.relation} heading error ${errorDeg.toFixed(2)}° exceeds ` +
          `${role.requiredHeadingRelation.maxErrorDeg.toFixed(2)}° relative to ${role.requiredHeadingRelation.role}`,
        );
      }
    }
  }
}

function bindConflictingGate(
  ctx: BindContext,
  role: Extract<RoleBinding, { kind: 'conflicting_gate' }>,
): FeatureBinding {
  const notes: string[] = [];
  const binding: FeatureBinding = {
    role: role.role,
    kind: 'conflicting_gate',
    status: 'failed',
    notes,
  };
  const match = ctx.featureMatches[role.feature];
  const junctionId = match?.mapFeatureId.startsWith('junction:')
    ? match.mapFeatureId.slice('junction:'.length)
    : undefined;
  if (!junctionId) {
    notes.push(`role references feature "${role.feature}", which did not bind to a junction`);
    return binding;
  }
  const descriptor = ctx.index.junctionDescriptors[junctionId];
  const egoGateId = egoGateForJunction(ctx.index, ctx.frame, junctionId);
  if (!descriptor || !egoGateId) {
    notes.push(`no ego gate through junction ${junctionId}`);
    return binding;
  }
  const gateById = new Map(ctx.index.gates.map((g) => [g.id, g]));

  interface Candidate {
    pair: ConflictPair;
    otherGateId: string;
    relation: ApproachRelation;
    angleErrorDeg: number;
  }
  const templateAngle = role.templateCrossingAngleDeg ?? DEFAULT_TEMPLATE_ANGLE_DEG[role.from];
  const candidates: Candidate[] = [];
  for (const pair of descriptor.conflictPairs) {
    if (pair.gateA !== egoGateId && pair.gateB !== egoGateId) continue;
    const otherGateId = pair.gateA === egoGateId ? pair.gateB : pair.gateA;
    const other = gateById.get(otherGateId);
    if (!other) continue;
    const relation: ApproachRelation =
      pair.gateA === egoGateId
        ? pair.relation
        : pair.relation === 'from_left'
          ? 'from_right'
          : pair.relation === 'from_right'
            ? 'from_left'
            : pair.relation;
    if (relation !== role.from) continue;
    if (other.turnRelation !== role.turn) continue;
    candidates.push({
      pair,
      otherGateId,
      relation,
      angleErrorDeg: Math.abs(pair.crossingAngleDeg - templateAngle),
    });
  }
  // Rank by crossing-angle closeness — this is what keeps a T-bone a T-bone.
  candidates.sort(
    (a, b) => a.angleErrorDeg - b.angleErrorDeg || (a.otherGateId < b.otherGateId ? -1 : 1),
  );
  const chosen = candidates[0];
  if (!chosen) {
    notes.push(
      `junction ${junctionId} has no ${role.from} ${role.turn} movement conflicting with the ego path`,
    );
    return binding;
  }

  const otherGate = gateById.get(chosen.otherGateId)!;
  const egoGate = gateById.get(egoGateId)!;
  const approachLane = ctx.index.lanes[otherGate.approachLaneRsl];
  const connectingLane = ctx.index.lanes[otherGate.connectingLaneRsl];
  const upstream = enumerateChains(ctx.index, otherGate.approachLaneRsl, CONFLICT_RUNUP_M, 'backward', 1)[0] ?? {
    lanes: [],
    lengthM: 0,
    contiguous: [],
  };
  const exitChain = enumerateChains(ctx.index, otherGate.connectingLaneRsl, CONFLICT_RUNUP_M, 'forward', 1)[0] ?? {
    lanes: [],
    lengthM: 0,
    contiguous: [],
  };
  const routeLaneChain = [
    ...upstream.lanes,
    otherGate.approachLaneRsl,
    otherGate.connectingLaneRsl,
    ...exitChain.lanes,
  ];

  const sOnB = chosen.pair.gateA === egoGateId ? chosen.pair.sOnB : chosen.pair.sOnA;
  const sOnA = chosen.pair.gateA === egoGateId ? chosen.pair.sOnA : chosen.pair.sOnB;
  const sOnActor = upstream.lengthM + (approachLane?.lengthM ?? 0) + sOnB;
  const egoConnectingS = ctx.frame.sOfLane[egoGate.connectingLaneRsl];
  const sOnEgo = (egoConnectingS ?? 0) + sOnA;

  const availableUpstreamM = upstream.lengthM + (approachLane?.lengthM ?? 0);
  if (
    role.minUpstreamRunwayM !== undefined &&
    availableUpstreamM + 1e-6 < role.minUpstreamRunwayM
  ) {
    notes.push(
      `conflicting gate has only ${availableUpstreamM.toFixed(2)} m connected upstream runway; ` +
      `${role.minUpstreamRunwayM.toFixed(2)} m required`,
    );
    return binding;
  }

  // Spawn pose: back up along the actor's own route by the run-up we walked.
  const spawnS = -(upstream.lengthM + (approachLane?.lengthM ?? 0));
  binding.status = 'bound';
  binding.laneRsl = upstream.lanes[0] ?? otherGate.approachLaneRsl;
  binding.routeLaneChain = routeLaneChain;
  binding.pose = poseAt(0, spawnS, 0);
  binding.conflict = {
    gateId: otherGate.id,
    egoGateId,
    point: chosen.pair.point,
    sOnEgo,
    sOnActor,
    crossingAngleDeg: chosen.pair.crossingAngleDeg,
    relation: chosen.relation,
    angleErrorDeg: chosen.angleErrorDeg,
  };
  if (role.arriveAtConflict) binding.arrival = { ...role.arriveAtConflict };
  notes.push(
    `bound to gate ${otherGate.id} (${chosen.relation} ${otherGate.turnRelation}), crossing at ${
      Math.round(chosen.pair.crossingAngleDeg * 10) / 10
    }° (template ${templateAngle}°)`,
  );
  if (!connectingLane) notes.push('connecting lane missing from the index');
  return binding;
}

/** Bind every role against one frame. Order is the author's; refs look backwards. */
export function bindRoles(
  index: DerivedMapIndex,
  frame: AnchorFrame,
  roles: RoleBinding[],
  featureMatches: MatchedSite['featureMatches'],
): FeatureBinding[] {
  const ctx: BindContext = { index, frame, featureMatches };
  const bound = new Map<string, FeatureBinding>();
  const out: FeatureBinding[] = [];

  for (const role of roles) {
    const notes: string[] = [];
    let binding: FeatureBinding;

    switch (role.kind) {
      case 'on_reference': {
        const at = laneAtS(frame, role.dsM);
        binding = {
          role: role.role,
          kind: role.kind,
          status: at ? 'bound' : 'failed',
          pose: poseAt(0, role.dsM, role.tFrac),
          notes,
        };
        if (at) {
          binding.laneRsl = at.span.laneRsl;
          binding.routeLaneChain = routeFrom(index, frame, at.span.laneRsl, 0);
        } else {
          notes.push(`s=${role.dsM} m is outside the reference path`);
        }
        break;
      }

      case 'lane_offset': {
        const resolved = resolveLaneOffset(frame, role.k, role.onMissing, notes);
        binding = {
          role: role.role,
          kind: role.kind,
          status: resolved.status,
          onMissing: role.onMissing,
          requestedK: role.k,
          notes,
        };
        if (resolved.status === 'bound' || resolved.status === 'clamped') {
          binding.pose = poseAt(resolved.k, role.dsM, role.tFrac);
          binding.laneRsl = resolved.laneRsl;
          binding.routeLaneChain = routeFrom(index, frame, resolved.laneRsl, resolved.k);
        }
        break;
      }

      case 'at_lane_drop': {
        const resolved = laneDropPair(ctx, role.feature);
        notes.push(...resolved.notes);
        const selectedRsl = role.lane === 'terminating'
          ? resolved.pair?.terminatingRsl
          : resolved.pair?.continuingRsl;
        const selectedK = role.lane === 'terminating'
          ? resolved.pair?.terminatingK
          : resolved.pair?.continuingK;
        binding = {
          role: role.role,
          kind: role.kind,
          status: selectedRsl === undefined || selectedK === undefined ? 'failed' : 'bound',
          notes,
        };
        if (selectedRsl !== undefined && selectedK !== undefined && resolved.pair) {
          binding.pose = poseAt(selectedK, role.dsM, role.tFrac);
          binding.laneRsl = selectedRsl;
          binding.routeLaneChain = routeThrough(index, selectedRsl);
          notes.push(
            `${role.lane} lane ${selectedRsl} bound at ${role.feature}; legal ${resolved.pair.side} merge to ${resolved.pair.continuingRsl}`,
          );
        }
        break;
      }

      case 'opposing': {
        const laneRsl = frame.opposingLanes[role.index];
        binding = {
          role: role.role,
          kind: role.kind,
          status: laneRsl ? 'bound' : 'failed',
          notes,
        };
        if (laneRsl) {
          // Opposing traffic runs the other way: `s` is measured along the ego
          // frame, so a positive `dsM` is still "ahead of the ego origin".
          binding.pose = poseAt(0, role.dsM, role.tFrac, Math.PI);
          binding.laneRsl = laneRsl;
          binding.routeLaneChain = routeFrom(index, frame, laneRsl, 1);
        } else {
          notes.push(`no opposing lane #${role.index} at this site`);
        }
        break;
      }

      case 'conflicting_gate': {
        binding = bindConflictingGate(ctx, role);
        break;
      }

      case 'on_crossing': {
        const match = featureMatches[role.feature];
        const crossing = match
          ? index.pointFeatures.find((p) => p.id === match.mapFeatureId && p.kind === 'crossing')
          : undefined;
        binding = {
          role: role.role,
          kind: role.kind,
          status: crossing ? 'bound' : 'failed',
          notes,
        };
        if (crossing) {
          const s = (frame.sOfLane[crossing.laneRsl] ?? 0) + crossing.s;
          binding.pose = poseAt(0, s, role.startFrac * 2 - 1, Math.PI / 2);
          binding.laneRsl = crossing.laneRsl;
          notes.push(`walks the crossing ${crossing.id} ${role.direction}`);
        } else {
          notes.push(
            index.capabilities.crossings
              ? `feature "${role.feature}" did not bind to a crossing`
              : 'this map index carries no crossing layer, so a pedestrian cannot be placed on a crossing',
          );
        }
        break;
      }

      case 'in_parking_zone': {
        const match = featureMatches[role.feature];
        const zone = match
          ? index.pointFeatures.find((p) => p.id === match.mapFeatureId && p.kind === 'parking_zone')
          : undefined;
        binding = {
          role: role.role,
          kind: role.kind,
          status: zone ? 'bound' : 'failed',
          notes,
        };
        if (zone) {
          const s = (frame.sOfLane[zone.laneRsl] ?? 0) + zone.s;
          binding.pose = poseAt(0, s, role.side === 'left' ? 1 : -1);
          binding.laneRsl = zone.laneRsl;
          notes.push(`parked in ${zone.id}, slot ${role.slotIndex}`);
        } else {
          notes.push(
            index.capabilities.parkingZones
              ? `feature "${role.feature}" did not bind to a parking zone`
              : 'this map index carries no parking-zone layer',
          );
        }
        break;
      }

      case 'relative_to': {
        const ref = bound.get(role.ref);
        binding = { role: role.role, kind: role.kind, status: 'failed', notes };
        if (!ref || !ref.pose) {
          notes.push(`reference role "${role.ref}" is not bound`);
          break;
        }
        const wantedK = ref.pose.k + role.dLane;
        const resolved = resolveLaneOffset(frame, wantedK, role.onMissing, notes);
        binding.onMissing = role.onMissing;
        binding.requestedK = wantedK;
        binding.status = resolved.status;
        if (resolved.status !== 'bound' && resolved.status !== 'clamped') break;
        binding.pose = poseAt(resolved.k, ref.pose.s + role.dsM, role.tFrac ?? ref.pose.tFrac);
        binding.laneRsl = resolved.laneRsl;
        binding.routeLaneChain = routeFrom(index, frame, resolved.laneRsl, resolved.k);
        break;
      }
    }

    // A lane that exists in the frame but not at the actor's `s` is still worth
    // flagging — the solver would otherwise spawn into thin air.
    if (binding.pose && binding.status !== 'dropped' && binding.status !== 'failed') {
      const at = laneAtS(frame, binding.pose.s);
      if (!at && binding.kind !== 'conflicting_gate') {
        binding.notes.push(`pose s=${binding.pose.s} m is outside the reference path`);
      }
      if (binding.laneRsl && !crossSectionAt(index.lanes, binding.laneRsl, 0)) {
        binding.notes.push('lane has no usable cross-section');
      }
    }

    bound.set(role.role, binding);
    out.push(binding);
  }

  enforceLocalRoleSemantics(index, frame, roles, out);

  return out;
}
