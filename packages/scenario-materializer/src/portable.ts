/**
 * Reverse materialization: lift a concrete Studio document into the portable
 * v2 vocabulary, then pair that document with a matched destination site.
 *
 * This is intentionally the inverse seam of `adapt.ts`.  `scenario-model`
 * cannot depend on `anchor-matcher` without a package cycle, while the
 * materializer already owns both vocabularies.  The returned template contains
 * no scene poses, lane refs, road ids, route lane chains, map feature ids or
 * site ids. Candidate-specific facts remain in the separate `MatchedSite`.
 */

import {
  ScenarioTemplateV2Schema,
  type AnchorFeature,
  type FramePose,
  type RoleBinding,
  type ScenarioTemplateV2,
} from '@uniscenarios/scenario-model';
import {
  MATCH_SEMANTICS_VERSION,
  buildCorridorFrame,
  buildJunctionFrames,
  computeSiteId,
  headingAtS,
  inferPortableSitePattern,
  projectPoint,
  pointAtS,
  sha256Hex,
  type AnchorFrame,
  type DerivedMapIndex,
  type FeatureBinding,
  type LogicalAnchor as MatcherAnchor,
  type MatchedSite,
  type Point2,
  type PortableSitePattern,
  type VariationIssue,
} from '@uniscenarios/anchor-matcher';

export type PortableLiftIssueCode =
  | 'reference_role_missing'
  | 'reference_lane_anchor_missing'
  | 'reference_lane_missing'
  | 'source_frame_unbuildable'
  | 'internal_lane_ambiguous'
  | 'terminal_lane_unconnected'
  | 'role_lane_anchor_missing'
  | 'role_lane_missing'
  | 'role_projection_too_far'
  | 'role_binding_ambiguous'
  | 'spatial_extension_removed'
  | 'candidate_not_equivalent';

export interface PortableLiftIssue {
  code: PortableLiftIssueCode;
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  /** A bounded dependency that allows a caller/agent to retry the lift. */
  dependency?: string;
  retryable: boolean;
}

export interface PortableLiftOptions {
  referenceRoleId?: string;
  /** Prefer a junction origin when one is reachable from the reference lane. */
  origin?: 'auto' | 'junction' | 'corridor';
  allowMirror?: boolean;
  maxProjectionDistanceM?: number;
  corridorExtentM?: number;
  /** Required to turn map signal handles into feature-relative references. */
  signalApproaches?: Record<string, 'subject' | 'opposing' | 'left' | 'right'>;
}

export interface PortableLiftResult {
  template?: ScenarioTemplateV2;
  sourceSite?: MatchedSite;
  pattern?: PortableSitePattern;
  issues: PortableLiftIssue[];
  ok: boolean;
}

export interface BoundVariation {
  /** Still portable and safe to save as the canonical authored document. */
  template: ScenarioTemplateV2;
  /** The re-derivable, map-specific binding used only for preview/materialization. */
  site: MatchedSite;
  issues: VariationIssue[];
}

const round = (value: number, places = 6): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

function angleDiff(a: number, b: number): number {
  let value = (a - b) % (Math.PI * 2);
  if (value > Math.PI) value -= Math.PI * 2;
  if (value <= -Math.PI) value += Math.PI * 2;
  return value;
}

function rslOf(role: Extract<RoleBinding, { kind: 'scene_absolute' }>): string | undefined {
  const lane = role.laneRef;
  return lane ? `${lane.roadId}:${lane.section}:${lane.laneId}` : undefined;
}

function scenePoint(role: Extract<RoleBinding, { kind: 'scene_absolute' }>): Point2 {
  return { x: role.pose.position.x, y: -role.pose.position.z };
}

function routeTurn(template: ScenarioTemplateV2, roleId: string): 'left' | 'right' | 'straight' | 'uturn' | undefined {
  for (const interaction of template.choreography.interactions) {
    if (interaction.actor !== roleId || interaction.verb !== 'route') continue;
    if (interaction.target.mode === 'turn' || interaction.target.mode === 'nextJunction') {
      return interaction.target.turn;
    }
  }
  return undefined;
}

function findFrame(
  template: ScenarioTemplateV2,
  reference: Extract<RoleBinding, { kind: 'scene_absolute' }>,
  index: DerivedMapIndex,
  origin: PortableLiftOptions['origin'],
  issues: PortableLiftIssue[],
): AnchorFrame | null {
  const sourceRsl = rslOf(reference);
  if (!sourceRsl) return null;
  const resolved = resolveFrameApproach(sourceRsl, index);
  if (resolved.status === 'ambiguous') {
    issues.push({ code: 'internal_lane_ambiguous', severity: 'error', path: `roles.${reference.id}.laneRef`, message: `lane ${sourceRsl} reaches multiple structural approaches: ${resolved.candidates.join(', ')}`, dependency: 'move the reference actor onto an unambiguous approach lane or author an explicit turn', retryable: true });
    return null;
  }
  if (resolved.status === 'unconnected') {
    issues.push({ code: 'terminal_lane_unconnected', severity: 'error', path: `roles.${reference.id}.laneRef`, message: `lane ${sourceRsl} has no deterministically connected corridor or junction approach`, dependency: 'extend topology connectivity or re-snap the actor to a connected driving lane', retryable: true });
    return null;
  }
  const rsl = resolved.rsl;
  const turn = routeTurn(template, reference.id) ?? resolved.turn;
  const featureId = 'transferOrigin';
  if (origin !== 'corridor') {
    const directGates = index.gates.filter((gate) => gate.approachLaneRsl === rsl);
    const segmentId = index.factIndex.segmentIdsByLane[rsl];
    const segment = index.segments.find((candidate) => candidate.id === segmentId);
    const approachRsl = directGates.length > 0
      ? rsl
      : segment?.laneRsls[segment.laneRsls.length - 1];
    const junctionIds = [...new Set(index.gates
      .filter((gate) => gate.approachLaneRsl === approachRsl)
      .map((gate) => gate.junctionId))].sort();
    for (const junctionId of junctionIds) {
      const frames = buildJunctionFrames(index, junctionId, approachRsl!, {
        anchorFeatureId: featureId,
        ...(turn ? { egoTurn: turn } : {}),
      });
      const containing = frames.find((frame) => frame.referencePath.some((span) => span.laneRsl === sourceRsl));
      if (containing) return containing;
      if (frames[0]) return frames[0];
    }
    if (origin === 'junction') return null;
  }
  const segmentId = index.factIndex.segmentIdsByLane[rsl];
  return segmentId
    ? buildCorridorFrame(index, segmentId, { anchorFeatureId: featureId, runwayDownstreamM: 240 })
    : null;
}

type FrameApproachResolution =
  | { status: 'resolved'; rsl: string; turn?: 'left' | 'right' | 'straight' | 'uturn' }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'unconnected' };

/** Deterministic connectivity walk; it never crosses to a disconnected road or guesses between branches. */
function resolveFrameApproach(sourceRsl: string, index: DerivedMapIndex): FrameApproachResolution {
  if (index.factIndex.segmentIdsByLane[sourceRsl] || index.gates.some((gate) => gate.approachLaneRsl === sourceRsl)) return { status: 'resolved', rsl: sourceRsl };
  const internal = index.gates.filter((gate) => gate.connectingLaneRsl === sourceRsl || gate.exitLaneRsls.includes(sourceRsl));
  const internalChoices = [...new Map(internal.map((gate) => [`${gate.approachLaneRsl}:${gate.turnRelation}`, gate])).values()]
    .sort((a, b) => a.approachLaneRsl.localeCompare(b.approachLaneRsl) || a.turnRelation.localeCompare(b.turnRelation));
  if (internalChoices.length === 1) return { status: 'resolved', rsl: internalChoices[0]!.approachLaneRsl, turn: internalChoices[0]!.turnRelation };
  if (internalChoices.length > 1) return { status: 'ambiguous', candidates: internalChoices.map((gate) => `${gate.approachLaneRsl} (${gate.turnRelation})`) };
  let frontier = [sourceRsl];
  const seen = new Set(frontier);
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const next = new Set<string>();
    const matches = new Set<string>();
    for (const rsl of frontier.sort()) {
      const lane = index.lanes[rsl];
      if (!lane) continue;
      for (const neighbor of [...lane.predecessors, ...lane.successors].sort()) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor); next.add(neighbor);
        if (index.factIndex.segmentIdsByLane[neighbor] || index.gates.some((gate) => gate.approachLaneRsl === neighbor)) matches.add(neighbor);
      }
    }
    if (matches.size === 1) return { status: 'resolved', rsl: [...matches][0]! };
    if (matches.size > 1) return { status: 'ambiguous', candidates: [...matches].sort() };
    frontier = [...next];
  }
  return { status: 'unconnected' };
}

interface Projection {
  pose: FramePose;
  distanceM: number;
  referenceHeadingRad: number;
}

function projectToFrame(
  role: Extract<RoleBinding, { kind: 'scene_absolute' }>,
  frame: AnchorFrame,
  index: DerivedMapIndex,
): Projection | null {
  const point = scenePoint(role);
  let best: { s: number; distance: number; side: 1 | -1; heading: number; width: number } | null = null;
  for (const span of frame.referencePath) {
    const lane = index.lanes[span.laneRsl];
    if (!lane) continue;
    const projected = projectPoint(lane.polyline, point);
    const candidate = {
      s: span.sStart + projected.s,
      distance: projected.distance,
      side: projected.side,
      heading: headingAtS(lane.polyline, projected.s),
      width: lane.representativeWidthM || 3.5,
    };
    if (!best || candidate.distance < best.distance) best = candidate;
  }
  if (!best) return null;
  return {
    pose: {
      laneOffset: 0,
      s: round(best.s),
      tFrac: round(Math.max(-1, Math.min(1, (best.side * best.distance) / best.width))),
      headingOffsetRad: round(angleDiff(role.pose.headingRad, best.heading)),
    },
    distanceM: best.distance,
    referenceHeadingRad: best.heading,
  };
}

function poseOnOwnLane(
  role: Extract<RoleBinding, { kind: 'scene_absolute' }>,
  frameProjection: Projection,
  index: DerivedMapIndex,
): FramePose {
  const rsl = rslOf(role);
  const lane = rsl ? index.lanes[rsl] : undefined;
  if (!lane) return frameProjection.pose;
  const projected = projectPoint(lane.polyline, scenePoint(role));
  const heading = headingAtS(lane.polyline, projected.s);
  return {
    ...frameProjection.pose,
    tFrac: round(Math.max(-1, Math.min(1, (projected.side * projected.distance) / (lane.representativeWidthM || 3.5)))),
    headingOffsetRad: round(angleDiff(role.pose.headingRad, heading)),
  };
}

function conflictingMovement(
  roleRsl: string,
  frame: AnchorFrame,
  index: DerivedMapIndex,
): { feature: string; from: 'opposing' | 'from_left' | 'from_right' | 'merge'; turn: 'left' | 'right' | 'straight' | 'uturn'; conflict: NonNullable<FeatureBinding['conflict']> } | null {
  if (!frame.egoGateId || frame.origin.kind !== 'junction') return null;
  const junctionId = frame.origin.mapFeatureId.replace(/^junction:/, '');
  const descriptor = index.junctionDescriptors[junctionId];
  if (!descriptor) return null;
  const gateById = new Map(index.gates.map((gate) => [gate.id, gate]));
  const candidateGates = index.gates.filter((gate) => gate.junctionId === junctionId && (
    gate.approachLaneRsl === roleRsl || gate.connectingLaneRsl === roleRsl || gate.exitLaneRsls.includes(roleRsl)
  ));
  for (const gate of candidateGates.sort((a, b) => a.id.localeCompare(b.id))) {
    const pair = descriptor.conflictPairs.find((item) =>
      (item.gateA === frame.egoGateId && item.gateB === gate.id) ||
      (item.gateB === frame.egoGateId && item.gateA === gate.id));
    if (!pair) continue;
    const egoIsA = pair.gateA === frame.egoGateId;
    const relation = egoIsA
      ? pair.relation
      : pair.relation === 'from_left'
        ? 'from_right'
        : pair.relation === 'from_right'
          ? 'from_left'
          : pair.relation;
    const egoGate = gateById.get(frame.egoGateId);
    const egoStart = egoGate ? frame.sOfLane[egoGate.connectingLaneRsl] ?? 0 : 0;
    return {
      feature: frame.origin.anchorFeatureId,
      from: relation,
      turn: gate.turnRelation,
      conflict: {
        gateId: gate.id,
        egoGateId: frame.egoGateId,
        point: pair.point,
        sOnEgo: egoStart + (egoIsA ? pair.sOnA : pair.sOnB),
        sOnActor: egoIsA ? pair.sOnB : pair.sOnA,
        crossingAngleDeg: pair.crossingAngleDeg,
        relation,
        angleErrorDeg: 0,
      },
    };
  }
  return null;
}

function nearbyPointFeature(
  role: Extract<RoleBinding, { kind: 'scene_absolute' }>,
  index: DerivedMapIndex,
  kinds: ReadonlySet<'crossing' | 'parking_zone'>,
  maxDistanceM = 10,
) {
  const actorPoint = scenePoint(role);
  return index.pointFeatures
    .filter((feature) => kinds.has(feature.kind as 'crossing' | 'parking_zone'))
    .map((feature) => {
      const lane = index.lanes[feature.laneRsl];
      const point = feature.point ?? (lane ? pointAtS(lane.polyline, feature.s) : undefined);
      return point ? { feature, distanceM: Math.hypot(point.x - actorPoint.x, point.y - actorPoint.y) } : null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null && candidate.distanceM <= maxDistanceM)
    .sort((a, b) => a.distanceM - b.distanceM || a.feature.id.localeCompare(b.feature.id))[0];
}

function roleBase(role: Extract<RoleBinding, { kind: 'scene_absolute' }>) {
  return {
    id: role.id,
    actor: role.actor,
    ...(role.label === undefined ? {} : { label: role.label }),
    ...(role.initialSpeedKph === undefined ? {} : { initialSpeedKph: role.initialSpeedKph }),
    ...(role.requiredMovementControl === undefined ? {} : { requiredMovementControl: role.requiredMovementControl }),
    ...(role.requiredSameSegmentAs === undefined ? {} : { requiredSameSegmentAs: role.requiredSameSegmentAs }),
    ...(role.requiredSameRoadSectionAs === undefined ? {} : { requiredSameRoadSectionAs: role.requiredSameRoadSectionAs }),
    ...(role.requiredHeadingRelation === undefined ? {} : { requiredHeadingRelation: role.requiredHeadingRelation }),
    essentiality: role.essentiality,
    ...(role.extensions === undefined ? {} : { extensions: sanitizeExtensions(role.extensions) }),
  };
}

const SPATIAL_EXTENSION_KEYS = new Set([
  'position', 'scenePosition', 'worldPosition', 'laneRef', 'roadId', 'laneId',
  'rsl', 'routeLaneChain', 'mapFeatureId', 'siteId', 'topologyDigest',
]);

function sanitizeExtensions(value: Record<string, unknown>): Record<string, unknown> {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([key]) => !SPATIAL_EXTENSION_KEYS.has(key))
      .map(([key, child]) => [key, visit(child)]));
  };
  return visit(value) as Record<string, unknown>;
}

function portableChoreography(
  choreography: ScenarioTemplateV2['choreography'],
  originFeatureId: string,
  signalApproaches: PortableLiftOptions['signalApproaches'],
  issues: PortableLiftIssue[],
): ScenarioTemplateV2['choreography'] {
  const visit = (item: unknown, path: string): unknown => {
    if (Array.isArray(item)) return item.map((child, index) => visit(child, `${path}.${index}`));
    if (!item || typeof item !== 'object') return item;
    const object = item as Record<string, unknown>;
    if (object['kind'] === 'signal' && object['signal'] && typeof object['signal'] === 'object') {
      const signal = object['signal'] as Record<string, unknown>;
      if (typeof signal['handle'] === 'string') {
        const approach = signalApproaches?.[signal['handle']];
        if (!approach) {
          issues.push({ code: 'role_binding_ambiguous', severity: 'error', path: `${path}.signal`, message: `signal handle "${signal['handle']}" has no portable approach binding`, dependency: `supply signalApproaches["${signal['handle']}"] as subject/opposing/left/right`, retryable: true });
        } else {
          return { ...object, signal: { feature: originFeatureId, approach } };
        }
      }
    }
    if (typeof object['key'] === 'string') {
      const match = /^signal:(.+)\.(phase|program)$/.exec(object['key']);
      if (match) {
        const approach = signalApproaches?.[match[1]!];
        if (!approach) {
          issues.push({ code: 'role_binding_ambiguous', severity: 'error', path: `${path}.key`, message: `signal set key "${object['key']}" has no portable approach binding`, dependency: `supply signalApproaches["${match[1]}"] as subject/opposing/left/right`, retryable: true });
        } else {
          return { ...object, key: `signal:feature:${originFeatureId}:${approach}.${match[2]}` };
        }
      }
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, visit(child, `${path}.${key}`)]));
  };
  return visit(choreography, 'choreography') as ScenarioTemplateV2['choreography'];
}

function matcherAnchorToV2(anchor: MatcherAnchor): ScenarioTemplateV2['anchor'] {
  const range = (clause: { value: [number, number]; essentiality: 'required' | 'preferred' | 'cosmetic'; weight?: number }) => ({
    value: clause.value as [number | null, number | null],
    essentiality: clause.essentiality,
    ...(clause.weight === undefined ? {} : { weight: clause.weight }),
  });
  const scalarRunway = (clause: { value: number; essentiality: 'required' | 'preferred' | 'cosmetic'; weight?: number }) => ({
    value: [clause.value, null] as [number | null, number | null],
    essentiality: clause.essentiality,
    ...(clause.weight === undefined ? {} : { weight: clause.weight }),
  });
  const adjacent = (clause: NonNullable<NonNullable<MatcherAnchor['corridor']>['requiresAdjacent']>) => ({
    ...clause,
    value: clause.value
      .filter((kind) => kind !== 'opposing')
      .map((kind) => kind === 'biking' ? 'bike' as const : kind),
  });
  const c = anchor.corridor;
  const corridor = c ? {
    ...(c.throughLanesSameDir ? { throughLanesSameDir: range(c.throughLanesSameDir) } : {}),
    ...(c.throughLanesOpposing ? { throughLanesOpposing: range(c.throughLanesOpposing) } : {}),
    ...(c.laneWidthM ? { laneWidthM: range(c.laneWidthM) } : {}),
    ...(c.speedLimitKph ? { speedLimitKph: range(c.speedLimitKph) } : {}),
    ...(c.runwayUpstreamM ? { runwayUpstreamM: scalarRunway(c.runwayUpstreamM) } : {}),
    ...(c.runwayDownstreamM ? { runwayDownstreamM: scalarRunway(c.runwayDownstreamM) } : {}),
    ...(c.curvatureDegPer10m ? { curvatureDegPer10m: range(c.curvatureDegPer10m) } : {}),
    ...(c.gradePct ? { gradePct: range(c.gradePct) } : {}),
    ...(c.requiresAdjacent && c.requiresAdjacent.value.some((kind) => kind !== 'opposing') ? { requiresAdjacent: adjacent(c.requiresAdjacent) } : {}),
    ...(c.forbidsAdjacent && c.forbidsAdjacent.value.some((kind) => kind !== 'opposing') ? { forbidsAdjacent: adjacent(c.forbidsAdjacent) } : {}),
    ...(c.laneChangeLegal ? { laneChangeLegal: { ...c.laneChangeLegal, value: { ...c.laneChangeLegal.value, sRange: c.laneChangeLegal.value.sRange as [number | null, number | null] } } } : {}),
  } : undefined;
  const features: AnchorFeature[] = anchor.features.map((feature) => {
    const common = {
      id: feature.id,
      atM: range(feature.atM),
      ...(feature.lateralDistanceM ? { lateralDistanceM: range(feature.lateralDistanceM) } : {}),
      ...(feature.sameRoad ? { sameRoad: feature.sameRoad } : {}),
      ...(feature.side ? { side: feature.side } : {}),
      essentiality: feature.atM.essentiality,
    };
    if (feature.kind === 'junction') {
      const junction = feature.junction;
      return {
        ...common,
        kind: 'junction' as const,
        ...(junction?.arms ? { arms: range(junction.arms) } : {}),
        ...(junction?.control ? { control: junction.control } : {}),
        ...(junction?.egoTurn ? { egoTurn: { ...junction.egoTurn, value: [junction.egoTurn.value] } } : {}),
        ...(junction?.conflictingApproach ? { conflictingApproach: junction.conflictingApproach } : {}),
        ...(junction?.sizeM ? { sizeM: range(junction.sizeM) } : {}),
        ...(junction?.hasCrossingOnLeg ? { hasCrossingOnLeg: junction.hasCrossingOnLeg } : {}),
      };
    }
    if (feature.kind === 'crossing') {
      const crossing = feature.crossing;
      return {
        ...common,
        kind: 'crossing' as const,
        ...(crossing?.marked ? { marked: crossing.marked } : {}),
        ...(crossing?.controlled ? { controlled: crossing.controlled } : {}),
        ...(crossing?.lengthM ? { lengthM: range(crossing.lengthM) } : {}),
        ...(crossing?.placement ? { placement: crossing.placement } : {}),
      };
    }
    return { ...common, kind: feature.kind } as AnchorFeature;
  });
  return {
    id: anchor.id,
    ...(corridor ? { corridor } : {}),
    features,
    policy: {
      allowMirror: anchor.policy?.allowMirror ?? false,
      maxSitesPerMap: anchor.policy?.maxSitesPerMap ?? 10,
      diversity: anchor.policy?.diversity === 'none' ? 'off' : anchor.policy?.diversity === 'road_direction' ? 'moderate' : 'strict',
      minScore: anchor.policy?.minScore ?? 0.5,
    },
  };
}

/** Lift a Studio map-bound v2 document into a portable structural template. */
export function liftMapBoundTemplate(
  template: ScenarioTemplateV2,
  index: DerivedMapIndex,
  options: PortableLiftOptions = {},
): PortableLiftResult {
  const issues: PortableLiftIssue[] = [];
  const absoluteRoles = template.roles.filter((role): role is Extract<RoleBinding, { kind: 'scene_absolute' }> => role.kind === 'scene_absolute');
  const referenceId = options.referenceRoleId ?? template.metricSubject ?? absoluteRoles[0]?.id;
  const reference = absoluteRoles.find((role) => role.id === referenceId);
  if (!reference) {
    issues.push({ code: 'reference_role_missing', severity: 'error', path: 'roles', message: `reference role "${referenceId ?? ''}" is absent or already portable`, dependency: 'choose a scene_absolute reference actor', retryable: true });
    return { ok: false, issues };
  }
  const referenceRsl = rslOf(reference);
  if (!referenceRsl) {
    issues.push({ code: 'reference_lane_anchor_missing', severity: 'error', path: `roles.${reference.id}.laneRef`, message: 'reference actor has no lane anchor', dependency: 'snap the reference actor to a driving lane and save its laneRef', retryable: true });
    return { ok: false, issues };
  }
  if (!index.lanes[referenceRsl]) {
    issues.push({ code: 'reference_lane_missing', severity: 'error', path: `roles.${reference.id}.laneRef`, message: `lane ${referenceRsl} is absent from the current topology`, dependency: 'reload the matching map topology or re-snap the actor', retryable: true });
    return { ok: false, issues };
  }
  const frame = findFrame(template, reference, index, options.origin ?? 'auto', issues);
  if (!frame) {
    if (!issues.some((issue) => issue.code === 'internal_lane_ambiguous' || issue.code === 'terminal_lane_unconnected')) issues.push({ code: 'source_frame_unbuildable', severity: 'error', path: 'anchor', message: 'no connected corridor or junction frame could be built from the reference approach', dependency: 'derive connected segments/gates for the reference lane or choose another reference actor', retryable: true });
    return { ok: false, issues };
  }

  const maxDistance = options.maxProjectionDistanceM ?? 20;
  const bindings: FeatureBinding[] = [];
  const liftedRoles: RoleBinding[] = [];
  const inferredFeatures = new Map<string, MatcherAnchor['features'][number]>();
  const referenceProjection = projectToFrame(reference, frame, index)!;
  for (const role of absoluteRoles) {
    const projection = projectToFrame(role, frame, index);
    const roleRsl = rslOf(role);
    if (!projection) {
      issues.push({ code: 'role_projection_too_far', severity: 'error', path: `roles.${role.id}.pose`, message: 'actor could not be projected into the source anchor frame', dependency: 'extend the source frame route or choose a closer reference actor', retryable: true });
      continue;
    }
    if (projection.distanceM > maxDistance) {
      issues.push({ code: 'role_projection_too_far', severity: 'warning', path: `roles.${role.id}.pose`, message: `actor is ${round(projection.distanceM, 2)} m from the reference path; using a semantic relative binding`, dependency: 'provide a crossing/parking/conflicting movement feature for a stronger binding', retryable: true });
    }
    if (!roleRsl) {
      issues.push({ code: 'role_lane_anchor_missing', severity: 'warning', path: `roles.${role.id}.laneRef`, message: 'actor has no lane anchor; inferred relative to the reference actor', dependency: 'snap this actor to a lane or crossing for a topology-aware transfer', retryable: true });
    } else if (!index.lanes[roleRsl]) {
      issues.push({ code: 'role_lane_missing', severity: 'warning', path: `roles.${role.id}.laneRef`, message: `lane ${roleRsl} is absent; inferred relative to the reference actor`, dependency: 're-snap this actor against the current topology', retryable: true });
    }

    const base = roleBase(role);
    const semanticPose = poseOnOwnLane(role, projection, index);
    const conflict = roleRsl ? conflictingMovement(roleRsl, frame, index) : null;
    const crossing = role.id === reference.id || !['pedestrian', 'bicycle', 'scooter', 'animal'].includes(role.actor.class)
      ? undefined
      : nearbyPointFeature(role, index, new Set(['crossing']));
    const parking = role.id === reference.id || !role.actor.static
      ? undefined
      : nearbyPointFeature(role, index, new Set(['parking_zone']));
    let lifted: RoleBinding;
    let matcherKind: FeatureBinding['kind'];
    if (crossing) {
      const featureId = `crossing_${role.id}`.slice(0, 64);
      inferredFeatures.set(featureId, {
        id: featureId,
        kind: 'crossing',
        atM: { value: [round(Number(projection.pose.s) - 6), round(Number(projection.pose.s) + 6)], essentiality: role.essentiality },
        sameRoad: { value: true, essentiality: 'preferred' },
      });
      lifted = { ...base, kind: 'on_crossing', feature: featureId, startFrac: 0.5, direction: angleDiff(role.pose.headingRad, projection.referenceHeadingRad) >= 0 ? 'near_to_far' : 'far_to_near', lateralFrac: 0 };
      matcherKind = 'on_crossing';
    } else if (parking) {
      const featureId = `parking_${role.id}`.slice(0, 64);
      inferredFeatures.set(featureId, {
        id: featureId,
        kind: 'parking_zone',
        atM: { value: [round(Number(projection.pose.s) - 8), round(Number(projection.pose.s) + 8)], essentiality: role.essentiality },
        sameRoad: { value: true, essentiality: 'preferred' },
      });
      lifted = { ...base, kind: 'in_parking_zone', feature: featureId, slot: 'any', facing: Math.abs(angleDiff(role.pose.headingRad, projection.referenceHeadingRad)) > Math.PI / 2 ? 'against_traffic' : 'with_traffic' };
      matcherKind = 'in_parking_zone';
    } else if (role.id === reference.id || (roleRsl && frame.referencePath.some((span) => span.laneRsl === roleRsl))) {
      lifted = { ...base, kind: 'on_reference', pose: semanticPose };
      matcherKind = 'on_reference';
    } else if (conflict) {
      lifted = { ...base, kind: 'conflicting_gate', feature: conflict.feature, from: conflict.from, turn: conflict.turn, fallbackPose: semanticPose };
      matcherKind = 'conflicting_gate';
    } else {
      const lateralEntry = roleRsl ? Object.entries(frame.lateralLanes).find(([, lane]) => lane === roleRsl) : undefined;
      const opposingIndex = roleRsl ? frame.opposingLanes.indexOf(roleRsl) : -1;
      if (lateralEntry && Number(lateralEntry[0]) !== 0) {
        const k = Number(lateralEntry[0]);
        lifted = { ...base, kind: 'lane_offset', k, onMissing: role.essentiality === 'required' ? 'fail' : 'clamp', pose: { ...semanticPose, laneOffset: k } };
        matcherKind = 'lane_offset';
      } else if (opposingIndex >= 0) {
        lifted = { ...base, kind: 'opposing', k: opposingIndex, pose: semanticPose };
        matcherKind = 'opposing';
      } else {
        const dsM = round((typeof projection.pose.s === 'number' ? projection.pose.s : 0) - (typeof referenceProjection.pose.s === 'number' ? referenceProjection.pose.s : 0));
        const signedLateral = projection.pose.tFrac;
        const dLane = Math.max(-8, Math.min(8, Math.round((typeof signedLateral === 'number' ? signedLateral : 0))));
        lifted = { ...base, kind: 'relative_to', ref: reference.id, dLane, dsM, tFrac: typeof projection.pose.tFrac === 'number' ? projection.pose.tFrac : 0, headingOffsetRad: projection.pose.headingOffsetRad };
        matcherKind = 'relative_to';
        issues.push({ code: 'role_binding_ambiguous', severity: 'warning', path: `roles.${role.id}`, message: 'actor did not map to a reference, lateral, opposing, or conflicting gate; retained as a relative structural role', dependency: 'add a semantic crossing, parking-zone, or junction movement association to strengthen transfer', retryable: true });
      }
    }
    liftedRoles.push(lifted);
    bindings.push({
      role: role.id,
      kind: matcherKind,
      status: 'bound',
      ...(roleRsl ? { laneRsl: roleRsl } : {}),
      pose: { k: projection.pose.laneOffset, s: projection.pose.s as number, tFrac: projection.pose.tFrac as number, headingOffsetRad: projection.pose.headingOffsetRad },
      ...(conflict ? { conflict: conflict.conflict } : {}),
      notes: [],
    });
  }
  if (issues.some((issue) => issue.severity === 'error')) return { ok: false, issues };

  const sourceSite: MatchedSite = {
    siteId: computeSiteId({ anchorId: template.anchor.id ?? 'transfer', mapId: index.mapId, topologyDigest: index.topologyDigest, originFeatureId: frame.origin.mapFeatureId, entryLaneRsl: frame.entryLaneRsl, originS: 0 }),
    mapId: index.mapId,
    topologyDigest: index.topologyDigest,
    matchSemanticsVersion: MATCH_SEMANTICS_VERSION,
    anchorId: template.anchor.id ?? 'transfer',
    score: 1,
    frame,
    clauses: [],
    bindings,
    featureMatches: frame.origin.kind === 'junction' ? { [frame.origin.anchorFeatureId]: { mapFeatureId: frame.origin.mapFeatureId, s: 0, kind: 'junction' } } : {},
    degradation: { verdict: 'exact', score: 1, repairs: [], failedRequiredClauses: [], summary: 'source authoring site lifted exactly', intentPreserved: true },
    matchedReasons: ['lifted from scene_absolute lane anchors'],
    alternateFrames: 0,
  };
  let pattern = inferPortableSitePattern(sourceSite, index, {
    patternId: template.anchor.id ?? `transfer-${sha256Hex(template.meta.name).slice(0, 12)}`,
    allowMirror: options.allowMirror ?? true,
    corridorExtentM: options.corridorExtentM,
    requiredRoles: liftedRoles.filter((role) => role.essentiality === 'required').map((role) => role.id),
  });
  if (inferredFeatures.size > 0) {
    const anchor = { ...pattern.anchor, features: [...pattern.anchor.features, ...[...inferredFeatures.values()].sort((a, b) => a.id.localeCompare(b.id))] };
    pattern = {
      ...pattern,
      anchor,
      requiredPaths: [...pattern.requiredPaths, ...[...inferredFeatures.keys()].map((id) => `features.${id}.atM`)].sort(),
      cacheKey: sha256Hex(JSON.stringify({ contract: 'lifted-point-features.v1', anchor, provenance: pattern.provenance, sourceSignature: pattern.sourceSignature })),
    };
  }
  const portableAnchor = matcherAnchorToV2(pattern.anchor);
  const choreography = portableChoreography(template.choreography, frame.origin.anchorFeatureId, options.signalApproaches, issues);
  if (issues.some((issue) => issue.severity === 'error')) return { ok: false, sourceSite, pattern, issues };
  const portable = ScenarioTemplateV2Schema.parse({
    ...template,
    anchor: portableAnchor,
    roles: liftedRoles,
    choreography,
    extensions: template.extensions ? sanitizeExtensions(template.extensions) : undefined,
  });
  return { ok: true, template: portable, sourceSite, pattern, issues };
}

/** Pair a portable template with a destination site without embedding map facts. */
export function bindPortableVariation(template: ScenarioTemplateV2, site: MatchedSite): BoundVariation {
  if (template.roles.some((role) => role.kind === 'scene_absolute')) {
    throw new TypeError('bindPortableVariation requires a lifted portable template');
  }
  if (!site.degradation.intentPreserved || site.degradation.verdict === 'infeasible') {
    throw new TypeError(`candidate ${site.siteId} does not preserve required scenario intent`);
  }
  const canonical = ScenarioTemplateV2Schema.parse({
    ...template,
    anchor: { ...template.anchor, pin: undefined },
  });
  return { template: canonical, site, issues: [] };
}
