/**
 * The causal ground-truth channel — the faithfulness-supervision contract.
 *
 * Per decision tick, the session records *why* the world changed in ways a
 * camera cannot show:
 *
 * - **LOS / occlusion transitions** per observer per target: every edge where
 *   geometric line of sight flipped, computed with the engine's occluder
 *   layer (same primitives the perception pass uses);
 * - **trigger causality**: trigger fires and skips with the exact predicate
 *   that caused them (canonical-JSON summary of the authored condition), plus
 *   preemption/release/completion events verbatim from the engine;
 * - **conflict genesis**: the first decision at which a monitored pair's
 *   running minimum TTC or distance crosses its criticality threshold.
 *
 * The channel is versioned (`causalVersion: 1`) and serialized as an optional
 * trace-side channel following the `ambientActorIds` precedent: absent on any
 * trace that did not carry it, so historical digests are untouched. Round
 * trips are byte-exact through `canonicalJson`.
 */

import { canonicalJson, type SessionPairMinima, type SimEvent, type SimScenarioInput } from '@simforge/engine';

export const CAUSAL_CHANNEL_VERSION = 1;

/** Default genesis thresholds; banded criticality comes with Phase 3 curriculum. */
export const CONFLICT_GENESIS_TTC_S = 3;
export const CONFLICT_GENESIS_DISTANCE_M = 5;

export interface CausalLosTransition {
  readonly observerId: string;
  readonly targetId: string;
  readonly becameVisible: boolean;
}

export interface CausalTriggerRecord {
  readonly tS: number;
  readonly kind: 'fired' | 'skipped' | 'preemption' | 'released' | 'completed';
  readonly interactionId: string;
  readonly actorId: string;
  /** Exact canonical-JSON summary of the authored predicate, for fired/skipped. */
  readonly condition?: string;
  readonly forced?: boolean;
  readonly reason?: string;
}

export interface CausalConflictGenesis {
  readonly a: string;
  readonly b: string;
  readonly metric: 'ttc' | 'distance';
  /** Threshold whose first crossing this record is. */
  readonly threshold: number;
  /** Running minimum value at the crossing decision. */
  readonly value: number;
}

export interface CausalFrame {
  readonly tS: number;
  readonly losTransitions: readonly CausalLosTransition[];
  readonly triggers: readonly CausalTriggerRecord[];
  readonly conflictGenesis: readonly CausalConflictGenesis[];
}

export interface CausalChannel {
  readonly causalVersion: typeof CAUSAL_CHANNEL_VERSION;
  readonly egoId: string;
  readonly decisionHz: number;
  readonly frames: readonly CausalFrame[];
}

interface PairGenesisState {
  ttc: boolean;
  distance: boolean;
}

/**
 * Incremental collector. One instance per episode; feed it one decision's
 * events, minima and LOS matrix, in order.
 */
export class CausalChannelCollector {
  private readonly frames: CausalFrame[] = [];
  private readonly losState = new Map<string, boolean>();
  private readonly genesis = new Map<string, PairGenesisState>();

  constructor(
    private readonly egoId: string,
    private readonly decisionHz: number,
    private readonly interactionsById: ReadonlyMap<string, SimScenarioInput['interactions'][number]>,
  ) {}

  /**
   * Record one decision. `losPairs` are the pairs whose LOS was evaluated
   * this decision (sorted by caller); `events` are the engine events drained
   * for the interval ending at `tS`; `minima` is the running pair-minimum set.
   */
  observe(
    tS: number,
    losPairs: readonly { observerId: string; targetId: string; visible: boolean }[],
    events: readonly SimEvent[],
    minima: readonly SessionPairMinima[],
  ): void {
    const losTransitions: CausalLosTransition[] = [];
    for (const pair of losPairs) {
      const key = `${pair.observerId}>${pair.targetId}`;
      const prev = this.losState.get(key);
      if (prev === undefined || prev !== pair.visible) {
        this.losState.set(key, pair.visible);
        losTransitions.push({ observerId: pair.observerId, targetId: pair.targetId, becameVisible: pair.visible });
      }
    }

    const triggers: CausalTriggerRecord[] = [];
    for (const event of events) {
      if (event.kind === 'trigger_fired') {
        triggers.push({
          tS: event.t,
          kind: 'fired',
          interactionId: event.interactionId,
          actorId: event.actorId,
          forced: event.forced,
          condition: summarizeCondition(this.interactionsById.get(event.interactionId)),
        });
      } else if (event.kind === 'trigger_skipped') {
        triggers.push({
          tS: event.t,
          kind: 'skipped',
          interactionId: event.interactionId,
          actorId: event.actorId,
          reason: event.reason,
          condition: summarizeCondition(this.interactionsById.get(event.interactionId)),
        });
      } else if (event.kind === 'preemption') {
        triggers.push({
          tS: event.t,
          kind: 'preemption',
          interactionId: event.byInteractionId,
          actorId: event.actorId,
          reason: `preempts:${event.preemptedInteractionId}`,
        });
      } else if (event.kind === 'released') {
        triggers.push({
          tS: event.t,
          kind: 'released',
          interactionId: event.interactionId,
          actorId: event.actorId,
          reason: event.reason,
        });
      } else if (event.kind === 'interaction_completed') {
        triggers.push({
          tS: event.t,
          kind: 'completed',
          interactionId: event.interactionId,
          actorId: event.actorId,
        });
      }
    }

    const conflictGenesis: CausalConflictGenesis[] = [];
    for (const pair of minima) {
      const key = `${pair.a}|${pair.b}`;
      let state = this.genesis.get(key);
      if (!state) {
        state = { ttc: false, distance: false };
        this.genesis.set(key, state);
      }
      const pushTtc = !state.ttc && Number.isFinite(pair.minTtcS) && pair.minTtcS <= CONFLICT_GENESIS_TTC_S;
      if (pushTtc) {
        state.ttc = true;
        conflictGenesis.push({ a: pair.a, b: pair.b, metric: 'ttc', threshold: CONFLICT_GENESIS_TTC_S, value: pair.minTtcS });
      }
      const pushDist =
        !state.distance && Number.isFinite(pair.minDistanceM) && pair.minDistanceM <= CONFLICT_GENESIS_DISTANCE_M;
      if (pushDist) {
        state.distance = true;
        conflictGenesis.push({
          a: pair.a,
          b: pair.b,
          metric: 'distance',
          threshold: CONFLICT_GENESIS_DISTANCE_M,
          value: pair.minDistanceM,
        });
      }
    }

    // Deterministic frame ordering regardless of map iteration order upstream.
    losTransitions.sort(
      (x, y) => x.observerId.localeCompare(y.observerId) || x.targetId.localeCompare(y.targetId),
    );
    triggers.sort(
      (x, y) =>
        x.tS - y.tS ||
        x.kind.localeCompare(y.kind) ||
        x.interactionId.localeCompare(y.interactionId) ||
        x.actorId.localeCompare(y.actorId),
    );
    conflictGenesis.sort(
      (x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.metric.localeCompare(y.metric),
    );
    this.frames.push({ tS, losTransitions, triggers, conflictGenesis });
  }

  channel(): CausalChannel {
    return { causalVersion: CAUSAL_CHANNEL_VERSION, egoId: this.egoId, decisionHz: this.decisionHz, frames: [...this.frames] };
  }
}

/** Canonical JSON of the interaction's trigger — exact, deterministic causality provenance. */
function summarizeCondition(interaction: SimScenarioInput['interactions'][number] | undefined): string {
  if (!interaction) return 'external';
  return canonicalJson(interaction.trigger);
}

/* --------------------------------------------------------- serialization */

export interface CausalTraceEnvelope {
  /** Versioned optional channel, present only when an episode recorded it — the ambientActorIds precedent. */
  readonly causal: CausalChannel;
}

/** Canonical bytes for persistence alongside (never inside) a historical trace. */
export function serializeCausalChannel(channel: CausalChannel): Uint8Array {
  return new TextEncoder().encode(canonicalJson(channel));
}

/** Byte-exact round trip of {@link serializeCausalChannel}. */
export function parseCausalChannel(bytes: Uint8Array): CausalChannel {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CausalChannel;
  if (parsed.causalVersion !== CAUSAL_CHANNEL_VERSION) {
    throw new Error(`unsupported causal channel version: ${String(parsed.causalVersion)}`);
  }
  return parsed;
}
