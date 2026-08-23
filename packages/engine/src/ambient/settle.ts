import { contentHash } from '../core/hash.js';
import { toSceneXZ } from '../frames.js';
import type { LaneGraph } from '../map/lane-graph.js';
import { buildRoute } from '../map/route.js';
import { normalizeSimScenarioInput, type SimActor, type SimScenarioInput } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';

/**
 * AMBIENT WARM-UP (settle).
 *
 * ## Why this exists
 *
 * Generated background traffic is spawned already at cruise speed. The corpus
 * templates carry `choreography.warmupSeconds = 0.6`, so at `t = 0` no
 * generated car has had time to reach a stop line, close on a leader, or build
 * a queue: the road is populated but visibly "just started". Measured on a
 * nine-cell `--ambient city` run, **0 of 32** ambient actors were below
 * 0.5 m/s at `t = 0` (minimum 5.02 m/s), while **14 of 32** were below
 * 0.5 m/s by the end of the same 13 s clip. The queuing behaviour is correct;
 * what is missing is a settle window before the recording starts.
 *
 * ## Why not simply raise `warmupSeconds`
 *
 * `Simulation` integrates the WHOLE scene from `t = -warmupSeconds`. Raising it
 * advances the ego and the authored challenger along their routes too, and
 * arrival triggers sync to the ego, so the authored conflict timing is
 * destroyed. The warm-up has to advance the generated population and **nothing
 * else**.
 *
 * ## The mechanism
 *
 * Run a separate, throw-away simulation whose actor list contains ONLY the
 * generated population, then write its final state back as those actors'
 * *initial* state in the real input. Authored actors never enter the settle
 * sim, so their input bytes cannot change; with no ambient actors this function
 * returns the input object it was given, unmodified.
 *
 * Three facts make the write-back exact:
 *
 * 1. `Simulation` derives route progress by PROJECTING `initial.pose` onto the
 *    actor's route (`engine.ts`, "the authored scene transform is the t=0
 *    source of truth"). `initial.laneRef` is advisory. So a settled actor is
 *    expressed by rewriting `initial.pose`, `initial.speedMps` and
 *    `initial.laneRef` while keeping the same `behavior.route`.
 * 2. `SignalBook.stateAt` reads `elapsed = t + warmupSeconds + offsetS`. The
 *    real run's prologue starts at `elapsed = offsetS`; a settle run with
 *    `warmupSeconds = 0` ends at `elapsed = settleSeconds + offsetS'`. Setting
 *    `offsetS' = offsetS - settleSeconds` therefore hands the real run exactly
 *    the phase the settle finished on, so a queue that formed on red is still
 *    stopped on red when the clip begins.
 * 3. Trace tracks are xodr-local (`frames.ts`), so `pose.z = -track.y`.
 *
 * The pass is deterministic: same seed, same profile, same population, same
 * settle, same digest.
 */

/** Generated actors are the ones the ambient generator tagged. */
function isAmbient(actor: SimActor): boolean {
  return actor.tags.includes('ambient');
}

export interface AmbientSettleOptions {
  /** Seconds of ambient-only integration before `t = 0`. `0` disables the pass. */
  readonly settleSeconds: number;
  /** Explicit population; defaults to every actor tagged `ambient`. */
  readonly ambientActorIds?: readonly string[];
  /** Integration step; defaults to the scenario `dt`. */
  readonly dt?: number;
  /**
   * POST-SETTLE SELECTION BUDGET.
   *
   * The generated population that matters is the one on the road at `t = 0`,
   * not the one spawned `settleSeconds` earlier. Measured on `c15g` with a 20 s
   * settle and no post-selection, the median number of ambient vehicles within
   * 60 m of the ego fell from 5 to 0: the population had simply driven 260 m
   * down the road. So the caller hands in an oversized COHORT and this pass
   * re-applies the near-authored ranking and the actor budget to the SETTLED
   * positions.
   *
   * Absent means "keep everything that survived", i.e. cohort == population.
   */
  readonly keep?: number;
  /**
   * Clearance the authored actors and props keep at `t = 0`.
   *
   * `AmbientTrafficOptions` enforces this at SPAWN. After a settle that is the
   * wrong instant: a generated car that spawned clear can be sitting on the
   * ego's spawn point twenty seconds later. Enforcing it here re-establishes it
   * at the instant the recording actually begins.
   */
  readonly exclusionRadiusM?: number;
}

export interface AmbientSettleProvenance {
  readonly version: 1;
  readonly settleSeconds: number;
  readonly dt: number;
  /** Actors that entered the settle sim. */
  readonly settledActorIds: readonly string[];
  /** Size of the cohort that entered the settle sim. */
  readonly cohortSize: number;
  /** Post-settle selection budget, or `null` when everything was kept. */
  readonly keep: number | null;
  /** Settled actors that had left the world by the end of the settle. */
  readonly droppedActorIds: readonly string[];
  /** Survivors dropped because they ended inside an authored clearance. */
  readonly authoredClearanceRejects: number;
  /** Survivors dropped because the post-settle budget was already full. */
  readonly budgetRejects: number;
  /** Settled actors whose final state could not be read back. */
  readonly unresolvedActorIds: readonly string[];
  readonly signalProgramsShifted: number;
  /** Speeds at the end of the settle, i.e. at real-run `t = -warmupSeconds`. */
  readonly finalSpeedMps: {
    readonly min: number;
    readonly median: number;
    readonly max: number;
    readonly belowHalfMps: number;
  } | null;
  readonly inputHashBefore: string;
  readonly inputHashAfter: string;
  readonly warnings: readonly string[];
}

export interface AmbientSettleResult {
  readonly input: SimScenarioInput;
  readonly provenance: AmbientSettleProvenance | null;
}

/**
 * Advance ONLY the generated population by `settleSeconds` and fold the result
 * back into their initial state. Authored actors are untouched by construction.
 */
export function settleAmbientTraffic(
  base: SimScenarioInput,
  graph: LaneGraph,
  options: AmbientSettleOptions,
): AmbientSettleResult {
  const settleSeconds = options.settleSeconds;
  const explicit = options.ambientActorIds === undefined ? null : new Set(options.ambientActorIds);
  const population = base.actors.filter((actor) =>
    explicit === null ? isAmbient(actor) : explicit.has(actor.id));
  // No settle requested, or nothing to settle: return the caller's own object so
  // an authored-only input is byte-identical and every historical digest holds.
  if (!(settleSeconds > 0) || population.length === 0) return { input: base, provenance: null };

  const dt = options.dt ?? base.dt;
  const warnings: string[] = [];
  const settleInput = normalizeSimScenarioInput({
    ...base,
    clipSeconds: settleSeconds,
    warmupSeconds: 0,
    dt,
    actors: population,
    // Authored choreography cannot be carried: every interaction names an
    // authored actor, and the near-miss criteria and metric subject do too.
    interactions: [],
    nearMissCriteria: undefined,
    metricSubject: population[0]!.id,
    // Hand the settle the phase that ends where the real prologue begins.
    signalPrograms: base.signalPrograms.map((program) => ({
      ...program,
      offsetS: program.offsetS - settleSeconds,
    })),
  });

  const result = runSimulation(settleInput, { graph, guards: 'skip', resolveArrival: false });
  const ticks = result.trace.ticks;
  const last = ticks.t.length - 1;
  if (last < 0) {
    warnings.push('settle produced no ticks; the population is unchanged');
    return { input: base, provenance: null };
  }

  const populationIds = new Set(population.map((actor) => actor.id));
  const authored = base.actors.filter((actor) => !populationIds.has(actor.id));
  const dropped: string[] = [];
  const unresolved: string[] = [];
  const survivors: Array<{ actor: SimActor; nearestAuthoredM: number; speedMps: number }> = [];
  // Rank against the authored choreography, exactly as spawn-time selection
  // does: the budget has to be spent where the ego and the camera can see it.
  const focusPoses = (authored.some((actor) => !actor.static)
    ? authored.filter((actor) => !actor.static)
    : authored).map((actor) => actor.initial.pose);

  for (const actor of population) {
    const track = ticks.actors[actor.id];
    if (!track) { unresolved.push(actor.id); continue; }
    // An actor that ran off the end of its route despawns during the settle. It
    // is dropped rather than teleported back: it has physically left the scene.
    if (track.present[last] !== 1) { dropped.push(actor.id); continue; }

    const x = track.x[last];
    const y = track.y[last];
    const headingRad = track.headingRad[last];
    const speedMps = track.speedMps[last];
    if (x === undefined || y === undefined || headingRad === undefined || speedMps === undefined) {
      unresolved.push(actor.id);
      continue;
    }
    const pose = toSceneXZ({ x, y });
    const settled: SimActor = {
      ...actor,
      initial: {
        ...actor.initial,
        pose: { ...actor.initial.pose, x: pose.x, z: pose.z, headingRad },
        speedMps: Math.max(0, speedMps),
        laneRef: settledLaneRef(base, graph, actor, track.laneRsl[last] ?? null, track.s[last], track.lateralOffsetM[last]),
      },
    };
    let nearest = Number.POSITIVE_INFINITY;
    for (const point of focusPoses) {
      const d = Math.hypot(pose.x - point.x, pose.z - point.z);
      if (d < nearest) nearest = d;
    }
    survivors.push({ actor: settled, nearestAuthoredM: nearest, speedMps: Math.max(0, speedMps) });
  }

  // Total order, tie-broken on the stable actor id, so the selection is
  // deterministic for a given seed.
  survivors.sort((a, b) =>
    a.nearestAuthoredM - b.nearestAuthoredM ||
    (a.actor.id < b.actor.id ? -1 : a.actor.id > b.actor.id ? 1 : 0));

  // Re-establish, at t = 0, the two spawn-time rules the settle invalidated:
  // authored clearance and the actor budget.
  const exclusionRadiusM = Math.max(0, options.exclusionRadiusM ?? 0);
  const occupied: Array<{ x: number; z: number; radiusM: number }> = exclusionRadiusM === 0 ? [] : [
    ...authored.map((actor) => ({
      x: actor.initial.pose.x,
      z: actor.initial.pose.z,
      radiusM: exclusionRadiusM + Math.hypot(actor.dims.l, actor.dims.w) * 0.5,
    })),
    ...base.props.filter((prop) => prop.collidable && prop.attachment === undefined).map((prop) => ({
      x: prop.pose.x,
      z: prop.pose.z,
      radiusM: exclusionRadiusM + Math.hypot(prop.dims.l * prop.scale, prop.dims.w * prop.scale) * 0.5,
    })),
  ];
  const keep = options.keep === undefined ? null : Math.max(0, Math.round(options.keep));
  const selected: SimActor[] = [];
  const finalSpeeds: number[] = [];
  let authoredClearanceRejects = 0;
  let budgetRejects = 0;
  for (const survivor of survivors) {
    if (keep !== null && selected.length >= keep) { budgetRejects++; continue; }
    const { x, z } = survivor.actor.initial.pose;
    const footprintRadiusM = Math.hypot(survivor.actor.dims.l, survivor.actor.dims.w) * 0.5;
    if (occupied.some((area) => Math.hypot(x - area.x, z - area.z) < area.radiusM + footprintRadiusM)) {
      authoredClearanceRejects++;
      continue;
    }
    // Bodies that ended the settle interpenetrating are separated the same way
    // spawn selection separates them: the nearer-to-authored one wins the space.
    if (selected.some((other) => Math.hypot(x - other.initial.pose.x, z - other.initial.pose.z)
      < footprintRadiusM + Math.hypot(other.dims.l, other.dims.w) * 0.5)) {
      authoredClearanceRejects++;
      continue;
    }
    selected.push(survivor.actor);
    finalSpeeds.push(survivor.speedMps);
  }

  if (selected.length === 0) {
    warnings.push('no ambient actor survived the settle; the population is unchanged');
    return { input: base, provenance: null };
  }

  // Authored actors keep their position AND their order; the settled population
  // is appended in selection order, exactly as `applyAmbientTraffic` appends it.
  const selectedIds = new Set(selected.map((actor) => actor.id));
  const settledById = new Map(selected.map((actor) => [actor.id, actor] as const));
  const actors = [
    ...base.actors.filter((actor) => !populationIds.has(actor.id)),
    ...base.actors.filter((actor) => selectedIds.has(actor.id)).map((actor) => settledById.get(actor.id)!),
  ];
  const input = normalizeSimScenarioInput({ ...base, actors });

  const sorted = [...finalSpeeds].sort((a, b) => a - b);
  const median = sorted.length === 0
    ? null
    : sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  if (dropped.length > 0) {
    warnings.push(`${dropped.length} ambient actor(s) left the world during the ${settleSeconds}s settle and were removed.`);
  }
  if (unresolved.length > 0) {
    warnings.push(`${unresolved.length} ambient actor(s) had no readable settle state and kept their spawn state.`);
  }

  return {
    input,
    provenance: {
      version: 1,
      settleSeconds,
      dt,
      settledActorIds: [...settledById.keys()].sort(),
      cohortSize: population.length,
      keep,
      droppedActorIds: [...dropped].sort(),
      authoredClearanceRejects,
      budgetRejects,
      unresolvedActorIds: [...unresolved].sort(),
      signalProgramsShifted: base.signalPrograms.length,
      finalSpeedMps: median === null ? null : {
        min: sorted[0]!,
        median,
        max: sorted[sorted.length - 1]!,
        belowHalfMps: sorted.filter((v) => v < 0.5).length,
      },
      inputHashBefore: contentHash(base),
      inputHashAfter: contentHash(input),
      warnings,
    },
  };
}

/**
 * Re-express the settled position as a lane reference.
 *
 * `laneRef` is advisory for placement (the pose wins), but the engine compares
 * the two and warns when they disagree by more than 0.25 m, and downstream
 * consumers read it. `Route.sOfLaneStorage` maps lane storage to route arc
 * length affinely inside a leg, so the inverse is one linear solve; `tFrac`
 * comes from the settled lateral offset so the declared point reproduces the
 * settled pose rather than the lane centreline.
 */
function settledLaneRef(
  base: SimScenarioInput,
  graph: LaneGraph,
  actor: SimActor,
  laneRsl: string | null,
  routeS: number | undefined,
  lateralOffsetM: number | undefined,
): SimActor['initial']['laneRef'] {
  if (laneRsl === null || routeS === undefined) return undefined;
  const built = buildRoute(graph, actor.behavior.route);
  if (!built.ok) return undefined;
  const route = built.route;
  const laneLengthM = graph.lengthOf(laneRsl);
  if (!(laneLengthM > 0)) return undefined;
  const sAtZero = route.sOfLaneStorage(laneRsl, 0);
  const sAtEnd = route.sOfLaneStorage(laneRsl, laneLengthM);
  if (sAtZero === null || sAtEnd === null || sAtEnd === sAtZero) return undefined;
  const storageS = ((routeS - sAtZero) / (sAtEnd - sAtZero)) * laneLengthM;
  if (!Number.isFinite(storageS)) return undefined;
  const clamped = Math.min(laneLengthM, Math.max(0, storageS));
  const widthM = route.widthAt(routeS);
  const tFrac = widthM > 0 && lateralOffsetM !== undefined ? lateralOffsetM / widthM : 0;
  return { rsl: laneRsl, s: clamped, tFrac: Math.min(1, Math.max(-1, tFrac)) };
}
