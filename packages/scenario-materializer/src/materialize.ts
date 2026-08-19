/**
 * The materializer: `template × site × draw → SimScenarioInput`.
 *
 * This is the one piece of the stack that did not exist before the CLI. Every
 * package below it is deliberately incomplete on its own — the matcher does the
 * *structural* pass and stops, the engine takes a fully-resolved document and
 * refuses anything less — and this module is the join.
 *
 * ## The pipeline
 *
 * ```
 * 1. PARAMS    per-cell seed = sha256(templateId|paramsVersion|siteId|drawIndex)
 *              → xoshiro128**, one forked stream per declaration
 * 2. FRAME     the site's AnchorFrame reference path is rebuilt as a sim-engine
 *              Route, which is what turns frame `s` into a world point
 * 3. ROLES     each FeatureBinding becomes a concrete actor: route from the
 *              binding's lane chain, spawn by *projecting the frame point onto
 *              that route* (not by re-deriving arc length), speeds and offsets
 *              from expressions evaluated in the role's own lane scope
 * 4. TIMELINE  v2 interactions → engine interactions, verb by verb; `set rules.*`
 *              at t ≤ 0 folds into the actor's initial rules so the arrival
 *              solve sees the behaviour it will actually run with
 * 5. ARRIVAL   every `conflicting_gate` role carrying `arriveAtConflict` is
 *              back-solved with `sim-engine`'s bisection on spawn `s`, aimed at
 *              the matcher's precomputed conflict point
 * 6. GUARDS    `checkFeasibility` — runway, decel budget, spawn overlap,
 *              route connectivity — reported as structured findings
 * ```
 *
 * ## Why projection rather than arithmetic
 *
 * A role's pose is `(k, s)` in the anchor frame. The obvious way to place it is
 * to add up lane lengths until `s` is consumed. That is wrong for every role
 * that is not on the reference lane: `k = +1` and `opposing` lanes have their
 * own arc-length origins, and the two packages measure lane length from
 * slightly different polylines. So the frame `s` is resolved to a **world
 * point** on the reference route, and that point is projected onto the actor's
 * own route. Cross-sections stay aligned by construction, and the two packages
 * only have to agree about geometry, never about bookkeeping.
 */

import {
  DEFAULT_ACTOR_DIMS,
  driverProfileDefinition,
  evaluateExpr,
  isExpr,
  rolePose,
  PropPlacementSchema,
  type Expr,
  type ExprScope,
  type Interaction as V2Interaction,
  type NumberOrExpr,
  type ScenarioTemplateV2,
  type SignalRef,
  type ActorClass,
  type Condition as V2Condition,
  type PointRef,
  type PropPlacement,
  type PropPlacementInput,
  type FramePose,
  type Environment,
  type RoleBinding as V2Role,
  type Trigger as V2Trigger,
} from '@uniscenarios/scenario-model';
import {
  MATCH_SEMANTICS_VERSION,
  type FeatureBinding,
  type MatchedSite,
} from '@uniscenarios/anchor-matcher';
import {
  ENGINE_VERSION,
  Route,
  buildFollowRoute,
  buildLanePathRoute,
  nominalRun,
  contentHash,
  checkFeasibility,
  parseSimScenarioInput,
  normalizeSimScenarioInput,
  safeParseSimScenarioInput,
  solveArrival,
  solvePedestrianNearMiss,
  applyArrivalSolution,
  resolveArrivalTriggers,
  resolveOverlappingControlLanes,
  buildOccluders,
  blockingOccluder,
  localFromScene,
  toSceneXZ,
  applyAmbientTraffic,
  resolveAmbientTrafficProfile,
  settleAmbientTraffic,
  type AmbientSettleProvenance,
  type AmbientTrafficProfile,
  type AmbientTrafficProvenance,
  type ArrivalSolution,
  type Condition as SimCondition,
  type Interaction as SimInteraction,
  type LaneGraph,
  type NearMissCriterion,
  type TurnRelation,
  type Occluder,
  type OcclusionPair,
  type RoadControl,
  type SignalProgram,
  type SimActor,
  type SimIssue,
  type SimScenarioInput,
  type StaticProp,
  type PerceptionConfig as SimPerceptionConfig,
  type SurfacePatch as SimSurfacePatch,
  type LaneClosure as SimLaneClosure,
  type Trigger as SimTrigger,
  pruneDanglingAfterInteractions,
} from '@uniscenarios/sim-engine';

import { CliError } from './errors.js';
import {
  atmosphereFromEnvironment,
  lowerMapDivergence,
  lowerSensor,
  type DivergenceWindow,
} from './perception.js';
import type { MapBundle } from './types.js';
import { paramsVersion, resolveParams, templateId, type ParamDraw } from './params.js';
import { actorCatalogMismatch, catalogActorDims, propBehavior, propDims } from './prop-dims.js';
import {
  buildMapControlPlan,
  buildSiteSignalPlan,
  buildSiteRoadControls,
  resolveSiteSignalProgram,
  type SiteSignalPlan,
} from './map-signals.js';
import { compileMapSignalPlans, MapSignalPlanCompileError } from './map-signal-plan-compiler.js';

const KPH_TO_MPS = 1 / 3.6;

type Point2 = { readonly x: number; readonly y: number };

function pointSegmentDistance(point: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 <= 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function segmentDistance(a: Point2, b: Point2, c: Point2, d: Point2): number {
  const cross = (p: Point2, q: Point2, r: Point2): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC <= 0 && abD >= 0) || (abC >= 0 && abD <= 0)) &&
      ((cdA <= 0 && cdB >= 0) || (cdA >= 0 && cdB <= 0))) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

function polylineDistance(a: readonly Point2[], b: readonly Point2[]): number {
  let best = Infinity;
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      best = Math.min(best, segmentDistance(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!));
    }
  }
  return best;
}

function routeIntersectionNear(
  a: Route,
  b: Route,
  near: { x: number; y: number },
): { x: number; y: number } | null {
  const stepM = 1;
  const sample = (route: Route) => {
    const points: Array<{ x: number; y: number }> = [];
    for (let s = 0; s < route.lengthM; s += stepM) points.push(route.poseAt(s).point);
    points.push(route.poseAt(route.lengthM).point);
    return points;
  };
  const aa = sample(a);
  const bb = sample(b);
  let best: { point: { x: number; y: number }; distance2: number } | null = null;
  for (let i = 0; i + 1 < aa.length; i += 1) {
    const p = aa[i]!;
    const p2 = aa[i + 1]!;
    const rx = p2.x - p.x;
    const ry = p2.y - p.y;
    for (let j = 0; j + 1 < bb.length; j += 1) {
      const q = bb[j]!;
      const q2 = bb[j + 1]!;
      const sx = q2.x - q.x;
      const sy = q2.y - q.y;
      const denom = rx * sy - ry * sx;
      if (Math.abs(denom) < 1e-9) continue;
      const qpx = q.x - p.x;
      const qpy = q.y - p.y;
      const ta = (qpx * sy - qpy * sx) / denom;
      const tb = (qpx * ry - qpy * rx) / denom;
      if (ta < 0 || ta > 1 || tb < 0 || tb > 1) continue;
      const point = { x: p.x + ta * rx, y: p.y + ta * ry };
      const distance2 = (point.x - near.x) ** 2 + (point.y - near.y) ** 2;
      if (!best || distance2 < best.distance2) best = { point, distance2 };
    }
  }
  return best?.point ?? null;
}

/**
 * Prove that a matcher-declared conflict survived route materialization.
 *
 * Matchers reason over candidate lane chains, whereas the engine executes the
 * final, connectable route emitted below.  Those can diverge when a chain is
 * shortened or a movement is rebound.  An arrival solve must never use the
 * matcher point as a convenient fiction in that case: its two nominal arrival
 * times would describe actors that cannot physically meet.
 *
 * The tolerance is explicitly footprint-aware: centre paths may be separated
 * by the two actors' half widths and still represent the same occupied conflict
 * region.  It is deliberately not a road-search radius.
 */
export function closeArrivalConflict(
  declared: { x: number; y: number },
  a: Route,
  b: Route,
  aWidthM: number,
  bWidthM: number,
): {
  readonly closed: boolean;
  readonly toleranceM: number;
  readonly aDistanceM: number;
  readonly bDistanceM: number;
  readonly pathSeparationM: number;
  readonly point: { x: number; y: number };
} {
  const aProjection = a.projectPoint(declared);
  const bProjection = b.projectPoint(declared);
  const aPoint = a.poseAt(aProjection.s).point;
  const bPoint = b.poseAt(bProjection.s).point;
  // A small numerical allowance prevents a centreline which is exactly at the
  // tyre envelope from oscillating between accepted/rejected across platforms.
  const toleranceM = Math.max(0.25, (aWidthM + bWidthM) / 2 + 0.05);
  const pathSeparationM = Math.hypot(aPoint.x - bPoint.x, aPoint.y - bPoint.y);
  const intersection = routeIntersectionNear(a, b, declared);
  const point = intersection ?? {
    x: (aPoint.x + bPoint.x) / 2,
    y: (aPoint.y + bPoint.y) / 2,
  };
  return {
    closed:
      aProjection.d <= toleranceM &&
      bProjection.d <= toleranceM &&
      pathSeparationM <= toleranceM,
    toleranceM,
    aDistanceM: aProjection.d,
    bDistanceM: bProjection.d,
    pathSeparationM,
    point,
  };
}

/** The full replay key: everything an instance needs to be re-derived exactly. */
export interface ReplayKey {
  readonly templateId: string;
  readonly templateVersion: number;
  /** Content hash of the whole authored template — the version field alone lies. */
  readonly templateDigest: string;
  readonly mapId: string;
  /** Matcher/map-intel digest used to derive the site id. */
  readonly matcherIndexDigest: string;
  /** Engine lane-graph digest written into traces. */
  readonly engineGraphDigest: string;
  readonly siteId: string;
  readonly matcherVersion: string;
  readonly solverVersion: string;
  readonly paramSeed: string;
  readonly drawIndex: number;
  /**
   * Hash of the resolved ambient-traffic profile, or the literal `'none'`.
   * A cached cell generated with a different background population is not the
   * same cell.
   */
  readonly ambientProfileHash: string;
}

export interface InstanceManifest {
  readonly kind: 'scenario-instance-manifest';
  readonly manifestVersion: 1;
  readonly replayKey: ReplayKey;
  readonly instanceId: string;
  readonly archetype: string | null;
  readonly negativeControl: boolean;
  readonly metricSubject: string | null;
  /** Catalog operational variant, closed over the exact engine conditions that
   * were applied before arrival solving and input hashing. `null` for ordinary
   * ad-hoc instantiation. */
  readonly operationalVariant: AppliedCatalogVariant | null;
  readonly site: {
    readonly siteId: string;
    readonly score: number;
    readonly verdict: string;
    readonly originFeatureId: string;
    readonly entryLaneRsl: string;
    readonly egoTurn: string | null;
    readonly degradationSummary: string;
    readonly matchedReasons: string[];
  };
  readonly params: {
    readonly values: Record<string, number>;
    readonly categorical: Record<string, string>;
    readonly rejectedConstraints: string[];
  };
  readonly actors: Array<{
    readonly id: string;
    readonly actorKind: SimActor['kind'];
    readonly roleKind: string;
    readonly laneRsl: string | null;
    readonly spawnS: number;
    readonly initialSpeedMps: number;
    readonly bindingStatus: string;
  }>;
  /** Hash-covered fixed catalog geometry expanded from the authored v2 props. */
  readonly props: StaticProp[];
  readonly arrival: ArrivalSolution[];
  /** `sha256(canonicalJson(parsedInput))` — matches `trace.header.inputHash`. */
  readonly inputHash: string;
  readonly feasible: boolean;
  readonly issues: SimIssue[];
  /**
   * Complete provenance of the generated background population. Absent — not
   * null — when no ambient traffic was requested, so an empty-road manifest is
   * byte-identical to the ones written before this existed.
   */
  readonly ambient?: AmbientTrafficProvenance;
  /**
   * Provenance of the ambient-only warm-up. Absent when no settle ran, so a
   * manifest written without this feature is byte-identical.
   */
  readonly ambientSettle?: AmbientSettleProvenance;
  /** Commands already accepted into the concrete t=0 world rather than left
   * for the runtime trigger evaluator. Optional for manifest-v1 compatibility. */
  readonly initialInteractionOutcomes?: InitialInteractionOutcome[];
  /** Lowering diagnostics; only notes without informational impact denote loss. */
  readonly notes: MaterializationNote[];
}

export interface InitialInteractionOutcome {
  readonly interactionId: string;
  readonly actorId: string;
  readonly verb: V2Interaction['verb'];
  readonly timeS: number;
  readonly outcome: 'executed';
  readonly basis: 'folded_initial_state';
}

/**
 * Cohort geometry for the ambient warm-up.
 *
 * A settled car travels `cruise x settleSeconds` — 260 m for 13 m/s over 20 s —
 * so the cars standing near the ego at `t = 0` are the ones that spawned that
 * far UPSTREAM, not the ones that spawned next to it. Selecting only the target
 * count inside the profile's radius and then settling it drove the measured
 * median within 60 m of the ego from 5 to 0: the whole population had driven
 * off the site.
 *
 * The cohort is therefore a LARGER neighbourhood at the SAME density, never the
 * same neighbourhood at a higher one — a denser cohort is a traffic jam, and a
 * jam manufactures exactly the standing queues the measure is trying to detect.
 * `MPS` is a nominal urban cruise used only to size the ring; `MULTIPLIER` only
 * lifts `profile.maxActors`, which caps the placed population rather than the
 * cohort.
 */
const AMBIENT_SETTLE_COHORT_MPS = 15;
const AMBIENT_SETTLE_COHORT_MULTIPLIER = 4;

export interface MaterializeResult {
  readonly input: SimScenarioInput;
  readonly manifest: InstanceManifest;
}

export interface MaterializeOptions {
  readonly drawIndex?: number;
  /** Overrides the derived per-cell seed. `--seed` on the command line. */
  readonly seed?: string | undefined;
  /** Operational conditions reserved by a catalog slot. These are applied to
   * the concrete engine input; they are not an evidence-only provenance stamp. */
  readonly variant?: CatalogVariantApplication | undefined;
  /**
   * Generated background road users.
   *
   * Absent, or `preset: 'off'`, reproduces the previous empty-road behaviour
   * byte for byte — nothing is added to the input and nothing is added to the
   * manifest. When present, ambient actors are appended to the concrete input
   * AFTER the authored feasibility verdict has been decided, so background
   * traffic can never turn an authored-feasible cell infeasible, and BEFORE
   * `inputHash` is taken, so the instance/trace evidence join still holds.
   */
  readonly ambient?: AmbientTrafficProfile | undefined;
  /**
   * AMBIENT WARM-UP. Seconds of ambient-ONLY integration applied before `t = 0`.
   *
   * `choreography.warmupSeconds` cannot be used for this: the engine integrates
   * the whole scene from `t = -warmupSeconds`, so raising it also advances the
   * ego and the authored challenger and destroys the authored conflict timing.
   * `settleAmbientTraffic` instead runs a throw-away simulation containing only
   * the generated population and folds its final state back into those actors'
   * initial state, leaving every authored actor's bytes untouched.
   *
   * `0` or absent reproduces the un-settled behaviour exactly.
   */
  readonly ambientSettleSeconds?: number | undefined;
}

export interface CatalogVariantApplication {
  readonly id: string;
  readonly title: string;
  readonly weather: string;
  readonly timeOfDay: string;
  readonly traffic: string;
  readonly visibility: string;
}

export interface AppliedCatalogVariant extends CatalogVariantApplication {
  readonly concrete: NonNullable<SimScenarioInput['operationalConditions']>;
}

/** Translate the catalog's deliberately human-readable visibility labels into
 * the finite engine vocabulary and its executable physical effects. */
export function applyCatalogVariant(
  variant: CatalogVariantApplication,
): NonNullable<SimScenarioInput['operationalConditions']> {
  const weather = variant.weather === 'clear' || variant.weather === 'rain' || variant.weather === 'overcast'
    ? variant.weather
    : null;
  const timeOfDay = variant.timeOfDay === 'day' || variant.timeOfDay === 'dusk' || variant.timeOfDay === 'night' || variant.timeOfDay === 'dawn'
    ? variant.timeOfDay
    : null;
  const traffic = variant.traffic === 'light' || variant.traffic === 'moderate' || variant.traffic === 'heavy'
    ? variant.traffic
    : null;
  const visibility = variant.visibility === 'unrestricted except authored occluders'
    ? 'unrestricted'
    : variant.visibility === 'reduced contrast and traffic occlusion'
      ? 'reduced-contrast'
      : variant.visibility === 'headlight-limited with wet-road reflections'
        ? 'headlight-limited'
        : variant.visibility === 'directional glare with otherwise clear air'
          ? 'directional-glare'
          : variant.visibility === 'dense actor and parked-vehicle occlusion'
            ? 'dense-occlusion'
            : null;
  if (!weather || !timeOfDay || !traffic || !visibility) {
    throw new CliError('variant_unsupported', `catalog variant "${variant.id}" contains unsupported operational conditions`, {
      path: 'variant',
      detail: { weather: variant.weather, timeOfDay: variant.timeOfDay, traffic: variant.traffic, visibility: variant.visibility },
    });
  }
  const visibilityRangeM = visibility === 'unrestricted'
    ? 1_000
    : visibility === 'reduced-contrast'
      ? 140
      : visibility === 'headlight-limited'
        ? 75
        : visibility === 'directional-glare'
          ? 105
          : 90;
  const frictionScale = weather === 'rain' ? 0.72 : 1;
  const trafficSpeedFactor = traffic === 'light' ? 1.05 : traffic === 'heavy' ? 0.85 : 1;
  return {
    weather,
    timeOfDay,
    traffic,
    visibility,
    effects: { visibilityRangeM, frictionScale, trafficSpeedFactor },
  };
}

/** Resolve the canonical v2 environment for ordinary Studio/CLI materialization.
 * Catalog slots still win when supplied, but an ad-hoc authored scenario must
 * never silently simulate as dry noon merely because it is not in a catalog. */
export function applyTemplateEnvironment(
  environment: Environment,
  evaluateNumber: (value: NumberOrExpr, path: string) => number = (value, path) => {
    if (typeof value === 'number') return value;
    throw new CliError('environment_expression_unresolved', `cannot resolve ${path} without a parameter scope`, { path });
  },
): NonNullable<SimScenarioInput['operationalConditions']> {
  const rain = new Set(['light_rain', 'heavy_rain', 'wet_road', 'sleet']);
  const overcast = new Set(['cloudy', 'overcast', 'fog_light', 'fog_dense', 'snow']);
  const weather = rain.has(environment.weather) ? 'rain' : overcast.has(environment.weather) ? 'overcast' : 'clear';
  const timeOfDay = environment.timeOfDay === 'dawn'
    ? 'dawn'
    : environment.timeOfDay === 'dusk'
      ? 'dusk'
      : environment.timeOfDay === 'night' || environment.timeOfDay === 'night_lit'
        ? 'night'
        : 'day';
  const extensionVisibility = environment.extensions?.['visibility'];
  const sunElevation = environment.sunElevationDeg === undefined
    ? null
    : evaluateNumber(environment.sunElevationDeg, 'environment.sunElevationDeg');
  const visibility = extensionVisibility === 'directional-glare'
    || (sunElevation !== null && sunElevation <= 10)
    ? 'directional-glare'
    : extensionVisibility === 'headlight-limited'
      ? 'headlight-limited'
      : extensionVisibility === 'dense-occlusion'
        ? 'dense-occlusion'
        : environment.weather === 'fog_dense'
          ? 'dense-occlusion'
          : environment.weather === 'fog_light' || environment.weather === 'heavy_rain'
            ? 'reduced-contrast'
            : 'unrestricted';
  const presetFriction: Record<string, number> = {
    light_rain: 0.78,
    heavy_rain: 0.58,
    wet_road: 0.72,
    snow: 0.35,
    sleet: 0.42,
  };
  const frictionScale = environment.frictionScale === undefined
    ? (presetFriction[environment.weather] ?? 1)
    : evaluateNumber(environment.frictionScale, 'environment.frictionScale');
  const visibilityRangeM = visibility === 'unrestricted'
    ? 1_000
    : visibility === 'reduced-contrast'
      ? 120
      : visibility === 'headlight-limited'
        ? 75
        : visibility === 'directional-glare'
          ? 105
          : 90;
  return {
    weather,
    timeOfDay,
    traffic: 'moderate',
    visibility,
    effects: { visibilityRangeM, frictionScale, trafficSpeedFactor: 1 },
  };
}

export interface MaterializationNote {
  path: string;
  reason: string;
  /**
   * Informational notes describe a semantics-preserving lowering decision.
   * They must remain visible in evidence, but they are not a reason to refuse
   * editable playback. Omitted means the note records semantic loss.
   */
  impact?: 'informational';
}

type Note = MaterializationNote;

/** Notes which mean the authored document could not be represented exactly. */
export function materializationSemanticLosses(
  notes: readonly MaterializationNote[],
): MaterializationNote[] {
  return notes.filter((note) => note.impact !== 'informational');
}

/** Refuse map-control claims the current engine cannot execute faithfully. */
export function assertMaterializableMapControls(
  template: ScenarioTemplateV2,
  bundle: MapBundle,
  site: MatchedSite,
  signalPlan: SiteSignalPlan,
  roadControls: readonly RoadControl[] = [],
): void {
  for (const feature of template.anchor.features) {
    if (feature.kind !== 'junction' || feature.control?.essentiality !== 'required') continue;
    const match = site.featureMatches[feature.id];
    const junctionId = match?.mapFeatureId.startsWith('junction:')
      ? match.mapFeatureId.slice('junction:'.length)
      : null;
    const actual = junctionId ? bundle.index.junctionDescriptors[junctionId]?.control : undefined;
    if (actual === 'all_way_stop' || actual === 'minor_stop') {
      if (roadControls.length === 0) {
        throw new CliError(
          'map_control_missing',
          `required ${actual} control has no deterministic stop-sign-to-movement binding`,
          { path: `anchor.features.${feature.id}.control`, detail: { junctionId, actual } },
        );
      }
    }
    const completeSignalBinding = signalPlan.programs.length > 0 && signalPlan.programs.every((program) =>
      program.stopLines.length > 0 &&
      program.stopLines.every((line) => line.connectingLaneRsls.length > 0) &&
      program.mapBinding?.junctionId === junctionId &&
      (program.mapBinding.controllerHeadGroups?.length ?? 0) > 0
    );
    if (actual === 'signalized' && !completeSignalBinding) {
      throw new CliError(
        'map_control_missing',
        'required signalized control has no complete OpenDRIVE controller/head/movement binding',
        { path: `anchor.features.${feature.id}.control`, detail: { junctionId, actual } },
      );
    }
  }
}

/** Enforce authored control semantics on the exact movement gate. Junction-level
 * labels such as `minor_stop` are insufficient: they do not say which arm is
 * stopped, and accepting them can invert violator and priority traffic. */
export function assertMaterializableMovementControls(
  template: ScenarioTemplateV2,
  bundle: MapBundle,
  site: MatchedSite,
  roadControls: readonly RoadControl[],
): void {
  const gateById = new Map(bundle.topology.gates.map((gate) => [gate.id, gate]));
  const isStopControlled = (gateId: string): boolean => {
    const gate = gateById.get(gateId);
    if (!gate) return false;
    return roadControls.some((control) => control.kind === 'stop' && control.stopLines.some((line) =>
      line.rsl === gate.approachLaneRsl && line.connectingLaneRsls.includes(gate.connectingLaneRsl)
    ));
  };

  for (const role of template.roles) {
    const required = role.requiredMovementControl;
    if (!required) continue;
    const binding = site.bindings.find((candidate) => candidate.role === role.id);
    const gateId = role.kind === 'conflicting_gate'
      ? binding?.conflict?.gateId
      : role.kind === 'on_reference'
        ? site.frame.egoGateId
        : undefined;
    if (!gateId) {
      throw new CliError(
        'movement_control_unresolved',
        `required ${required} movement control cannot be resolved to an exact junction gate`,
        { path: `roles.${role.id}.requiredMovementControl`, detail: { roleId: role.id, siteId: site.siteId } },
      );
    }
    const stopped = isStopControlled(gateId);
    if (required === 'stop' && !stopped) {
      throw new CliError(
        'movement_stop_missing',
        `bound movement gate ${gateId} has no physical stop control`,
        { path: `roles.${role.id}.requiredMovementControl`, detail: { roleId: role.id, gateId, siteId: site.siteId } },
      );
    }
    if (required === 'uncontrolled' && stopped) {
      throw new CliError(
        'movement_priority_missing',
        `bound movement gate ${gateId} is physically stop-controlled but requires priority/uncontrolled movement`,
        { path: `roles.${role.id}.requiredMovementControl`, detail: { roleId: role.id, gateId, siteId: site.siteId } },
      );
    }
  }
}

function materializedSetKey(key: string, path: string): string | null {
  void path;
  return mapSetKey(key);
}

function assertMaterializableRuleControls(template: ScenarioTemplateV2): void {
  for (const interaction of template.choreography.interactions) {
    if (interaction.verb === 'set') {
      materializedSetKey(interaction.target.key, `choreography.interactions.${interaction.id}.target.key`);
    }
  }
}

/** The simulation contract now carries the authoring class directly instead
 * of collapsing it to the old two motion families. */
export function actorKindForClass(actorClass: ActorClass): SimActor['kind'] {
  return actorClass;
}

function supportsDriverProfile(actorClass: ActorClass): boolean {
  return !['pedestrian', 'sidewalk_robot', 'drone', 'animal', 'static_object'].includes(actorClass);
}

/* ------------------------------------------------------------------ scopes */

function laneScope(bundle: MapBundle, laneRsl: string | undefined): ExprScope['lane'] {
  const lane = laneRsl ? bundle.index.lanes[laneRsl] : undefined;
  return {
    speedLimitKph: lane?.speedLimitKph,
    widthM: lane?.representativeWidthM,
  };
}

function junctionScope(bundle: MapBundle, site: MatchedSite): ExprScope['junction'] {
  const id = site.frame.origin.mapFeatureId.startsWith('junction:')
    ? site.frame.origin.mapFeatureId.slice('junction:'.length)
    : null;
  const descriptor = id ? bundle.index.junctionDescriptors[id] : undefined;
  return { sizeM: descriptor?.sizeM };
}

/* ------------------------------------------------------------------ routes */

/**
 * Build a sim-engine route from a matcher lane chain.
 *
 * The two packages verify lane adjacency with different tolerances, so a chain
 * the matcher accepted can fail here. Rather than reject the whole site we keep
 * the longest connectable run that still contains `mustInclude` — the actor
 * gets a shorter route, the runway guard reports it, and the failure surfaces
 * as a measurable finding instead of an unbindable template.
 */
function routeFromChain(
  graph: LaneGraph,
  lanes: readonly string[],
  mustInclude: string | undefined,
  notes: Note[],
  path: string,
): Route | null {
  if (lanes.length === 0) return null;
  const full = buildLanePathRoute(graph, lanes);
  if (full.ok) return full.route;

  const anchorIndex = mustInclude ? lanes.indexOf(mustInclude) : 0;
  const pivot = anchorIndex >= 0 ? anchorIndex : 0;
  let best: Route | null = null;
  let bestLen = 0;
  for (let from = 0; from <= pivot; from += 1) {
    for (let to = lanes.length; to > pivot; to -= 1) {
      const slice = lanes.slice(from, to);
      if (slice.length === 0) continue;
      const built = buildLanePathRoute(graph, slice);
      if (built.ok && built.route.lengthM > bestLen) {
        best = built.route;
        bestLen = built.route.lengthM;
      }
    }
  }
  if (best) {
    notes.push({
      path,
      reason: `lane chain was not connectable end to end for the engine; kept the longest connectable run (${bestLen.toFixed(1)} m of ${lanes.length} lanes)`,
    });
    return best;
  }
  notes.push({ path, reason: `no connectable lane chain: ${full.error.reason}` });
  return null;
}

/**
 * Extend a lane chain **backwards** until the route actually contains `target`.
 *
 * The target is always inside the site's frame — the matcher rejects a site
 * whose reference path cannot hold the template's actors, and `buildActor`
 * refuses a station outside it. What is *not* guaranteed is that the actor's own
 * lane chain reaches that far: a lateral or opposing lane can start later than
 * the reference path does, and a chain built from it then begins downstream of
 * the actor's station.
 *
 * So the materializer checks its own work: if the target point projects onto an
 * endpoint of the route rather than into its interior, the chain is too short
 * and gets a predecessor prepended, up to `MAX_BACKWARD_STEPS` times.
 */
const MAX_BACKWARD_STEPS = 12;
/** A projection this close to either end of a route is a clamp, not a hit. */
const ENDPOINT_CLAMP_M = 1;
const LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M = 12;
/** A point geometrically on a matched lane endpoint is an authored station,
 * not the ambiguous far-away clamp that the endpoint guard rejects. */
const CONSTRAINED_ENDPOINT_EXACT_HIT_M = 0.25;

/**
 * Failures that mean "the author named a lane this site does not have".
 *
 * They are singled out because several call sites wrap pose resolution in a
 * best-effort `try`/`continue` — correct for a repeat that walks off the end of
 * the frame, catastrophic for a lane offset, which is a statement about the
 * cross-section the scenario needs rather than about how far along it reaches.
 */
const LANE_OFFSET_ERROR_CODES: ReadonlySet<string> = new Set([
  'lane_offset_unavailable',
  'lane_offset_unroutable',
]);

function coverTarget(
  bundle: MapBundle,
  lanes: readonly string[],
  target: { x: number; y: number },
  constrained = false,
  semanticRequirements?: {
    preserveSegment: boolean;
    preserveRoadSection: boolean;
    allowLocalSiblingSelection?: boolean;
    expectedHeadingRad?: number;
    maxHeadingErrorRad?: number;
  },
): {
  lanes: string[];
  route: Route;
  constrainedProjection?: { routeS: number; laneRsl: string; storageS: number; distanceM: number };
} | null {
  if (constrained) return coverConstrainedTarget(bundle, lanes, target, semanticRequirements);
  let current = [...lanes];
  let route: Route | null = null;
  for (let step = 0; step <= MAX_BACKWARD_STEPS; step += 1) {
    const built = buildLanePathRoute(bundle.graph, current);
    if (!built.ok) break;
    route = built.route;
    const projection = route.projectPoint(target);
    if (
      projection.d <= 12 &&
      projection.s > ENDPOINT_CLAMP_M &&
      projection.s < route.lengthM - ENDPOINT_CLAMP_M
    ) {
      return { lanes: current, route };
    }
    // Prepend a predecessor in the route's *travel direction*. OpenDRIVE's
    // raw predecessor/successor fields describe storage direction; for a
    // positive-id (opposing) lane, legal travel reverses that direction. Using
    // only `lane.predecessors` therefore leaves positive ego-frame stations
    // outside the opposing route and every authored pose.s clamps to its start.
    const first = route.legs[0] as { rsl: string; reversed: boolean } | undefined;
    if (!first) break;
    const geometry = bundle.graph.geometry(first.rsl);
    if (!geometry) break;
    const neighbours = [...new Set([
      ...(geometry.lane.predecessors ?? []),
      ...(geometry.lane.successors ?? []),
    ])].filter((rsl) => !current.includes(rsl) && bundle.graph.geometry(rsl));
    const entryHeading = bundle.graph.sampleDirected(first, 0).headingRad;
    const candidates: Array<{ rsl: string; reversed: boolean; turn: number }> = [];
    for (const rsl of neighbours) {
      const nominal = bundle.graph.nominalReversed(rsl);
      for (const reversed of nominal === null ? [false, true] : [nominal]) {
        const directed = { rsl, reversed };
        if (!bundle.graph.successors(directed).some((next) => next.rsl === first.rsl && next.reversed === first.reversed)) continue;
        const exitHeading = bundle.graph.sampleDirected(directed, bundle.graph.lengthOf(rsl)).headingRad;
        const turn = Math.abs(Math.atan2(Math.sin(entryHeading - exitHeading), Math.cos(entryHeading - exitHeading)));
        candidates.push({ rsl, reversed, turn });
      }
    }
    candidates.sort((a, b) => a.turn - b.turn || a.rsl.localeCompare(b.rsl) || Number(a.reversed) - Number(b.reversed));
    const chosen = candidates[0];
    if (!chosen) break;
    const candidate = [chosen.rsl, ...current];
    if (!buildLanePathRoute(bundle.graph, candidate).ok) break;
    current = candidate;
  }
  return route ? { lanes: current, route } : null;
}

/**
 * Cover a constrained role's frame point without ever leaving its matched
 * movement. Junctions often expose several graph neighbours and the old greedy
 * walk could choose the locally closest branch, then dead-end before reaching
 * the authored station. Search a small deterministic frontier instead. Every
 * added lane must be a directed predecessor/successor of the existing route
 * and continue within 45 degrees, so a nearby perpendicular or generic lane
 * can never satisfy the projection guard.
 */
function coverConstrainedTarget(
  bundle: MapBundle,
  lanes: readonly string[],
  target: { x: number; y: number },
  requirements?: {
    preserveSegment: boolean;
    preserveRoadSection: boolean;
    allowLocalSiblingSelection?: boolean;
    expectedHeadingRad?: number;
    maxHeadingErrorRad?: number;
  },
): {
  lanes: string[];
  route: Route;
  constrainedProjection: { routeS: number; laneRsl: string; storageS: number; distanceM: number };
} | null {
  interface Candidate {
    lanes: string[];
    route: Route;
    projection: { routeS: number; laneRsl: string; storageS: number; distanceM: number };
  }

  const initialBuilt = buildLanePathRoute(bundle.graph, [...lanes]);
  if (!initialBuilt.ok) return null;
  const rawInitialProjection = projectConstrainedRole(bundle.graph, initialBuilt.route, lanes, target);
  if (!rawInitialProjection) return null;
  const headingCompatible = (route: Route, routeS: number): boolean => {
    if (requirements?.expectedHeadingRad === undefined || requirements.maxHeadingErrorRad === undefined) return true;
    const heading = route.poseAt(routeS).headingRad;
    const error = Math.abs(Math.atan2(
      Math.sin(heading - requirements.expectedHeadingRad),
      Math.cos(heading - requirements.expectedHeadingRad),
    ));
    return error <= requirements.maxHeadingErrorRad + 1e-9;
  };
  // Prefer the lane in the matcher-bound chain that already proves the
  // authored direction. On older pinned sites the geometrically nearest leg
  // can be a transition/perpendicular leg while a later leg is the actual
  // semantic carriageway.
  const initialProjection = projectConstrainedRole(
    bundle.graph,
    initialBuilt.route,
    lanes,
    target,
    (_rsl, routeS) => headingCompatible(initialBuilt.route, routeS),
  ) ?? rawInitialProjection;
  const semanticLane = bundle.index.lanes[initialProjection.laneRsl];
  const semanticSegment = bundle.index.factIndex.segmentIdsByLane[initialProjection.laneRsl];
  // A heading relation describes a movement, so route-connected continuation
  // across OpenDRIVE road records is valid as long as its local direction still
  // satisfies that relation. Without a heading relation, retain the matcher's
  // exact segment/road identity because there is no directional proof that a
  // continuation is semantically equivalent.
  const preserveTopologyIdentity = requirements?.expectedHeadingRad === undefined;
  const laneAllowed = (rsl: string): boolean => {
    const lane = bundle.index.lanes[rsl];
    if (!lane) return false;
    // Segment ids are the map index's carriageway-continuity proof. Preserve
    // the segment selected by the matcher even when OpenDRIVE splits it across
    // several road/junction records; this is what rejects a connected loop
    // that returns near the target on a different street.
    if (semanticSegment && bundle.index.factIndex.segmentIdsByLane[rsl] !== semanticSegment) return false;
    if (preserveTopologyIdentity && requirements?.preserveRoadSection && semanticLane &&
      (lane.roadId !== semanticLane.roadId || lane.section !== semanticLane.section)) return false;
    if (preserveTopologyIdentity && requirements?.preserveSegment && semanticSegment &&
      bundle.index.factIndex.segmentIdsByLane[rsl] !== semanticSegment) return false;
    return true;
  };
  const projectionAllowed = (route: Route, rsl: string, routeS: number): boolean => {
    if (!laneAllowed(rsl)) return false;
    return headingCompatible(route, routeS);
  };
  const makeCandidate = (chain: string[]): Candidate | null => {
    const built = buildLanePathRoute(bundle.graph, chain);
    if (!built.ok) return null;
    // Keep walking a connected chain even when an intermediate lane does not
    // yet satisfy the final local-heading predicate. Junction connectors and
    // short transition roads can legitimately sit between two aligned road
    // sections. They may guide the search, but `isCovered` below can never
    // accept them as the actor's semantic spawn lane.
    const projection = projectConstrainedRole(
      bundle.graph,
      built.route,
      chain,
      target,
      (rsl, routeS) => projectionAllowed(built.route, rsl, routeS),
    ) ?? projectConstrainedRole(bundle.graph, built.route, chain, target);
    return projection ? { lanes: chain, route: built.route, projection } : null;
  };
  const extensions = (candidate: Candidate): string[][] => {
    const out: string[][] = [];
    const first = candidate.route.legs[0];
    if (first) {
      const geometry = bundle.graph.geometry(first.rsl);
      const entryHeading = bundle.graph.sampleDirected(first, 0).headingRad;
      const neighbours = geometry
        ? [...new Set([
            ...(geometry.lane.predecessors ?? []),
            ...(geometry.lane.successors ?? []),
          ])]
        : [];
      for (const rsl of neighbours) {
        if (candidate.lanes.includes(rsl) || !bundle.graph.geometry(rsl)) continue;
        if (preserveTopologyIdentity &&
          (requirements?.preserveRoadSection || requirements?.preserveSegment) && !laneAllowed(rsl)) continue;
        const nominal = bundle.graph.nominalReversed(rsl);
        for (const reversed of nominal === null ? [false, true] : [nominal]) {
          const directed = { rsl, reversed };
          if (!bundle.graph.successors(directed).some((next) =>
            next.rsl === first.rsl && next.reversed === first.reversed)) continue;
          const exitHeading = bundle.graph.sampleDirected(directed, bundle.graph.lengthOf(rsl)).headingRad;
          const turn = Math.abs(Math.atan2(
            Math.sin(entryHeading - exitHeading),
            Math.cos(entryHeading - exitHeading),
          ));
          if (turn <= Math.PI / 4) out.push([rsl, ...candidate.lanes]);
        }
      }
    }
    const last = candidate.route.legs.at(-1);
    if (last) {
      const exitHeading = bundle.graph.sampleDirected(last, bundle.graph.lengthOf(last.rsl)).headingRad;
      for (const next of bundle.graph.successors(last)) {
        if (candidate.lanes.includes(next.rsl)) continue;
        if (preserveTopologyIdentity &&
          (requirements?.preserveRoadSection || requirements?.preserveSegment) && !laneAllowed(next.rsl)) continue;
        const entryHeading = bundle.graph.sampleDirected(next, 0).headingRad;
        const turn = Math.abs(Math.atan2(
          Math.sin(entryHeading - exitHeading),
          Math.cos(entryHeading - exitHeading),
        ));
        if (turn <= Math.PI / 4) out.push([...candidate.lanes, next.rsl]);
      }
    }
    return out;
  };
  const isCovered = (candidate: Candidate): boolean => {
    if (!projectionAllowed(candidate.route, candidate.projection.laneRsl, candidate.projection.routeS)) return false;
    if (candidate.projection.distanceM > LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M) return false;
    const interior =
      candidate.projection.routeS > ENDPOINT_CLAMP_M &&
      candidate.projection.routeS < candidate.route.lengthM - ENDPOINT_CLAMP_M;
    return interior || candidate.projection.distanceM <= CONSTRAINED_ENDPOINT_EXACT_HIT_M;
  };
  const rank = (a: Candidate, b: Candidate): number => {
    const aEndpoint = Math.min(a.projection.routeS, a.route.lengthM - a.projection.routeS);
    const bEndpoint = Math.min(b.projection.routeS, b.route.lengthM - b.projection.routeS);
    return a.projection.distanceM - b.projection.distanceM ||
      bEndpoint - aEndpoint ||
      a.lanes.join('|').localeCompare(b.lanes.join('|'));
  };

  const initial = makeCandidate([...lanes]);
  if (!initial) return null;
  let frontier = [initial];
  const seen = new Set([initial.lanes.join('|')]);
  for (let step = 0; step <= MAX_BACKWARD_STEPS; step += 1) {
    const covered = frontier.filter(isCovered).sort(rank)[0];
    if (covered) {
      return {
        lanes: covered.lanes,
        route: covered.route,
        constrainedProjection: covered.projection,
      };
    }
    const next: Candidate[] = [];
    for (const candidate of frontier) {
      for (const chain of extensions(candidate)) {
        const key = chain.join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const built = makeCandidate(chain);
        if (built) next.push(built);
      }
    }
    // Real junctions can fan out. A bounded beam keeps the search cheap while
    // retaining alternatives that either reduce lateral distance or move the
    // projection away from a clamped endpoint.
    frontier = next.sort(rank).slice(0, 24);
    if (frontier.length === 0) break;
  }

  // Some pinned scenario sites predate full opposing-chain coverage. Recover
  // only the exact sibling carriageway at the authored station: first identify
  // the road section geometrically containing the frame point, then consider
  // lanes on that same OpenDRIVE road/section whose directed heading satisfies
  // the authored opposing relation. This is deliberately not a generic
  // nearest-lane fallback and therefore cannot jump to a crossing street.
  if (requirements?.allowLocalSiblingSelection &&
    requirements.expectedHeadingRad !== undefined &&
    requirements.maxHeadingErrorRad !== undefined) {
    let reference: { rsl: string; distanceM: number } | null = null;
    for (const rsl of Object.keys(bundle.index.lanes)) {
      const projection = bundle.graph.projectOnto(rsl, target);
      if (!projection) continue;
      if (!reference || projection.d < reference.distanceM) {
        reference = { rsl, distanceM: projection.d };
      }
    }
    const referenceLane = reference ? bundle.index.lanes[reference.rsl] : undefined;
    if (referenceLane) {
      const siblings: Candidate[] = [];
      for (const [rsl, lane] of Object.entries(bundle.index.lanes)) {
        if (lane.roadId !== referenceLane.roadId || lane.section !== referenceLane.section) continue;
        const built = buildLanePathRoute(bundle.graph, [rsl]);
        if (!built.ok) continue;
        const projection = projectConstrainedRole(bundle.graph, built.route, [rsl], target);
        if (!projection || projection.distanceM > LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M) continue;
        if (!headingCompatible(built.route, projection.routeS)) continue;
        siblings.push({ lanes: [rsl], route: built.route, projection });
      }
      const sibling = siblings.filter((candidate) =>
        (candidate.projection.routeS > ENDPOINT_CLAMP_M &&
          candidate.projection.routeS < candidate.route.lengthM - ENDPOINT_CLAMP_M) ||
        candidate.projection.distanceM <= CONSTRAINED_ENDPOINT_EXACT_HIT_M,
      ).sort(rank)[0];
      if (sibling) {
        return {
          lanes: sibling.lanes,
          route: sibling.route,
          constrainedProjection: sibling.projection,
        };
      }
    }
  }
  return null;
}

/**
 * Project a structurally constrained role onto the same local lane that the
 * matcher used to enforce its segment/road/heading requirements.
 *
 * A route can later turn back near the authored frame point. Projecting over
 * the whole route can therefore move an actor from its bound local lane onto a
 * geometrically-near future leg (for example, an oncoming car onto a
 * perpendicular road after a junction). The matcher deliberately compares
 * every lane in the bound chain and selects the nearest lane. Repeat that
 * operation here, then translate the winning lane-local storage station into
 * route arc length.
 */
function projectConstrainedRole(
  graph: LaneGraph,
  route: Route,
  lanes: readonly string[],
  target: { x: number; y: number },
  allowed: (rsl: string, routeS: number) => boolean = () => true,
): { routeS: number; laneRsl: string; storageS: number; distanceM: number } | null {
  let best: { rsl: string; storageS: number; distance: number } | null = null;
  for (const rsl of lanes) {
    if (!route.includesLane(rsl)) continue;
    const projection = graph.projectOnto(rsl, target);
    if (!projection) continue;
    const routeS = route.sOfLaneStorage(rsl, projection.s);
    if (routeS === null || !allowed(rsl, routeS)) continue;
    if (!best || projection.d < best.distance) {
      best = { rsl, storageS: projection.s, distance: projection.d };
    }
  }
  if (!best) return null;
  const routeS = route.sOfLaneStorage(best.rsl, best.storageS);
  return routeS === null
    ? null
    : { routeS, laneRsl: best.rsl, storageS: best.storageS, distanceM: best.distance };
}

/**
 * Walk successors until `needM` metres of route exist past `fromS`.
 *
 * The matcher stops walking at its own run-up constant (150 m) because it only
 * needs enough road to place a role and to score a corridor. A 20-second clip at
 * 55 kph covers 305 m, so a route that ends where the matcher stopped looking
 * makes `runway_insufficient` fire on a site that is perfectly fine — the road
 * carries on, nobody walked it. Extending here (deterministically: straightest
 * continuation, ties broken by `rsl`) is the materializer's job, because it is
 * the only layer that knows both the clip length and the actor's speed.
 */
function extendChainForward(
  graph: LaneGraph,
  lanes: readonly string[],
  route: Route,
  fromS: number,
  needM: number,
): string[] {
  let have = route.lengthM - fromS;
  if (have >= needM || route.legs.length === 0) return [...lanes];
  const out = [...lanes];
  const seen = new Set(out);
  let current = route.legs[route.legs.length - 1] as { rsl: string; reversed: boolean };
  for (let step = 0; step < 64 && have < needM; step += 1) {
    const options = graph
      .successors(current)
      .filter((next) => !seen.has(next.rsl) && graph.geometry(next.rsl));
    if (options.length === 0) break;
    const exitHeading = graph.sampleDirected(current, graph.lengthOf(current.rsl)).headingRad;
    const straightness = (candidate: { rsl: string; reversed: boolean }): number => {
      const entry = graph.sampleDirected(candidate, 0).headingRad;
      const d = Math.abs(Math.atan2(Math.sin(entry - exitHeading), Math.cos(entry - exitHeading)));
      return d;
    };
    options.sort((a, b) => straightness(a) - straightness(b) || (a.rsl < b.rsl ? -1 : 1));
    const next = options[0] as { rsl: string; reversed: boolean };
    out.push(next.rsl);
    seen.add(next.rsl);
    have += graph.lengthOf(next.rsl);
    current = next;
  }
  return out;
}

/** Prepend legal, geometrically connected predecessors until an arrival-solved
 * actor has enough route before its conflict point. Matcher chains are sized
 * for structural binding, not temporal solving; at large junctions they can
 * begin only a few metres before the conflict, making a truthful positive
 * arrival offset impossible even though the approach continues upstream. */
function extendChainBackward(
  graph: LaneGraph,
  lanes: readonly string[],
  conflictPoint: { x: number; y: number },
  needM: number,
): string[] {
  let out = [...lanes];
  const seen = new Set(out);
  for (let step = 0; step < 64; step += 1) {
    const built = buildLanePathRoute(graph, out);
    if (!built.ok || built.route.projectPoint(conflictPoint).s >= needM || built.route.legs.length === 0) break;
    const first = built.route.legs[0] as { rsl: string; reversed: boolean };
    const geometry = graph.geometry(first.rsl);
    if (!geometry) break;
    const neighbours = [...new Set([
      ...(geometry.lane.predecessors ?? []),
      ...(geometry.lane.successors ?? []),
    ])].filter((rsl) => !seen.has(rsl) && graph.geometry(rsl));
    const entryHeading = graph.sampleDirected(first, 0).headingRad;
    const candidates: Array<{ rsl: string; reversed: boolean; turn: number }> = [];
    for (const rsl of neighbours) {
      const nominal = graph.nominalReversed(rsl);
      for (const reversed of nominal === null ? [false, true] : [nominal]) {
        const directed = { rsl, reversed };
        if (!graph.successors(directed).some((next) => next.rsl === first.rsl && next.reversed === first.reversed)) continue;
        const exitHeading = graph.sampleDirected(directed, graph.lengthOf(rsl)).headingRad;
        const turn = Math.abs(Math.atan2(Math.sin(entryHeading - exitHeading), Math.cos(entryHeading - exitHeading)));
        candidates.push({ rsl, reversed, turn });
      }
    }
    candidates.sort((a, b) => a.turn - b.turn || a.rsl.localeCompare(b.rsl) || Number(a.reversed) - Number(b.reversed));
    const chosen = candidates[0];
    if (!chosen) break;
    const candidate = [chosen.rsl, ...out];
    if (!buildLanePathRoute(graph, candidate).ok) break;
    out = candidate;
    seen.add(chosen.rsl);
  }
  return out;
}

/* ------------------------------------------------------------ verb helpers */

function evalNum(
  value: NumberOrExpr | undefined,
  scope: ExprScope,
  path: string,
  fallback?: number,
): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new CliError('missing_value', 'a required numeric value is absent', { path });
  }
  try {
    return evaluateExpr(value as Expr | number, scope);
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new CliError('expression_unresolvable', `${error instanceof Error ? error.message : String(error)}`, {
      path,
      detail: { expression: isExpr(value) ? 'expr' : String(value) },
    });
  }
}

function evalTFrac(
  value: NumberOrExpr | undefined,
  scope: ExprScope,
  path: string,
  fallback = 0,
): number {
  const t = evalNum(value, scope, path, fallback);
  if (!Number.isFinite(t)) return fallback;
  return Math.max(-1, Math.min(1, t));
}

const CMP: Record<string, 'lte' | 'gte'> = { '<': 'lte', '<=': 'lte', '>': 'gte', '>=': 'gte' };

/**
 * Reject a stale or externally supplied site before it can produce an engine
 * document with interactions/occlusion declarations that reference an actor
 * the matcher did not bind. Normal matching already excludes these sites; this
 * boundary check keeps catalog replays and cached sites equally safe.
 */
export function assertRequiredRoleBindings(
  template: ScenarioTemplateV2,
  site: Pick<MatchedSite, 'bindings'>,
): void {
  const bindingByRole = new Map(site.bindings.map((binding) => [binding.role, binding]));
  for (const role of template.roles) {
    if (role.essentiality !== 'required') continue;
    const binding = bindingByRole.get(role.id);
    if (!binding || binding.status === 'failed' || binding.status === 'dropped') {
      throw new CliError('role_unbound', `required role "${role.id}" did not bind at this site`, {
        path: `roles.${role.id}`,
        detail: {
          status: binding?.status ?? 'missing',
          notes: binding?.notes ?? ['no matcher binding for this role'],
        },
        exitCode: 2,
      });
    }
  }
}

/**
 * Lateral clearance kept each side of the widest vehicle passing a closure, metres.
 *
 * MUTCD shy distance is 2 ft (0.6 m) from channelizing devices, which with a 1.82 m car gives a
 * 3.02 m running lane -- the same order as the 10 ft (3.0 m) minimum work-zone lane width. This is
 * the standard, not a number tuned until the probe passed: at 0.35 m the corridor was 2.52 m and
 * 7/56 cells still made contact.
 */
const CLOSURE_SIDE_CLEARANCE_M = 0.6;
/** Below this, a closure takes so little of the lane that it is not worth calling one. */
const CLOSURE_MIN_USEFUL_M = 0.4;
/** An actor needs at least this much road before the taper to shift onto the open corridor. */
const CLOSURE_MIN_APPROACH_M = 20;

/** Catalog id per channelizing device kind. The author names a kind, never an asset. */
const CLOSURE_DEVICE_CATALOG: Record<'cone' | 'drum' | 'barricade' | 'barrier', string> = {
  cone: 'construction.traffic_cone',
  drum: 'construction.channelizer_drum',
  barricade: 'construction.barricade_type3',
  barrier: 'construction.jersey_barrier_run',
};

/**
 * MUTCD merging-taper length, metres. `L = W·S²/60` below 40 mph, `L = W·S` at or above, with W in
 * feet and S in mph. Solver-owned geometry: a work zone's taper is a consequence of the design
 * speed and the width taken, not an authoring choice.
 */
function mutcdTaperLengthM(speedKph: number, offsetM: number): number {
  const mph = speedKph / 1.609;
  const widthFt = offsetM * 3.281;
  const lengthFt = mph < 40 ? (widthFt * mph * mph) / 60 : widthFt * mph;
  return Math.max(15, lengthFt / 3.281);
}

/** Solved geometry for one closure, shared by its devices, its detour and the engine override. */
interface ClosurePlan {
  readonly id: string;
  readonly laneOffset: number;
  readonly fromS: number;
  readonly toS: number;
  readonly taperStartS: number;
  readonly advanceM: number;
  /** Lateral centre of the remaining drivable corridor, metres from the lane centreline. */
  readonly openCentre: number;
  readonly openWidth: number;
  readonly closedWidth: number;
  readonly side: 'left' | 'right';
  readonly shiftTraffic: boolean;
}

/* ------------------------------------------------------------- the builder */

class Materializer {
  private readonly notes: Note[] = [];
  private readonly actors: SimActor[] = [];
  private readonly interactions: SimInteraction[] = [];
  private readonly props: StaticProp[] = [];
  /** Devices solved from `template.closures`; expanded alongside authored props. */
  private readonly generatedClosureProps: PropPlacementInput[] = [];
  /** Solved geometry per closure: shared by the device layout, the detour and the engine override. */
  private readonly closurePlans: ClosurePlan[] = [];
  private readonly occluders: Occluder[] = [];
  private readonly occlusionPairs: OcclusionPair[] = [];
  private readonly nearMissCriteria: NearMissCriterion[] = [];
  private readonly bindingByRole = new Map<string, FeatureBinding>();
  private readonly roleById = new Map<string, V2Role>();
  private readonly routeByRole = new Map<string, Route>();
  private readonly laneByRole = new Map<string, string | undefined>();
  private readonly spawnSByRole = new Map<string, number>();
  private readonly scopeByRole = new Map<string, ExprScope>();
  private readonly initialRules = new Map<string, Record<string, boolean | number>>();
  private readonly foldedInteractions = new Set<string>();
  private readonly foldedTriggerStart = new Map<string, number>();
  private readonly initialInteractionOutcomes: InitialInteractionOutcome[] = [];
  private signalPlan: SiteSignalPlan | null = null;
  private compiledMapSignalPrograms: readonly SignalProgram[] | null = null;
  private roadControls: RoadControl[] = [];
  private readonly authoredControlPrograms: SignalProgram[] = [];
  private refRoute: Route | null = null;

  constructor(
    private readonly template: ScenarioTemplateV2,
    private readonly bundle: MapBundle,
    private readonly site: MatchedSite,
    private readonly draw: ParamDraw,
  ) {
    for (const binding of site.bindings) this.bindingByRole.set(binding.role, binding);
    for (const role of template.roles) this.roleById.set(role.id, role);
  }

  private baseScope(laneRsl?: string): ExprScope {
    return {
      params: this.draw.values,
      clip: { seconds: this.template.choreography.clipSeconds },
      lane: laneScope(this.bundle, laneRsl ?? this.site.frame.entryLaneRsl),
      junction: junctionScope(this.bundle, this.site),
    };
  }

  /** Optional role-local frame origin supplied through the v2 extension seam. */
  private placementFeatureOffset(roleId: string, path: string): number {
    const raw = this.roleById.get(roleId)?.extensions?.['placementFeature'];
    if (raw === undefined) return 0;
    if (typeof raw !== 'string') {
      this.notes.push({ path, reason: 'placementFeature must be a feature id string; using frame origin' });
      return 0;
    }
    const match = this.site.featureMatches[raw];
    if (!match) {
      this.notes.push({ path, reason: `placementFeature "${raw}" is not bound at this site; using frame origin` });
      return 0;
    }
    return match.s;
  }

  /** Evaluate a role's authored frame station for this concrete draw. Matcher
   * bindings carry the default/static station; relative-role parameter draws
   * must be re-applied here, including chained queue placements. */
  private sampledFrameS(role: V2Role, binding: FeatureBinding, seen = new Set<string>()): number {
    if (seen.has(role.id)) {
      throw new CliError('role_reference_cycle', `relative role cycle reaches "${role.id}"`, {
        path: `roles.${role.id}.ref`,
        exitCode: 2,
      });
    }
    const nextSeen = new Set(seen).add(role.id);
    const scope = this.scopeByRole.get(role.id) ?? this.baseScope(binding.laneRsl);
    if (role.kind === 'relative_to') {
      const refRole = this.roleById.get(role.ref);
      const refBinding = this.bindingByRole.get(role.ref);
      if (!refRole || !refBinding) return binding.pose?.s ?? 0;
      // Feature-bound roles such as `in_parking_zone` store lane-local s in
      // their matcher binding. Reusing that value as an anchor-frame station
      // places a relative actor near the start of the corridor instead of by
      // its referenced parked vehicle. Once the reference actor exists, its
      // concrete world pose is the authoritative bridge back into the anchor
      // frame (and also preserves the exact selected parking slot).
      const refActor = this.actors.find((actor) => actor.id === role.ref);
      const refFrameS = refActor && this.refRoute
        ? this.site.frame.sRange[0] + this.refRoute.projectPoint({
            x: refActor.initial.pose.x,
            y: -refActor.initial.pose.z,
          }).s
        : this.sampledFrameS(refRole, refBinding, nextSeen);
      return refFrameS +
        evalNum(role.dsM, scope, `roles.${role.id}.dsM`, 0);
    }
    const pose = rolePose(role);
    return pose
      ? this.placementFeatureOffset(role.id, `roles.${role.id}.extensions.placementFeature`) +
          evalNum(pose.s, scope, `roles.${role.id}.pose.s`, 0)
      : (binding.pose?.s ?? 0);
  }

  /** Frame arc length → world point on the reference path. */
  private framePoint(s: number): { x: number; y: number; headingRad: number } {
    const route = this.refRoute;
    if (!route) throw new CliError('reference_route_unbuildable', 'the site has no drivable reference path', {
      path: `site.${this.site.siteId}`,
    });
    const pose = route.poseAt(s - this.site.frame.sRange[0]);
    return { ...pose.point, headingRad: pose.headingRad };
  }

  /**
   * Signed lateral offset in metres from the lane centreline, positive to the left.
   *
   * Two authored forms, one result:
   *
   * - `tFrac`    — a fraction of local lane width. Portable, but bounded to [-1, 1], so every
   *                position it can express is ON the carriageway.
   * - `lateralM` — metres from a NAMED reference, which is what makes the roadside addressable
   *                without baking in a coordinate:
   *      `lane_centre`  from this lane's centreline;
   *      `lane_edge`    outward from this lane's nearer edge;
   *      `verge`        outward from the far edge of the outermost same-direction lane on that
   *                     side, i.e. from the edge of the carriageway itself.
   *
   * The side is carried by the sign of `lateralM`, so a single number says both how far and which
   * way. `verge` is the form a roadside occluder needs: with `tFrac` alone a hedge lands at the
   * same lateral position as the VRU it is supposed to hide (`OCCLUSION-FINDING.md`).
   */
  private resolveLateral(pose: FramePose, scope: ExprScope, path: string, laneWidth: number): number {
    if (pose.lateralM === undefined) {
      return evalTFrac(pose.tFrac, scope, `${path}.tFrac`, 0) * laneWidth;
    }
    const metres = evalNum(pose.lateralM, scope, `${path}.lateralM`, 0);
    const side = metres === 0 ? 1 : Math.sign(metres);
    switch (pose.lateralRef) {
      case 'lane_edge':
        return side * (laneWidth / 2) + metres;
      case 'verge':
        return side * this.carriagewayHalfWidth(side, laneWidth) + metres;
      default:
        return metres;
    }
  }

  /**
   * Distance from the reference lane's centreline to the outer edge of the carriageway on one
   * side, metres. Half the reference lane, plus the full width of every same-direction lane
   * between it and the outside. A site with no lane on that side is simply half a lane wide, which
   * is the correct answer for a single-lane corridor.
   */
  private carriagewayHalfWidth(side: number, laneWidth: number): number {
    let width = laneWidth / 2;
    const lanes = this.site.frame.lateralLanes;
    for (const key of Object.keys(lanes)) {
      const k = Number(key);
      if (k === 0 || Math.sign(k) !== side) continue;
      const rsl = lanes[k];
      width += (rsl ? this.bundle.index.lanes[rsl]?.representativeWidthM : undefined) ?? laneWidth;
    }
    return width;
  }

  /** Representative width of the reference lane, metres. Used to convert fractional drift. */
  private referenceLaneWidth(): number {
    return this.bundle.index.lanes[this.site.frame.entryLaneRsl]?.representativeWidthM ?? 3.5;
  }

  /** Resolve a full frame pose, including laneOffset and tFrac, into xodr-local metres. */
  private framePosePoint(
    pose: FramePose,
    scope: ExprScope,
    path: string,
    frameSOffset = 0,
  ): { x: number; y: number; headingRad: number } {
    const frameS = frameSOffset + evalNum(pose.s, scope, `${path}.s`, 0);
    const center = this.framePoint(frameS);
    let route = this.refRoute;
    if (!route) throw new CliError('reference_route_unbuildable', 'the site has no drivable reference path', { path });
    let routeS = frameS - this.site.frame.sRange[0];
    if (pose.laneOffset !== 0) {
      const semanticRoute = [...this.routeByRole.entries()]
        .filter(([roleId, candidate]) => {
          const role = this.roleById.get(roleId);
          return !candidate.isFreeform && role !== undefined && rolePose(role)?.laneOffset === pose.laneOffset;
        })
        .map(([, candidate]) => candidate)
        .sort((a, b) => a.projectPoint(center).d - b.projectPoint(center).d)[0];
      const rsl = this.site.frame.lateralLanes[pose.laneOffset];
      if (semanticRoute) {
        route = semanticRoute;
        routeS = route.projectPoint({ x: center.x, y: center.y }).s;
      } else if (!rsl) {
        // Falling back to the reference lane here is the silent-relocation
        // defect in its purest form: a prop, route vertex, arrival trigger or
        // `at.pose` invariant authored one lane over lands in the *reference*
        // lane instead, and nothing downstream can tell that it moved. The
        // scenario then measures a station it never described — and on the
        // one-lane corridors that dominate these maps, an actor authored
        // beside the ego is placed inside it. A lane the site does not have is
        // a site that cannot render this scenario.
        throw new CliError(
          'lane_offset_unavailable',
          `no lane at lane offset ${pose.laneOffset} at this site`,
          {
            path: `${path}.laneOffset`,
            detail: {
              siteId: this.site.siteId,
              requestedK: pose.laneOffset,
              availableK: Object.keys(this.site.frame.lateralLanes).map(Number).sort((a, b) => a - b),
              hint: 'require corridor.throughLanesSameDir so only sites wide enough to hold this pose are matched',
            },
            exitCode: 2,
          },
        );
      } else {
        const built = routeFromChain(this.bundle.graph, [rsl], rsl, this.notes, `${path}.laneOffset`);
        if (!built) {
          // The lane is in the cross-section but is not drivable as a route,
          // so its stations do not exist either. Same rule: say so.
          throw new CliError(
            'lane_offset_unroutable',
            `lane offset ${pose.laneOffset} resolves to ${rsl}, which has no drivable route at this site`,
            {
              path: `${path}.laneOffset`,
              detail: { siteId: this.site.siteId, requestedK: pose.laneOffset, laneRsl: rsl },
              exitCode: 2,
            },
          );
        }
        route = built;
        routeS = built.projectPoint({ x: center.x, y: center.y }).s;
      }
    }
    const laneWidth = route.widthAt(routeS) ?? this.bundle.index.lanes[this.site.frame.entryLaneRsl]?.representativeWidthM ?? 3.5;
    const at = route.poseAt(routeS);
    const lateral = this.resolveLateral(pose, scope, path, laneWidth);
    return {
      x: at.point.x - Math.sin(at.headingRad) * lateral,
      y: at.point.y + Math.cos(at.headingRad) * lateral,
      headingRad: at.headingRad + pose.headingOffsetRad,
    };
  }

  private buildReferenceRoute(): void {
    if (this.template.roles.every((role) => role.kind === 'scene_absolute')) {
      const first = this.template.roles[0];
      if (!first || first.kind !== 'scene_absolute') {
        throw new CliError('no_actors', 'map-bound scenario has no actors', { path: 'roles' });
      }
      const rsl = first.laneRef
        ? `${first.laneRef.roadId}:${first.laneRef.section}:${first.laneRef.laneId}`
        : null;
      if (rsl) {
        const built = buildFollowRoute(this.bundle.graph, rsl, [], 2_000);
        if (!built.ok) throw new CliError(built.error.code, built.error.reason, { path: `roles.${first.id}.laneRef`, detail: built.error.detail });
        this.refRoute = built.route;
      } else {
        const p = first.pose.position;
        const h = first.pose.headingRad;
        this.refRoute = Route.fromPolyline([
          { x: p.x, y: -p.z },
          { x: p.x + Math.cos(h) * 2_000, y: -p.z + Math.sin(h) * 2_000 },
        ]);
      }
      return;
    }
    const lanes = this.site.frame.referencePath.map((span) => span.laneRsl);
    this.refRoute = routeFromChain(
      this.bundle.graph,
      lanes,
      this.site.frame.entryLaneRsl,
      this.notes,
      'site.frame.referencePath',
    );
    if (!this.refRoute) {
      throw new CliError('reference_route_unbuildable', 'the site reference path is not drivable', {
        path: 'site.frame.referencePath',
        detail: { lanes },
      });
    }
  }

  /* --------------------------------------------------------------- actors */

  private buildActors(): void {
    for (const role of this.template.roles) {
      const binding = this.bindingByRole.get(role.id);
      if (!binding) {
        if (role.essentiality === 'required') {
          throw new CliError('role_binding_missing', `required role "${role.id}" has no matcher binding`, {
            path: `roles.${role.id}`,
            detail: { siteId: this.site.siteId },
            exitCode: 2,
          });
        }
        this.notes.push({ path: `roles.${role.id}`, reason: 'no matcher binding for this role' });
        continue;
      }
      if (binding.status === 'dropped') {
        if (role.essentiality === 'required') {
          throw new CliError('role_binding_dropped', `required role "${role.id}" was dropped by the matcher`, {
            path: `roles.${role.id}`,
            detail: { notes: binding.notes, siteId: this.site.siteId },
            exitCode: 2,
          });
        }
        this.notes.push({
          path: `roles.${role.id}`,
          reason: `role dropped by the matcher: ${binding.notes.join('; ')}`,
        });
        continue;
      }
      if (binding.status === 'failed') {
        if (role.essentiality === 'required') {
          throw new CliError('role_unbound', `required role "${role.id}" did not bind at this site`, {
            path: `roles.${role.id}`,
            detail: { notes: binding.notes },
            exitCode: 2,
          });
        }
        this.notes.push({
          path: `roles.${role.id}`,
          reason: `role unbound and dropped (${role.essentiality}): ${binding.notes.join('; ')}`,
        });
        continue;
      }
      const actor = this.buildActor(role, binding);
      if (actor) this.actors.push(actor);
    }
    if (this.actors.length === 0) {
      throw new CliError('no_actors', 'no role produced an actor at this site', {
        path: 'roles',
        exitCode: 2,
      });
    }
  }

  /**
   * A lane-drop `changeLane` is not licensed merely because both actors found
   * some nearby route.  The disappearing lane must be the lane named by the
   * matched taper and it must have a directed, legal continuation onto the
   * target actor's route.  This prevents a projection onto a neighbouring
   * junction branch from being presented as a late merge.
   */
  private assertTerminatingLaneMergeClosure(): void {
    for (const role of this.template.roles) {
      const feature = role.extensions?.['terminatingLaneFeature'];
      if (typeof feature !== 'string') continue;
      const merge = this.template.choreography.interactions.find((item) =>
        item.actor === role.id && item.verb === 'changeLane' && 'mode' in item.target && item.target.mode === 'toRole');
      if (!merge || !('mode' in merge.target) || merge.target.mode !== 'toRole') continue;
      const matched = this.site.featureMatches[feature];
      const prefix = typeof matched?.mapFeatureId === 'string' ? matched.mapFeatureId.match(/^lane_drop:([^@]+)@/) : null;
      const terminatingRsl = prefix?.[1];
      const source = this.routeByRole.get(role.id);
      const target = this.routeByRole.get(merge.target.role);
      const sourceLanes = new Set(source?.legs.map((leg) => leg.rsl) ?? []);
      const targetLanes = new Set(target?.legs.map((leg) => leg.rsl) ?? []);
      const targetRole = this.roleById.get(merge.target.role);
      const structurallyBoundPair = role.kind === 'at_lane_drop' && role.lane === 'terminating' &&
        targetRole?.kind === 'at_lane_drop' && targetRole.lane === 'continuing_sibling' &&
        role.feature === feature && targetRole.feature === feature;
      const closes = terminatingRsl !== undefined && sourceLanes.has(terminatingRsl) && (
        structurallyBoundPair ||
        [...this.bundle.graph.successors({ rsl: terminatingRsl, reversed: this.bundle.graph.nominalReversed(terminatingRsl) ?? false })]
          .some((next) => targetLanes.has(next.rsl)));
      if (!closes) {
        throw new CliError('terminating_lane_merge_unclosed',
          `terminating role "${role.id}" does not reach the target route at mapped ${feature}`,
          { path: `roles.${role.id}.extensions.terminatingLaneFeature`, detail: {
            siteId: this.site.siteId, terminatingRsl, sourceLanes: [...sourceLanes], targetRole: merge.target.role,
            targetLanes: [...targetLanes],
          }, exitCode: 2 });
      }
    }
  }

  private buildActor(role: V2Role, binding: FeatureBinding): SimActor | null {
    const path = `roles.${role.id}`;
    const scope = this.baseScope(binding.laneRsl);
    this.scopeByRole.set(role.id, scope);

    // An actor's semantic class and its catalog model must describe the same
    // kind of thing. A measured clip in this repo reads class:animal with
    // catalog:pedestrian.adult_walking — the trajectory is an animal's and the
    // model is a walking human, which passes every trajectory- and render-based
    // check because only the catalog id can see it. Same defect as an
    // unresolvable id silently becoming a sedan, so the rule is stated for
    // every class. (`ActorSpecSchema` in scenario-model is the better long-term
    // home — it would fail at `template validate` — but reaching the catalog
    // from there needs a new workspace dependency.)
    const catalogMismatch = role.actor.catalogId === undefined
      ? null
      : actorCatalogMismatch(role.actor.class, role.actor.catalogId);
    if (catalogMismatch !== null) {
      throw new CliError('actor_catalog_class_mismatch', `role "${role.id}": ${catalogMismatch}`, {
        path: `${path}.actor.catalogId`,
        detail: { roleId: role.id, actorClass: role.actor.class, catalogId: role.actor.catalogId },
        exitCode: 2,
      });
    }
    // The catalog model's own footprint, when the template did not override it:
    // `ActorSpecSchema.dims` is documented as "overriding the catalog model's
    // own", which only means anything if the catalog's dims are used otherwise.
    const dims = role.actor.dims
      ?? (role.actor.catalogId === undefined ? null : catalogActorDims(role.actor.catalogId))
      ?? DEFAULT_ACTOR_DIMS[role.actor.class];
    const kind = actorKindForClass(role.actor.class);

    if (role.kind === 'scene_absolute') {
      const speedMps = Math.max(0, evalNum(role.initialSpeedKph, scope, `${path}.initialSpeedKph`, 0) * KPH_TO_MPS);
      const authoredSpeedCeilingMps = this.template.choreography.interactions.reduce((ceiling, interaction) => {
        if (interaction.actor !== role.id || interaction.verb !== 'speed') return ceiling;
        if (interaction.target.mode === 'absolute') return Math.max(ceiling, evalNum(interaction.target.valueKph, scope, `choreography.${interaction.id}.target.valueKph`) * KPH_TO_MPS);
        if (interaction.target.mode === 'delta') return Math.max(ceiling, speedMps + evalNum(interaction.target.deltaKph, scope, `choreography.${interaction.id}.target.deltaKph`) * KPH_TO_MPS);
        if (interaction.target.mode === 'factor') return Math.max(ceiling, speedMps * evalNum(interaction.target.factor, scope, `choreography.${interaction.id}.target.factor`));
        return ceiling;
      }, speedMps);
      const rsl = role.laneRef
        ? `${role.laneRef.roadId}:${role.laneRef.section}:${role.laneRef.laneId}`
        : null;
      let route: Route;
      let routeSpec: SimActor['behavior']['route'];
      let laneRef: SimActor['initial']['laneRef'];
      if (rsl) {
        const distance = Math.max(100, authoredSpeedCeilingMps * (this.template.choreography.clipSeconds + this.template.choreography.warmupSeconds) * 1.6);
        const authoredLanePath = role.initialRoute?.lanes ?? this.spawnRouteLanePathFor(role.id);
        if (authoredLanePath && authoredLanePath[0] !== rsl) {
          throw new CliError('route_disconnected', `authored lane path for "${role.id}" does not start on its placed lane`, {
            path: `${path}.laneRef`, detail: { placedLane: rsl, routeStart: authoredLanePath[0] },
          });
        }
        const built = authoredLanePath
          ? buildLanePathRoute(this.bundle.graph, authoredLanePath)
          : buildFollowRoute(this.bundle.graph, rsl, [], distance);
        if (!built.ok) throw new CliError(built.error.code, built.error.reason, { path: `${path}.laneRef`, detail: built.error.detail });
        route = built.route;
        routeSpec = { kind: 'lanePath', lanes: route.legs.map((leg) => leg.rsl) };
        const width = this.bundle.graph.geometry(rsl)?.widthM ?? 3.5;
        laneRef = { rsl, s: role.laneRef!.s, tFrac: Math.max(-1, Math.min(1, role.laneRef!.t / width)) };
      } else {
        const p = role.pose.position;
        const h = role.pose.headingRad;
        const distance = Math.max(100, authoredSpeedCeilingMps * (this.template.choreography.clipSeconds + this.template.choreography.warmupSeconds) * 1.6);
        routeSpec = { kind: 'polyline', points: [
          { x: p.x, z: p.z },
          { x: p.x + Math.cos(h) * distance, z: p.z - Math.sin(h) * distance },
        ] };
        route = Route.fromPolyline(routeSpec.points.map((point) => ({ x: point.x, y: -point.z })));
      }
      const projected = route.projectPoint({ x: role.pose.position.x, y: -role.pose.position.z });
      this.routeByRole.set(role.id, route);
      this.laneByRole.set(role.id, rsl ?? undefined);
      this.spawnSByRole.set(role.id, projected.s);
      return parseActor({
        id: role.id,
        kind,
        dims: { l: dims.length, w: dims.width, h: dims.height },
        initial: {
          ...(laneRef ? { laneRef } : {}),
          pose: { x: role.pose.position.x, z: role.pose.position.z, headingRad: role.pose.headingRad },
          speedMps,
        },
        behavior: {
          rules: this.rulesFor(role.id),
          route: routeSpec,
          cruiseSpeedMps: speedMps,
        },
        presentAtStart: true,
        static: role.actor.static || role.actor.class === 'static_object',
        tags: [`role:${role.id}`, `class:${role.actor.class}`, ...(supportsDriverProfile(role.actor.class) ? [`driver-profile:${role.driverProfile ?? 'lawful'}`] : []), 'binding:scene_absolute', ...(role.actor.catalogId ? [`catalog:${role.actor.catalogId}`] : [])],
      });
    }

    let route: Route | null = null;
    let spawnS = 0;
    let tFrac = 0;
    /** Metric lateral offset when the pose used `lateralM`; null means "use tFrac". */
    let lateralOverrideM: number | null = null;
    let headingOffset = 0;
    const boundedStraightContinuation =
      role.extensions?.['movementSemantics'] === 'same-approach-straight-kerb-edge';

    const relativeParallel = this.relativeParallelRouteFor(role, scope, path);
    const spawnPolyline = relativeParallel ?? this.spawnRoutePolylineFor(role.id);

    if (spawnPolyline) {
      route = spawnPolyline;
      spawnS = 0;
    } else if (role.kind === 'on_crossing') {
      const built = this.crossingRoute(role, binding, path);
      if (!built) return null;
      route = built.route;
      spawnS = built.startS;
    } else {
      // An actor on the reference lane drives the reference path, and the
      // reference path is the one chain guaranteed to span the whole frame —
      // including the road behind the actor, which the warm-up drives over.
      // The matcher's per-role chain starts at the actor's own lane, so using it
      // would cut the approach off at the spawn.
      const onReferencePath =
        binding.laneRsl !== undefined &&
        this.site.frame.referencePath.some((span) => span.laneRsl === binding.laneRsl);
      const straightAlongApproach =
        boundedStraightContinuation && binding.laneRsl !== undefined
          // A mechanism-local straight continuation must not roam around a
          // connected city graph until it loops back into ego's route.  The
          // selected site already guarantees 70 m of downstream aftermath;
          // 80 m preserves that runway while bounding the executed movement
          // to the junction approach and its immediate receiving corridor.
          ? buildFollowRoute(this.bundle.graph, binding.laneRsl, ['Straight'], 80)
          : null;
      if (straightAlongApproach && !straightAlongApproach.ok) {
        throw new CliError(straightAlongApproach.error.code, straightAlongApproach.error.reason, {
          path: `${path}.extensions.movementSemantics`,
          detail: straightAlongApproach.error.detail,
        });
      }
      // A right-hook has two different movements from the same approach: the
      // metric vehicle follows the matcher's right-turn reference path while
      // the kerb-side cyclist continues straight. Reusing the reference chain
      // for both actors makes the bicycle turn with the car and erases the
      // conflict. The authored semantic is therefore a real route constraint,
      // resolved against the exact bound approach lane.
      let seed = straightAlongApproach?.ok
        ? straightAlongApproach.route.legs.map((leg) => leg.rsl)
        : onReferencePath
          ? this.site.frame.referencePath.map((span) => span.laneRsl)
          : (binding.routeLaneChain ?? (binding.laneRsl ? [binding.laneRsl] : []));
      if (role.kind === 'conflicting_gate') {
        const nominalSpeedMps = Math.max(
          1,
          evalNum(role.initialSpeedKph, scope, `${path}.initialSpeedKph`, 0) * KPH_TO_MPS,
        );
        const extended = extendChainBackward(
          this.bundle.graph,
          seed,
          binding.conflict!.point,
          nominalSpeedMps * (this.template.choreography.clipSeconds + this.template.choreography.warmupSeconds),
        );
        if (extended.length > seed.length) {
          this.notes.push({
            path: `${path}.route`,
            reason: `lane chain extended upstream by ${extended.length - seed.length} lane(s) to give the arrival solver temporal runway`,
            impact: 'informational',
          });
          seed = extended;
        }
      }
      route = routeFromChain(
        this.bundle.graph,
        seed,
        binding.laneRsl,
        this.notes,
        `${path}.route`,
      );
      if (!route) {
        if (role.essentiality === 'required') {
          throw new CliError('route_unbuildable', `required role "${role.id}" has no drivable route`, {
            path,
            exitCode: 2,
          });
        }
        return null;
      }
      if (role.kind === 'conflicting_gate') {
        // The arrival solver owns this actor's longitudinal placement; it starts
        // at the head of its run-up so the bisection has the whole route to work
        // with.
        spawnS = 0;
        tFrac = evalTFrac(role.tFrac, scope, `${path}.tFrac`, 0);
      } else {
        const pose = rolePose(role);
        const frameS = this.sampledFrameS(role, binding);
        // `framePoint` converts a frame station through `Route.poseAt`, which
        // saturates at the route ends: a station outside the frame silently
        // becomes the road end, and every number derived from it is wrong. The
        // matcher sizes each site's frame to the template's own longitudinal
        // envelope (`requiredRunway`), so this is unreachable for a site it
        // accepted — a param draw that reaches further than the envelope is the
        // one way in, and it is a refusal, not an adjustment.
        const [frameMinS, frameMaxS] = this.site.frame.sRange;
        if (frameS < frameMinS || frameS > frameMaxS) {
          throw new CliError(
            'role_station_outside_frame',
            `role "${role.id}" is placed at frame s=${frameS.toFixed(1)} m, outside this site's ` +
              `reference path [${frameMinS.toFixed(1)}, ${frameMaxS.toFixed(1)}] m`,
            {
              path: `${path}.pose.s`,
              detail: { frameS, sRange: [frameMinS, frameMaxS], siteId: this.site.siteId },
              exitCode: 2,
            },
          );
        }
        const frameAt = this.framePoint(frameS);
        const hasLocalSemanticConstraint =
          role.requiredSameSegmentAs !== undefined ||
          role.requiredSameRoadSectionAs !== undefined ||
          role.requiredHeadingRelation !== undefined;
        const constrainedCoverage = hasLocalSemanticConstraint
          ? coverTarget(
              this.bundle,
              route.legs.map((leg) => leg.rsl),
              { x: frameAt.x, y: frameAt.y },
              true,
              {
                preserveSegment: role.requiredSameSegmentAs !== undefined,
                preserveRoadSection: role.requiredSameRoadSectionAs !== undefined,
                allowLocalSiblingSelection: role.kind === 'opposing',
                ...(role.requiredHeadingRelation
                  ? {
                      expectedHeadingRad: frameAt.headingRad +
                        (role.requiredHeadingRelation.relation === 'antiparallel' ? Math.PI : 0),
                      maxHeadingErrorRad: role.requiredHeadingRelation.maxErrorDeg * Math.PI / 180,
                    }
                  : {}),
              },
            )
          : null;
        const constrainedProjection = constrainedCoverage?.constrainedProjection ?? null;
        if (hasLocalSemanticConstraint && constrainedProjection === null) {
          throw new CliError(
            'role_semantic_projection_failed',
            `constrained role "${role.id}" cannot reach its matcher-selected local lane within ` +
              `${LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M.toFixed(2)} m`,
            {
              path: `${path}.pose.s`,
              detail: {
                bindingLaneRsl: binding.laneRsl,
                routeLaneChain: binding.routeLaneChain ?? [],
                frameS,
                maxDistanceM: LOCAL_ROLE_PROJECTION_MAX_DISTANCE_M,
              },
              exitCode: 2,
            },
          );
        }
        if (constrainedProjection !== null) {
          // The matcher-bound local lane already owns this station. Do not run
          // whole-route cover/projection first: a later perpendicular crossing
          // can look closer and prepend an unrelated road before the actor's
          // truthful route start.
          if (constrainedCoverage && constrainedCoverage.lanes.length > route.legs.length) {
            this.notes.push({
              path: `${path}.route`,
              reason: `constrained lane chain extended upstream by ` +
                `${constrainedCoverage.lanes.length - route.legs.length} lane(s) to preserve the matcher-selected local lane`,
              impact: 'informational',
            });
            route = constrainedCoverage.route;
          }
          spawnS = constrainedProjection.routeS;
        } else {
          const covered = coverTarget(
            this.bundle,
            route.legs.map((leg) => leg.rsl),
            { x: frameAt.x, y: frameAt.y },
          );
          if (covered && covered.lanes.length > route.legs.length) {
            this.notes.push({
              path: `${path}.route`,
              reason: `lane chain extended upstream by ${covered.lanes.length - route.legs.length} lane(s) to reach the site-evaluated spawn at frame s=${frameS.toFixed(1)} m`,
              impact: 'informational',
            });
            route = covered.route;
          }
          spawnS = route.projectPoint({ x: frameAt.x, y: frameAt.y }).s;
        }
        tFrac = pose ? evalTFrac(pose.tFrac, scope, `${path}.pose.tFrac`, 0) : (binding.pose?.tFrac ?? 0);
        // A role can also state its lateral offset in metres from a named reference. This is what
        // lets a VRU START off the carriageway -- behind the hedge that is supposed to hide it --
        // instead of on the lane edge, which is the furthest `tFrac` can reach.
        lateralOverrideM = pose?.lateralM === undefined
          ? null
          : this.resolveLateral(pose, scope, `${path}.pose`, route.widthAt(spawnS) ?? this.referenceLaneWidth());
        // A `relative_to` role carries its own lateral fields rather than a FramePose, so it needs
        // the same treatment explicitly. This is the role that most needs the kerb -- a parked car,
        // a van protruding from a bay, a vehicle pulling out -- and with `tFrac` alone none of them
        // can be placed off the carriageway.
        if (role.kind === 'relative_to') {
          tFrac = role.tFrac;
          if (role.lateralM !== undefined) {
            lateralOverrideM = this.resolveLateral(
              { laneOffset: 0, s: 0, tFrac: 0, headingOffsetRad: 0,
                lateralM: role.lateralM, lateralRef: role.lateralRef } as FramePose,
              scope, `${path}.lateralM`,
              route.widthAt(spawnS) ?? this.referenceLaneWidth());
          }
          headingOffset = role.headingOffsetRad;
        }
        headingOffset = pose?.headingOffsetRad ?? binding.pose?.headingOffsetRad ?? 0;
      }
    }

    const speedMps = Math.max(
      0,
      evalNum(role.initialSpeedKph, scope, `${path}.initialSpeedKph`, 0) * KPH_TO_MPS,
    );
    // Route construction must cover authored motion after the spawn, not only
    // the initial velocity. This matters for a dwelling bus: its initial speed
    // is truthfully zero, but its later absolute speed action still consumes
    // substantial downstream runway.
    const authoredSpeedCeilingMps = this.template.choreography.interactions.reduce((ceiling, interaction) => {
      if (interaction.actor !== role.id || interaction.verb !== 'speed') return ceiling;
      switch (interaction.target.mode) {
        case 'absolute':
          return Math.max(ceiling, evalNum(interaction.target.valueKph, scope, `choreography.${interaction.id}.target.valueKph`) * KPH_TO_MPS);
        case 'delta':
          return Math.max(ceiling, speedMps + evalNum(interaction.target.deltaKph, scope, `choreography.${interaction.id}.target.deltaKph`) * KPH_TO_MPS);
        case 'factor':
          return Math.max(ceiling, speedMps * evalNum(interaction.target.factor, scope, `choreography.${interaction.id}.target.factor`));
        case 'match':
        case 'stop':
        case 'resume':
          return ceiling;
      }
    }, speedMps);
    const speedForRunway = Math.max(1, authoredSpeedCeilingMps);
    if (!route.isFreeform && !boundedStraightContinuation) {
      // 1.6× the nominal distance: the clip's own length, plus the unrecorded
      // warm-up the actor also drives, plus headroom for the cruise governor
      // overshooting the authored speed.
      const needM =
        speedForRunway *
        (this.template.choreography.clipSeconds + this.template.choreography.warmupSeconds) *
        1.6;
      const extended = extendChainForward(
        this.bundle.graph,
        route.legs.map((leg) => leg.rsl),
        route,
        spawnS,
        needM,
      );
      if (extended.length > route.legs.length) {
        const rebuilt = buildLanePathRoute(this.bundle.graph, extended);
        if (rebuilt.ok) route = rebuilt.route;
      }
    }

    const routePose = route.poseAt(spawnS);
    const lateralM = lateralOverrideM ?? tFrac * route.widthAt(spawnS);
    const point = route.pointWithOffset(spawnS, lateralM);
    const scene = toSceneXZ(point);
    const hasAuthoredDeparture = this.template.choreography.interactions.some(
      (interaction) => interaction.actor === role.id && interaction.verb === 'speed' && interaction.target.mode !== 'stop',
    );
    const holdsAtZeroUntilDeparture = speedMps === 0 && (
      role.extensions?.['serviceState'] === 'dwelling' || hasAuthoredDeparture
    );

    this.routeByRole.set(role.id, route);
    this.laneByRole.set(role.id, routePose.rsl ?? binding.laneRsl);
    this.spawnSByRole.set(role.id, spawnS);

    const laneRef = routePose.rsl
      ? { rsl: routePose.rsl, s: routePose.storageS, tFrac }
      : undefined;

    return parseActor({
      id: role.id,
      kind,
      dims: { l: dims.length, w: dims.width, h: dims.height },
      initial: {
        ...(laneRef ? { laneRef } : {}),
        pose: { x: scene.x, z: scene.z, headingRad: routePose.headingRad + headingOffset },
        speedMps,
      },
      behavior: {
        rules: this.rulesFor(role.id),
        route: route.isFreeform
          ? { kind: 'polyline', points: polylinePointsOf(route) }
          : { kind: 'lanePath', lanes: route.legs.map((leg) => leg.rsl) },
        // Without this the actor accelerates to `speedFactor × limit` and the
        // author's `initialSpeedKph` is a transient, which silently rewrites
        // every arrival solve.
        // Omitting cruise means "use the lane limit", not "hold the authored
        // zero". Preserve a real dwell through warm-up; the later speed action
        // takes ownership of the longitudinal axis and persists its target.
        ...(speedMps > 0 || holdsAtZeroUntilDeparture ? { cruiseSpeedMps: speedMps } : {}),
      },
      presentAtStart: true,
      static: role.actor.static || role.actor.class === 'static_object',
      tags: [
        `role:${role.id}`,
        `class:${role.actor.class}`,
        ...(supportsDriverProfile(role.actor.class) ? [`driver-profile:${role.driverProfile ?? 'lawful'}`] : []),
        `binding:${role.kind}`,
        ...(role.extensions?.['motionSemantics'] === 'reverse' ? ['motion:reverse'] : []),
        ...(role.actor.catalogId ? [`catalog:${role.actor.catalogId}`] : []),
      ],
    });
  }

  /**
   * Build a role-local path parallel to a concrete reference actor.
   *
   * Parking lanes are often not members of the corridor's integer
   * `lateralLanes` frame. A `relative_to` bicycle beside a selected parked car
   * therefore cannot truthfully be represented by guessing a generic dLane.
   * This extension keeps the semantic reference and derives the actual path
   * from that actor's selected slot, pose, and heading.
   */
  private relativeParallelRouteFor(role: V2Role, scope: ExprScope, path: string): Route | null {
    if (role.kind !== 'relative_to' || role.extensions?.['pathSemantics'] !== 'parallel_to_reference_actor') {
      return null;
    }
    const ref = this.actors.find((actor) => actor.id === role.ref);
    if (!ref) {
      throw new CliError('role_reference_unmaterialized', `relative path reference "${role.ref}" is not materialized`, {
        path: `${path}.ref`,
        detail: { role: role.id, ref: role.ref },
        exitCode: 2,
      });
    }
    const lateralRaw = role.extensions?.['lateralOffsetM'];
    const lateralM = typeof lateralRaw === 'number'
      ? lateralRaw
      : 0;
    const lengthRaw = role.extensions?.['pathLengthM'];
    const pathLengthM = Math.max(
      20,
      typeof lengthRaw === 'number'
        ? lengthRaw
        : 120,
    );
    const longitudinalM = evalNum(role.dsM, scope, `${path}.dsM`, 0);
    // Actor headings are already xodr-local (x east, y north); only scene
    // positions encode north as `-z`. Negating sin here made a supposedly
    // parallel cyclist path anti-parallel after the polyline round-trip.
    const referenceRoute = this.routeByRole.get(role.ref);
    const referenceSpawnS = this.spawnSByRole.get(role.ref);
    // Preserve the actual curvature of the selected reference route.  A
    // tangent-only approximation can place a roadside barrier dozens of
    // metres away from a vehicle following a bend, which turns a declared
    // road-edge conflict into a cosmetic object.
    const stations = referenceRoute && referenceSpawnS !== undefined
      ? Array.from(
          { length: Math.max(2, Math.ceil(pathLengthM / 5) + 1) },
          (_, index) => referenceSpawnS + longitudinalM + Math.min(pathLengthM, index * 5),
        )
      : [];
    const points = stations.length > 0
      ? (() => {
          const route = referenceRoute!;
          const spawn = referenceSpawnS!;
          const referencePoint = { x: ref.initial.pose.x, y: -ref.initial.pose.z };
          const spawnPose = route.poseAt(spawn);
          const spawnLeft = { x: -Math.sin(spawnPose.headingRad), y: Math.cos(spawnPose.headingRad) };
          // A feature-bound actor can sit off its bound lane centre (for
          // example, a parked car at tFrac=-1). Preserve that concrete slot
          // offset before adding the authored actor-to-actor lateral offset.
          // Otherwise `parallel_to_reference_actor` is accidentally parallel
          // to the parking lane centre rather than to the selected car.
          const referenceLateralM =
            (referencePoint.x - spawnPose.point.x) * spawnLeft.x +
            (referencePoint.y - spawnPose.point.y) * spawnLeft.y;
          const totalLateralM = referenceLateralM + lateralM;
          const extendedPoseAt = (station: number): { point: { x: number; y: number }; headingRad: number } => {
            if (station >= 0 && station <= route.lengthM) return route.poseAt(station);
            const endpointS = station < 0 ? 0 : route.lengthM;
            const endpoint = route.poseAt(endpointS);
            const delta = station - endpointS;
            return {
              point: {
                x: endpoint.point.x + Math.cos(endpoint.headingRad) * delta,
                y: endpoint.point.y + Math.sin(endpoint.headingRad) * delta,
              },
              headingRad: endpoint.headingRad,
            };
          };
          return stations.map((station) => {
            // Parking-zone lane fragments are commonly much shorter than the
            // authored approach/runway. Extrapolate from their endpoint
            // tangents instead of letting Route.poseAt clamp every out-of-range
            // sample onto an endpoint and collapse dsM/pathLengthM.
            const pose = extendedPoseAt(station);
            const left = { x: -Math.sin(pose.headingRad), y: Math.cos(pose.headingRad) };
            return {
              x: pose.point.x + left.x * totalLateralM,
              y: pose.point.y + left.y * totalLateralM,
            };
          });
        })()
      : (() => {
          const forward = { x: Math.cos(ref.initial.pose.headingRad), y: Math.sin(ref.initial.pose.headingRad) };
          const left = { x: -forward.y, y: forward.x };
          const referencePoint = { x: ref.initial.pose.x, y: -ref.initial.pose.z };
          const start = {
            x: referencePoint.x + forward.x * longitudinalM + left.x * lateralM,
            y: referencePoint.y + forward.y * longitudinalM + left.y * lateralM,
          };
          return [start, { x: start.x + forward.x * pathLengthM, y: start.y + forward.y * pathLengthM }];
        })();
    const route = buildRouteFromPoints(points);
    if (!route) throw new CliError('route_unbuildable', `relative parallel path for "${role.id}" is degenerate`, { path });
    this.notes.push({
      path: `${path}.extensions.pathSemantics`,
      reason: `parallel path resolved in ${role.ref}'s selected local frame (${longitudinalM.toFixed(1)} m longitudinal, ${lateralM.toFixed(2)} m left)`,
      impact: 'informational',
    });
    return route;
  }

  /**
   * A pedestrian crossing is a freeform path, not a lane chain: it runs
   * *across* the carriageway. The path is built from the crossing's anchor
   * point, perpendicular to the reference heading, spanning the full
   * cross-section plus a kerb allowance at each end.
   */
  private crossingRoute(
    role: Extract<V2Role, { kind: 'on_crossing' }>,
    binding: FeatureBinding,
    path: string,
  ): { route: Route; startS: number } | null {
    // The feature match owns the crossing's station in the anchor frame.  A
    // crossing can be catalogued on an adjacent/receiving-road lane that is
    // not itself in `frame.sOfLane`; the role binding's fallback station then
    // differs from the projected station used by PointRef resolution. Building
    // the path at that fallback makes `{ feature: xw }` visibly correct yet
    // impossible for the arrival solver to reach. Keep route construction and
    // every feature PointRef on the same matched station.
    const frameS = this.site.featureMatches[role.feature]?.s ?? binding.pose?.s ?? 0;
    const at = this.framePoint(frameS);
    const laneRsl = binding.laneRsl ?? this.site.frame.entryLaneRsl;
    const lane = this.bundle.index.lanes[laneRsl];
    const width = lane?.representativeWidthM ?? 3.5;
    // `lateralLanes` contains offsets away from the reference lane; the
    // reference lane itself still contributes one full lane to the crossing.
    // `+n` is left of travel. Resolve the real lane centres at this station
    // instead of estimating cross-section width from a lane count: parallel
    // lanes can have independent curvature and spacing, and a count-based span
    // can stop metres short of the adjacent ego lane.
    let nx = -Math.sin(at.headingRad);
    let ny = Math.cos(at.headingRad);
    const crossSectionPoints: Array<{ x: number; y: number }> = [];
    for (const key of Object.keys(this.site.frame.lateralLanes)) {
      const k = Number(key);
      if (!Number.isFinite(k)) continue;
      const point = this.framePosePoint(
        { laneOffset: k, s: frameS, tFrac: 0, headingOffsetRad: 0 },
        this.baseScope(laneRsl),
        `${path}.crossSection.${key}`,
      );
      crossSectionPoints.push(point);
    }
    for (const route of this.routeByRole.values()) {
      if (route.isFreeform) continue;
      const projected = route.projectPoint({ x: at.x, y: at.y });
      if (projected.d > 30) continue;
      const point = route.poseAt(projected.s).point;
      crossSectionPoints.push(point);
    }
    const outer = crossSectionPoints.reduce<{ point: { x: number; y: number }; distance: number } | null>(
      (best, point) => {
        const distance = Math.hypot(point.x - at.x, point.y - at.y);
        return !best || distance > best.distance ? { point, distance } : best;
      },
      null,
    );
    if (outer && outer.distance > 1) {
      nx = (outer.point.x - at.x) / outer.distance;
      ny = (outer.point.y - at.y) / outer.distance;
    }
    const offsets = [0, ...crossSectionPoints.map((point) =>
      (point.x - at.x) * nx + (point.y - at.y) * ny
    )];
    const opposingAllowance = this.site.frame.opposingLanes.length * width;
    const kerbAllowanceM = width / 2 + 3;
    const low = Math.min(...offsets, -opposingAllowance) - kerbAllowanceM;
    const high = Math.max(...offsets) + kerbAllowanceM;
    const sign = role.direction === 'near_to_far' ? 1 : -1;
    const fromOffset = sign > 0 ? low : high;
    const toOffset = sign > 0 ? high : low;
    const from = { x: at.x + nx * fromOffset, y: at.y + ny * fromOffset };
    const to = { x: at.x + nx * toOffset, y: at.y + ny * toOffset };
    const built = buildRouteFromPoints([from, to]);
    if (!built) {
      this.notes.push({ path, reason: 'could not build a crossing path' });
      return null;
    }
    return { route: built, startS: role.startFrac * built.lengthM };
  }

  /**
   * The polyline an actor's `route` interaction lays down at `t ≤ 0`, if any.
   *
   * Folded into the spawn route (and the interaction dropped) for the reason in
   * `buildActor`. Only the *first* such interaction is folded; a second one is
   * a genuine mid-clip re-route and stays on the timeline.
   */
  private spawnRoutePolylineFor(roleId: string): Route | null {
    for (const it of this.template.choreography.interactions) {
      if (it.verb !== 'route' || it.actor !== roleId) continue;
      if (it.trigger.kind !== 'at' || it.target.mode !== 'polyline') continue;
      const scope = this.baseScope();
      const t = evalNum(it.trigger.t, scope, `choreography.${it.id}.trigger.t`, 0);
      if (t > 0) continue;
      const frameSOffset = this.placementFeatureOffset(roleId, `roles.${roleId}.extensions.placementFeature`);
      const points: Array<{ x: number; y: number }> = [];
      for (let idx = 0; idx < it.target.points.length; idx += 1) {
        const p = it.target.points[idx]!;
        const at = this.framePosePoint(p, scope, `choreography.${it.id}.target.points.${idx}`, frameSOffset);
        points.push({ x: at.x, y: at.y });
      }
      const route = buildRouteFromPoints(points);
      if (!route) continue;
      this.foldedInteractions.add(it.id);
      this.foldedTriggerStart.set(it.id, t);
      this.recordInitialInteractionOutcome(it, t);
      this.notes.push({
        path: `choreography.interactions.${it.id}`,
        reason: `route(polyline) at t=${t} folded into ${roleId}'s spawn route (${route.lengthM.toFixed(1)} m), so the arrival solver can place the actor along it`,
        impact: 'informational',
      });
      return route;
    }
    return null;
  }

  /** Exact Studio-authored map-bound route at t=0, folded into actor spawn. */
  private spawnRouteLanePathFor(roleId: string): readonly string[] | null {
    for (const it of this.template.choreography.interactions) {
      if (it.verb !== 'route' || it.actor !== roleId || it.target.mode !== 'lanePath') continue;
      if (it.trigger.kind !== 'at') continue;
      const t = evalNum(it.trigger.t, this.baseScope(), `choreography.${it.id}.trigger.t`, 0);
      if (t > 0) continue;
      this.foldedInteractions.add(it.id);
      this.foldedTriggerStart.set(it.id, t);
      this.recordInitialInteractionOutcome(it, t);
      this.notes.push({
        path: `choreography.interactions.${it.id}`,
        reason: `route(lanePath) at t=${t} folded into ${roleId}'s spawn route (${it.target.lanes.length} connected lanes)`,
        impact: 'informational',
      });
      return it.target.lanes;
    }
    return null;
  }

  /** Initial `rules`, after folding `set rules.*` interactions at `t ≤ 0`. */
  private rulesFor(roleId: string): Record<string, boolean | number> {
    const role = this.roleById.get(roleId);
    if (!role || !supportsDriverProfile(role.actor.class)) return this.initialRules.get(roleId) ?? {};
    const profile = driverProfileDefinition(role.driverProfile);
    return { ...profile.rules, ...(this.initialRules.get(roleId) ?? {}) };
  }

  private foldInitialRules(): void {
    for (const interaction of this.template.choreography.interactions) {
      if (interaction.verb !== 'set') continue;
      if (interaction.trigger.kind !== 'at') continue;
      const scope = this.scopeByRole.get(interaction.actor) ?? this.baseScope();
      const t = evalNum(interaction.trigger.t, scope, `choreography.${interaction.id}.trigger.t`, 0);
      if (t > 0) continue;
      const mapped = materializedSetKey(
        interaction.target.key,
        `choreography.interactions.${interaction.id}.target.key`,
      );
      if (!mapped || !mapped.startsWith('rules.')) continue;
      const bucket = this.initialRules.get(interaction.actor) ?? {};
      const key = mapped.slice('rules.'.length);
      const value = interaction.target.value;
      if (typeof value === 'boolean' || typeof value === 'number') {
        bucket[key] = value;
        this.initialRules.set(interaction.actor, bucket);
        this.foldedInteractions.add(interaction.id);
        this.foldedTriggerStart.set(interaction.id, t);
        this.recordInitialInteractionOutcome(interaction, t);
      }
    }
  }

  private recordInitialInteractionOutcome(interaction: V2Interaction, timeS: number): void {
    if (this.initialInteractionOutcomes.some((item) => item.interactionId === interaction.id)) return;
    this.initialInteractionOutcomes.push({
      interactionId: interaction.id,
      actorId: interaction.actor,
      verb: interaction.verb,
      timeS,
      outcome: 'executed',
      basis: 'folded_initial_state',
    });
  }

  /* ----------------------------------------------------------- the timeline */

  private buildInteractions(): void {
    for (const interaction of this.template.choreography.interactions) {
      if (this.foldedInteractions.has(interaction.id)) continue;
      if (interaction.verb === 'route' && interaction.target.mode === 'nearMiss') {
        this.interactions.push(...this.buildNearMissInteractions(interaction));
        continue;
      }
      const built = this.buildInteraction(interaction);
      if (built) this.interactions.push(built);
    }
    const repaired = pruneDanglingAfterInteractions(this.interactions);
    if (repaired.removed.length === 0) return;
    this.interactions.splice(0, this.interactions.length, ...repaired.interactions);
    for (const removal of repaired.removed) {
      this.notes.push({
        path: `choreography.interactions.${removal.interactionId}`,
        reason: `command removed during concrete normalization because after(${removal.missingInteractionId}) no longer has a materialized source interaction`,
      });
    }
  }

  /** Resolve semantic near-miss intent against the target's concrete site route. */
  private buildNearMissInteractions(
    interaction: Extract<V2Interaction, { verb: 'route' }>,
  ): SimInteraction[] {
    const path = `choreography.interactions.${interaction.id}`;
    const goal = interaction.target;
    if (goal.mode !== 'nearMiss') return [];
    const pedestrian = this.actors.find((actor) => actor.id === interaction.actor);
    const target = this.actors.find((actor) => actor.id === goal.target);
    const targetRoute = this.routeByRole.get(goal.target);
    if (!pedestrian || pedestrian.kind !== 'pedestrian' || !target || !targetRoute) {
      throw new CliError('near_miss_actor_unavailable', 'near-miss pedestrian or target has no concrete actor/route at this site', { path: `${path}.target`, exitCode: 2 });
    }
    const scope = this.scopeByRole.get(interaction.actor) ?? this.baseScope();
    const clipSeconds = this.template.choreography.clipSeconds;
    const spawnTime = (actor: SimActor): number => {
      if (actor.presentAtStart) return 0;
      const spawn = this.template.choreography.interactions.find((candidate) =>
        candidate.actor === actor.id && candidate.verb === 'exist' && candidate.target.state === 'present' && candidate.trigger.kind === 'at'
      );
      return spawn && spawn.trigger.kind === 'at'
        ? Math.max(0, evalNum(spawn.trigger.t, this.scopeByRole.get(actor.id) ?? this.baseScope(), `choreography.${spawn.id}.trigger.t`))
        : Infinity;
    };
    const targetSpawnS = spawnTime(target);
    const pedestrianSpawnS = spawnTime(pedestrian);
    if (!Number.isFinite(targetSpawnS) || !Number.isFinite(pedestrianSpawnS)) {
      throw new CliError('near_miss_actor_unavailable', 'near-miss actors must have a deterministic initial or at(t) spawn', { path: `${path}.target`, exitCode: 2 });
    }
    const targetStart = targetRoute.projectPoint(localFromScene(target.initial.pose)).s;
    const speedEvents = this.template.choreography.interactions
      .flatMap((candidate) => candidate.actor === target.id && candidate.verb === 'speed' && candidate.trigger.kind === 'at'
        ? [{ t: evalNum(candidate.trigger.t, this.scopeByRole.get(target.id) ?? this.baseScope(), `choreography.${candidate.id}.trigger.t`), target: candidate.target }]
        : [])
      .sort((a, b) => a.t - b.t);
    let speed = target.initial.speedMps;
    let routeS = targetStart;
    let eventIndex = 0;
    const trajectory: Array<{ t: number; x: number; z: number; headingRad: number }> = [];
    for (let tick = Math.ceil(targetSpawnS * 20); tick <= Math.ceil(clipSeconds * 20); tick++) {
      const t = Math.min(clipSeconds, tick / 20);
      while (eventIndex < speedEvents.length && speedEvents[eventIndex]!.t <= t + 1e-9) {
        const command = speedEvents[eventIndex]!.target;
        if (command.mode === 'stop') speed = 0;
        else if (command.mode === 'absolute') speed = Math.max(0, evalNum(command.valueKph, scope, `${path}.targetTrajectory.speed`) * KPH_TO_MPS);
        else if (command.mode === 'delta') speed = Math.max(0, speed + evalNum(command.deltaKph, scope, `${path}.targetTrajectory.speed`) * KPH_TO_MPS);
        else if (command.mode === 'factor') speed = Math.max(0, speed * evalNum(command.factor, scope, `${path}.targetTrajectory.speed`));
        eventIndex++;
      }
      const pose = targetRoute.poseAt(routeS);
      const scene = toSceneXZ(pose.point);
      trajectory.push({ t, x: scene.x, z: scene.z, headingRad: -pose.headingRad });
      routeS = Math.min(targetRoute.lengthM, routeS + speed / 20);
    }
    const pedStart = pedestrian.initial.pose;
    const triggerTime = (() => {
      if (interaction.trigger.kind === 'at') return Math.max(pedestrianSpawnS, targetSpawnS, evalNum(interaction.trigger.t, scope, `${path}.trigger.t`));
      if (interaction.trigger.kind !== 'when') return null;
      const condition = interaction.trigger.condition;
      if (condition.kind === 'distance' && 'role' in condition.to) {
        const pairMatches = (condition.from === target.id && condition.to.role === pedestrian.id)
          || (condition.from === pedestrian.id && condition.to.role === target.id);
        if (!pairMatches) return null;
        const value = Math.max(0, evalNum(condition.valueM, scope, `${path}.trigger.condition.valueM`));
        const band = condition.hysteresisM === undefined ? 0 : Math.max(0, evalNum(condition.hysteresisM, scope, `${path}.trigger.condition.hysteresisM`));
        const threshold = condition.op === '<' || condition.op === '<=' ? Math.max(0, value - band) : value + band;
        const radii = Math.hypot(pedestrian.dims.l, pedestrian.dims.w) / 2 + Math.hypot(target.dims.l, target.dims.w) / 2;
        return trajectory.find((sample) => sample.t >= pedestrianSpawnS && (() => {
          const gap = Math.max(0, Math.hypot(sample.x - pedStart.x, sample.z - pedStart.z) - radii);
          return condition.op === '<' || condition.op === '<=' ? gap <= threshold : gap >= threshold;
        })())?.t ?? null;
      }
      if (condition.kind === 'ttc' && ((condition.of === target.id && condition.to === pedestrian.id) || (condition.of === pedestrian.id && condition.to === target.id))) {
        const threshold = Math.max(0, evalNum(condition.valueS, scope, `${path}.trigger.condition.valueS`));
        for (let index = 0; index + 1 < trajectory.length; index++) {
          const sample = trajectory[index]!;
          if (sample.t < pedestrianSpawnS) continue;
          const next = trajectory[index + 1]!;
          const vx = (next.x - sample.x) * 20;
          const vz = (next.z - sample.z) * 20;
          const dx = pedStart.x - sample.x;
          const dz = pedStart.z - sample.z;
          const speed2 = vx * vx + vz * vz;
          if (speed2 <= 1e-9) continue;
          const approaching = (dx * vx + dz * vz) / speed2;
          const closest2 = (dx - vx * approaching) ** 2 + (dz - vz * approaching) ** 2;
          const radius = Math.hypot(pedestrian.dims.l, pedestrian.dims.w) / 2 + Math.hypot(target.dims.l, target.dims.w) / 2;
          if (approaching < 0 || closest2 > radius * radius) continue;
          const ttc = Math.max(0, approaching - Math.sqrt(Math.max(0, radius * radius - closest2) / speed2));
          const match = condition.op === '<' || condition.op === '<=' ? ttc <= threshold : ttc >= threshold;
          if (match) return sample.t;
        }
      }
      return null;
    })();
    if (triggerTime === null) {
      throw new CliError('near_miss_trigger_unresolved', 'near-miss trigger cannot be resolved against the canonical target trajectory', { path: `${path}.trigger`, exitCode: 2 });
    }
    const deadline = goal.deadlineS === undefined
      ? interaction.trigger.kind === 'when' && interaction.trigger.byLatest !== undefined
        ? evalNum(interaction.trigger.byLatest, scope, `${path}.trigger.byLatest`)
        : clipSeconds
      : evalNum(goal.deadlineS, scope, `${path}.target.deadlineS`);
    const result = solvePedestrianNearMiss({
      pedestrianId: pedestrian.id, targetId: target.id,
      pedestrianStart: { x: pedStart.x, z: pedStart.z }, pedestrianDims: pedestrian.dims,
      targetTrajectory: trajectory, targetDims: target.dims, triggerTimeS: triggerTime,
      deadlineS: deadline, clearanceM: Math.max(0.01, evalNum(goal.clearanceM, scope, `${path}.target.clearanceM`)),
      pass: goal.pass,
      minSpeedMps: Math.max(0.1, evalNum(goal.minSpeedKph, scope, `${path}.target.minSpeedKph`) * KPH_TO_MPS),
      maxSpeedMps: Math.max(0.1, evalNum(goal.maxSpeedKph, scope, `${path}.target.maxSpeedKph`) * KPH_TO_MPS),
    });
    if (!result.ok) throw new CliError(result.diagnostic.code, result.diagnostic.message, { path: `${path}.target`, detail: result.diagnostic.detail, exitCode: 2 });
    const trigger = this.buildTrigger(interaction.trigger, scope, `${path}.trigger`);
    if (!trigger) throw new CliError('near_miss_trigger_unresolved', 'near-miss trigger did not materialize', { path: `${path}.trigger`, exitCode: 2 });
    const route = parseInteraction({ id: interaction.id, actorId: pedestrian.id, trigger, verb: 'route', target: { kind: 'polyline', points: result.solution.points } });
    const walking = parseInteraction({
      id: `${interaction.id}__speed`, actorId: pedestrian.id, trigger,
      verb: 'speed', target: { mode: 'absolute', value: result.solution.speedMps },
      dynamics: { shape: 'linear', constraint: 'time', value: 0.1 },
    });
    this.notes.push({
      path: `${path}.target`, impact: 'informational',
      reason: `near miss re-solved: ${result.solution.pass}, ${result.solution.predictedClearanceM.toFixed(3)} m clearance, ${result.solution.speedMps.toFixed(3)} m/s, plan ${result.solution.planHash}`,
    });
    this.nearMissCriteria.push({
      interactionId: interaction.id,
      pedestrianId: pedestrian.id,
      targetId: target.id,
      clearanceM: result.solution.requestedClearanceM,
      toleranceM: 0.15,
      pass: result.solution.pass,
      planHash: result.solution.planHash,
      predictedClosestApproachS: result.solution.closestApproachTimeS,
      predictedTimeGapS: result.solution.predictedTimeGapS,
    });
    return [route, walking];
  }

  /** Bind portable control stop lines onto concrete lateral lanes. */
  private buildTrafficControls(): void {
    for (const control of this.template.trafficControls) {
      const scope = this.baseScope();
      const stopLines = control.stopLines.map((line, index) => {
        const featureOffset = line.feature ? (this.site.featureMatches[line.feature]?.s ?? NaN) : 0;
        if (!Number.isFinite(featureOffset)) {
          throw new CliError('control_feature_unbound', `traffic control "${control.id}" references an unbound feature`, {
            path: `trafficControls.${control.id}.stopLines.${index}.feature`, exitCode: 2,
          });
        }
        const frameS = featureOffset + evalNum(line.pose.s, scope, `trafficControls.${control.id}.stopLines.${index}.pose.s`);
        const laneRsl = this.site.frame.lateralLanes[line.pose.laneOffset];
        if (!laneRsl) {
          throw new CliError('control_lane_unbound', `traffic control "${control.id}" has no lane at offset ${line.pose.laneOffset}`, {
            path: `trafficControls.${control.id}.stopLines.${index}.pose.laneOffset`, exitCode: 2,
          });
        }
        const point = this.framePoint(frameS);
        const projected = this.bundle.graph.projectOnto(laneRsl, point);
        if (!projected) {
          throw new CliError('control_stop_line_unprojectable', `traffic control "${control.id}" stop line cannot project onto ${laneRsl}`, {
            path: `trafficControls.${control.id}.stopLines.${index}`, exitCode: 2,
          });
        }
        return { rsl: laneRsl, s: projected.s, connectingLaneRsls: [] };
      });
      this.authoredControlPrograms.push({
        id: `control:${control.id}`,
        phases: control.phases.map((phase, index) => ({
          phase: phase.indication,
          durationS: evalNum(phase.durationS, scope, `trafficControls.${control.id}.phases.${index}.durationS`),
        })),
        offsetS: evalNum(control.offsetS, scope, `trafficControls.${control.id}.offsetS`, 0),
        loop: control.loop,
        stopLines,
      });
    }
  }

  /** Resolve legacy world signal setters before a map plan takes ownership. */
  private worldSignalSetIds(programs: readonly SignalProgram[]): string[] {
    const ids = new Set<string>();
    for (const interaction of this.template.choreography.interactions) {
      if (interaction.actor !== '@world' || interaction.verb !== 'set') continue;
      const semantic = /^signal:feature:([A-Za-z][A-Za-z0-9_-]{0,63}):(ego|opposing|left|right)\.phase$/.exec(interaction.target.key);
      if (semantic) {
        const id = resolveSiteSignalProgram(this.bundle, this.site, this.signalPlan!, {
          featureId: semantic[1]!, approach: semantic[2]!,
        });
        if (id) ids.add(id);
        continue;
      }
      const direct = /^signal:(.+)\.phase$/.exec(interaction.target.key);
      if (!direct) continue;
      const handle = direct[1]!;
      const program = programs.find((candidate) =>
        candidate.id === handle || candidate.mapBinding?.headIds.includes(handle),
      );
      if (program) ids.add(program.id);
    }
    return [...ids].sort();
  }

  private compileAuthoredMapSignals(): void {
    if (this.template.mapSignalPlans.length === 0) return;
    const controls = buildMapControlPlan(this.bundle);
    try {
      this.compiledMapSignalPrograms = compileMapSignalPlans(
        controls.signalPrograms,
        this.template.mapSignalPlans,
        {
          mapId: this.bundle.mapId,
          controlDigest: contentHash(controls),
          clipSeconds: this.template.choreography.clipSeconds,
          warmupSeconds: this.template.choreography.warmupSeconds,
          signalCatalog: this.bundle.signalCatalog,
          topology: this.bundle.topology,
          conflictPairsByJunction: Object.fromEntries(
            Object.entries(this.bundle.index.junctionDescriptors).map(([id, descriptor]) => [id, descriptor.conflictPairs]),
          ),
          worldSignalSetIds: this.worldSignalSetIds(controls.signalPrograms),
        },
      );
      this.notes.push({
        path: 'mapSignalPlans',
        reason: `${this.template.mapSignalPlans.length} physical junction signal plan(s) compiled into complete warm-up and clip-bounded programs`,
        impact: 'informational',
      });
    } catch (error) {
      if (error instanceof MapSignalPlanCompileError) {
        throw new CliError(error.code, error.message, { path: error.path, exitCode: 2 });
      }
      throw error;
    }
  }

  private buildInteraction(it: V2Interaction): SimInteraction | null {
    const path = `choreography.interactions.${it.id}`;
    if (it.actor !== '@world' && !this.actors.some((a) => a.id === it.actor)) {
      this.notes.push({ path, reason: `actor "${it.actor}" is not present at this site; interaction dropped` });
      return null;
    }
    const scope = this.scopeByRole.get(it.actor) ?? this.baseScope();
    const trigger = this.buildTrigger(
      it.trigger,
      scope,
      `${path}.trigger`,
      this.placementFeatureOffset(it.actor, `roles.${it.actor}.extensions.placementFeature`),
    );
    if (!trigger) return null;

    const until = it.until?.kind === 'when'
      ? this.buildCondition(it.until.condition, scope, `${path}.until.condition`)
      : undefined;

    // Studio clip bounds form a half-open trigger eligibility window. A
    // continuous command that fires inside it completes according to its own
    // dynamics; the window end never truncates the physical manoeuvre.
    const windowStartS = it.trigger.kind === 'at'
      ? evalNum(it.trigger.t, scope, `${path}.trigger.t`)
      : 0;
    const windowEndS = it.until?.kind === 'at'
      ? evalNum(it.until.t, scope, `${path}.until.t`)
      : it.trigger.kind === 'when' && it.trigger.byLatest !== undefined
        ? evalNum(it.trigger.byLatest, scope, `${path}.trigger.byLatest`)
        : undefined;
    const window = windowEndS === undefined
      ? undefined
      : { startS: windowStartS, endS: windowEndS };

    const base = {
      id: it.id,
      // Engine interactions remain actor-addressed; world state uses the first
      // concrete actor as an event carrier while the key itself is global.
      actorId: it.actor === '@world' ? this.actors[0]!.id : it.actor,
      trigger,
      ...(window ? { window } : {}),
      ...(until ? { until } : {}),
    };

    const dyn = (
      dynamics: { shape: string; constraint: string; value: NumberOrExpr } | undefined,
    ): { shape: string; constraint: string; value: number } => {
      if (!dynamics) {
        throw new CliError('dynamics_required', `${it.verb} requires dynamics`, {
          path: `${path}.dynamics`,
          exitCode: 2,
        });
      }
      return {
        shape: dynamics.shape,
        constraint: dynamics.constraint,
        value: evalNum(dynamics.value, scope, `${path}.dynamics.value`),
      };
    };

    const lateralDyn = (
      interaction: Extract<V2Interaction, { verb: 'changeLane' | 'laneOffset' }>,
    ): { shape: string; constraint: string; value: number } => {
      const legacy = dyn(interaction.dynamics);
      if (interaction.maneuverDurationS === undefined) return legacy;
      const style = interaction.maneuverStyle ?? 'normal';
      return {
        // Every style remains subject to the engine's physical envelopes.
        // Cautious eases in/out most strongly; assertive asks the bounded
        // controller to track a more direct profile.
        shape: style === 'cautious' ? 'sinusoidal' : style === 'assertive' ? 'linear' : 'cubic',
        constraint: 'time',
        value: evalNum(interaction.maneuverDurationS, scope, `${path}.maneuverDurationS`),
      };
    };

    switch (it.verb) {
      case 'speed': {
        const t = it.target;
        let target: unknown;
        switch (t.mode) {
          case 'absolute':
            target = { mode: 'absolute', value: Math.max(0, evalNum(t.valueKph, scope, `${path}.target.valueKph`) * KPH_TO_MPS) };
            break;
          case 'delta':
            target = { mode: 'delta', value: evalNum(t.deltaKph, scope, `${path}.target.deltaKph`) * KPH_TO_MPS };
            break;
          case 'factor':
            target = { mode: 'factor', value: Math.max(0, evalNum(t.factor, scope, `${path}.target.factor`)) };
            break;
          case 'match':
            target = {
              mode: 'match',
              actorId: t.role,
              offsetMps: evalNum(t.offsetKph, scope, `${path}.target.offsetKph`, 0) * KPH_TO_MPS,
            };
            break;
          case 'stop':
            target = { mode: 'stop' };
            break;
          case 'resume':
            // The engine's longitudinal controller is command-owned, so a
            // resume must actively replace the previous stop command. Resolve
            // it to the role's authored cruise speed (or the bound lane limit
            // when the actor intentionally starts at rest). This keeps resume
            // executable and gives XML exporters an ordinary absolute target.
            target = {
              mode: 'absolute',
              value: Math.max(0, (
                evalNum(this.roleById.get(it.actor)?.initialSpeedKph, scope, `${path}.target.resumeSpeedKph`, scope.lane?.speedLimitKph ?? 30)
              ) * KPH_TO_MPS),
            };
            this.notes.push({
              path,
              reason: 'speed(resume) materialized to the actor route-cruise speed',
              impact: 'informational',
            });
            break;
        }
        return parseInteraction({ ...base, verb: 'speed', target, dynamics: dyn(it.dynamics) });
      }
      case 'gap':
        return parseInteraction({
          ...base,
          verb: 'gap',
          target: { actorId: it.target.role },
          value: Math.max(0.01, evalNum(it.target.value, scope, `${path}.target.value`)),
          mode: it.target.unit,
          dynamics: dyn(it.dynamics),
        });
      case 'changeLane': {
        const t = it.target;
        let target: unknown;
        if (t.mode === 'relative') {
          if (t.dk === 0) {
            this.notes.push({ path, reason: 'changeLane with dk = 0 is a no-op; interaction dropped', impact: 'informational' });
            return null;
          }
          target = { mode: t.dk > 0 ? 'left' : 'right', count: Math.abs(t.dk) };
        } else if (t.mode === 'absolute') {
          const rsl = this.site.frame.lateralLanes[t.k];
          if (!rsl) {
            this.notes.push({ path, reason: `no lane at k = ${t.k} at this site; interaction dropped` });
            return null;
          }
          target = { mode: 'lane', rsl };
        } else {
          target = { mode: 'actorLane', actorId: t.role };
        }
        return parseInteraction({ ...base, verb: 'changeLane', target, dynamics: lateralDyn(it) });
      }
      case 'laneOffset':
        return parseInteraction({
          ...base,
          verb: 'laneOffset',
          target: { mode: 'fraction', value: evalNum(it.target.tFrac, scope, `${path}.target.tFrac`) },
          dynamics: lateralDyn(it),
        });
      case 'route': {
        const t = it.target;
        if (t.mode === 'nextJunction') {
          const actor = this.actors.find((candidate) => candidate.id === it.actor);
          const startRsl = actor?.initial.laneRef?.rsl;
          if (!actor || !startRsl) {
            throw new CliError(
              'route_turn_unbindable',
              `next-junction route for "${it.actor}" needs a lane-bound actor`,
              { path: `${path}.target` },
            );
          }
          const ordered = this.template.choreography.interactions
            .map((candidate, index) => ({ candidate, index }))
            .filter(({ candidate }) =>
              candidate.actor === it.actor &&
              candidate.verb === 'route' &&
              candidate.target.mode === 'nextJunction')
            .sort((a, b) => {
              const time = (candidate: V2Interaction): number =>
                candidate.trigger.kind === 'at'
                  ? evalNum(candidate.trigger.t, scope, `choreography.${candidate.id}.trigger.t`)
                  : Number.POSITIVE_INFINITY;
              return time(a.candidate) - time(b.candidate) || a.index - b.index;
            });
          const through = ordered.findIndex(({ candidate }) => candidate.id === it.id);
          const turns: TurnRelation[] = ordered.slice(0, through + 1).map(({ candidate }) => {
            if (candidate.verb !== 'route' || candidate.target.mode !== 'nextJunction') {
              throw new Error('filtered next-junction interaction lost its type');
            }
            return candidate.target.turn === 'straight'
              ? 'Straight'
              : candidate.target.turn === 'left'
                ? 'Left'
                : 'Right';
          });
          const distance = Math.max(
            100,
            actor.initial.speedMps *
              (this.template.choreography.clipSeconds + this.template.choreography.warmupSeconds) *
              1.6,
          );
          const built = buildFollowRoute(this.bundle.graph, startRsl, turns, distance);
          if (!built.ok) {
            throw new CliError(built.error.code, built.error.reason, {
              path: `${path}.target`, detail: built.error.detail,
            });
          }
          return parseInteraction({
            ...base,
            verb: 'route',
            target: { kind: 'lanePath', lanes: built.route.legs.map((leg) => leg.rsl) },
          });
        }
        if (t.mode === 'lanePath') {
          return parseInteraction({ ...base, verb: 'route', target: { kind: 'lanePath', lanes: t.lanes } });
        }
        if (t.mode === 'polyline') {
          const points = t.points.map((p, idx) => {
            const at = this.framePosePoint(p, scope, `${path}.target.points.${idx}`);
            const scene = toSceneXZ({ x: at.x, y: at.y });
            return { x: scene.x, z: scene.z };
          });
          return parseInteraction({ ...base, verb: 'route', target: { kind: 'polyline', points } });
        }
        if (t.mode === 'customRoute') {
          return parseInteraction({
            ...base,
            verb: 'route',
            target: { kind: 'polyline', points: t.points },
            joinFromCurrentPose: true,
            bestEffortWorldPath: true,
          });
        }
        if (t.mode === 'turn') {
          const match = this.site.featureMatches[t.feature];
          const actor = this.actors.find((candidate) => candidate.id === it.actor);
          if (!match || !actor || actor.behavior.route.kind !== 'lanePath') {
            throw new CliError('route_turn_unbindable', `turn route for "${it.actor}" is not backed by a concrete lane path`, {
              path: `${path}.target`,
              detail: { feature: t.feature, turn: t.turn },
            });
          }
          if (it.actor === this.template.metricSubject && this.site.frame.egoTurn !== t.turn) {
            throw new CliError('route_turn_mismatch', `catalog site binds ${this.site.frame.egoTurn ?? 'no'} ego turn, not ${t.turn}`, {
              path: `${path}.target.turn`,
              detail: { featureId: match.mapFeatureId, siteId: this.site.siteId },
            });
          }
          // The matcher already chose the exact movement and the actor's lane
          // path contains it. Keeping the authored trigger as a route action
          // records when the actor commits and re-projects its current pose onto
          // that bound movement without inventing a generic turn trajectory.
          return parseInteraction({ ...base, verb: 'route', target: actor.behavior.route });
        }
        this.notes.push({
          path,
          reason: `route(${t.mode}) is fixed by the role binding's lane chain at instantiation time; the timeline entry is redundant and was dropped`,
          impact: 'informational',
        });
        return null;
      }
      case 'exist':
        return parseInteraction({ ...base, verb: 'exist', target: { state: it.target.state } });
      case 'set': {
        const authoredControlKey = /^control:(.+)\.indication$/.exec(it.target.key);
        if (authoredControlKey) {
          const id = authoredControlKey[1]!;
          if (!this.template.trafficControls.some((control) => control.id === id)) {
            throw new CliError('control_unbound', `set() references unknown traffic control "${id}"`, {
              path: `${path}.target.key`, exitCode: 2,
            });
          }
          return parseInteraction({ ...base, verb: 'set', target: { key: `signal:control:${id}.phase`, value: it.target.value } });
        }
        const semanticSignalKey = /^signal:feature:([A-Za-z][A-Za-z0-9_-]{0,63}):(ego|opposing|left|right)\.(phase|program)$/.exec(it.target.key);
        const signalKey = semanticSignalKey ? null : /^signal:(.+)\.phase$/.exec(it.target.key);
        const signalProgram = semanticSignalKey
            ? this.resolveSignalProgram({ feature: semanticSignalKey[1]!, approach: semanticSignalKey[2] as 'ego' | 'opposing' | 'left' | 'right' }, `${path}.target`)
          : signalKey
            ? this.resolveSignalProgram({ handle: signalKey[1]! }, `${path}.target`)
          : null;
        const key = signalKey || semanticSignalKey
          ? (signalProgram ? `signal:${signalProgram}.phase` : null)
          : materializedSetKey(it.target.key, `${path}.target.key`);
        if (!key) {
          this.notes.push({
            path: `${path}.target.key`,
            reason: `set key "${it.target.key}" has no engine counterpart; interaction dropped`,
          });
          return null;
        }
        return parseInteraction({ ...base, verb: 'set', target: { key, value: it.target.value } });
      }
    }
  }

  private buildTrigger(
    trigger: V2Trigger,
    scope: ExprScope,
    path: string,
    frameSOffset = 0,
  ): SimTrigger | null {
    switch (trigger.kind) {
      case 'at':
        return { kind: 'at', t: evalNum(trigger.t, scope, `${path}.t`) };
      case 'after': {
        const delayS = Math.max(0, evalNum(trigger.delayS, scope, `${path}.delayS`, 0));
        const foldedAt = this.foldedTriggerStart.get(trigger.of);
        if (foldedAt !== undefined) {
          this.notes.push({
            path,
            reason: `after(${trigger.of}) references an interaction folded into initial state; materialized as at(${(foldedAt + delayS).toFixed(3)})`,
            impact: 'informational',
          });
          return { kind: 'at', t: foldedAt + delayS };
        }
        return {
          kind: 'after',
          interactionId: trigger.of,
          event: trigger.event,
          delayS,
        };
      }
      case 'when': {
        const condition = this.buildCondition(trigger.condition, scope, `${path}.condition`);
        if (!condition) return null;
        if (trigger.byLatest === undefined) {
          throw new CliError('bylatest_required', 'when() requires byLatest', {
            path: `${path}.byLatest`,
            exitCode: 2,
          });
        }
        return {
          kind: 'when',
          condition,
          byLatest: evalNum(trigger.byLatest, scope, `${path}.byLatest`),
          ifNever: trigger.ifNever,
        };
      }
      case 'arrival': {
        let at = this.arrivalPoint(trigger.at, scope, `${path}.at`, frameSOffset);
        if (!at) return null;
        if ('feature' in trigger.at) {
          const ofRoute = this.routeByRole.get(trigger.of);
          const syncRoute = this.routeByRole.get(trigger.syncWith);
          if (ofRoute && syncRoute && (ofRoute.isFreeform || syncRoute.isFreeform)) {
            const authored = localFromScene(at.at);
            const conflict = routeIntersectionNear(ofRoute, syncRoute, authored);
            if (conflict && Math.hypot(conflict.x - authored.x, conflict.y - authored.y) <= 20) {
              at = { kind: 'point', at: toSceneXZ(conflict) };
              this.notes.push({
                path: `${path}.at`,
                reason: `mapped feature point resolved to the exact ${trigger.of}/${trigger.syncWith} route intersection`,
                impact: 'informational',
              });
            }
          }
        }
        const ttc = trigger.ttc === undefined ? undefined : evalNum(trigger.ttc, scope, `${path}.ttc`);
        const deltaT =
          trigger.deltaT === undefined ? undefined : evalNum(trigger.deltaT, scope, `${path}.deltaT`);
        return {
          kind: 'arrival',
          arrival: {
            of: trigger.of,
            at,
            syncWith: trigger.syncWith,
            ...(ttc === undefined ? {} : { ttc }),
            ...(deltaT === undefined ? {} : { deltaT }),
          },
        };
      }
    }
  }

  private arrivalPoint(
    ref: PointRef,
    scope: ExprScope,
    path: string,
    frameSOffset = 0,
  ): { kind: 'point'; at: { x: number; z: number }; referenceFrame?: { stations: Array<{ rsl: string; s: number }> } } | null {
    const world = this.pointOf(ref, scope, path, frameSOffset);
    if (!world) return null;
    const scene = toSceneXZ(world);
    const base = { kind: 'point' as const, at: { x: scene.x, z: scene.z } };
    if ('pose' in ref && this.refRoute) {
      const frameS = frameSOffset + evalNum(ref.pose.s, scope, `${path}.pose.s`, 0);
      const frameCenter = this.framePoint(frameS);
      const stations = new Map<string, number>();

      // These are not nearest-road guesses: every route here already belongs
      // to a role bound into this anchor frame. Projecting the frame centre onto
      // those known routes records the equivalent longitudinal cross-section
      // for each lane. The engine can then solve by exact lane identity while a
      // freeform crossing route still has to pass geometrically through `at`.
      for (const route of [this.refRoute, ...this.routeByRole.values()]) {
        if (route.isFreeform) continue;
        const projected = route.projectPoint({ x: frameCenter.x, y: frameCenter.y });
        const pose = route.poseAt(projected.s);
        if (pose.rsl && !stations.has(pose.rsl)) stations.set(pose.rsl, pose.storageS);
      }
      if (stations.size > 0) {
        return {
          ...base,
          referenceFrame: {
            stations: [...stations].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([rsl, s]) => ({ rsl, s })),
          },
        };
      }
    }
    return base;
  }

  /** Resolve a `PointRef` into an xodr-local point, where that is possible. */
  private pointOf(
    ref: PointRef,
    scope: ExprScope,
    path: string,
    frameSOffset = 0,
  ): { x: number; y: number } | null {
    if ('pose' in ref) {
      const at = this.framePosePoint(ref.pose, scope, `${path}.pose`, frameSOffset);
      return { x: at.x, y: at.y };
    }
    if ('feature' in ref) {
      const match = this.site.featureMatches[ref.feature];
      if (!match) {
        this.notes.push({ path, reason: `feature "${ref.feature}" is not bound at this site` });
        return null;
      }
      if (match.mapFeatureId.startsWith('junction:')) {
        // The conflict point of whichever conflicting role uses this feature is
        // a far better aim point than the junction centroid: it is where the
        // paths actually cross.
        for (const binding of this.site.bindings) {
          if (binding.conflict && this.roleById.get(binding.role)?.kind === 'conflicting_gate') {
            const role = this.roleById.get(binding.role) as Extract<V2Role, { kind: 'conflicting_gate' }>;
            if (role.feature === ref.feature) return binding.conflict.point;
          }
        }
      }
      const at = this.framePoint(match.s);
      return { x: at.x, y: at.y };
    }
    this.notes.push({
      path,
      reason: 'a point measured against a moving role is not expressible as a fixed arrival point',
    });
    return null;
  }

  private buildCondition(
    condition: V2Condition,
    scope: ExprScope,
    path: string,
  ): SimCondition | undefined {
    switch (condition.kind) {
      case 'ttc':
        return {
          kind: 'ttc',
          a: condition.of,
          b: condition.to,
          cmp: CMP[condition.op] as 'lte' | 'gte',
          value: Math.max(0, evalNum(condition.valueS, scope, `${path}.valueS`)),
        };
      case 'headway':
        return {
          kind: 'headway',
          a: condition.of,
          b: condition.to,
          cmp: CMP[condition.op] as 'lte' | 'gte',
          value: Math.max(0, evalNum(condition.valueS, scope, `${path}.valueS`)),
        };
      case 'distance': {
        const to = condition.to;
        if ('role' in to) {
          return {
            kind: 'distance',
            a: condition.from,
            b: to.role,
            mode: condition.measure,
            cmp: CMP[condition.op] as 'lte' | 'gte',
            value: Math.max(0, evalNum(condition.valueM, scope, `${path}.valueM`)),
            ...(condition.hysteresisM === undefined ? {} : {
              hysteresis: Math.max(0, evalNum(condition.hysteresisM, scope, `${path}.hysteresisM`)),
            }),
          };
        }
        // Distance to a fixed place is `reaches` with an explicit radius.
        const point = this.pointOf(to, scope, `${path}.to`);
        if (!point) return undefined;
        const scene = toSceneXZ(point);
        return {
          kind: 'reaches',
          actorId: condition.from,
          region: {
            kind: 'circle',
            center: { x: scene.x, z: scene.z },
            radiusM: Math.max(0.5, evalNum(condition.valueM, scope, `${path}.valueM`)),
          },
        };
      }
      case 'reaches': {
        const point = this.pointOf(condition.region, scope, `${path}.region`);
        if (!point) return undefined;
        const scene = toSceneXZ(point);
        return {
          kind: 'reaches',
          actorId: condition.of,
          region: {
            kind: 'circle',
            center: { x: scene.x, z: scene.z },
            radiusM: Math.max(0.5, evalNum(condition.toleranceM, scope, `${path}.toleranceM`, 3)),
          },
        };
      }
      case 'speed':
        return {
          kind: 'speed',
          actorId: condition.of,
          cmp: CMP[condition.op] as 'lte' | 'gte',
          value: Math.max(0, evalNum(condition.valueKph, scope, `${path}.valueKph`) * KPH_TO_MPS),
        };
      case 'standstill':
        return {
          kind: 'standstill',
          actorId: condition.of,
          durationS: Math.max(0, evalNum(condition.forS, scope, `${path}.forS`)),
        };
      case 'visible':
        return { kind: 'visible', a: condition.of, to: condition.to, value: condition.visible };
      case 'detected':
        // `visible` is geometry; `detected` asks the observer's sensor suite.
        return {
          kind: 'detected',
          a: condition.of,
          by: condition.by,
          ...(condition.sensor === undefined ? {} : { sensor: condition.sensor }),
          value: condition.detected,
        };
      case 'collision':
        return {
          kind: 'collision',
          a: condition.of,
          ...(condition.with === 'any' ? {} : { b: condition.with }),
        };
      case 'signal':
        {
          const signalId = this.resolveSignalProgram(condition.signal, path);
          if (!signalId) return undefined;
          return { kind: 'signal', signalId, phase: condition.phase };
        }
      case 'and':
      case 'or': {
        const operands = condition.operands
          .map((operand, i) => this.buildCondition(operand, scope, `${path}.operands.${i}`))
          .filter((c): c is SimCondition => c !== undefined);
        if (operands.length === 0) return undefined;
        if (operands.length === 1) return operands[0];
        return { kind: condition.kind, of: operands } as SimCondition;
      }
      case 'not': {
        const operand = this.buildCondition(condition.operand, scope, `${path}.operand`);
        return operand ? ({ kind: 'not', of: operand } as SimCondition) : undefined;
      }
    }
  }

  private resolveSignalProgram(ref: SignalRef, path: string): string | null {
    if ('control' in ref) {
      if (!this.template.trafficControls.some((control) => control.id === ref.control)) {
        throw new CliError('control_unbound', `condition references unknown traffic control "${ref.control}"`, { path, exitCode: 2 });
      }
      return `control:${ref.control}`;
    }
    const plan = this.signalPlan ?? buildSiteSignalPlan(this.bundle, this.site);
    this.signalPlan = plan;
    const signalId = resolveSiteSignalProgram(
      this.bundle,
      this.site,
      plan,
      'handle' in ref
        ? { handle: ref.handle }
        : { featureId: ref.feature, approach: ref.approach },
    );
    if (signalId) return signalId;
    const description =
      'handle' in ref
        ? `map signal handle "${ref.handle}" is not controlled at site junction ${plan.junctionId ?? '<none>'}`
        : `no physical signal head binds the ${ref.approach} movement for feature "${ref.feature}" at site junction ${plan.junctionId ?? '<none>'}`;
    throw new CliError('signal_unbindable', description, {
      path: 'handle' in ref ? `${path}.signal.handle` : `${path}.signal.approach`,
      detail: {
        junctionId: plan.junctionId,
        timingSource: plan.timingSource,
        stateSource: plan.stateSource,
      },
    });
  }

  private declareOcclusionPair(pair: { observer: string; target: string; occluderId?: string }): void {
    if (!this.actors.some((a) => a.id === pair.observer) || !this.actors.some((a) => a.id === pair.target)) {
      this.notes.push({
        path: 'occlusionPairs',
        reason: `occlusion pair ${pair.observer}/${pair.target} references a role that was not materialized`,
      });
      return;
    }
    if (pair.occluderId?.startsWith('actor:')) {
      const occluderActor = pair.occluderId.slice('actor:'.length);
      if (!this.actors.some((actor) => actor.id === occluderActor)) {
        this.notes.push({
          path: 'occlusionPairs',
          reason: `occlusion pair ${pair.observer}/${pair.target} references occluder role ${occluderActor} that was not materialized`,
        });
        return;
      }
    }
    if (pair.occluderId?.startsWith('actor:')) {
      const actorId = pair.occluderId.slice('actor:'.length);
      if (!this.actors.some((actor) => actor.id === actorId)) {
        this.notes.push({
          path: 'occlusionPairs',
          reason: `occlusion pair ${pair.observer}/${pair.target} depends on absent actor occluder ${actorId}; pair omitted`,
        });
        return;
      }
    }
    const key = `${pair.observer}\0${pair.target}\0${pair.occluderId ?? ''}`;
    const existing = this.occlusionPairs.some(
      (p) => `${p.observer}\0${p.target}\0${p.occluderId ?? ''}` === key,
    );
    if (!existing) this.occlusionPairs.push(pair);
  }

  /* ------------------------------------------------------------ perception */

  /**
   * The sensor passthrough.
   *
   * Roles have carried a `sensors` array since the schema was written, and
   * nothing consumed it: `parseSimScenarioInput` silently *stripped* the field,
   * so a template could declare a dash camera, validate clean, and simulate as
   * though it had said nothing. This is the seam that was missing.
   *
   * It runs after the actors are built rather than inside `buildActor`, so the
   * lowering stays one reviewable block and cannot perturb placement.
   */
  private applyRoleSensors(): void {
    for (const role of this.template.roles) {
      if (role.actor.sensors.length === 0) continue;
      const index = this.actors.findIndex((actor) => actor.id === role.id);
      if (index < 0) {
        // Refuse to lose the declaration quietly. A sensor that vanishes is the
        // exact failure this layer exists to make impossible.
        throw new CliError(
          'sensor_actor_unavailable',
          `role "${role.id}" declares ${role.actor.sensors.length} sensor(s) but has no concrete actor at this site`,
          { path: `roles.${role.id}.sensors`, exitCode: 2 },
        );
      }
      this.actors[index] = {
        ...this.actors[index]!,
        sensors: role.actor.sensors.map((sensor) => lowerSensor(sensor)),
      };
    }
  }

  /**
   * Atmosphere from `environment`, plus any declared map/percept divergence.
   *
   * Returns `undefined` when the scenario says nothing about perception and
   * nothing carries a sensor, so an existing document's input hash is
   * unchanged — the field is `.optional()` on `SimScenarioInput` for exactly
   * that reason.
   */
  private buildPerception(): SimPerceptionConfig | undefined {
    const hasSensor = this.actors.some((actor) => (actor.sensors?.length ?? 0) > 0);
    const declared = this.template.perception.mapDivergences;
    if (!hasSensor && declared.length === 0) return undefined;
    const scope = this.baseScope();
    // A site always has a reference chain; the null guard keeps the sun bearing
    // well defined rather than silently rotating glare to due east.
    const referenceHeadingRad = this.refRoute === null ? 0 : this.refRoute.poseAt(0).headingRad;
    const divergences = declared.flatMap((divergence) =>
      lowerMapDivergence(divergence, {
        windows: (fromFrac, toFrac, lane) => this.divergenceWindows(divergence.id, fromFrac, toFrac, lane),
        rolePose: (role) => {
          const actor = this.actors.find((candidate) => candidate.id === role);
          return actor ? { x: actor.initial.pose.x, z: actor.initial.pose.z } : undefined;
        },
      }),
    );
    for (const divergence of declared) {
      if (divergence.extent.kind === 'corridor' && !divergences.some((d) => d.id === divergence.id || d.id.startsWith(`${divergence.id}:`))) {
        this.notes.push({
          path: `perception.mapDivergences.${divergence.id}`,
          reason: 'divergence covers no drivable lane at this site; omitted',
        });
      }
    }
    return {
      atmosphere: atmosphereFromEnvironment(
        this.template.environment,
        referenceHeadingRad,
        (value, path) => evalNum(value, scope, path, 0),
      ),
      mapDivergences: divergences,
    } as SimPerceptionConfig;
  }

  /** Lane windows covered by a corridor-relative divergence interval. */
  private divergenceWindows(
    id: string,
    fromFrac: number,
    toFrac: number,
    lane: number | undefined,
  ): DivergenceWindow[] {
    const rsl = lane === undefined || lane === 0 ? null : this.site.frame.lateralLanes[lane];
    if (lane !== undefined && lane !== 0 && !rsl) {
      this.notes.push({
        path: `perception.mapDivergences.${id}.extent.lane`,
        reason: `no lane at k = ${lane} at this site; divergence omitted`,
      });
      return [];
    }
    const route = rsl
      ? routeFromChain(this.bundle.graph, [rsl], rsl, this.notes, `perception.mapDivergences.${id}`)
      : this.refRoute;
    if (route === null || route === undefined) return [];
    const lo = Math.max(0, Math.min(fromFrac, toFrac)) * route.lengthM;
    const hi = Math.min(1, Math.max(fromFrac, toFrac)) * route.lengthM;
    const windows: DivergenceWindow[] = [];
    for (const leg of route.legs) {
      const legLo = Math.max(lo, leg.sStart);
      const legHi = Math.min(hi, leg.sStart + leg.lengthM);
      if (legHi - legLo <= 1e-6) continue;
      // Route `s` runs along the leg's travel direction; a reversed leg stores
      // its arc length the other way round.
      const a = leg.reversed ? leg.lengthM - (legHi - leg.sStart) : legLo - leg.sStart;
      const b = leg.reversed ? leg.lengthM - (legLo - leg.sStart) : legHi - leg.sStart;
      windows.push({ rsl: leg.rsl, sMin: Math.max(0, Math.min(a, b)), sMax: Math.max(0, Math.max(a, b)) });
    }
    return windows;
  }

  private buildRoleOcclusionPairs(): void {
    for (const role of this.template.roles) {
      const raw = role.extensions?.['occludes'];
      if (!raw || typeof raw !== 'object') continue;
      const pair = raw as { observer?: unknown; target?: unknown };
      if (typeof pair.observer !== 'string' || typeof pair.target !== 'string') {
        this.notes.push({ path: `roles.${role.id}.extensions.occludes`, reason: 'occlusion declaration is not {observer,target}' });
        continue;
      }
      this.declareOcclusionPair({ observer: pair.observer, target: pair.target, occluderId: `actor:${role.id}` });
    }
  }

  /* -------------------------------------------------------------- surfaces */

  /**
   * Lower `environment.surfacePatches` onto the site.
   *
   * The authored patch is a longitudinal interval of the corridor; the engine
   * wants lane windows, because grip has to be answered per actor per tick from
   * the actor's own lane position. A patch that spans a lane boundary of the
   * reference chain therefore becomes one window per crossed lane — which is
   * also why this walks the route legs rather than emitting a single window and
   * hoping the corridor is one lane all the way.
   *
   * An empty `laneOffsets` means every same-direction lane the site knows
   * about, which is what a weather-like covering actually does. That is the
   * common case and it is also the safe one: 87.8% of non-junction sections on
   * these maps have exactly one driving lane per direction, so asking for a
   * specific non-zero offset usually asks for a lane that is not there.
   */
  private buildSurfacePatches(): SimSurfacePatch[] {
    const patches: SimSurfacePatch[] = [];
    const scope = this.baseScope();
    for (const patch of this.template.environment.surfacePatches) {
      const path = `environment.surfacePatches.${patch.id}`;
      const featureOffset = patch.feature
        ? this.site.featureMatches[patch.feature]?.s
        : 0;
      if (featureOffset === undefined) {
        if (patch.essentiality === 'required') {
          throw new CliError(
            'surface_patch_feature_unbound',
            `required surface patch "${patch.id}" is anchored to feature "${patch.feature}", which is not bound at this site`,
            { path: `${path}.feature`, detail: { feature: patch.feature, siteId: this.site.siteId }, exitCode: 2 },
          );
        }
        this.notes.push({ path: `${path}.feature`, reason: `feature "${patch.feature}" is not bound at this site; patch omitted` });
        continue;
      }
      const startFrameS = featureOffset + evalNum(patch.atM, scope, `${path}.atM`, 0);
      const lengthM = evalNum(patch.lengthM, scope, `${path}.lengthM`, 0);
      if (!(lengthM > 0)) {
        this.notes.push({ path: `${path}.lengthM`, reason: `patch length resolved to ${lengthM} m; patch omitted` });
        continue;
      }
      const frictionScale = patch.frictionScale === undefined
        ? undefined
        : evalNum(patch.frictionScale, scope, `${path}.frictionScale`);
      const edgeTaperM = Math.max(0, evalNum(patch.edgeTaperM, scope, `${path}.edgeTaperM`, 0));

      const offsets = patch.laneOffsets.length > 0
        ? [...new Set(patch.laneOffsets)].sort((a, b) => a - b)
        : [...new Set([0, ...Object.keys(this.site.frame.lateralLanes).map(Number)])]
            .filter((k) => Number.isFinite(k))
            .sort((a, b) => a - b);

      const windows: Array<{ rsl: string; sMin: number; sMax: number }> = [];
      for (const k of offsets) {
        const route = this.surfaceRouteAt(k, path);
        if (!route) continue;
        // Project the two frame endpoints onto whichever lane chain this offset
        // resolved to: `s` restarts on every lane of a chain, so the interval
        // cannot be carried across as a pair of numbers.
        const from = route.projectPoint(this.framePoint(startFrameS)).s;
        const to = route.projectPoint(this.framePoint(startFrameS + lengthM)).s;
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        for (const leg of route.legs) {
          const legLo = Math.max(lo, leg.sStart);
          const legHi = Math.min(hi, leg.sStart + leg.lengthM);
          if (legHi - legLo <= 1e-6) continue;
          // Route `s` runs along the leg's travel direction; a reversed leg
          // stores its arc length the other way round.
          const a = leg.reversed ? leg.lengthM - (legHi - leg.sStart) : legLo - leg.sStart;
          const b = leg.reversed ? leg.lengthM - (legLo - leg.sStart) : legHi - leg.sStart;
          windows.push({ rsl: leg.rsl, sMin: Math.max(0, Math.min(a, b)), sMax: Math.max(0, Math.max(a, b)) });
        }
      }
      if (windows.length === 0) {
        if (patch.essentiality === 'required') {
          throw new CliError(
            'surface_patch_unplaceable',
            `required surface patch "${patch.id}" covers no drivable lane at this site`,
            { path, detail: { atM: startFrameS, lengthM, siteId: this.site.siteId }, exitCode: 2 },
          );
        }
        this.notes.push({ path, reason: 'patch covers no drivable lane at this site; omitted' });
        continue;
      }
      const seen = new Set<string>();
      for (const window of windows) {
        const key = `${window.rsl} ${window.sMin.toFixed(3)} ${window.sMax.toFixed(3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        patches.push({
          id: windows.length === 1 ? patch.id : `${patch.id}:${seen.size - 1}`,
          kind: patch.kind,
          region: { kind: 'laneWindow', rsl: window.rsl, sMin: window.sMin, sMax: window.sMax },
          ...(frictionScale === undefined ? {} : { frictionScale }),
          edgeTaperM,
          ...(patch.label ? { label: patch.label } : {}),
        });
      }
    }
    return patches;
  }

  /** The lane chain a surface patch at same-direction lane index `k` sits on. */
  private surfaceRouteAt(k: number, path: string): Route | null {
    if (k === 0) return this.refRoute;
    const rsl = this.site.frame.lateralLanes[k];
    if (!rsl) {
      this.notes.push({ path: `${path}.laneOffsets`, reason: `no lane at k = ${k}; that offset is not covered` });
      return null;
    }
    return routeFromChain(this.bundle.graph, [rsl], rsl, this.notes, `${path}.laneOffsets`);
  }

  /* ------------------------------------------------------------------ props */

/**
   * Solve every authored lane closure into devices, an availability override, and a shifted path.
   *
   * One description in, three consistent products out:
   *
   *   1. an engine `laneClosures` entry — the drivable-surface override, hashed with the input;
   *   2. an MUTCD device layout — taper length from the design speed and the closed width
   *      (L = W·S²/60 below 40 mph, L = W·S above), device spacing S/2 ft, an arrow board at the
   *      taper head and an advance warning sign upstream;
   *   3. the open corridor's centreline offset, which traffic is shifted onto.
   *
   * The author supplies no geometry. Device poses and the detour offset are computed from the SAME
   * numbers, so contact-free passage is a property of the representation rather than of a lucky
   * choice of offsets. Authoring the two separately is what leaves residual contacts: measured
   * 15/60 cells with a hand-authored detour against the solved layout below.
   */
/**
   * Narrowest lane width over the span a closure occupies, including its taper and advance area.
   *
   * Sampled from the reference route rather than taken from the lane's representative width, so the
   * device layout and the running corridor are both sized for the worst section they cross.
   */
  private narrowestWidthOver(fromS: number, toS: number, closure: { readonly laneOffset: number }): number {
    const fallback = this.referenceLaneWidth();
    const route = this.refRoute;
    if (!route || closure.laneOffset !== 0) return fallback;
    const origin = this.site.frame.sRange[0];
    // Widen the sampled span generously: the taper starts upstream of `fromS` and the advance
    // warning further upstream still, and none of those may sit inside the running lane either.
    const lo = fromS - 200;
    const hi = toS + 40;
    let narrowest = Infinity;
    const steps = 40;
    for (let i = 0; i <= steps; i += 1) {
      const s = lo + ((hi - lo) * i) / steps - origin;
      if (s < 0 || s > route.lengthM) continue;
      const w = route.widthAt(s);
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) narrowest = Math.min(narrowest, w);
    }
    return Number.isFinite(narrowest) ? narrowest : fallback;
  }

/**
   * Reject a closure whose works do not fit inside the drivable reference route.
   *
   * Checked in the route's own station space, because that is where `poseAt` clamps.
   */
  private assertClosureFitsRoute(id: string, path: string, firstFrameS: number, lastFrameS: number): void {
    const route = this.refRoute;
    if (!route) return;
    const origin = this.site.frame.sRange[0];
    const first = firstFrameS - origin;
    const last = lastFrameS - origin;
    if (first >= 0 && last <= route.lengthM) return;
    throw new CliError(
      'closure_exceeds_route',
      `closure ${id} spans ${firstFrameS.toFixed(0)}..${lastFrameS.toFixed(0)} m of the frame, which ` +
      `falls outside the ${route.lengthM.toFixed(0)} m drivable reference route at this site`,
      {
        path,
        detail: {
          siteId: this.site.siteId,
          routeLengthM: Number(route.lengthM.toFixed(2)),
          requiredRouteSpan: [Number(first.toFixed(2)), Number(last.toFixed(2))],
          hint: 'require a longer corridor.runwayDownstreamM, or author the works closer to the frame origin',
        },
        exitCode: 2,
      },
    );
  }

  private buildClosures(): void {
    const closures = this.template.closures ?? [];
    if (closures.length === 0) return;
    const scope = this.baseScope();
    for (const closure of closures) {
      const path = `closures.${closure.id}`;
      const fromS = evalNum(closure.fromS, scope, `${path}.fromS`, 0);
      const toS = evalNum(closure.toS, scope, `${path}.toS`, 0);
      if (toS < fromS) {
        throw new CliError('closure_span_inverted', `closure ${closure.id} ends before it starts`, {
          path, detail: { fromS, toS }, exitCode: 2,
        });
      }
      // Design against the NARROWEST section the closure spans, not a representative width for the
      // lane as a whole. `referenceLaneWidth()` is one number for the whole entry lane; where the
      // carriageway pinches, a device placed at "the lane edge" lands inside the running lane and
      // the ego clips it. Measured: all 8 residual contacts were `wz-taper-0` / `wz-taper-1`, the
      // devices nearest the edge, at three sites where the local width is below the representative.
      const laneWidth = this.narrowestWidthOver(fromS, toS, closure);
      const requested = Math.min(
        Math.max(0, evalNum(closure.closedWidthM, scope, `${path}.closedWidthM`, 0)),
        laneWidth,
      );
      // A closure that leaves less road than the widest vehicle that must pass is not a lane
      // closure with a shift -- it is a road closure, and every cell then ends in contact by
      // construction. Measured: closing 1.54 m of a 3.23 m lane leaves 1.69 m for a 1.82 m car and
      // produced contact in 24/60 cells. So the corridor width is solved, not assumed: take as much
      // as can be taken while a passable lane remains, and say so in the notes.
      const widestActorW = this.actors.reduce((w, a) => Math.max(w, a.dims?.w ?? 0), 0)
        || DEFAULT_ACTOR_DIMS.car.width;
      const minPassableM = widestActorW + 2 * CLOSURE_SIDE_CLEARANCE_M;
      let closedWidth = requested;
      if (closure.shiftTraffic && laneWidth - requested < minPassableM) {
        const allowed = laneWidth - minPassableM;
        if (allowed < CLOSURE_MIN_USEFUL_M) {
          throw new CliError(
            'closure_lane_too_narrow',
            `lane is ${laneWidth.toFixed(2)} m wide; a shifted closure needs ${minPassableM.toFixed(2)} m ` +
            'of running lane plus a useful closed width, so this site cannot host this closure',
            { path, detail: { laneWidthM: laneWidth, minPassableM, requestedClosedWidthM: requested,
                              hint: 'require a wider corridor, or set shiftTraffic:false to author a road that is genuinely shut' },
              exitCode: 2 },
          );
        }
        this.notes.push({
          path,
          reason: `closed width reduced ${requested.toFixed(2)} m -> ${allowed.toFixed(2)} m so a ` +
            `${minPassableM.toFixed(2)} m running lane remains for the widest actor (${widestActorW.toFixed(2)} m)`,
        });
        closedWidth = allowed;
      }
      // Lateral convention: + is left, so a closure on the right has sign −1.
      const sign = closure.side === 'right' ? -1 : 1;
      const openWidth = laneWidth - closedWidth;
      // Inner boundary of the works, from the lane centreline.
      const worksEdge = sign * (laneWidth / 2 - closedWidth);
      // Centre of what is left, on the far side of the works edge.
      const openCentre = openWidth <= 0 ? worksEdge : worksEdge - sign * (openWidth / 2);
      const speedKph = closure.assumedSpeedKph === undefined
        ? (this.bundle.index.lanes[this.site.frame.entryLaneRsl]?.speedLimitKph ?? 40)
        : evalNum(closure.assumedSpeedKph, scope, `${path}.assumedSpeedKph`, 40);
      const taperLenM = mutcdTaperLengthM(speedKph, Math.max(closedWidth, 0.5));
      const spacingM = Math.max(6, speedKph / 3.281 / 2);
      const deviceCount = Math.max(4, Math.round(taperLenM / spacingM));
      const advanceM = closure.advanceWarningM === undefined
        ? Math.max(45, taperLenM * 1.5)
        : evalNum(closure.advanceWarningM, scope, `${path}.advanceWarningM`, 45);
      const catalogId = CLOSURE_DEVICE_CATALOG[closure.device];
      const essentiality = closure.essentiality;
      const taperStartS = fromS - taperLenM;
      const laneEdge = sign * (laneWidth / 2);

      // The whole works -- advance sign, taper, activity area and the run-out beyond it -- has to
      // FIT on the reference route. `Route.poseAt` clamps beyond the route end, so a closure
      // authored past it does not fail: every station downstream collapses onto the same point, the
      // shifted path degenerates, and the ego is left with a route it cannot follow. Measured
      // signature: a 25-50 m closure mapping to 6.7 m of storage station, and 57/144 cells with the
      // ego showing a spawn speed but travelling 0.0 m -- a frozen ego, which then trivially avoids
      // every cone. This is the same clamp defect as TG-A2 and it gets the same treatment: refuse
      // loudly instead of emitting a scenario that silently measures nothing.
      const exitRunM = Math.max(25, toS - fromS);
      this.assertClosureFitsRoute(closure.id, path, taperStartS - advanceM, toS + exitRunM);

      const generated: PropPlacementInput[] = [];
      for (let i = 0; i < deviceCount; i += 1) {
        const f = deviceCount === 1 ? 1 : i / (deviceCount - 1);
        generated.push({
          id: `${closure.id}-taper-${i}`, catalogId, essentiality,
          label: `${closure.id} MUTCD taper ${taperLenM.toFixed(0)} m`,
          pose: { laneOffset: closure.laneOffset, s: taperStartS + f * taperLenM,
                  lateralM: laneEdge + (worksEdge - laneEdge) * f,
                  lateralRef: 'lane_centre', headingOffsetRad: 0 },
          headingOffsetRad: 0, scale: 1,
        });
      }
      const activityCount = Math.max(2, Math.round((toS - fromS) / spacingM) + 1);
      for (let i = 0; i < activityCount; i += 1) {
        const f = activityCount === 1 ? 0 : i / (activityCount - 1);
        generated.push({
          id: `${closure.id}-works-${i}`, catalogId, essentiality,
          label: `${closure.id} activity area`,
          pose: { laneOffset: closure.laneOffset, s: fromS + f * (toS - fromS),
                  lateralM: worksEdge, lateralRef: 'lane_centre', headingOffsetRad: 0 },
          headingOffsetRad: 0, scale: 1,
        });
      }
      generated.push({
        id: `${closure.id}-board`, catalogId: 'construction.arrow_board', essentiality,
        label: `${closure.id} arrow board`,
        pose: { laneOffset: closure.laneOffset, s: taperStartS - 4,
                lateralM: laneEdge, lateralRef: 'lane_centre', headingOffsetRad: 0 },
        headingOffsetRad: 0, scale: 1,
      });
      generated.push({
        id: `${closure.id}-advance`, catalogId: 'construction.sign_road_work', essentiality,
        label: `${closure.id} advance warning`,
        pose: { laneOffset: closure.laneOffset, s: taperStartS - advanceM,
                lateralM: sign * 1.2, lateralRef: 'verge', headingOffsetRad: 0 },
        headingOffsetRad: 0, scale: 1,
      });

      this.generatedClosureProps.push(...generated);
      this.closurePlans.push({
        id: closure.id, laneOffset: closure.laneOffset, fromS, toS, taperStartS, advanceM,
        openCentre, openWidth, closedWidth, side: closure.side,
        shiftTraffic: closure.shiftTraffic,
      });
    }
  }

  /**
   * Shift traffic onto the open corridor for the length of every closure.
   *
   * Emitted as an ordinary `route` polyline so it goes through the same, already-proven path the
   * engine uses for every other authored trajectory — this is `reroute_ego`, expressed in the
   * representation rather than bolted beside it. The vertices come from the closure plan, so the
   * path and the devices are two views of one description.
   */
  private buildClosureDetours(): void {
    const plans = this.closurePlans.filter((plan) => plan.shiftTraffic && plan.openWidth > 0);
    if (plans.length === 0) return;
    const subject = this.template.metricSubject;
    for (const role of this.template.roles) {
      if (role.kind !== 'on_reference') continue;
      if (subject !== undefined && role.id !== subject) continue;
      // A `route` polyline is the actor's WHOLE path, so it has to begin where the actor already
      // is. Starting it at the taper (which is downstream) left the ego unable to reach its own
      // route and it never moved at all: measured 36/456 cells with the ego travelling >= 10 m,
      // median distance 0.0 m. A frozen ego trivially hits no cones, which is exactly the false
      // pass gate criterion C1 exists to catch.
      const spawnS = evalNum(rolePose(role)?.s ?? 0, this.baseScope(), `roles.${role.id}.pose.s`, 0);
      for (const plan of plans) {
        if (plan.taperStartS <= spawnS + CLOSURE_MIN_APPROACH_M) continue;  // no room to shift
        const points = this.shiftProfilePoints(plan, spawnS);
        if (points.length < 4) continue;
        const built = this.buildInteraction({
          id: `${plan.id}-shift-${role.id}`,
          actor: role.id,
          verb: 'route',
          trigger: { kind: 'at', t: 0 },
          target: { mode: 'polyline', points },
        } as never);
        if (built) this.interactions.push(built);
      }
    }
  }

/**
   * The engine-side availability override, in the closed lane's own storage stations.
   *
   * This is the part that makes a closure a fact about the road rather than a pile of props: it is
   * inside the simulation input, so it is hashed, it replays, and a consumer can see that part of
   * the carriageway is not drivable without inferring it from cone positions.
   */
/**
   * The shifted path through a closure, sampled UNIFORMLY along the corridor.
   *
   * Emitting one vertex per landmark (spawn, approach, taper head, works start, works end, run-out)
   * looks tidy and is unfollowable: when the works sit close to the spawn, the first two landmarks
   * collapse to within a few metres of each other and the polyline acquires a ~25 degree kink 3 m in
   * front of a 4.7 m vehicle doing 10 m/s. Measured: with that polyline 86 of 143 cells had the ego
   * driving; with no polyline at all, 647 of 654. The path, not the closure, was stopping the ego.
   *
   * Sampling the lateral profile at a fixed spacing instead gives a well-conditioned polyline with
   * no coincident vertices and no kinks, and it makes the taper a taper rather than a corner. The
   * ramp is a smoothstep over the MUTCD taper length: the taper length still sets how long the shift
   * takes, the smoothstep only removes the two curvature discontinuities at its ends.
   */
  private shiftProfilePoints(
    plan: ClosurePlan,
    spawnS: number,
  ): Array<{ laneOffset: number; s: number; lateralM: number; lateralRef: 'lane_centre'; headingOffsetRad: number }> {
    const exitRunM = Math.max(25, plan.toS - plan.fromS);
    const endS = plan.toS + exitRunM;
    const taperLenM = Math.max(1, plan.fromS - plan.taperStartS);
    const step = Math.max(4, Math.min(10, taperLenM / 4));

    const lateralAt = (s: number): number => {
      if (s <= plan.taperStartS) return 0;
      if (s >= plan.toS) {
        const back = (s - plan.toS) / exitRunM;
        const u = Math.min(1, Math.max(0, back));
        return plan.openCentre * (1 - (u * u * (3 - 2 * u)));
      }
      if (s >= plan.fromS) return plan.openCentre;
      const u = (s - plan.taperStartS) / taperLenM;
      return plan.openCentre * (u * u * (3 - 2 * u));
    };

    const out: Array<{ laneOffset: number; s: number; lateralM: number; lateralRef: 'lane_centre'; headingOffsetRad: number }> = [];
    let last = -Infinity;
    for (let s = spawnS; s <= endS + 1e-6; s += step) {
      if (s - last < step - 1e-6 && out.length > 0) continue;
      out.push({ laneOffset: plan.laneOffset, s, lateralM: lateralAt(s),
                 lateralRef: 'lane_centre', headingOffsetRad: 0 });
      last = s;
      if (out.length >= 32) break;                   // FramePose polylines cap at 32 vertices
    }
    if (out.length > 0 && out[out.length - 1]!.s < endS - step / 2 && out.length < 32) {
      out.push({ laneOffset: plan.laneOffset, s: endS, lateralM: lateralAt(endS),
                 lateralRef: 'lane_centre', headingOffsetRad: 0 });
    }
    return out;
  }

  private buildLaneClosures(): SimLaneClosure[] {
    const out: SimLaneClosure[] = [];
    for (const plan of this.closurePlans) {
      const route = this.refRoute;
      if (!route) continue;
      const from = route.poseAt(Math.max(0, plan.fromS - this.site.frame.sRange[0]));
      const to = route.poseAt(Math.max(0, plan.toS - this.site.frame.sRange[0]));
      const rsl = from.rsl ?? to.rsl ?? this.site.frame.entryLaneRsl;
      if (!rsl) continue;
      const a = from.storageS ?? 0;
      const b = to.storageS ?? a;
      out.push({
        id: plan.id,
        rsl,
        fromS: Math.min(a, b),
        toS: Math.max(a, b),
        closedWidthM: plan.closedWidth,
        side: plan.side,
        openCentreOffsetM: plan.openCentre,
        openWidthM: Math.max(0, plan.openWidth),
        label: `${plan.closedWidth.toFixed(2)} m of lane closed for ${(plan.toS - plan.fromS).toFixed(0)} m`,
      });
    }
    return out;
  }

  private buildPropsAndOccluders(): void {
    // Devices solved from `closures` are expanded through exactly the same path as authored props,
    // so a work-zone device is a normal prop for every downstream consumer -- collision, render,
    // export -- and there is no second, parallel prop pipeline to drift out of step.
    const authored = this.template.props as readonly PropPlacement[];
    const generated = this.generatedClosureProps.length === 0
      ? []
      : this.generatedClosureProps.map((p, i) =>
          PropPlacementSchema.parse(p) as PropPlacement & { readonly __i?: number });
    for (const prop of [...authored, ...generated]) {
      const count = prop.repeat?.count ?? 1;
      const scope = this.baseScope();
      const spacing = prop.repeat
        ? evalNum(prop.repeat.spacingM, scope, `props.${prop.id}.repeat.spacingM`, 6)
        : 0;
      const baseS = evalNum(prop.pose.s, scope, `props.${prop.id}.pose.s`, 0);
      const featureOffset = prop.feature ? (this.site.featureMatches[prop.feature]?.s ?? 0) : 0;
      const dimsOverride = (prop.extensions?.['dims'] ?? undefined) as
        | { l?: number; w?: number; h?: number }
        | undefined;
      const dims = propDims(prop.catalogId, dimsOverride);
      const targetRevealToConflictS = prop.targetRevealToConflictS === undefined
        ? undefined
        : evalNum(
            prop.targetRevealToConflictS,
            scope,
            `props.${prop.id}.targetRevealToConflictS`,
          );
      const catalogBehavior = propBehavior(prop.catalogId);
      const collidable = typeof prop.extensions?.['collidable'] === 'boolean'
        ? prop.extensions['collidable']
        : catalogBehavior.collidable;

      for (let i = 0; i < count; i += 1) {
        const s = featureOffset + baseS + i * spacing;
        let at: { x: number; y: number; headingRad: number };
        try {
          const baseTFrac = evalTFrac(prop.pose.tFrac, scope, `props.${prop.id}.pose.tFrac`, 0);
          const tFracStep = prop.repeat
            ? evalTFrac(prop.repeat.tFracStep, scope, `props.${prop.id}.repeat.tFracStep`, 0)
            : 0;
          // A repeat drifts laterally in whichever unit the pose was authored in. Writing the
          // fractional drift into `tFrac` while `lateralM` is set would silently produce a pose
          // with two lateral offsets, which the schema forbids and `resolveLateral` would ignore —
          // a cone taper on the verge would come out perfectly straight. Convert the drift to
          // metres instead, against this lane's own width, so a taper stays a taper off-carriageway.
          const drift = i * tFracStep;
          const stepped = prop.pose.lateralM === undefined
            ? { ...prop.pose, s, tFrac: baseTFrac + drift }
            : {
                ...prop.pose,
                s,
                lateralM:
                  evalNum(prop.pose.lateralM, scope, `props.${prop.id}.pose.lateralM`, 0) +
                  drift * this.referenceLaneWidth(),
              };
          at = this.framePosePoint(stepped, scope, `props.${prop.id}.pose`);
        } catch (error) {
          // A repeat that runs off the end of the frame is a normal, expected
          // outcome and is skipped. An unsatisfiable `laneOffset` is not: the
          // prop was authored in a lane this site does not have, and skipping
          // it silently deletes an occluder the scenario depends on. Let that
          // one through.
          if (error instanceof CliError && LANE_OFFSET_ERROR_CODES.has(error.code)) throw error;
          continue;
        }
        const scene = toSceneXZ({ x: at.x, y: at.y });
        const id = count > 1 ? `${prop.id}-${i}` : prop.id;
        const headingRad = at.headingRad + prop.headingOffsetRad;
        this.props.push({
          id,
          ...(count > 1 ? { groupId: prop.id } : {}),
          catalogId: prop.catalogId,
          pose: { x: scene.x, z: scene.z, headingRad },
          ...(prop.attachment ? {
            attachment: {
              actorId: prop.attachment.role,
              longitudinalM: prop.attachment.longitudinalM,
              lateralM: prop.attachment.lateralM,
              heightM: prop.attachment.heightM,
              headingOffsetRad: prop.attachment.headingOffsetRad,
            },
          } : {}),
          dims,
          scale: prop.scale,
          collidable,
          essentiality: prop.essentiality,
          ...(prop.occludes ? { occludes: { ...prop.occludes } } : {}),
          ...(targetRevealToConflictS === undefined ? {} : { targetRevealToConflictS }),
        });
        if (catalogBehavior.occluder) {
          this.occluders.push({
            id,
            ...(count > 1 ? { groupId: prop.id } : {}),
            obb: {
              center: { x: scene.x, z: scene.z },
              lengthM: dims.l * prop.scale,
              widthM: dims.w * prop.scale,
              headingRad,
              heightM: dims.h * prop.scale,
            },
          });
        }
      }
      if (prop.occludes && count > 0) {
        this.declareOcclusionPair({ observer: prop.occludes.observer, target: prop.occludes.target, occluderId: prop.id });
        this.notes.push({
          path: `props.${prop.id}`,
          reason: `occlusion declared between ${prop.occludes.observer} and ${prop.occludes.target}; reveal-to-conflict is reported by the engine, not solved for`,
          impact: 'informational',
        });
      }
    }
  }

  /* --------------------------------------------------------------- assemble */

  /**
   * Mechanism-specific hard eligibility for the authored double-park reveal.
   * This is deliberately a pre-simulation geometry proof: catalog generation
   * invokes materialization before reserving a slot, while runtime metrics
   * independently prove that the executable motion realizes the closure.
   */
  private assertDeliveryGeometryEligibility(
    input: SimScenarioInput,
    arrivals: readonly ArrivalSolution[],
  ): void {
    if (this.template.meta.archetype !== 'parking.delivery-double-park') return;
    const ego = input.actors.find((actor) => actor.id === 'ego');
    const van = input.actors.find((actor) => actor.id === 'delivery-vehicle');
    const worker = input.actors.find((actor) => actor.id === 'delivery-worker');
    const pass = input.interactions.find((interaction) => interaction.id === 'ego-passes-left');
    const pair = input.occlusionPairs.find((entry) =>
      entry.observer === 'ego' && entry.target === 'delivery-worker' &&
      entry.occluderId === 'actor:delivery-vehicle');
    const passLaneRsl = this.site.frame.lateralLanes[2];
    const passLane = passLaneRsl ? this.bundle.graph.geometry(passLaneRsl) : undefined;
    const workerArrival = arrivals.find((arrival) => arrival.actorId === 'delivery-worker');

    const reasons: string[] = [];
    if (!ego || van?.kind !== 'van' || van.static !== true) reasons.push('semantic static delivery van is absent');
    if (worker?.kind !== 'pedestrian' || worker.static === true || worker.behavior.route.kind !== 'polyline') {
      reasons.push('moving pedestrian worker polyline is absent');
    }
    if (pass?.verb !== 'changeLane' || pass.target.mode !== 'left' || pass.target.count !== 1) {
      reasons.push('ego does not execute one adjacent-left pass');
    }
    if (!pair) reasons.push('delivery van is not the declared ego/worker occluder');
    if (!passLaneRsl || !passLane) reasons.push('adjacent executable pass lane is absent at the conflict cross-section');
    if (!workerArrival?.converged) reasons.push('worker arrival does not converge');

    let initialBlocker: string | null = null;
    let laterClear = false;
    let passPathDistanceM = Infinity;
    let passPathToleranceM = 0;
    if (ego && van && worker && worker.behavior.route.kind === 'polyline') {
      const vanShape = buildOccluders([{
        id: `actor:${van.id}`,
        obb: {
          center: { x: van.initial.pose.x, z: van.initial.pose.z },
          lengthM: van.dims.l,
          widthM: van.dims.w,
          heightM: van.dims.h,
          headingRad: van.initial.pose.headingRad,
        },
      }]);
      const positionAtClipStart = (actor: SimActor): Point2 => {
        const route = this.routeByRole.get(actor.id);
        if (!route) return localFromScene(actor.initial.pose);
        const startS = route.projectPoint(localFromScene(actor.initial.pose)).s;
        const probe = nominalRun(this.bundle.graph, {
          kind: actor.kind,
          route,
          startS,
          initialSpeedMps: actor.initial.speedMps,
          speedFactor: actor.behavior.rules.speedFactor,
          cruiseOverrideMps: actor.behavior.cruiseSpeedMps ?? null,
        }, null, {
          dt: input.dt,
          warmupSeconds: input.warmupSeconds,
          horizonSeconds: 0,
        });
        return route.poseAt(startS + probe.distanceM).point;
      };
      const observer = positionAtClipStart(ego);
      initialBlocker = blockingOccluder(observer, positionAtClipStart(worker), vanShape);
      laterClear = worker.behavior.route.points.some((point) =>
        blockingOccluder(observer, localFromScene(point), vanShape) === null);
      if (passLane) {
        const workerPath = worker.behavior.route.points.map(localFromScene);
        passPathDistanceM = polylineDistance(workerPath, passLane.points);
        passPathToleranceM = (passLane.widthM + worker.dims.w) / 2 + 0.05;
      }
    }
    if (initialBlocker !== 'actor:delivery-vehicle') reasons.push('worker is not initially hidden by the delivery van OBB');
    if (!laterClear) reasons.push('worker path never clears the delivery van OBB');
    if (passPathDistanceM > passPathToleranceM) reasons.push('worker path does not close on the adjacent pass lane');

    if (reasons.length > 0) {
      throw new CliError(
        'delivery_geometry_unclosed',
        'double-parked delivery site failed executable van/worker/pass-path hard eligibility',
        {
          path: 'roles.delivery-worker',
          detail: {
            siteId: this.site.siteId,
            reasons,
            passLaneRsl: passLaneRsl ?? null,
            initialBlocker,
            laterClear,
            passPathDistanceM: Number.isFinite(passPathDistanceM) ? passPathDistanceM : null,
            passPathToleranceM,
            workerArrivalConverged: workerArrival?.converged ?? false,
          },
          exitCode: 2,
        },
      );
    }
  }

  run(options: MaterializeOptions): MaterializeResult {
    const operationalConditions = options.variant === undefined
      ? applyTemplateEnvironment(
          this.template.environment,
          (value, path) => evalNum(value, this.baseScope(), path),
        )
      : applyCatalogVariant(options.variant);
    this.signalPlan = buildSiteSignalPlan(this.bundle, this.site);
    this.roadControls = buildSiteRoadControls(this.bundle, this.site);
    assertMaterializableMapControls(this.template, this.bundle, this.site, this.signalPlan, this.roadControls);
    assertMaterializableMovementControls(this.template, this.bundle, this.site, this.roadControls);
    assertMaterializableRuleControls(this.template);
    this.buildReferenceRoute();
    this.buildTrafficControls();
    this.compileAuthoredMapSignals();
    this.buildActors();
    this.assertTerminatingLaneMergeClosure();
    this.foldInitialRules();
    // Rules folded after the actors were built: rebuild the ones that changed.
    if (this.initialRules.size > 0) {
      for (let i = 0; i < this.actors.length; i += 1) {
        const rules = this.initialRules.get(this.actors[i]!.id);
        if (!rules) continue;
        this.actors[i] = parseActor({
          ...this.actors[i]!,
          behavior: { ...this.actors[i]!.behavior, rules: { ...this.actors[i]!.behavior.rules, ...rules } },
        });
      }
    }
    if (this.signalPlan.programs.length > 0 && !this.compiledMapSignalPrograms) {
      const physicalHeadCount = new Set(
        this.signalPlan.programs.flatMap((program) => program.mapBinding?.headIds ?? []),
      ).size;
      this.notes.push({
        path: 'signalPrograms',
        reason: `${physicalHeadCount} physical map signal head(s) bound as ${this.signalPlan.programs.length} logical program(s) to junction ${this.signalPlan.junctionId} with authoritative OpenDRIVE controller-stage provenance; phase durations and t=0 state use the explicit synthetic-default cycle because authoritative timing/state data is absent`,
      });
    }
    if (this.roadControls.length > 0) {
      this.notes.push({
        path: 'roadControls',
        reason: `${this.roadControls.length} physical map stop control(s) bound to actor-local dwell-and-release state`,
        impact: 'informational',
      });
    }
    // Sensors first: an interaction may name one, and the loud "declares no
    // sensors" check must see the suite that the roles actually declared.
    this.applyRoleSensors();
    // Closures are solved BEFORE interactions so the shifted path can be emitted as an ordinary
    // authored route, and before props so the devices join the same expansion.
    this.buildClosures();
    this.buildInteractions();
    this.buildClosureDetours();
    this.buildRoleOcclusionPairs();
    this.buildPropsAndOccluders();
    const perception = this.buildPerception();

    let input = parseSimScenarioInput({
      schemaVersion: 1,
      mapId: this.bundle.mapId,
      clipSeconds: this.template.choreography.clipSeconds,
      warmupSeconds: this.template.choreography.warmupSeconds,
      dt: 0.02,
      seed: this.draw.paramSeed.slice(0, 16),
      // New concrete/editable products pin the current authoring default so a
      // future engine default cannot silently reinterpret their motion model.
      physics: { mode: 'dynamic-v1' },
      operationalConditions,
      ...(this.template.metricSubject && this.actors.some((a) => a.id === this.template.metricSubject)
        ? { metricSubject: this.template.metricSubject }
        : {}),
      actors: this.actors,
      interactions: this.interactions,
      signalPrograms: [...(this.compiledMapSignalPrograms ?? this.signalPlan.programs), ...this.authoredControlPrograms],
      roadControls: this.roadControls,
      surfacePatches: this.buildSurfacePatches(),
      laneClosures: this.buildLaneClosures(),
      props: this.props,
      occluders: this.occluders,
      occlusionPairs: this.occlusionPairs,
      nearMissCriteria: this.nearMissCriteria,
      ...(perception ? { perception } : {}),
    });

    // --- arrival: the criticality that makes the scenario a scenario --------
    const solutions: ArrivalSolution[] = [];
    for (const role of this.template.roles) {
      if (role.kind !== 'conflicting_gate' || !role.arriveAtConflict) continue;
      const binding = this.bindingByRole.get(role.id);
      if (!binding?.conflict) continue;
      if (!input.actors.some((a) => a.id === role.id)) continue;
      const scope = this.scopeByRole.get(role.id) ?? this.baseScope();
      const deltaT = evalNum(
        role.arriveAtConflict.deltaT,
        scope,
        `roles.${role.id}.arriveAtConflict.deltaT`,
      );
      const referenceId = role.arriveAtConflict.relativeTo;
      const conflictRoute = this.routeByRole.get(role.id);
      const referenceRoute = this.routeByRole.get(referenceId);
      const conflictActor = input.actors.find((actor) => actor.id === role.id);
      const referenceActor = input.actors.find((actor) => actor.id === referenceId);
      if (!conflictRoute || !referenceRoute || !conflictActor || !referenceActor) {
        throw new CliError(
          'arrival_conflict_unclosed',
          `required arrival pair "${role.id}"/"${referenceId}" has no final executable route`,
          {
            path: `roles.${role.id}.arriveAtConflict`,
            detail: { siteId: this.site.siteId, conflictGateId: binding.conflict.gateId },
            exitCode: 2,
          },
        );
      }
      const closure = closeArrivalConflict(
        binding.conflict.point,
        conflictRoute,
        referenceRoute,
        conflictActor.dims.w,
        referenceActor.dims.w,
      );
      if (!closure.closed) {
        throw new CliError(
          'arrival_conflict_unclosed',
          `matcher conflict does not close on the final ${role.id}/${referenceId} executable paths`,
          {
            path: `roles.${role.id}.arriveAtConflict`,
            detail: {
              siteId: this.site.siteId,
              conflictGateId: binding.conflict.gateId,
              declaredPoint: binding.conflict.point,
              aDistanceM: closure.aDistanceM,
              bDistanceM: closure.bDistanceM,
              pathSeparationM: closure.pathSeparationM,
              footprintToleranceM: closure.toleranceM,
              conflictRoute: conflictRoute.legs.map((leg) => leg.rsl),
              referenceRoute: referenceRoute.legs.map((leg) => leg.rsl),
            },
            exitCode: 2,
          },
        );
      }
      const solvedPoint = closure.point;
      const scene = toSceneXZ(solvedPoint);
      const stationByLane = new Map<string, number>();
      for (const actorId of [role.id, referenceId]) {
        const route = this.routeByRole.get(actorId);
        if (!route || route.isFreeform) continue;
        // This is intentionally projected from the closure point, not the
        // matcher-only point.  The nominal solver therefore times the same
        // executable paths whose geometry was proved above.
        const projection = route.projectPoint(solvedPoint);
        const pose = route.poseAt(projection.s);
        if (pose.rsl) stationByLane.set(pose.rsl, pose.storageS);
      }
      const stations = [...stationByLane]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rsl, s]) => ({ rsl, s }));
      const solved = solveArrival(
        input,
        {
          of: role.id,
          at: {
            kind: 'point',
            at: { x: scene.x, z: scene.z },
            ...(stations.length > 0 ? { referenceFrame: { stations } } : {}),
          },
          syncWith: referenceId,
          deltaT,
        },
        this.bundle.graph,
        { interactionId: `role:${role.id}` },
      );
      if (!solved.ok) {
        this.notes.push({
          path: `roles.${role.id}.arriveAtConflict`,
          reason: `${solved.issue.code}: ${solved.issue.reason}`,
        });
        continue;
      }
      if (!solved.solution.converged && role.essentiality === 'required') {
        throw new CliError(
          'arrival_unconverged',
          `required arrival for "${role.id}" cannot be achieved on the bound approach`,
          {
            path: `roles.${role.id}.arriveAtConflict`,
            detail: {
              targetDeltaT: solved.solution.targetDeltaT,
              achievedDeltaT: solved.solution.achievedDeltaT,
              spawnS: solved.solution.spawnS,
              siteId: this.site.siteId,
              conflictGateId: binding.conflict.gateId,
            },
            exitCode: 2,
          },
        );
      }
      solutions.push(solved.solution);
      input = applyArrivalSolution(input, solved.solution, this.bundle.graph);
    }

    // Timeline-level `arrival` triggers are baked here rather than left for the
    // engine. The engine would solve them identically on every run, but then the
    // *instance file* would not be a fully-resolved document — and "the seam is
    // a fully resolved concrete scenario" is the whole point of the seam.
    const resolved = resolveArrivalTriggers(input, this.bundle.graph);
    input = normalizeSimScenarioInput(resolved.input);
    solutions.push(...resolved.solutions);
    for (const issue of resolved.issues) {
      const interactionId = issue.path.split('.')[1];
      const authored = this.template.choreography.interactions.find((interaction) => interaction.id === interactionId);
      const role = authored ? this.roleById.get(authored.actor) : undefined;
      if (authored?.trigger.kind === 'arrival' && role?.essentiality === 'required') {
        throw new CliError(
          issue.code === 'arrival_unsolvable' ? 'arrival_unconverged' : issue.code,
          `required arrival interaction "${authored.id}" cannot be resolved`,
          { path: issue.path, detail: { reason: issue.reason, siteId: this.site.siteId }, exitCode: 2 },
        );
      }
      this.notes.push({
        path: issue.path,
        reason: `${issue.code}: ${issue.reason}`,
      });
    }

    this.assertDeliveryGeometryEligibility(input, solutions);

    const issues = checkFeasibility(input, this.bundle.graph);
    const feasible = !issues.some((i) => i.severity === 'error');

    // --- ambient traffic ----------------------------------------------------
    // Deliberately LAST. The authored scenario is fully solved, its geometry is
    // proved and its feasibility verdict is already fixed above, so generated
    // background traffic cannot alter the authored answer in any direction.
    // What it does alter, on purpose, is `input` — and therefore `inputHash` —
    // so the instance, the trace and the evidence check all describe the same
    // populated world.
    let ambientProvenance: AmbientTrafficProvenance | null = null;
    let ambientSettleProvenance: AmbientSettleProvenance | null = null;
    const ambientProfile = options.ambient;
    const ambientSettleSeconds = options.ambientSettleSeconds ?? 0;
    if (ambientProfile !== undefined && resolveAmbientTrafficProfile(ambientProfile).preset !== 'off') {
      const resolvedAmbient = resolveAmbientTrafficProfile(ambientProfile);
      const applied = applyAmbientTraffic(input, this.bundle.graph, ambientProfile, {
        // NOT `extraTravelSeconds: ambientSettleSeconds`. Requiring every
        // candidate to own `cruise x (warmup + clip + settle)` of downstream
        // route — 480 m for a 20 s settle — is unaffordable on these maps:
        // measured on the 15-cell c15g probe it collapsed the cohort from ~32
        // to 7-43 candidates because the pool ran out of long-enough routes,
        // and the delivered population fell with it. An actor that does run out
        // of route during the settle simply despawns and is dropped, which the
        // oversized cohort already absorbs.
        // With a settle the placed population is a COHORT, not the answer: it is
        // settled and then re-selected against the positions it actually holds
        // at t=0. Without a settle the multiplier is 1 and nothing changes.
        ...(ambientSettleSeconds > 0
          ? {
            targetMultiplier: AMBIENT_SETTLE_COHORT_MULTIPLIER,
            cohortRadiusBonusM: ambientSettleSeconds * AMBIENT_SETTLE_COHORT_MPS,
          }
          : {}),
      });
      input = applied.input;
      ambientProvenance = applied.provenance;
      // AMBIENT WARM-UP. Advances ONLY the generated population, so the road is
      // already in motion — with standing queues where the network implies them
      // — at t=0, while every authored actor's initial state is untouched.
      if (ambientSettleSeconds > 0) {
        const cohortIds = ambientProvenance.actors.map((a) => a.id);
        const settled = settleAmbientTraffic(input, this.bundle.graph, {
          settleSeconds: ambientSettleSeconds,
          ambientActorIds: cohortIds,
          keep: ambientProvenance.placementTarget,
          exclusionRadiusM: resolvedAmbient.exclusionRadiusM,
        });
        input = settled.input;
        ambientSettleProvenance = settled.provenance;
        if (ambientSettleProvenance !== null) {
          // The manifest must describe the population the clip records, not the
          // cohort that was settled to produce it.
          const kept = new Set(input.actors.map((a) => a.id));
          ambientProvenance = {
            ...ambientProvenance,
            actors: ambientProvenance.actors.filter((a) => kept.has(a.id)),
          };
        }
      }
    }

    // The engine applies `resolveOverlappingControlLanes` to whatever input it
    // receives and hashes the REPAIRED document into `trace.header.inputHash`.
    // Bake the same resolution here — after ambient placement, because ambient
    // routes are exactly what introduces coincident control-lane traffic in
    // practice — so the instance stays a fully resolved document and the
    // evidence join (`manifest.inputHash` == `trace.header.inputHash`) holds.
    // Idempotent on the engine side: every repaired binding is already present,
    // so the engine repairs nothing and hashes the same bytes.
    const controlResolution = resolveOverlappingControlLanes(
      normalizeSimScenarioInput(input),
      this.bundle.graph,
    );
    input = controlResolution.input;
    for (const repair of controlResolution.repairs) {
      issues.push({
        code: 'traffic_control_binding_repaired',
        path: `${repair.source}.${repair.controlId}`,
        reason: `A coincident OpenDRIVE lane was bound to ${repair.routeRsl} so this route can obey the physical control. Choose an unambiguous lane when portability matters.`,
        detail: { ...repair },
        severity: 'warning',
      });
    }

    const key: ReplayKey = {
      templateId: templateId(this.template),
      templateVersion: this.template.scenarioVersion,
      templateDigest: contentHash(this.template).slice(0, 16),
      mapId: this.bundle.mapId,
      matcherIndexDigest: this.site.topologyDigest,
      engineGraphDigest: this.bundle.graph.topologyDigest,
      siteId: this.site.siteId,
      matcherVersion: MATCH_SEMANTICS_VERSION,
      solverVersion: ENGINE_VERSION,
      paramSeed: this.draw.paramSeed,
      drawIndex: options.drawIndex ?? -1,
      // Part of the replay key, not decoration: two cells with the same seed
      // and different ambient populations are different worlds, and a resumable
      // batch that reused one for the other would be serving a stale answer.
      // The settle length is part of the population's identity for the same
      // reason: the same seed settled for 0 s and for 20 s are different worlds.
      ambientProfileHash: ambientProvenance === null
        ? 'none'
        : ambientSettleSeconds > 0
          ? `${ambientProvenance.profileHash}+settle${ambientSettleSeconds}`
          : ambientProvenance.profileHash,
    };

    const manifest: InstanceManifest = {
      kind: 'scenario-instance-manifest',
      manifestVersion: 1,
      replayKey: key,
      instanceId: `${key.siteId}#${key.drawIndex}`,
      archetype: this.template.meta.archetype ?? null,
      negativeControl: this.template.meta.negativeControl,
      metricSubject: input.metricSubject ?? null,
      operationalVariant: options.variant === undefined
        ? null
        : { ...options.variant, concrete: input.operationalConditions! },
      site: {
        siteId: this.site.siteId,
        score: this.site.score,
        verdict: this.site.degradation.verdict,
        originFeatureId: this.site.frame.origin.mapFeatureId,
        entryLaneRsl: this.site.frame.entryLaneRsl,
        egoTurn: this.site.frame.egoTurn ?? null,
        degradationSummary: this.site.degradation.summary,
        matchedReasons: this.site.matchedReasons,
      },
      params: {
        values: { ...this.draw.values },
        categorical: { ...this.draw.categorical },
        rejectedConstraints: [...this.draw.rejectedConstraints],
      },
      actors: input.actors.map((a) => ({
        id: a.id,
        actorKind: a.kind,
        roleKind: this.roleById.get(a.id)?.kind
          ?? (a.tags.includes('ambient') ? 'ambient' : 'unknown'),
        laneRsl: a.initial.laneRef?.rsl ?? null,
        spawnS: this.spawnSByRole.get(a.id) ?? 0,
        initialSpeedMps: a.initial.speedMps,
        bindingStatus: this.bindingByRole.get(a.id)?.status
          ?? (a.tags.includes('ambient') ? 'generated' : 'unknown'),
      })),
      props: input.props.map((prop) => ({ ...prop })),
      arrival: solutions,
      inputHash: contentHash(input),
      feasible,
      issues,
      ...(ambientProvenance === null ? {} : { ambient: ambientProvenance }),
      ...(ambientSettleProvenance === null ? {} : { ambientSettle: ambientSettleProvenance }),
      initialInteractionOutcomes: [...this.initialInteractionOutcomes],
      notes: [...this.notes],
    };

    return { input, manifest };
  }
}

/* --------------------------------------------------------------- utilities */

function parseActor(value: unknown): SimActor {
  const parsed = safeParseSimScenarioInput({ actors: [value] });
  if (!parsed.ok) {
    throw new CliError('actor_invalid', 'a materialized actor failed the engine contract', {
      path: 'actors',
      detail: { issues: parsed.issues },
      exitCode: 2,
    });
  }
  return parsed.value.actors[0] as SimActor;
}

/**
 * Actor and sensor ids a lowered interaction's `detected()` leaves reference.
 *
 * Walks the already-lowered engine condition shape, which is one level of
 * `and`/`or`/`not` over leaves by contract, so this needs no recursion.
 */
function detectedReferences(record: { trigger?: unknown; until?: unknown }): {
  actors: string[];
  sensorsByObserver: Map<string, string[]>;
} {
  const actors: string[] = [];
  const sensorsByObserver = new Map<string, string[]>();
  const roots: unknown[] = [];
  const trigger = record.trigger as { kind?: string; condition?: unknown } | undefined;
  if (trigger?.kind === 'when') roots.push(trigger.condition);
  if (record.until !== undefined) roots.push(record.until);
  for (const root of roots) {
    const node = root as { kind?: string; of?: unknown } | undefined;
    if (!node) continue;
    const leaves: unknown[] = node.kind === 'and' || node.kind === 'or'
      ? (node.of as unknown[]) ?? []
      : node.kind === 'not'
        ? [node.of]
        : [node];
    for (const raw of leaves) {
      const leaf = raw as { kind?: string; a?: string; by?: string; sensor?: string } | undefined;
      if (leaf?.kind !== 'detected') continue;
      if (typeof leaf.a === 'string') actors.push(leaf.a);
      if (typeof leaf.by === 'string') {
        actors.push(leaf.by);
        // A probe observer must own a sensor, otherwise the loud "declares no
        // sensors" check fires on a world this function invented.
        const ids = sensorsByObserver.get(leaf.by) ?? [];
        ids.push(typeof leaf.sensor === 'string' ? leaf.sensor : `${leaf.by}-probe-sensor`);
        sensorsByObserver.set(leaf.by, [...new Set(ids)].sort());
      }
    }
  }
  return { actors, sensorsByObserver };
}

function parseInteraction(value: unknown): SimInteraction {
  const record = value as {
    id?: string;
    actorId?: string;
    trigger?: { kind?: string; interactionId?: string };
  };
  const actorId = record.actorId ?? 'probe';

  // BUGFIX (occluded-pedestrian campaign, 2026-08-01): this probe validates one
  // interaction inside a scenario that contains only that interaction, but
  // `simScenarioInputSchema` resolves `after()` references at *scenario* level.
  // So every `after()` trigger failed here with "after() references unknown
  // interaction <id>" — the whole trigger kind was unreachable through `uniscenarios`,
  // even though the engine runs it correctly once the real scenario is
  // assembled. The probe now carries a stub for whatever the trigger names.
  const afterId =
    record.trigger?.kind === 'after' && typeof record.trigger.interactionId === 'string'
      ? record.trigger.interactionId
      : undefined;
  const stubs =
    afterId === undefined || afterId === record.id
      ? []
      : [
          {
            id: afterId,
            actorId,
            verb: 'exist',
            trigger: { kind: 'at', t: 0 },
            target: { state: 'present' },
          },
        ];

  // Same class of bug as the `after()` one above, for the same reason:
  // `detected()` resolves its observer, its target and the observer's sensor at
  // *scenario* level, so inside a one-actor probe every perception trigger
  // would fail with "unknown actor" / "declares no sensors" and the whole
  // condition kind would be unreachable through `uniscenarios`. The probe
  // carries a stub for whatever the condition names, including a sensor on any
  // actor used as an observer.
  const perceptionRefs = detectedReferences(record as { trigger?: unknown; until?: unknown });
  const probeActor = (id: string, sensorIds: readonly string[]) => ({
    id,
    kind: 'vehicle' as const,
    dims: { l: 4, w: 2, h: 1.5 },
    initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
    behavior: { route: { kind: 'polyline' as const, points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } },
    ...(sensorIds.length > 0
      ? {
          sensors: sensorIds.map((sensorId) => ({
            id: sensorId,
            type: 'dash_camera' as const,
            mount: { position: { x: 0, y: 1, z: 0 } },
          })),
        }
      : {}),
  });
  const probeIds = [...new Set([actorId, ...perceptionRefs.actors])].sort();

  const parsed = safeParseSimScenarioInput({
    actors: probeIds.map((id) => probeActor(id, perceptionRefs.sensorsByObserver.get(id) ?? [])),
    interactions: [...stubs, value],
  });
  if (!parsed.ok) {
    throw new CliError('interaction_invalid', 'a materialized interaction failed the engine contract', {
      path: 'interactions',
      detail: { issues: parsed.issues },
      exitCode: 2,
    });
  }
  return parsed.value.interactions[stubs.length] as SimInteraction;
}

function polylinePointsOf(route: Route): Array<{ x: number; z: number }> {
  const n = Math.max(2, Math.ceil(route.lengthM));
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i <= n; i += 1) {
    const p = route.poseAt((route.lengthM * i) / n).point;
    const scene = toSceneXZ(p);
    out.push({ x: scene.x, z: scene.z });
  }
  return out;
}

function buildRouteFromPoints(points: Array<{ x: number; y: number }>): Route | null {
  const distinct = points.filter(
    (p, i) => i === 0 || Math.hypot(p.x - (points[i - 1] as { x: number }).x, p.y - (points[i - 1] as { y: number }).y) > 1e-6,
  );
  if (distinct.length < 2) return null;
  return Route.fromPolyline(distinct);
}

/**
 * The engine's `set` keys are a subset of the authored registry, and two of the
 * authored ones split a single engine switch. Mapping is explicit so a key with
 * no counterpart is *reported*, never silently ignored.
 */
export function mapSetKey(key: string): string | null {
  switch (key) {
    case 'rules.collisionAvoidance':
    case 'rules.yield':
    case 'rules.obeySignals':
    case 'rules.aggression':
      return key;
    case 'rules.yieldToVehicles':
    case 'rules.yieldToPedestrians':
      return key;
    case 'rules.speedFactor':
      return 'rules.speedFactor';
    default:
      break;
  }
  // `motion.gear` is a controller switch, not recorded state: the engine reads
  // it to select forward or reverse. It rides the same passthrough because the
  // key name is identical on both sides of the boundary.
  if (/^(motion|lights|doors|pose|env|audio)\.[A-Za-z0-9_]+$/.test(key)) return key;
  if (/^signal:[A-Za-z0-9._:@/-]+\.phase$/.test(key)) return key;
  if (/^control:[A-Za-z0-9._:@/-]+\.indication$/.test(key)) return key;
  return null;
}

/** Materialize one concrete instance. */
export function materialize(
  template: ScenarioTemplateV2,
  bundle: MapBundle,
  site: MatchedSite,
  options: MaterializeOptions = {},
): MaterializeResult {
  assertRequiredRoleBindings(template, site);
  const drawIndex = options.drawIndex ?? -1;
  const draw = resolveParams(template, {
    siteId: site.siteId,
    drawIndex,
    seedOverride: options.seed,
  });
  return new Materializer(template, bundle, site, draw).run({ ...options, drawIndex });
}

export { paramsVersion };
