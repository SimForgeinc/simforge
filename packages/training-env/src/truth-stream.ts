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

import { decode, encode } from '@msgpack/msgpack';

import type {
  ActorKind,
  Dims,
  EngineTickObservation,
  SessionActorSnapshot,
  SignalBook,
  SignalSnapshot,
} from '@simforge/engine';

import { yawToQuaternion, type ActorClass, type SceneFrame } from '@simforge/engine/scene-state';

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

/* ------------------------------------------------ world-session truth v1 */

/** Static actor identity carried beside the frozen scene-state.v1 frame. */
export interface TruthActor {
  readonly id: string;
  readonly class: ActorClass;
  readonly dims: { readonly l: number; readonly w: number; readonly h: number };
  /** XODR-local world-plane acceleration in m/s². */
  readonly accel: { readonly ax: number; readonly ay: number };
}

/**
 * Frozen world-session truth contract. One complete value is encoded into one
 * msgpack payload and one length-prefixed transport frame.
 */
export interface TruthFrame {
  readonly tick: number;
  readonly timeSec: number;
  readonly scene: SceneFrame;
  readonly signals: readonly SignalSnapshot[];
  readonly actors: readonly TruthActor[];
}

export interface TruthActorCatalogEntry {
  readonly kind: ActorKind;
  readonly dims: Dims;
}

export interface TruthSubscriptionStats {
  readonly queued: number;
  /** Cumulative frames discarded from this subscription by drop-oldest. */
  readonly dropped: number;
}

/** Default bounded frame count for one world-session subscriber. */
export const WORLD_TRUTH_QUEUE_CAPACITY = 256;

const ACTOR_CLASS_BY_KIND: Readonly<Record<ActorKind, ActorClass>> = {
  vehicle: 'car',
  car: 'car',
  truck: 'truck',
  bus: 'bus',
  van: 'car',
  motorcycle: 'motorcycle',
  bicycle: 'bicycle',
  pedestrian: 'pedestrian',
  scooter: 'motorcycle',
  sidewalk_robot: 'prop',
  drone: 'prop',
  animal: 'prop',
  static_object: 'prop',
};

/** Encode one TruthFrame as `u32le byteLength || msgpack(TruthFrame)`. */
export function encodeTruthFrame(frame: TruthFrame): Uint8Array {
  const payload = encode(frame);
  const framed = Buffer.allocUnsafe(4 + payload.byteLength);
  framed.writeUInt32LE(payload.byteLength, 0);
  framed.set(payload, 4);
  return framed;
}

/**
 * Incremental client-side decoder for the public truth-stream framing. It
 * accepts arbitrary transport chunks and returns every complete TruthFrame.
 */
export class TruthStreamClient {
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Uint8Array): TruthFrame[] {
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.buffered = this.buffered.length === 0 ? incoming : Buffer.concat([this.buffered, incoming]);
    const frames: TruthFrame[] = [];
    for (;;) {
      if (this.buffered.length < 4) return frames;
      const length = this.buffered.readUInt32LE(0);
      if (length > 64 * 1024 * 1024) throw new Error(`truth frame of ${length} bytes exceeds 64 MiB`);
      if (this.buffered.length < length + 4) return frames;
      frames.push(decode(this.buffered.subarray(4, length + 4)) as TruthFrame);
      this.buffered = this.buffered.subarray(length + 4);
    }
  }
}

/**
 * One pull-based subscriber. Publishing only enqueues already-encoded bytes;
 * it never invokes consumer code on the engine tick path.
 */
export class TruthSubscription {
  private readonly pending: Uint8Array[] = [];
  private droppedTotal = 0;
  private active = true;

  constructor(
    readonly capacity: number,
    private readonly closeSubscription: () => void,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`truth subscription capacity must be a positive integer, got ${String(capacity)}`);
    }
  }

  /** Internal publisher seam; the byte array is immutable and shared. */
  enqueue(frame: Uint8Array): void {
    if (!this.active) return;
    if (this.pending.length >= this.capacity) {
      this.pending.shift();
      this.droppedTotal += 1;
    }
    this.pending.push(frame);
  }

  /** Pull the oldest complete length-prefixed msgpack frame, or null. */
  read(): Uint8Array | null {
    return this.pending.shift() ?? null;
  }

  /** Pull every currently queued frame in tick order. */
  drain(): Uint8Array[] {
    return this.pending.splice(0);
  }

  stats(): TruthSubscriptionStats {
    return { queued: this.pending.length, dropped: this.droppedTotal };
  }

  unsubscribe(): void {
    if (!this.active) return;
    this.active = false;
    this.pending.length = 0;
    this.closeSubscription();
  }
}

/**
 * Per-world fan-out. A tick is composed and encoded once, then the same
 * immutable framed bytes are enqueued for every subscriber.
 */
export class WorldTruthPublisher {
  private readonly subscribers = new Set<TruthSubscription>();
  private readonly prevPresent = new Map<string, boolean>();
  private readonly prevVelocity = new Map<string, { x: number; y: number }>();

  subscribe(capacity: number = WORLD_TRUTH_QUEUE_CAPACITY): TruthSubscription {
    if (this.subscribers.size === 0) {
      this.prevPresent.clear();
      this.prevVelocity.clear();
    }
    let subscription!: TruthSubscription;
    subscription = new TruthSubscription(capacity, () => this.subscribers.delete(subscription));
    this.subscribers.add(subscription);
    return subscription;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  publish(
    obs: EngineTickObservation,
    book: SignalBook,
    catalog: ReadonlyMap<string, TruthActorCatalogEntry>,
    dtS: number,
  ): void {
    if (this.subscribers.size === 0) return;

    const sceneActors: LiveActorRecord[] = [];
    const actors: TruthActor[] = [];
    for (const actor of obs.actors) {
      const wasPresent = this.prevPresent.get(actor.id) === true;
      this.prevPresent.set(actor.id, actor.present);
      let kind: LiveActorRecord['kind'];
      if (actor.present && !wasPresent) kind = 'spawn';
      else if (!actor.present && wasPresent) kind = 'despawn';
      else if (!actor.present) continue;
      else kind = 'update';

      const vx = actor.speedMps * Math.cos(actor.headingRad);
      const vy = actor.speedMps * Math.sin(actor.headingRad);
      const previousVelocity = this.prevVelocity.get(actor.id);
      const ax = kind === 'spawn' || !previousVelocity ? 0 : (vx - previousVelocity.x) / dtS;
      const ay = kind === 'spawn' || !previousVelocity ? 0 : (vy - previousVelocity.y) / dtS;
      if (kind === 'despawn') this.prevVelocity.delete(actor.id);
      else this.prevVelocity.set(actor.id, { x: vx, y: vy });

      const meta = catalog.get(actor.id);
      if (!meta) throw new Error(`truth stream has no actor catalog entry for ${actor.id}`);
      const acceleration: [number, number, number] = [q(ax), 0, q(-ay)];
      sceneActors.push({
        id: actor.id,
        kind,
        position: [q(actor.x), 0, q(-actor.y)],
        rotation: yawToQuaternion(actor.headingRad).map(q) as [number, number, number, number],
        yawRad: q(actor.headingRad),
        velocity: [q(vx), 0, q(-vy)],
        acceleration,
      });
      actors.push({
        id: actor.id,
        class: ACTOR_CLASS_BY_KIND[meta.kind],
        dims: { l: meta.dims.l, w: meta.dims.w, h: meta.dims.h },
        accel: { ax: q(ax), ay: q(ay) },
      });
    }

    const tick = obs.tickIndex;
    const timeSec = q(obs.tS);
    const truth: TruthFrame = {
      tick,
      timeSec,
      scene: { tick, t: timeSec, actors: sceneActors },
      signals: book.snapshotsAt(obs.tS, dtS),
      actors,
    };
    const framed = encodeTruthFrame(truth);
    for (const subscriber of this.subscribers) subscriber.enqueue(framed);
  }
}
