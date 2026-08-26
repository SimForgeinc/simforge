/**
 * WorldSession — a multi-client, command-driven world over the fixed-step
 * engine (world-session server v1, F5).
 *
 * ## Design: world state is a pure function of the command log
 *
 * The engine has no runtime-mutation surface: actors are authored in
 * `SimScenarioInput`, and mid-clip presence is expressed with
 * `presentAtStart: false` + `exist` interactions. WorldSession therefore
 * implements arbitrary runtime spawn/despawn by **input mutation plus
 * deterministic rebuild**: a structural command produces a candidate input
 * (new actor spec, new `exist` interaction anchored at the current tick
 * boundary), validates it through the engine's own entry points, and — on
 * acceptance — rebuilds the simulation from t = -warmup and re-advances to
 * the current tick. The engine is deterministic, so every pre-existing actor
 * lands exactly where it was; the world continues seamlessly.
 *
 * Because every mutation is recorded in an ordered session log, replaying the
 * log against the same base input and lane graph reproduces the exact same
 * sequence of engine generations, tick frames, and therefore the same trace
 * digest. The log is the artifact; the digest is the proof.
 *
 * ## Engine entry points used (never forked)
 *
 * - catalog:      `ACTOR_KINDS`, `DEFAULT_ACTOR_DIMS`, `parseSimScenarioInput`
 * - ground snap:  `LaneGraph.nearestLane` / `sampleDirected` / `nominalReversed`
 * - validation:   `checkFeasibility` (schema + route/lane guards) and
 *                 `obbOverlap` against the *current* world snapshot (the
 *                 feasibility guards only cover t = 0 placement)
 * - execution:    `createFixedStepSimulation` with an `ActionHook` timeline
 *
 * ## Digest
 *
 * Every live engine tick with `tS >= 0` is hashed (chained SHA-256 over the
 * canonical JSON of the sorted actor rows). Catch-up ticks replayed during a
 * rebuild are *not* re-hashed: the digest covers frames as first observed,
 * and a replayed log rebuilds at the same boundaries, so the hashed frame
 * sequence is identical by construction.
 */

import {
  ACTOR_KINDS,
  DEFAULT_ACTOR_DIMS,
  canonicalJson,
  checkFeasibility,
  contentHash,
  createFixedStepSimulation,
  isRoadActorKind,
  localFromScene,
  normalizeSimScenarioInput,
  obbOverlap,
  parseSimScenarioInput,
  sceneHeading,
  sha256,
  toSceneXZ,
  type ActionHook,
  type ActionOverride,
  type ActorKind,
  type Dims,
  type FixedStepSimulationSession,
  type LaneGraph,
  type Obb,
  type RouteSpec,
  type SessionActorSnapshot,
  type SimEvent,
  type SimScenarioInput,
  type TickObserver,
} from '@simforge-oss/engine';
import {
  WorldTruthPublisher,
  type TruthActorCatalogEntry,
  type TruthSubscription,
} from './truth-stream.js';
/** Version tag of the session-log artifact; bumped on any breaking change. */
export const WORLD_SESSION_LOG_VERSION = 1;

const EPS_S = 1e-9;
/** Ground-snap search radius; matches `LaneGraph.nearestLane`'s default. */
const SNAP_MAX_DIST_M = 25;

/* ------------------------------------------------------------- commands */

/**
 * A runtime spawn request. Everything beyond `kind` and `pose` has an
 * engine-derived default: dims from `DEFAULT_ACTOR_DIMS`, lane placement from
 * the nearest drivable lane (road kinds), heading from the snapped lane
 * tangent, and a `follow` route from the snapped lane (road kinds) or a
 * zero-length `polyline` hold (everything else).
 */
export interface SpawnRequest {
  /** Explicit actor id; must be globally unused. Omitted = allocated (`ws:NNNN`). */
  readonly id?: string;
  readonly kind: ActorKind;
  /** Scene-frame ground pose. `headingRad` optional when lane-snapped. */
  readonly pose: { readonly x: number; readonly z: number; readonly headingRad?: number };
  readonly speedMps?: number;
  readonly dims?: Dims;
  /** Explicit route; overrides the snap-derived default. */
  readonly route?: RouteSpec;
  readonly cruiseSpeedMps?: number;
  /** Snap pose to the nearest drivable lane. Default: `isRoadActorKind(kind)`. */
  readonly snapToLane?: boolean;
  readonly static?: boolean;
  readonly tags?: readonly string[];
}

export type BatchOp =
  | { readonly kind: 'spawn'; readonly spawn: SpawnRequest }
  | { readonly kind: 'despawn'; readonly actorId: string };

export type WorldCommand =
  | { readonly kind: 'spawn'; readonly spawn: SpawnRequest }
  | { readonly kind: 'despawn'; readonly actorId: string }
  /** Atomic: every op applies, or none does and the world is untouched. */
  | { readonly kind: 'batch'; readonly ops: readonly BatchOp[] }
  /** Zero-order-hold action override for one actor; `null` releases it. */
  | { readonly kind: 'act'; readonly actorId: string; readonly action: ActionOverride | null };

export interface CommandOutcome {
  readonly ok: boolean;
  /** Actor ids allocated/affected by spawn ops, in op order. */
  readonly actorIds?: readonly string[];
  readonly error?: string;
}

/* ------------------------------------------------------------ session log */

export type WorldLogEntry =
  | {
      readonly kind: 'command';
      readonly clientId: string;
      readonly seq: number;
      readonly command: WorldCommand;
      readonly ok: boolean;
      readonly actorIds?: readonly string[];
      readonly error?: string;
    }
  | { readonly kind: 'advance'; readonly ticks: number };

/** The session log artifact: everything needed to replay the world exactly. */
export interface WorldSessionLog {
  readonly version: typeof WORLD_SESSION_LOG_VERSION;
  /** `contentHash` of the normalized base input the session was built from. */
  readonly baseInputHash: string;
  readonly horizonSeconds: number;
  readonly entries: readonly WorldLogEntry[];
  /** Chained frame digest at export time. */
  readonly digest: string;
}

/* -------------------------------------------------------------- snapshots */

/** Scene-frame actor row exposed to clients. */
export interface WorldActorState {
  readonly id: string;
  readonly kind: ActorKind;
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly present: boolean;
  readonly s: number;
  readonly laneRsl: string | null;
}

export interface WorldSnapshot {
  readonly tS: number;
  readonly tick: number;
  readonly done: boolean;
  readonly actors: readonly WorldActorState[];
}

export interface AdvanceResult {
  readonly tS: number;
  readonly tick: number;
  readonly done: boolean;
  readonly events: readonly SimEvent[];
  readonly actors: readonly WorldActorState[];
}

export interface WorldSessionOptions {
  readonly input: SimScenarioInput;
  readonly graph: LaneGraph;
  /**
   * The world's clip horizon, seconds. A world session is open-ended relative
   * to the authored clip, so the default extends it to 120 s.
   */
  readonly horizonSeconds?: number;
}

/* ---------------------------------------------------------------- helpers */

function obbOf(a: Pick<SessionActorSnapshot, 'x' | 'y' | 'headingRad'>, dims: Dims): Obb {
  return { center: { x: a.x, y: a.y }, lengthM: dims.l, widthM: dims.w, headingRad: a.headingRad };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Does a feasibility-issue path refer to one of `ids`? Paths are dotted (`actors.<id>.…`). */
function pathTouches(path: string, ids: readonly string[]): boolean {
  return ids.some((id) => path === `actors.${id}` || path.startsWith(`actors.${id}.`)
    || path === `interactions.${id}` || path.startsWith(`interactions.${id}.`)
    || path.includes(`.${id}.`) || path.endsWith(`.${id}`));
}

interface ActionEpoch {
  readonly fromTS: number;
  readonly action: ActionOverride | null;
}

/* ------------------------------------------------------------ the session */

export class WorldSession {
  private readonly graph: LaneGraph;
  private readonly horizonSeconds: number;
  /** Canonical, normalized current input; swapped atomically on commit. */
  private input: SimScenarioInput;
  private sim: FixedStepSimulationSession;

  /** Ticks advanced past t = 0 (requested; the engine clamps at `done`). */
  private tickCount = 0;
  private actorCounter = 0;
  private existCounter = 0;
  /** Per-actor zero-order-hold action timeline (append-only, time-ordered). */
  private readonly actionTimeline = new Map<string, ActionEpoch[]>();
  /** Spawn/despawn events surfaced by a rebuild's catch-up, for the next advance. */
  private pendingEvents: SimEvent[] = [];
  private readonly entries: WorldLogEntry[] = [];
  private digestHex: string;
  /** Pull-based truth fan-out; never calls consumer code from the tick path. */
  private readonly truthPublisher = new WorldTruthPublisher();
  private actorCatalog = new Map<string, TruthActorCatalogEntry>();

  readonly baseInputHash: string;

  constructor(options: WorldSessionOptions) {
    this.graph = options.graph;
    this.horizonSeconds = options.horizonSeconds ?? 120;
    this.input = normalizeSimScenarioInput({ ...options.input, clipSeconds: this.horizonSeconds });
    this.baseInputHash = contentHash(this.input);
    this.refreshActorCatalog();
    this.digestHex = sha256(`world-session.v${WORLD_SESSION_LOG_VERSION}:${this.baseInputHash}`);

    const errors = checkFeasibility(this.input, this.graph).filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new Error(`base input fails feasibility: ${errors.map((i) => `${i.code}@${i.path}`).join(', ')}`);
    }
    this.sim = this.buildSim();
    this.consumeWarmup();
  }

  /* -------------------------------------------------------------- engine */

  private buildSim(): FixedStepSimulationSession {
    // Guards are 'skip': the constructor and every structural commit run
    // checkFeasibility explicitly, so construction must never re-litigate.
    return createFixedStepSimulation(this.input, {
      graph: this.graph,
      guards: 'skip',
      actionHook: this.hook,
    });
  }

  /**
   * The engine records state *at* t before stepping, so consuming exactly
   * warmupTicks leaves the snapshot at t = -dt; one more tick parks the world
   * at t = 0 (same convention as EnvSession).
   */
  private consumeWarmup(): void {
    const warmupTicks = Math.round(this.input.warmupSeconds / this.input.dt) + 1;
    if (warmupTicks > 0) this.sim.advance(warmupTicks);
  }

  /** Zero-order hold: the latest action epoch at or before tS drives the actor. */
  private readonly hook: ActionHook = ({ actorId, tS }): ActionOverride | undefined => {
    const timeline = this.actionTimeline.get(actorId);
    if (!timeline) return undefined;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const epoch = timeline[i]!;
      if (tS >= epoch.fromTS - EPS_S) return epoch.action ?? undefined;
    }
    return undefined;
  };

  /** Chained digest and atomic truth publication for every live tick. */
  private readonly onTick: TickObserver = (obs) => {
    if (obs.tS < -EPS_S) return;
    const rows = obs.actors
      .map((a) => [a.id, a.x, a.y, a.headingRad, a.speedMps, a.present ? 1 : 0, a.s] as const)
      .sort((r, q) => (r[0] < q[0] ? -1 : r[0] > q[0] ? 1 : 0));
    this.digestHex = sha256(this.digestHex + canonicalJson([obs.tickIndex, obs.tS, rows]));
    this.truthPublisher.publish(obs, this.sim.signalBook(), this.actorCatalog, this.input.dt);
  };

  private refreshActorCatalog(): void {
    this.actorCatalog = new Map(this.input.actors.map((actor) => [
      actor.id,
      {
        kind: actor.kind,
        dims: actor.dims ?? DEFAULT_ACTOR_DIMS[actor.kind],
      },
    ]));
  }

  /**
   * Rebuild the engine from the (new) canonical input and re-advance to the
   * current tick. Deterministic engine ⇒ pre-existing actors reproduce their
   * exact state; frames are NOT re-hashed (see the digest contract above).
   * Spawn/despawn events for actors touched by this rebuild that fire exactly
   * at the boundary are kept for the next advance's event report.
   */
  private rebuild(touchedIds: readonly string[], boundaryTS: number): void {
    this.sim = this.buildSim();
    this.consumeWarmup();
    if (this.tickCount > 0) this.sim.advance(this.tickCount);
    const replayed = this.sim.drainEvents();
    for (const event of replayed) {
      if (
        event.t >= boundaryTS - EPS_S &&
        (event.kind === 'spawn' || event.kind === 'despawn') &&
        touchedIds.includes(event.actorId)
      ) {
        this.pendingEvents.push(event);
      }
    }
  }

  /* ------------------------------------------------------------ read side */

  time(): number {
    return this.sim.peek().tS;
  }

  tick(): number {
    return this.tickCount;
  }

  digest(): string {
    return this.digestHex;
  }

  /**
   * Subscribe to future committed ticks. The pull queue is bounded and uses
   * drop-oldest, so a consumer can never stall world advancement.
   */
  subscribeTruth(options: { readonly capacity?: number } = {}): TruthSubscription {
    return this.truthPublisher.subscribe(options.capacity);
  }

  snapshot(): WorldSnapshot {
    const snap = this.sim.peek();
    const kinds = new Map(this.input.actors.map((a) => [a.id, a.kind]));
    return {
      tS: snap.tS,
      tick: this.tickCount,
      done: snap.done,
      actors: snap.actors.map((a) => {
        const scene = toSceneXZ({ x: a.x, y: a.y });
        return {
          id: a.id,
          kind: kinds.get(a.id) ?? 'vehicle',
          x: scene.x,
          z: scene.z,
          headingRad: sceneHeading(a.headingRad),
          speedMps: a.speedMps,
          present: a.present,
          s: a.s,
          laneRsl: a.laneRsl,
        };
      }),
    };
  }

  exportLog(): WorldSessionLog {
    return {
      version: WORLD_SESSION_LOG_VERSION,
      baseInputHash: this.baseInputHash,
      horizonSeconds: this.horizonSeconds,
      entries: [...this.entries],
      digest: this.digestHex,
    };
  }

  /* ----------------------------------------------------------- write side */

  /**
   * Apply one command at the current tick boundary and record it in the log.
   * Ordering across clients is the caller's contract (the registry sorts
   * queued commands by client id, then seq, before applying).
   */
  applyCommand(clientId: string, seq: number, command: WorldCommand): CommandOutcome {
    const outcome = this.execute(command);
    this.entries.push({
      kind: 'command',
      clientId,
      seq,
      command,
      ok: outcome.ok,
      ...(outcome.actorIds ? { actorIds: outcome.actorIds } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    return outcome;
  }

  /** Advance the engine by `ticks`, hashing every frame into the digest. */
  advance(ticks: number): AdvanceResult {
    if (!Number.isInteger(ticks) || ticks <= 0) throw new Error(`ticks must be a positive integer, got ${String(ticks)}`);
    this.sim.advance(ticks, { onTick: this.onTick });
    this.tickCount += ticks;
    const events = [...this.pendingEvents, ...this.sim.drainEvents()];
    this.pendingEvents = [];
    this.entries.push({ kind: 'advance', ticks });
    const snap = this.snapshot();
    return { tS: snap.tS, tick: snap.tick, done: snap.done, events, actors: snap.actors };
  }

  private execute(command: WorldCommand): CommandOutcome {
    switch (command.kind) {
      case 'spawn':
        return this.applyStructural([{ kind: 'spawn', spawn: command.spawn }]);
      case 'despawn':
        return this.applyStructural([{ kind: 'despawn', actorId: command.actorId }]);
      case 'batch':
        if (command.ops.length === 0) return { ok: false, error: 'batch must contain at least one op' };
        return this.applyStructural(command.ops);
      case 'act':
        return this.applyAct(command.actorId, command.action);
      default:
        return { ok: false, error: `unknown command kind ${String((command as { kind?: unknown }).kind)}` };
    }
  }

  private applyAct(actorId: string, action: ActionOverride | null): CommandOutcome {
    if (!this.input.actors.some((a) => a.id === actorId)) {
      return { ok: false, error: `act: unknown actor ${actorId}` };
    }
    const epoch: ActionEpoch = { fromTS: this.time(), action };
    const timeline = this.actionTimeline.get(actorId);
    if (timeline) timeline.push(epoch);
    else this.actionTimeline.set(actorId, [epoch]);
    return { ok: true };
  }

  /**
   * Atomic structural mutation: resolve and validate every op against a
   * candidate input; commit (swap input + rebuild) only when the whole batch
   * is valid, otherwise reject and leave the world byte-identical.
   */
  private applyStructural(ops: readonly BatchOp[]): CommandOutcome {
    const snap = this.sim.peek();
    const boundaryTS = snap.tS;

    const dimsById = new Map(this.input.actors.map((a) => [a.id, a.dims]));
    const worldObbs = snap.actors
      .filter((a) => a.present)
      .map((a) => ({ id: a.id, obb: obbOf(a, dimsById.get(a.id) ?? DEFAULT_ACTOR_DIMS.vehicle) }));

    const usedIds = new Set(this.input.actors.map((a) => a.id));
    const presentNow = new Set(snap.actors.filter((a) => a.present).map((a) => a.id));
    const batchSpawned = new Set<string>();
    const batchDespawned = new Set<string>();
    const batchObbs: Array<{ id: string; obb: Obb }> = [];

    const newActors: unknown[] = [];
    const newInteractions: unknown[] = [];
    const spawnedIds: string[] = [];
    let actorCounter = this.actorCounter;
    let existCounter = this.existCounter;

    for (const op of ops) {
      if (op.kind === 'spawn') {
        const req = op.spawn;
        if (!ACTOR_KINDS.includes(req.kind)) return { ok: false, error: `spawn: unknown actor kind ${String(req.kind)}` };

        let id = req.id;
        if (id !== undefined) {
          if (usedIds.has(id)) return { ok: false, error: `spawn: actor id ${id} already in use` };
        } else {
          do id = `ws:${pad(++actorCounter, 4)}`; while (usedIds.has(id));
        }

        const resolved = this.resolveSpawnPlacement(req);
        if (!resolved.ok) return { ok: false, error: `spawn ${id}: ${resolved.error}` };
        const { pose, laneRef, route } = resolved;

        const dims = req.dims ?? DEFAULT_ACTOR_DIMS[req.kind];
        const obb: Obb = { center: localFromScene(pose), lengthM: dims.l, widthM: dims.w, headingRad: pose.headingRad };
        const hit = [...worldObbs, ...batchObbs].find((o) => !batchDespawned.has(o.id) && obbOverlap(obb, o.obb));
        if (hit) return { ok: false, error: `spawn ${id}: footprint overlaps ${hit.id} at the current tick` };

        usedIds.add(id);
        batchSpawned.add(id);
        batchObbs.push({ id, obb });
        spawnedIds.push(id);
        newActors.push({
          id,
          kind: req.kind,
          ...(req.dims ? { dims: req.dims } : {}),
          initial: { ...(laneRef ? { laneRef } : {}), pose, speedMps: req.speedMps ?? 0 },
          behavior: { route, ...(req.cruiseSpeedMps !== undefined ? { cruiseSpeedMps: req.cruiseSpeedMps } : {}) },
          presentAtStart: false,
          ...(req.static !== undefined ? { static: req.static } : {}),
          tags: [...(req.tags ?? []), 'world-session:spawned'],
        });
        newInteractions.push({
          id: `ws:exist:${pad(++existCounter, 6)}`,
          actorId: id,
          trigger: { kind: 'at', t: boundaryTS },
          verb: 'exist',
          target: { state: 'present' },
        });
      } else {
        const id = op.actorId;
        const alive = (presentNow.has(id) || batchSpawned.has(id)) && !batchDespawned.has(id);
        if (!alive) return { ok: false, error: `despawn: actor ${id} is not present at the current tick` };
        batchDespawned.add(id);
        newInteractions.push({
          id: `ws:exist:${pad(++existCounter, 6)}`,
          actorId: id,
          trigger: { kind: 'at', t: boundaryTS },
          verb: 'exist',
          target: { state: 'absent' },
        });
      }
    }

    // Schema gate: the candidate must parse through the engine's own contract.
    let candidate: SimScenarioInput;
    try {
      candidate = normalizeSimScenarioInput(
        parseSimScenarioInput({
          ...this.input,
          actors: [...this.input.actors, ...(newActors as SimScenarioInput['actors'])],
          interactions: [...this.input.interactions, ...(newInteractions as SimScenarioInput['interactions'])],
        }),
      );
    } catch (error) {
      return { ok: false, error: `batch rejected by input schema: ${error instanceof Error ? error.message : String(error)}` };
    }

    // Feasibility gate, scoped to what this batch introduced: pre-existing
    // issues in the base input are not this batch's fault and never block it.
    const touched = [...spawnedIds, ...batchDespawned];
    const bad = checkFeasibility(candidate, this.graph).find(
      (issue) => issue.severity === 'error' && pathTouches(issue.path, touched),
    );
    if (bad) return { ok: false, error: `batch rejected by feasibility: ${bad.code} at ${bad.path}` };

    // Commit: swap the canonical input and its static truth catalog together,
    // then rebuild at the boundary.
    this.input = candidate;
    this.refreshActorCatalog();
    this.actorCounter = actorCounter;
    this.existCounter = existCounter;
    this.rebuild(touched, boundaryTS);
    return { ok: true, actorIds: spawnedIds };
  }

  /**
   * Ground snap + defaults for one spawn request, via the lane graph:
   * nearest drivable lane, its legal traversal direction, and the lane
   * tangent as the default heading. Non-road kinds (and `snapToLane: false`)
   * keep the authored pose and hold position on a zero-length polyline route
   * unless an explicit route is given.
   */
  private resolveSpawnPlacement(req: SpawnRequest):
    | { ok: true; pose: { x: number; z: number; headingRad: number }; laneRef: { rsl: string; s: number; tFrac: number } | null; route: RouteSpec }
    | { ok: false; error: string } {
    const snap = req.snapToLane ?? isRoadActorKind(req.kind);
    if (!snap) {
      const pose = { x: req.pose.x, z: req.pose.z, headingRad: req.pose.headingRad ?? 0 };
      return { ok: true, pose, laneRef: null, route: req.route ?? { kind: 'polyline', points: [{ x: pose.x, z: pose.z }] } };
    }
    const local = localFromScene(req.pose);
    const nearest = this.graph.nearestLane(local, { maxDistM: SNAP_MAX_DIST_M });
    if (!nearest) return { ok: false, error: `no drivable lane within ${SNAP_MAX_DIST_M} m of (${req.pose.x}, ${req.pose.z})` };
    const reversed = this.graph.nominalReversed(nearest.rsl) ?? false;
    const lengthM = this.graph.lengthOf(nearest.rsl);
    const directedS = reversed ? lengthM - nearest.s : nearest.s;
    const sample = this.graph.sampleDirected({ rsl: nearest.rsl, reversed }, directedS);
    const scene = toSceneXZ(sample.point);
    const pose = { x: scene.x, z: scene.z, headingRad: req.pose.headingRad ?? sceneHeading(sample.headingRad) };
    return {
      ok: true,
      pose,
      laneRef: { rsl: nearest.rsl, s: nearest.s, tFrac: 0 },
      route: req.route ?? { kind: 'follow', startRsl: nearest.rsl, turns: [], maxLengthM: 2000 },
    };
  }
}

/* ----------------------------------------------------------------- replay */

export interface ReplayResult {
  readonly digest: string;
  /** True when every log entry reproduced its recorded outcome. */
  readonly outcomesMatch: boolean;
  /** First divergent entry index, when any. */
  readonly divergedAt: number | null;
}

/**
 * Replay a session log against the same base input + graph. Determinism
 * contract: the returned digest equals `log.digest` and every command
 * reproduces its recorded outcome (including rejections).
 */
export function replayWorldSessionLog(
  log: WorldSessionLog,
  options: { input: SimScenarioInput; graph: LaneGraph },
): ReplayResult {
  if (log.version !== WORLD_SESSION_LOG_VERSION) {
    throw new Error(`unsupported world-session log version ${String(log.version)}`);
  }
  const world = new WorldSession({ input: options.input, graph: options.graph, horizonSeconds: log.horizonSeconds });
  if (world.baseInputHash !== log.baseInputHash) {
    throw new Error(`base input mismatch: log built from ${log.baseInputHash}, replay input is ${world.baseInputHash}`);
  }
  let divergedAt: number | null = null;
  for (let i = 0; i < log.entries.length; i++) {
    const entry = log.entries[i]!;
    if (entry.kind === 'advance') {
      world.advance(entry.ticks);
      continue;
    }
    const outcome = world.applyCommand(entry.clientId, entry.seq, entry.command);
    const sameIds = canonicalJson(outcome.actorIds ?? []) === canonicalJson(entry.actorIds ?? []);
    if (divergedAt === null && (outcome.ok !== entry.ok || !sameIds)) divergedAt = i;
  }
  return { digest: world.digest(), outcomesMatch: divergedAt === null, divergedAt };
}
