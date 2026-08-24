/**
 * TruthStream — the live ground-truth side channel on the env-server.
 *
 * One framed-msgpack document per engine tick, atomic per tick:
 * `{op:'tick', s, seq, tick, t, mapId, xodrSha256, dropped, frame, signals}`
 * where `frame` is a scene-state.v1 actor record set (with per-actor world-
 * frame acceleration) and `signals` is the full `signalSnapshotAt(t)` array
 * for the session's signal programs.
 *
 * Backpressure contract: each subscriber owns a bounded queue. The engine
 * never blocks on a slow consumer — when the queue is full the OLDEST tick is
 * dropped and the subscriber's cumulative `dropped` gap counter advances, so
 * consumers detect exactly which ticks they missed. Frames are flushed to the
 * wire between request/reply exchanges, never mid-tick.
 *
 * Determinism: documents are built purely from engine state — no wall clock,
 * no randomness — so two identical runs produce byte-identical streams.
 */

import type {
  EngineTickObservation,
  SessionActorSnapshot,
  SignalBook,
  SignalSnapshot,
} from '@simforge/engine';

import { yawToQuaternion } from '@simforge/engine/scene-state';

/** Static per-session metadata stamped onto every tick: the map identity pair
 * the V5 digest rule requires ({mapId, xodrSha256}) plus the engine step the
 * tick-denominated signal fields assume. */
export interface SceneStateMeta {
  readonly mapId: string | null;
  readonly xodrSha256: string | null;
  readonly dtS: number;
}


/** Bounded queue depth per subscriber before drop-oldest kicks in. */
export const TRUTH_STREAM_QUEUE_CAPACITY = 1024;

/** One actor record on the live wire (scene-state.v1 shape + acceleration). */
export interface LiveActorRecord {
  readonly id: string;
  readonly kind: 'spawn' | 'update' | 'despawn';
  readonly position: [number, number, number];
  readonly rotation: [number, number, number, number];
  readonly yawRad: number;
  readonly velocity: [number, number, number];
  readonly acceleration: [number, number, number];
}

/** Atomic per-tick subscription document. */
export interface TruthTickDocument {
  readonly op: 'tick';
  /** Env session index. */
  readonly s: number;
  /** Monotonic per-subscriber sequence of DELIVERED ticks. */
  readonly seq: number;
  /** Engine tick index (absolute, warm-up included). */
  readonly tick: number;
  /** Simulation time, seconds. */
  readonly t: number;
  /** Map identity + authoritative XODR digest (consumers refuse mismatches). */
  readonly mapId: string | null;
  readonly xodrSha256: string | null;
  /** Cumulative ticks dropped by this subscriber's queue before this one. */
  readonly dropped: number;
  /** scene-state.v1 actor records for this tick. */
  readonly frame: { readonly actors: LiveActorRecord[] };
  /** Full signal snapshot array at `t`. */
  readonly signals: SignalSnapshot[];
}

const q = (v: number): number => Number(v.toFixed(6));

/**
 * Builds one atomic {@link TruthTickDocument} payload (pre-sequence-number)
 * from an engine observation. Spawn/despawn semantics follow scene-state.v1:
 * presence transitions only, despawn carries the terminal pose.
 */
export class TruthStreamBuilder {
  private readonly prevPresent = new Map<string, boolean>();

  constructor(private readonly meta: SceneStateMeta) {}

  observe(obs: EngineTickObservation, book: SignalBook): Omit<TruthTickDocument, 'op' | 's' | 'seq' | 'dropped'> {
    const actors = buildActorRecords(obs.actors, this.prevPresent);
    const signals = book.snapshotsAt(obs.tS, this.meta.dtS);
    return {
      tick: obs.tickIndex,
      t: q(obs.tS),
      mapId: this.meta.mapId,
      xodrSha256: this.meta.xodrSha256,
      frame: { actors },
      signals,
    };
  }
}

function velocityOf(a: SessionActorSnapshot): [number, number, number] {
  // Scene frame: z = −y_local; heading numerically identical (frames.ts).
  return [q(a.speedMps * Math.cos(a.headingRad)), 0, q(-a.speedMps * Math.sin(a.headingRad))];
}

function accelerationOf(a: SessionActorSnapshot): [number, number, number] {
  // Native engine truth: planned longitudinal acceleration on the heading.
  return [q(a.accelMps2 * Math.cos(a.headingRad)), 0, q(-a.accelMps2 * Math.sin(a.headingRad))];
}

function buildActorRecords(
  actors: readonly SessionActorSnapshot[],
  prevPresent: Map<string, boolean>,
): LiveActorRecord[] {
  // Engine order is already sorted by id; keep it that way for byte stability.
  const records: LiveActorRecord[] = [];
  for (const a of actors) {
    const was = prevPresent.get(a.id) === true;
    prevPresent.set(a.id, a.present);
    let kind: LiveActorRecord['kind'];
    if (a.present && !was) kind = 'spawn';
    else if (!a.present && was) kind = 'despawn';
    else if (!a.present) continue; // absent before and after: nothing on the wire
    else kind = 'update';
    records.push({
      id: a.id,
      kind,
      position: [q(a.x), 0, q(-a.y)],
      rotation: yawToQuaternion(a.headingRad).map(q) as [number, number, number, number],
      yawRad: q(a.headingRad),
      velocity: velocityOf(a),
      acceleration: accelerationOf(a),
    });
  }
  return records;
}

/** One connection's subscription to one session: bounded queue + gap counter. */
export class SubscriberQueue {
  private readonly pending: Omit<TruthTickDocument, 'op' | 's' | 'seq' | 'dropped'>[] = [];
  private nextSeq = 0;
  private droppedTotal = 0;

  constructor(readonly capacity: number = TRUTH_STREAM_QUEUE_CAPACITY) {}

  push(payload: Omit<TruthTickDocument, 'op' | 's' | 'seq' | 'dropped'>): void {
    if (this.pending.length >= this.capacity) {
      this.pending.shift();
      this.droppedTotal += 1;
    }
    this.pending.push(payload);
  }

  /** Drain into complete wire documents stamped with the session index;
   * empty when the consumer is caught up. */
  drain(s: number): TruthTickDocument[] {
    const out: TruthTickDocument[] = [];
    for (const payload of this.pending.splice(0)) {
      out.push({
        ...payload,
        op: 'tick',
        s,
        seq: this.nextSeq++,
        dropped: this.droppedTotal,
      });
    }
    return out;
  }

  get depth(): number {
    return this.pending.length;
  }
}
