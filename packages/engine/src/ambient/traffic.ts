import { z } from 'zod';

import { contentHash } from '../core/hash.js';
import { Rng } from '../core/rng.js';
import { toSceneXZ } from '../frames.js';
import type { DirectedLane, LaneGraph } from '../map/lane-graph.js';
import { buildRoute } from '../map/route.js';
import {
  actorSchema,
  normalizeSimScenarioInput,
  type ActorKind,
  type SimActor,
  type SimScenarioInput,
} from '../schema/input.js';

/** Versioned, browser-safe configuration for generated background road users. */
export const ambientTrafficProfileSchema = z.object({
  version: z.literal(1).default(1),
  preset: z.enum(['off', 'light', 'moderate', 'city', 'heavy', 'custom']).default('off'),
  /** Target moving road users per kilometre of eligible lane near the scenario. */
  densityVehiclesPerKm: z.number().finite().min(0).max(80).optional(),
  flows: z.object({
    through: z.number().finite().min(0).default(0.7),
    left: z.number().finite().min(0).default(0.12),
    right: z.number().finite().min(0).default(0.16),
    uTurn: z.number().finite().min(0).default(0.02),
  }).default({ through: 0.7, left: 0.12, right: 0.16, uTurn: 0.02 }),
  vehicleMix: z.object({
    car: z.number().finite().min(0).default(0.72),
    van: z.number().finite().min(0).default(0.1),
    truck: z.number().finite().min(0).default(0.08),
    bus: z.number().finite().min(0).default(0.04),
    motorcycle: z.number().finite().min(0).default(0.06),
  }).default({ car: 0.72, van: 0.1, truck: 0.08, bus: 0.04, motorcycle: 0.06 }),
  pedestrianShare: z.number().finite().min(0).max(1).default(0),
  cyclistShare: z.number().finite().min(0).max(1).default(0.04),
  aggressiveness: z.number().finite().min(0).max(1).default(0.35),
  speedVariance: z.number().finite().min(0).max(0.8).default(0.12),
  seed: z.union([z.string().min(1), z.number().int()]).default('ambient'),
  maxActors: z.number().int().min(0).max(128).default(40),
  /** Candidate selection is local to authored choreography, not the whole city. */
  radiusM: z.number().finite().min(25).max(2000).default(250),
  /** Empty road around authored starts and explicit reservations. */
  exclusionRadiusM: z.number().finite().min(2).max(100).default(12),
}).refine((profile) => profile.pedestrianShare + profile.cyclistShare <= 1, {
  path: ['cyclistShare'],
  message: 'pedestrianShare + cyclistShare must not exceed 1',
});

export type AmbientTrafficProfile = z.input<typeof ambientTrafficProfileSchema>;
export type ResolvedAmbientTrafficProfile = z.output<typeof ambientTrafficProfileSchema> & {
  densityVehiclesPerKm: number;
};

export interface AmbientReservation {
  readonly x: number;
  readonly z: number;
  readonly radiusM: number;
  readonly reason?: string;
}

export interface AmbientTrafficOptions {
  readonly reservations?: readonly AmbientReservation[];
  /**
   * Retained for robustness-evaluator callers. Candidate materialization does
   * not run the clip; the explicit robustness job applies this ceiling.
   */
  readonly maxAchievableDecelMps2?: number;
  /**
   * Keep generated traffic off the ground the authored scenario is going to
   * use. A candidate is rejected when its spawn lane, or any lane on its route,
   * is in this set.
   *
   * WHY. Background traffic exists to populate the road, never to become the
   * conflict. A generated car that spawns in the ego's own lane becomes the
   * ego's leader and can manufacture the braking demand and the closest
   * approach that the authored challenger was supposed to own — the scenario
   * then measures the wrong pair. Reserving the authored corridor makes that
   * structurally impossible rather than statistically unlikely.
   *
   * `materializeAmbientCandidatePool` derives the authored corridor
   * automatically from every authored `lanePath` route; this option adds to it.
   */
  readonly excludedLaneRsls?: readonly string[];
  /**
   * Opt out of the automatic authored-corridor exclusion. Off by default and
   * intended only for the ambient-robustness evaluator, which deliberately
   * drives generated traffic at the authored actors.
   */
  readonly allowAuthoredCorridor?: boolean;
  /**
   * Extra seconds of downstream route runway every candidate must own, on top
   * of `warmupSeconds + clipSeconds`.
   *
   * Set to the ambient-settle length. The settle advances the generated
   * population before `t = 0`, so a candidate sized only for the clip runs off
   * the end of its route during the settle and despawns before the recording
   * it was generated for begins.
   */
  readonly extraTravelSeconds?: number;
  /**
   * Multiply the placement target to build an oversized SETTLE COHORT.
   *
   * With an ambient warm-up the population that matters is the one standing on
   * the road at `t = 0`, not the one that was spawned `settleSeconds` earlier:
   * measured on `c15g` with a 20 s settle, selecting the 32 candidates nearest
   * the authored choreography and then settling them drove the median count
   * within 60 m of the ego from 5 to 0, because 20 s at 13 m/s is 260 m of
   * travel. The caller therefore selects a larger cohort here, settles it, and
   * re-applies the ranking, the reservations and the budget to the settled
   * positions. `1` (the default) is the un-settled behaviour exactly.
   */
  readonly targetMultiplier?: number;
  /**
   * Extra selection radius, metres, for the settle cohort.
   *
   * The cohort must not be the same neighbourhood at four times the density —
   * that is a traffic jam, and a jam manufactures the queues the measure is
   * supposed to find. It must be a LARGER neighbourhood at the SAME density:
   * the cars standing next to the ego at `t = 0` are the ones that spawned
   * `cruise x settleSeconds` upstream, so the radius has to reach that far.
   * `targetMultiplier` then exists only to lift `profile.maxActors`, which is a
   * cap on the placed population rather than on the cohort.
   */
  readonly cohortRadiusBonusM?: number;
}

export interface AmbientScreeningReason {
  readonly actorId: string;
  readonly reason: 'collision' | 'required_decel';
  readonly detail?: string;
  readonly requiredDecelMps2?: number;
  readonly maxAchievableDecelMps2?: number;
}

export interface AmbientActorProvenance {
  readonly id: string;
  readonly kind: ActorKind;
  readonly routeLaneRsls: readonly string[];
  readonly seedKey: string;
  readonly origin: 'ambient';
  readonly timelineVisible: false;
  readonly editable: false;
}

export interface AmbientTrafficProvenance {
  readonly version: 1;
  readonly profile: ResolvedAmbientTrafficProfile;
  readonly profileHash: string;
  /** Stable population identity. Authored choreography is deliberately absent. */
  readonly candidatePoolKey: string;
  readonly mapGraphDigest: string;
  readonly baseInputHash: string;
  readonly generatedInputHash: string;
  readonly actors: readonly AmbientActorProvenance[];
  readonly rejectedSpawnCount: number;
  /** Candidates dropped purely for touching the authored corridor. */
  readonly authoredCorridorRejects: number;
  /** The authored corridor that was reserved, sorted. */
  readonly authoredCorridorLaneRsls: readonly string[];
  readonly eligibleLaneKm: number;
  /**
   * Actors an un-settled run would have placed: the profile's density over the
   * profile's own radius, under its own cap. With no settle this equals the
   * placed count's target; with a settle it is the post-settle budget.
   */
  readonly placementTarget: number;
  /** Compatibility summary. Ordinary materialization never executes a screening clip. */
  readonly screening: {
    readonly evaluated: boolean;
    readonly passes: number;
    readonly maxAchievableDecelMps2: number | null;
    readonly count: number;
    readonly actorIds: readonly string[];
    readonly reasons: readonly AmbientScreeningReason[];
  };
  readonly warnings: readonly string[];
}

export interface AmbientTrafficResult {
  readonly input: SimScenarioInput;
  readonly provenance: AmbientTrafficProvenance;
}

export interface AmbientCandidate {
  readonly id: string;
  readonly actor: SimActor;
  readonly laneRsl: string;
  readonly routeLaneRsls: readonly string[];
  readonly seedKey: string;
  readonly footprintRadiusM: number;
  /** Runtime/editor ownership metadata; simulation still receives an ordinary SimActor. */
  readonly origin: 'ambient';
  readonly timelineVisible: false;
  readonly editable: false;
}

export interface AmbientCandidatePool {
  readonly version: 1;
  readonly key: string;
  readonly mapGraphDigest: string;
  readonly profile: ResolvedAmbientTrafficProfile;
  readonly profileHash: string;
  readonly candidates: readonly AmbientCandidate[];
}

const PRESET_DENSITY: Record<ResolvedAmbientTrafficProfile['preset'], number> = {
  off: 0,
  light: 3,
  moderate: 8,
  city: 8,
  heavy: 16,
  custom: 8,
};

/**
 * The City preset is deliberately car-heavy while still making sidewalks feel
 * inhabited. These are applied only when a field was not explicitly authored,
 * so a stored City profile remains a stable, editable scenario setting.
 */
const CITY_PRESET_DEFAULTS = {
  pedestrianShare: 0.06,
  cyclistShare: 0.02,
  aggressiveness: 0.25,
  speedVariance: 0.1,
  maxActors: 32,
  radiusM: 275,
  exclusionRadiusM: 16,
} as const;

export const AMBIENT_TRAFFIC_EXTENSION_KEY = 'studio.ambientTraffic.profile.v1';

export function defaultAmbientTrafficProfile(): ResolvedAmbientTrafficProfile {
  return resolveAmbientTrafficProfile({ version: 1, preset: 'city', seed: 'ambient-1' });
}

/** Read the canonical authored ambient profile used by browser and compiler. */
export function ambientTrafficProfileFromExtensions(
  extensions: Readonly<Record<string, unknown>> | undefined,
): ResolvedAmbientTrafficProfile {
  const value = extensions?.[AMBIENT_TRAFFIC_EXTENSION_KEY];
  if (value === undefined) return defaultAmbientTrafficProfile();
  try {
    return resolveAmbientTrafficProfile(value as AmbientTrafficProfile);
  } catch {
    return defaultAmbientTrafficProfile();
  }
}

/** Resolve defaults once so hashes and worker messages have one canonical shape. */
export function resolveAmbientTrafficProfile(profile: AmbientTrafficProfile): ResolvedAmbientTrafficProfile {
  const withPresetDefaults = profile.preset === 'city'
    ? { ...CITY_PRESET_DEFAULTS, ...profile }
    : profile;
  const parsed = ambientTrafficProfileSchema.parse(withPresetDefaults);
  return {
    ...parsed,
    densityVehiclesPerKm: parsed.densityVehiclesPerKm ?? PRESET_DENSITY[parsed.preset],
  };
}

/** Generate map-wide candidates once. The key intentionally excludes authored state. */
export function createAmbientCandidatePool(
  graph: LaneGraph,
  rawProfile: AmbientTrafficProfile,
): AmbientCandidatePool {
  const profile = resolveAmbientTrafficProfile(rawProfile);
  const profileHash = contentHash(profile);
  const key = contentHash({ version: 1, mapGraphDigest: graph.topologyDigest, profile });
  if (profile.preset === 'off' || profile.densityVehiclesPerKm === 0 || profile.maxActors === 0) {
    return { version: 1, key, mapGraphDigest: graph.topologyDigest, profile, profileHash, candidates: [] };
  }
  const roadLanes = eligibleDirectedLanes(graph, ['driving'], [], Number.POSITIVE_INFINITY);
  const walkingLanes = eligibleDirectedLanes(graph, ['sidewalk', 'walking'], [], Number.POSITIVE_INFINITY);
  const totalLaneKm = roadLanes.reduce((sum, lane) => sum + graph.lengthOf(lane.rsl), 0) / 1000;
  // Oversample. Selection is LOCAL — a site uses only the candidates that fall
  // inside `radiusM` — while the pool is map-wide, so the budget has to cover
  // the rejection rate at the densest point rather than the average one.
  // Measured on belmont-research-center/3b536530 with the old ×2 factor: 67
  // candidates reached the site, 47 were rejected by reservations, runway and
  // authored-corridor protection, and only 20 of a target 33 were placed. The
  // shortfall was pure supply. ×8 leaves the same selection rules and the same
  // determinism, and simply stops the local pool running dry.
  const candidateBudget = Math.min(4096, Math.max(profile.maxActors * 16, Math.ceil(totalLaneKm * profile.densityVehiclesPerKm * 8)));
  const rng = new Rng(`${key}|ambient-candidate-pool-v1`);
  const candidates: AmbientCandidate[] = [];
  const attemptLimit = Math.max(80, candidateBudget * 4);
  for (let attempt = 0; attempt < attemptLimit && candidates.length < candidateBudget; attempt++) {
    const actorRng = rng.fork(`candidate:${attempt}`);
    const requestedKind = chooseRoadUserKind(profile, actorRng);
    const lanes = requestedKind === 'pedestrian' ? walkingLanes : roadLanes;
    if (lanes.length === 0) continue;
    const lane = lanes[Math.floor(actorRng.next() * lanes.length)]!;
    const geom = graph.requireGeometry(lane.rsl);
    // Degenerate stubs cannot hold a road user, and they used to produce a
    // NEGATIVE storage station. The old expression was
    //   routeS = range(margin, max(margin + 0.01, lengthM - margin))
    // whose lower clamp can exceed `lengthM` on a centimetre-long lane; the
    // reversed branch below then computed `lengthM - routeS < 0` and the actor
    // failed `laneRef.s >= 0` at parse time. That surfaced as
    // `internal_error: ZodError … initial.laneRef.s Too small` on
    // el-camino-road/74cdf0b0 — a whole cell lost to one unusable lane.
    // With `lengthM >= 1` the margin is at most `0.2 · lengthM`, so
    // `routeS ∈ [0.2·L, 0.8·L]` and both branches stay inside the lane.
    if (geom.lengthM < 1) continue;
    const margin = Math.min(8, geom.lengthM * 0.2);
    const routeS = actorRng.range(margin, geom.lengthM - margin);
    const pose = graph.sampleDirected(lane, routeS);
    const scene = toSceneXZ(pose.point);
    const laneSpeed = requestedKind === 'pedestrian' ? 1.35 : requestedKind === 'bicycle' ? 5.5 : geom.speedLimitMps;
    const factor = Math.max(0.35, 1 + actorRng.range(-profile.speedVariance, profile.speedVariance));
    const cruise = laneSpeed * factor;
    const routeLaneRsls = walkRoute(graph, lane, profile, actorRng, routeS, 5_000);
    if (routeLaneRsls.length === 0) continue;
    const storageS = Math.min(geom.lengthM, Math.max(0, lane.reversed ? geom.lengthM - routeS : routeS));
    const seedKey = contentHash({ key, attempt, lane: lane.rsl, storageS }).slice(0, 16);
    const id = `ambient:v1:${seedKey}`;
    const actor = normalizeActor({
      id,
      kind: requestedKind,
      initial: {
        laneRef: { rsl: lane.rsl, s: storageS, tFrac: 0 },
        pose: { x: scene.x, z: scene.z, headingRad: pose.headingRad },
        speedMps: cruise,
      },
      behavior: {
        rules: {
          obeySignals: true,
          yield: true,
          yieldToVehicles: true,
          yieldToPedestrians: true,
          collisionAvoidance: true,
          aggression: profile.aggressiveness,
          speedFactor: factor,
        },
        route: { kind: 'lanePath', lanes: routeLaneRsls },
        cruiseSpeedMps: cruise,
      },
      presentAtStart: true,
      static: false,
      tags: [
        'ambient',
        'ambient:v1',
        `catalog:${ambientCatalogId(requestedKind)}`,
        `ambient-profile:${profileHash.slice(0, 16)}`,
        `ambient-seed:${seedKey}`,
      ],
    });
    candidates.push({
      id,
      actor,
      laneRsl: lane.rsl,
      routeLaneRsls,
      seedKey,
      footprintRadiusM: requestedKind === 'bus' || requestedKind === 'truck' ? 7 : requestedKind === 'pedestrian' ? 1.2 : 3.5,
      origin: 'ambient',
      timelineVisible: false,
      editable: false,
    });
  }
  return { version: 1, key, mapGraphDigest: graph.topologyDigest, profile, profileHash, candidates };
}

/** Select stable candidates around authored geometry and compile them to ordinary SimActors. */
export function materializeAmbientCandidatePool(
  base: SimScenarioInput,
  graph: LaneGraph,
  pool: AmbientCandidatePool,
  options: AmbientTrafficOptions = {},
): AmbientTrafficResult {
  if (pool.mapGraphDigest !== graph.topologyDigest) throw new Error('Ambient candidate pool does not match the lane graph');
  const { profile, profileHash } = pool;
  const baseInputHash = contentHash(base);
  const focus = base.actors.filter((actor) => !actor.static).map((actor) => actor.initial.pose);
  const allFocus = focus.length > 0 ? focus : base.actors.map((actor) => actor.initial.pose);
  const cohortRadiusBonusM = Math.max(0, options.cohortRadiusBonusM ?? 0);
  const roadLanes = eligibleDirectedLanes(graph, ['driving'], allFocus, profile.radiusM + cohortRadiusBonusM);
  // The authored corridor: every lane an authored actor is routed along, plus
  // whatever the caller reserved. Generated traffic may not spawn on it and may
  // not route through it, so it can never become an authored actor's leader or
  // its closest approach.
  const authoredCorridor = new Set<string>(options.excludedLaneRsls ?? []);
  if (options.allowAuthoredCorridor !== true) {
    for (const actor of base.actors) {
      if (actor.behavior.route.kind === 'lanePath') {
        for (const rsl of actor.behavior.route.lanes) authoredCorridor.add(rsl);
      }
      const laneRef = actor.initial.laneRef;
      if (laneRef) authoredCorridor.add(laneRef.rsl);
    }
  }
  const extraTravelSeconds = Math.max(0, options.extraTravelSeconds ?? 0);
  const eligibleRsls = new Set(roadLanes.map((lane) => lane.rsl).filter((rsl) => !authoredCorridor.has(rsl)));
  const eligibleLaneKm = roadLanes
    .filter((lane) => eligibleRsls.has(lane.rsl))
    .reduce((sum, lane) => sum + graph.lengthOf(lane.rsl), 0) / 1000;
  // `placementTarget` is what an un-settled run would have placed: the density
  // over the profile's OWN radius, under the profile's own actor cap. It is the
  // budget the settle re-selects down to, and it is reported so the caller does
  // not have to re-derive it.
  const baseEligibleLaneKm = cohortRadiusBonusM === 0
    ? eligibleLaneKm
    : eligibleDirectedLanes(graph, ['driving'], allFocus, profile.radiusM)
      .filter((lane) => eligibleRsls.has(lane.rsl))
      .reduce((sum, lane) => sum + graph.lengthOf(lane.rsl), 0) / 1000;
  const placementTarget = Math.min(profile.maxActors, Math.round(baseEligibleLaneKm * profile.densityVehiclesPerKm));
  const targetMultiplier = Math.max(1, Math.round(options.targetMultiplier ?? 1));
  const target = targetMultiplier
    * Math.min(profile.maxActors, Math.round(eligibleLaneKm * profile.densityVehiclesPerKm));
  const reservations: AmbientReservation[] = [
    ...base.actors.map((actor) => ({
      x: actor.initial.pose.x,
      z: actor.initial.pose.z,
      radiusM: profile.exclusionRadiusM + Math.hypot(actor.dims.l, actor.dims.w) * 0.5,
      reason: `authored:${actor.id}`,
    })),
    ...base.props.filter((prop) => prop.collidable && prop.attachment === undefined).map((prop) => ({
      x: prop.pose.x,
      z: prop.pose.z,
      radiusM: profile.exclusionRadiusM + Math.hypot(prop.dims.l * prop.scale, prop.dims.w * prop.scale) * 0.5,
      reason: `authored-prop:${prop.groupId ?? prop.id}`,
    })),
    ...(options.reservations ?? []),
  ];
  const occupied = [...reservations];
  const selected: AmbientCandidate[] = [];
  let rejectedSpawnCount = 0;
  // Spend the actor budget where it is visible.
  //
  // The pool is map-wide and ordered by generation attempt, so taking the first
  // `target` eligible candidates scatters the population uniformly across the
  // whole selection radius. Measured on `c3-allway-stop` at radius 90 m that put
  // a median of 2 vehicles within 60 m of the ego while placing 9 per cell — the
  // traffic existed, just not where the ego or the camera could see it.
  // Ranking by distance to the authored choreography puts the same budget on the
  // ego's own approach. The comparator is total and the tie-break is the stable
  // candidate id, so selection stays deterministic.
  const rankedCandidates = pool.candidates
    .filter((candidate) => eligibleRsls.has(candidate.laneRsl))
    .map((candidate) => {
      let nearest = Number.POSITIVE_INFINITY;
      for (const point of allFocus) {
        const d = Math.hypot(candidate.actor.initial.pose.x - point.x, candidate.actor.initial.pose.z - point.z);
        if (d < nearest) nearest = d;
      }
      return { candidate, nearest };
    })
    .sort((a, b) => a.nearest - b.nearest || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0))
    .map((entry) => entry.candidate);

  let authoredCorridorRejects = 0;
  for (const candidate of rankedCandidates) {
    if (selected.length >= target) break;
    // A candidate whose route re-enters the authored corridor DURING THE CLIP is
    // rejected too: spawning clear of the ego's lane is worthless if the car
    // drives into it 60 m later and becomes the ego's leader.
    //
    // The window is bounded on purpose. An earlier version rejected any route
    // that touched an authored lane anywhere along its full 5 km walk, and
    // measured on belmont-research-center/3b536530 that threw away 41 of 51
    // otherwise-usable candidates — background traffic starved because a car on
    // the far side of the map would eventually reach the ego's exit lane long
    // after the recording had stopped. Only ground contested inside
    // `warmupSeconds + clipSeconds` can affect the evidence, so only that much
    // of the route is protected. The travel budget is the same figure the
    // downstream-runway check below already uses.
    const travelBudgetM = (candidate.actor.behavior.cruiseSpeedMps ?? candidate.actor.initial.speedMps)
      * (base.warmupSeconds + base.clipSeconds + extraTravelSeconds) * 1.1;
    let travelledM = 0;
    let entersAuthoredCorridor = false;
    for (const rsl of candidate.routeLaneRsls) {
      if (authoredCorridor.has(rsl)) { entersAuthoredCorridor = true; break; }
      travelledM += graph.lengthOf(rsl);
      if (travelledM >= travelBudgetM) break;
    }
    if (entersAuthoredCorridor) {
      authoredCorridorRejects++;
      rejectedSpawnCount++;
      continue;
    }
    const { x, z } = candidate.actor.initial.pose;
    if (occupied.some((area) => Math.hypot(x - area.x, z - area.z) < area.radiusM + candidate.footprintRadiusM)) {
      rejectedSpawnCount++;
      continue;
    }
    const builtRoute = buildRoute(graph, candidate.actor.behavior.route);
    const laneRef = candidate.actor.initial.laneRef;
    const startOnRoute = builtRoute.ok && laneRef ? builtRoute.route.sOfLaneStorage(laneRef.rsl, laneRef.s) : null;
    const requiredDownstreamM = (candidate.actor.behavior.cruiseSpeedMps ?? candidate.actor.initial.speedMps)
      * (base.warmupSeconds + base.clipSeconds + extraTravelSeconds) * 1.1;
    if (!builtRoute.ok || startOnRoute === null || builtRoute.route.lengthM - startOnRoute < requiredDownstreamM) {
      rejectedSpawnCount++;
      continue;
    }
    selected.push(candidate);
    occupied.push({ x, z, radiusM: candidate.footprintRadiusM + 4, reason: candidate.id });
  }
  const actors = selected.map((candidate) => candidate.actor);
  const input = normalizeSimScenarioInput({ ...base, actors: [...base.actors, ...actors] });
  const warnings: string[] = [];
  if (target === 0 && profile.preset !== 'off') warnings.push('No eligible drivable lane length was available near the authored scenario.');
  if (actors.length < target) warnings.push(`Placed ${actors.length}/${target} ambient actors; reservations and route feasibility rejected the remainder.`);
  if (authoredCorridorRejects > 0) warnings.push(`${authoredCorridorRejects} candidate(s) rejected for entering the authored corridor (${authoredCorridor.size} lane(s)).`);
  return {
    input,
    provenance: {
      version: 1,
      profile,
      profileHash,
      candidatePoolKey: pool.key,
      mapGraphDigest: pool.mapGraphDigest,
      baseInputHash,
      generatedInputHash: contentHash(input),
      actors: selected.map(({ id, actor, routeLaneRsls, seedKey, origin, timelineVisible, editable }) => ({
        id,
        kind: actor.kind,
        routeLaneRsls,
        seedKey,
        origin,
        timelineVisible,
        editable,
      })),
      rejectedSpawnCount,
      authoredCorridorRejects,
      authoredCorridorLaneRsls: [...authoredCorridor].sort(),
      eligibleLaneKm,
      placementTarget,
      screening: {
        evaluated: false,
        passes: 0,
        maxAchievableDecelMps2: null,
        count: 0,
        actorIds: [],
        reasons: [],
      },
      warnings,
    },
  };
}

/** Convenience API: cheap pool construction plus selection; it never runs the clip. */
export function applyAmbientTraffic(
  base: SimScenarioInput,
  graph: LaneGraph,
  rawProfile: AmbientTrafficProfile,
  options: AmbientTrafficOptions = {},
): AmbientTrafficResult {
  return materializeAmbientCandidatePool(base, graph, createAmbientCandidatePool(graph, rawProfile), options);
}

/** One ambient expansion path shared by browser preparation and export. */
export function materializeAmbientTrafficProfile(
  base: SimScenarioInput,
  graph: LaneGraph,
  rawProfile: AmbientTrafficProfile,
  reusablePool?: AmbientCandidatePool,
  options: AmbientTrafficOptions = {},
): AmbientTrafficResult & { readonly candidatePool: AmbientCandidatePool } {
  const profile = resolveAmbientTrafficProfile(rawProfile);
  const profileHash = contentHash(profile);
  const candidatePool = reusablePool
    && reusablePool.mapGraphDigest === graph.topologyDigest
    && reusablePool.profileHash === profileHash
    ? reusablePool
    : createAmbientCandidatePool(graph, profile);
  return {
    ...materializeAmbientCandidatePool(base, graph, candidatePool, options),
    candidatePool,
  };
}

/** Remove ambient provenance so an editor can adopt the actor as authored. */
export function promoteAmbientActor(actor: SimActor, authoredId: string): SimActor {
  if (!actor.tags.includes('ambient')) throw new Error(`${actor.id} is not an ambient actor`);
  return {
    ...actor,
    id: authoredId,
    tags: actor.tags.filter((tag) => tag !== 'ambient' && !tag.startsWith('ambient:') && !tag.startsWith('ambient-')),
  };
}

function normalizeActor(actor: z.input<typeof actorSchema>): SimActor {
  return actorSchema.parse(actor);
}

function ambientCatalogId(kind: ActorKind): string {
  return {
    vehicle: 'vehicle.sedan',
    car: 'vehicle.sedan',
    truck: 'vehicle.box_truck',
    bus: 'vehicle.bus',
    van: 'vehicle.van',
    motorcycle: 'vehicle.motorcycle',
    bicycle: 'vehicle.bicycle',
    scooter: 'vehicle.bicycle',
    sidewalk_robot: 'sidewalk_robot.delivery_rover',
    drone: 'drone.camera_quadcopter',
    pedestrian: 'pedestrian.adult_walking',
    animal: 'pedestrian.child_walking',
    static_object: 'hazard.cardboard_box',
  }[kind];
}

function eligibleDirectedLanes(
  graph: LaneGraph,
  laneTypes: readonly string[],
  focus: readonly { x: number; z: number }[],
  radiusM: number,
): DirectedLane[] {
  const out: DirectedLane[] = [];
  for (const rsl of graph.laneRsls()) {
    const geom = graph.requireGeometry(rsl);
    if (geom.lane.isJunction || !laneTypes.includes(geom.lane.laneType)) continue;
    const reversed = graph.nominalReversed(rsl);
    if (reversed === null) continue;
    if (focus.length > 0) {
      let nearby = false;
      for (const point of focus) {
        const local = { x: point.x, y: -point.z };
        const projection = graph.projectOnto(rsl, local);
        if (projection && projection.d <= radiusM) { nearby = true; break; }
      }
      if (!nearby) continue;
    }
    out.push({ rsl, reversed });
  }
  return out.sort((a, b) => a.rsl.localeCompare(b.rsl));
}

function walkRoute(
  graph: LaneGraph,
  start: DirectedLane,
  profile: ResolvedAmbientTrafficProfile,
  rng: Rng,
  startRouteS: number,
  requiredDownstreamM: number,
  preferredFirstSuccessor?: string,
): string[] {
  const lanes = [start.rsl];
  let current = start;
  // `startRouteS` is measured in travel direction by `sampleDirected`.
  let lengthM = Math.max(0, graph.lengthOf(start.rsl) - startRouteS);
  const needM = Math.max(80, requiredDownstreamM);
  const visited = new Set([`${start.rsl}:${start.reversed ? 1 : 0}`]);
  while (lengthM < needM && lanes.length < 32) {
    const successors = graph.successors(current).filter((candidate) => !visited.has(`${candidate.rsl}:${candidate.reversed ? 1 : 0}`));
    if (successors.length === 0) break;
    const preferred = lanes.length === 1 && preferredFirstSuccessor
      ? successors.find((candidate) => candidate.rsl === preferredFirstSuccessor)
      : undefined;
    const next = preferred ?? weightedSuccessor(graph, successors, profile, rng);
    current = next;
    visited.add(`${next.rsl}:${next.reversed ? 1 : 0}`);
    lanes.push(next.rsl);
    lengthM += graph.lengthOf(next.rsl);
  }
  const built = buildRoute(graph, { kind: 'lanePath', lanes });
  return built.ok ? lanes : [];
}

function weightedSuccessor(
  graph: LaneGraph,
  candidates: readonly DirectedLane[],
  profile: ResolvedAmbientTrafficProfile,
  rng: Rng,
): DirectedLane {
  const weights = candidates.map((candidate) => {
    const relation = graph.turnRelationOf(candidate.rsl);
    if (relation === 'Left') return profile.flows.left;
    if (relation === 'Right') return profile.flows.right;
    if (relation === 'UTurnLeft' || relation === 'UTurnRight') return profile.flows.uTurn;
    return profile.flows.through;
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return candidates[0]!;
  let draw = rng.range(0, total);
  for (let i = 0; i < candidates.length; i++) {
    draw -= weights[i]!;
    if (draw <= 0) return candidates[i]!;
  }
  return candidates[candidates.length - 1]!;
}

function chooseRoadUserKind(profile: ResolvedAmbientTrafficProfile, rng: Rng): ActorKind {
  const shareDraw = rng.next();
  if (shareDraw < profile.pedestrianShare) return 'pedestrian';
  if (shareDraw < profile.pedestrianShare + profile.cyclistShare) return 'bicycle';
  return chooseVehicleKind(profile, rng);
}

function chooseVehicleKind(profile: ResolvedAmbientTrafficProfile, rng: Rng): ActorKind {
  const entries = Object.entries(profile.vehicleMix) as Array<[Exclude<ActorKind, 'vehicle' | 'bicycle' | 'pedestrian' | 'scooter' | 'animal' | 'static_object'>, number]>;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return 'car';
  let draw = rng.range(0, total);
  for (const [kind, weight] of entries) {
    draw -= weight;
    if (draw <= 0) return kind;
  }
  return 'car';
}
