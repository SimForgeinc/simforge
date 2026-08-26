/**
 * EnvSession — the Gymnasium-semantics environment over the fixed-step engine.
 *
 * - `reset(seed)` rebuilds the simulation from (optionally pre-settled)
 *   inputs and consumes the warm-up prologue so no policy-visible tick is
 *   ever negative.
 * - `step(action)` holds the action for `50/decisionHz` engine ticks through
 *   the engine's action hook (zero-order hold), then returns observation,
 *   reward, `terminated` (collision or goal), `truncated` (horizon or clip
 *   end), and an `info` bag with the drained engine events, running metric
 *   minima, and this decision's causal ground-truth frame.
 *
 * Determinism: the session never reads wall time; seeds flow into the
 * engine's own Rng; actor iteration is sorted everywhere.
 */

import {
  createFixedStepSimulation,
  type SignalBook,
  normalizeSimScenarioInput,
  type ActionHook,
  type ActionOverride,
  type FixedStepSimulationSession,
  type LaneGraph,
  type RunOptions,
  type SessionActorSnapshot,
  type SessionPairMinima,
  type SimEvent,
  type SimScenarioInput,
  type TickObserver,
} from '@simforge-oss/engine';

import { CausalChannelCollector, type CausalChannel, type CausalFrame } from './causal.js';
import {
  BevRasterBuilder,
  ObjectListBuilder,
  StateVectorBuilder,
  type ObservationContextInput,
  type ObservationFrame,
} from './observations.js';
import { assembleReward, type RewardTerms } from './reward.js';
import {
  DEFAULT_BEV_CONFIG,
  DEFAULT_OBSERVATION_CONFIG,
  DEFAULT_REWARD_CONFIG,
  type EnvAction,
  type EpisodeConfig,
  type Observation,
  type RewardConfig,
} from './types.js';

/**
 * Pre-settled episode bank seam: given a reset seed, return an equivalent,
 * already-settled input to run instead of the live one, or `null` to fall
 * back. Phase 1 always returns `null` in practice; the interface exists now
 * so bank-backed resets (<100 ms) need no API change later.
 */
export type SettledInputProvider = (seed: number | string) => SimScenarioInput | null;

export interface EnvSessionOptions {
  /** Materialized scenario input (template × map × site × seed). */
  readonly input: SimScenarioInput;
  readonly graph: LaneGraph;
  /** Extra engine options; `graph` and `actionHook` are owned by the session. */
  readonly runOptions?: Partial<Omit<RunOptions, 'graph' | 'actionHook'>>;
  readonly episode?: Partial<EpisodeConfig>;
  readonly settledInputProvider?: SettledInputProvider;
  /**
   * Live ground-truth seam (TruthStream): invoked once per engine tick with a
   * frozen read-only observation. Purely observational — attaching one never
   * changes tick order, traces, or digests.
   */
  readonly tickObserver?: TickObserver;
}

/** Fully resolved episode configuration. */
export interface ResolvedEpisode {
  readonly decisionHz: number;
  readonly clipSeconds: number;
  readonly decisionTicks: number;
  readonly dtDecisionS: number;
  readonly maxDecisions: number | null;
  readonly goal: { interactionId?: string; routeEnd?: boolean } | undefined;
  readonly warmupExcluded: boolean;
}

export interface StepInfo {
  readonly tS: number;
  readonly events: readonly SimEvent[];
  readonly minima: readonly SessionPairMinima[];
  /** This decision's causal frame; all frames accumulate into {@link StepInfo.causalChannel}. */
  readonly causal: CausalFrame;
  readonly causalChannel: () => CausalChannel;
  readonly rewardTerms: RewardTerms;
}

export interface StepResult {
  readonly observation: Observation;
  readonly reward: number;
  readonly terminated: boolean;
  readonly truncated: boolean;
  readonly info: StepInfo;
}

const ENGINE_HZ = 50;
const EPS_S = 1e-9;

function resolveEgoId(input: SimScenarioInput): string {
  if (input.metricSubject) return input.metricSubject;
  const vehicles = input.actors
    .filter((a) => a.kind === 'vehicle')
    .map((a) => a.id)
    .sort();
  if (vehicles.length === 0) throw new Error('scenario has no vehicle actor to act as the ego');
  return vehicles[0]!;
}

function snapshotEgo(actors: readonly SessionActorSnapshot[], egoId: string): SessionActorSnapshot {
  const ego = actors.find((a) => a.id === egoId);
  if (!ego) throw new Error(`ego actor ${egoId} missing from snapshot`);
  return ego;
}

export class EnvSession {
  private readonly baseInput: SimScenarioInput;
  private readonly graph: LaneGraph;
  private readonly runOptions: Partial<Omit<RunOptions, 'graph' | 'actionHook'>>;
  private readonly settledInputProvider: SettledInputProvider | null;
  private readonly tickObserver: TickObserver | null;
  private readonly episode: ResolvedEpisode;
  private readonly rewardConfig: RewardConfig;
  private obsCtx: ObservationContextInput;

  private readonly stateVector = new StateVectorBuilder();
  private readonly objectList: ObjectListBuilder;
  private readonly bev: BevRasterBuilder | null;

  private engineSession: FixedStepSimulationSession | null = null;
  private causalCollector: CausalChannelCollector | null = null;
  private pendingAction: EnvAction | null = null;
  private egoId = '';
  private decisionCount = 0;
  private prevEgoS: number | null = null;
  private ended = false;

  constructor(options: EnvSessionOptions) {
    this.graph = options.graph;
    this.runOptions = options.runOptions ?? {};
    this.settledInputProvider = options.settledInputProvider ?? null;
    this.tickObserver = options.tickObserver ?? null;

    const cfg = options.episode ?? {};
    const decisionHz = cfg.decisionHz ?? 10;
    if (!Number.isInteger(decisionHz) || decisionHz <= 0 || ENGINE_HZ % decisionHz !== 0) {
      throw new Error(`decisionHz must be a positive integer dividing ${ENGINE_HZ}, got ${String(decisionHz)}`);
    }
    const clipSeconds = cfg.clipSeconds ?? options.input.clipSeconds;
    this.baseInput =
      clipSeconds === options.input.clipSeconds
        ? options.input
        : normalizeSimScenarioInput({ ...options.input, clipSeconds });
    this.episode = {
      decisionHz,
      clipSeconds,
      decisionTicks: ENGINE_HZ / decisionHz,
      dtDecisionS: 1 / decisionHz,
      maxDecisions: cfg.maxDecisions ?? null,
      goal: cfg.goal,
      warmupExcluded: cfg.warmupExcluded ?? true,
    };
    this.rewardConfig = { ...DEFAULT_REWARD_CONFIG, ...(cfg.reward ?? {}) };

    const observationCfg = { ...DEFAULT_OBSERVATION_CONFIG, ...(cfg.observation ?? {}) };
    this.egoId = resolveEgoId(this.baseInput);
    this.obsCtx = { input: this.baseInput, graph: options.graph, egoId: this.egoId, config: observationCfg };
    this.objectList = new ObjectListBuilder(this.obsCtx);
    this.bev = observationCfg.bev
      ? new BevRasterBuilder({ ...DEFAULT_BEV_CONFIG, ...observationCfg.bev })
      : null;
  }

  /** The metric-subject actor all actions apply to. */
  get ego(): string {
    return this.egoId;
  }

  /**
   * Rebuild the episode. The optional seed replaces the input's authored
   * seed; everything else about the scenario is preserved byte-for-byte.
   */
  reset(seed?: number | string): StepResult {
    const seedValue = seed ?? this.baseInput.seed;
    const input =
      this.settledInputProvider?.(seedValue) ?? normalizeSimScenarioInput({ ...this.baseInput, seed: seedValue });
    this.egoId = resolveEgoId(input);
    this.obsCtx = { ...this.obsCtx, input, egoId: this.egoId };
    this.engineSession = createFixedStepSimulation(input, {
      ...this.runOptions,
      graph: this.graph,
      actionHook: this.hook,
    });
    this.causalCollector = new CausalChannelCollector(
      this.egoId,
      this.episode.decisionHz,
      new Map(input.interactions.map((it) => [it.id, it])),
    );
    this.objectList.reset();
    this.pendingAction = null;
    this.decisionCount = 0;
    this.prevEgoS = null;
    this.ended = false;

    // The engine records state *at* t before stepping, so consuming exactly
    // warmupTicks leaves the snapshot at t=-dt; one more tick parks the
    // world exactly at t=0, the first policy-visible instant.
    const warmupTicks = this.episode.warmupExcluded ? Math.round(input.warmupSeconds / input.dt) + 1 : 0;
    if (warmupTicks > 0) this.engineSession.advance(warmupTicks, this.advanceOpts());

    const snap = this.engineSession.peek();
    return {
      observation: this.observe(snap.tS, snap.actors, 0),
      reward: 0,
      terminated: false,
      truncated: false,
      info: {
        tS: snap.tS,
        events: [] as SimEvent[],
        minima: snap.minima,
        causal: { tS: snap.tS, losTransitions: [], triggers: [], conflictGenesis: [] },
        causalChannel: () => this.requireCollector().channel(),
        rewardTerms: { progress: 0, proximity: 0, comfort: 0 },
      },
    };
  }

  /**
   * Apply one policy decision. Throws after termination/truncation —
   * Gymnasium semantics leave post-episode stepping undefined, so we refuse.
   */
  step(action: EnvAction = {}): StepResult {
    if (this.ended || !this.engineSession || !this.causalCollector) {
      throw new Error('step() called on a finished or un-reset EnvSession');
    }
    this.pendingAction = action;
    this.engineSession.advance(this.episode.decisionTicks, this.advanceOpts());
    const events = this.engineSession.drainEvents();
    const snap = this.engineSession.peek();
    this.decisionCount += 1;

    const observation = this.observe(snap.tS, snap.actors, this.episode.dtDecisionS);

    const reward = assembleReward({
      config: this.rewardConfig,
      egoId: this.egoId,
      actors: snap.actors,
      minima: snap.minima,
      events,
      dtS: this.episode.dtDecisionS,
      prevEgoS: this.prevEgoS,
      goal: this.episode.goal,
    });
    // Stored only after assembly: progress is measured against the previous decision.
    this.prevEgoS = snapshotEgo(snap.actors, this.egoId).s;

    this.causalCollector.observe(snap.tS, this.objectList.lastLos(), events, snap.minima);
    const frames = this.causalCollector.channel().frames;
    const causal = frames[frames.length - 1]!;

    const terminated = reward.collision || reward.goal;
    const clipOver = snap.tS >= this.episode.clipSeconds - EPS_S;
    const horizonOver = this.episode.maxDecisions !== null && this.decisionCount >= this.episode.maxDecisions;
    const truncated = !terminated && (clipOver || horizonOver || snap.done);
    this.ended = terminated || truncated;

    return {
      observation,
      reward: reward.total,
      terminated,
      truncated,
      info: {
        tS: snap.tS,
        events,
        minima: snap.minima,
        causal,
        causalChannel: () => this.requireCollector().channel(),
        rewardTerms: reward.terms,
      },
    };
  }


  /** Advance options carrying the live truth observer when one is attached. */
  private advanceOpts(): { onTick?: TickObserver } {
    return this.tickObserver ? { onTick: this.tickObserver } : {};
  }

  /**
   * Planar ego pose + travel speed at the current engine snapshot — the
   * observation instant the next `step()` action responds to. Null before
   * `reset()`.
   */
  egoPose(): { tS: number; x: number; y: number; yawRad: number; speedMps: number } | null {
    if (!this.engineSession) return null;
    const snap = this.engineSession.peek();
    const ego = snapshotEgo(snap.actors, this.egoId);
    return { tS: snap.tS, x: ego.x, y: ego.y, yawRad: ego.headingRad, speedMps: ego.speedMps };
  }

  /** The live engine's SignalBook (overrides included); null before reset(). */
  signalBook(): SignalBook | null {
    return this.engineSession?.signalBook() ?? null;
  }

  private requireCollector(): CausalChannelCollector {
    if (!this.causalCollector) throw new Error('no causal collector; call reset() first');
    return this.causalCollector;
  }

  /** Zero-order hold: the pending action rides every planning tick until the next decision. */
  private readonly hook: ActionHook = ({ actorId, tS }): ActionOverride | undefined => {
    if (actorId !== this.egoId || tS < 0 || this.pendingAction === null) return undefined;
    return this.pendingAction;
  };

  private observe(tS: number, actors: readonly SessionActorSnapshot[], dtS: number): Observation {
    const frame: ObservationFrame = { tS, actors, dtS };
    return {
      tS,
      stateVector: this.obsCtx.config.stateVector ? this.stateVector.build(frame, this.obsCtx) : null,
      objects: this.objectList.build(frame, this.obsCtx),
      bev: this.bev ? this.bev.build(frame, this.obsCtx) : null,
    };
  }
}
