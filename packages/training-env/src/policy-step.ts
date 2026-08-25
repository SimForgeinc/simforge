/**
 * policy_step protocol (F3) — session ops layered on the env-server wire.
 *
 * Transport: the existing length-prefixed msgpack framing (4-byte LE u32
 * length + one msgpack document) and the existing request/response envelope
 *
 *   request   {i: u64 id, op: string, ...}
 *   response  {i, ok: 1, r: payload} | {i, ok: 0, e: message}
 *
 * Namespacing: policy ops are `policy.*`; world/session ops owned by the
 * world server are `world.*`; the legacy core ops stay unprefixed. All three
 * families share one connection and one envelope.
 *
 * Ops:
 *
 *   policy.hello {v}                          → PolicyHello
 *   policy.reset {s?, seed?, deadlineMs?, fallback?}
 *                                             → {seed, st: bin, ob: step frame}
 *   policy.act   {s?, steps: [{a, elapsedMs?}…], st?: bin, deadlineMs?}
 *                                             → {st: bin, rs: [step frame + dl…]}
 *   policy.close {s?}                         → {closed: true}
 *
 * Step frames are the env-server's existing compact frames (t, rw, term,
 * trunc, sv, objs, bev, cw, terms) extended with:
 *
 *   dl: {limitMs|null, elapsedMs|null, miss: 0|1, applied: 'policy'|fallback}
 *   fb: null | {shm, tick, cams: [[id, digest, off, len, w, h, fmt]…]}   // ShmBridge
 *
 * Determinism invariant (inherited from the env-server): the server never
 * emits wall-clock data. Deadline enforcement is therefore *declarative*:
 * the client (or a real-time gateway in front of the server) measures its
 * own inference latency and reports it as `elapsedMs`. The server's response
 * is a pure function of request bytes — same requests, byte-identical
 * responses — while the reported latency still deterministically selects
 * the fallback action whenever `elapsedMs > deadlineMs`.
 *
 * Fallback semantics on a deadline miss (the supplied action is discarded):
 *
 *   'repeat-last'  — re-apply the last *applied* action of this episode
 *                    (policy or fallback); before any applied action it
 *                    degrades to 'scripted'.
 *   'zero-control' — control passthrough of all zeros
 *                    {throttle: 0, brake: 0, steer: 0} (coast, wheel centred).
 *   'scripted'     — no override this decision; the authored choreography
 *                    (cruise/route logic) drives the ego.
 *
 * Recurrent state token: opaque bytes owned entirely by the policy. The
 * server stores the most recent token per session and echoes it in every
 * `policy.act`/`policy.reset` response (`st`), so stateless rollout workers
 * can hand an episode across processes without a side channel. `policy.reset`
 * clears it to zero bytes.
 */

import { z } from 'zod';

import type { EnvAction } from './types.js';
import type { WireRequest, WireResponse } from './env-server.js';

/** policy_step protocol version; bumped on any breaking change to the ops above. */
export const POLICY_STEP_PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------ envelope */

/** Shared request envelope — identical for `policy.*`, `world.*` and core ops. */
export type Envelope = WireRequest;
/** Shared response envelope. */
export type ResponseEnvelope = WireResponse;

/* ------------------------------------------------------------- actions */

/**
 * One trajectory sample in the *ego frame at plan issuance*: x forward along
 * the ego heading, y left (90° CCW), heading relative to the ego yaw
 * (radians), signed speed (m/s, negative = reverse), `t` seconds from
 * issuance. Samples are strictly future (`t > 0`) — the first point is not
 * the current pose. Matches the Alpamayo adapter's "ego frame at t0"
 * waypoint convention (FLU, z dropped).
 */
export interface TrajectoryPoint {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly speed: number;
  readonly t: number;
}

/**
 * Trajectory action. Execution is a server property (reported by
 * `policy.hello` as `trajExec`):
 *
 * - `'pure-pursuit'` (default): the trajectory executor anchors the plan to
 *   the world frame at the pose of the observation this act responds to and
 *   tracks it — pure-pursuit preview steering + the plan's time-indexed
 *   speed profile — until a *different* plan replaces it (zero-order hold;
 *   byte-identical points hold the original anchor). See
 *   docs/policy-step.md "Trajectory execution".
 * - `'speed-setpoint'` (v1 reduction, kept for regression comparability):
 *   the target speed is taken from the earliest point with `t > 0` (falling
 *   back to the first point); steering stays with the authored route logic.
 */
export interface ActionTrajectory {
  readonly kind: 'trajectory';
  readonly points: readonly TrajectoryPoint[];
}

/** Low-level control action, passed through to the vehicle backend. */
export interface ActionControl {
  readonly kind: 'control';
  readonly throttle: number;
  readonly brake: number;
  readonly steer: number;
}

export type PolicyAction = ActionTrajectory | ActionControl;

/** Fallback applied when a decision misses its deadline. */
export type FallbackPolicy = 'repeat-last' | 'zero-control' | 'scripted';
export const FALLBACK_POLICIES: readonly FallbackPolicy[] = ['repeat-last', 'zero-control', 'scripted'];

/** How a server executes trajectory actions (see {@link ActionTrajectory}). */
export type TrajectoryExecution = 'pure-pursuit' | 'speed-setpoint';

/* ------------------------------------------------------ frame bundles */

/** One camera image inside a shared-memory frame bundle (ShmBridge contract). */
export interface FrameBundleCamera {
  readonly id: string;
  /** CRC32 (IEEE) of the payload bytes, 8-char lowercase hex. */
  readonly digest: string;
  /** Physical offset of the payload bytes in the shm file (record header sits at byteOffset - 128). */
  readonly byteOffset: number;
  /** Payload length in bytes, row-padded; rowStride = byteLength / height (wgpu 256-byte row alignment). */
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  /** Pixel format tag: 'rgba8' | 'depth32f' | 'carla-depth-bgra'. */
  readonly format: string;
}
/** Reference to rendered camera frames living in a shm ring — never inline pixels. */
export interface FrameBundleRef {
  readonly shmName: string;
  readonly simTick: number;
  readonly cameras: readonly FrameBundleCamera[];
}

/* ------------------------------------------------------- hello payload */

/** `policy.hello` response: capabilities a policy client needs up front. */
export interface PolicyHello {
  /** policy_step protocol version ({@link POLICY_STEP_PROTOCOL_VERSION}). */
  readonly proto: number;
  /** Underlying env-server protocol version. */
  readonly envProto: number;
  readonly sessions: number;
  readonly decisionHz: number;
  readonly engineHz: number;
  readonly egos: readonly string[];
  /** Action kinds this server accepts. */
  readonly actions: readonly PolicyAction['kind'][];
  readonly fallbacks: readonly FallbackPolicy[];
  readonly obs: { readonly sv: boolean; readonly bev: boolean; readonly frameBundle: boolean };
  /** How this server executes trajectory actions. */
  readonly trajExec: TrajectoryExecution;
}

/* ------------------------------------------------------ deadline report */

/** Per-decision deadline verdict, attached to every `policy.act` step frame as `dl`. */
export interface DeadlineReport {
  /** Effective limit for this decision; null = no deadline. */
  readonly limitMs: number | null;
  /** Client/gateway-reported inference latency; null = unreported. */
  readonly elapsedMs: number | null;
  readonly miss: boolean;
  /** What actually drove the ego: the policy's action or a fallback. */
  readonly applied: 'policy' | FallbackPolicy;
}

/* ---------------------------------------------------------- wire codecs */

const trajectoryPointTuple = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]);

const wireActionSchema = z.union([
  z.object({ k: z.literal('t'), p: z.array(trajectoryPointTuple).min(1) }),
  z.object({ k: z.literal('c'), c: z.tuple([z.number(), z.number(), z.number()]) }),
]);

export type WirePolicyAction = z.infer<typeof wireActionSchema>;

/** Encode a {@link PolicyAction} into its compact wire form. */
export function encodePolicyAction(action: PolicyAction): WirePolicyAction {
  if (action.kind === 'control') return { k: 'c', c: [action.throttle, action.brake, action.steer] };
  return { k: 't', p: action.points.map((pt) => [pt.x, pt.y, pt.heading, pt.speed, pt.t]) };
}

/** Decode a compact wire action; throws on malformed input. */
export function decodePolicyAction(wire: unknown): PolicyAction {
  const doc = wireActionSchema.parse(wire);
  if (doc.k === 'c') return { kind: 'control', throttle: doc.c[0], brake: doc.c[1], steer: doc.c[2] };
  return {
    kind: 'trajectory',
    points: doc.p.map(([x, y, heading, speed, t]) => ({ x, y, heading, speed, t })),
  };
}

/**
 * Reduce a policy action to the engine's {@link EnvAction} — the
 * `'speed-setpoint'` trajectory execution (see {@link TrajectoryExecution}).
 *
 * Control passes through verbatim. A trajectory reduces to a speed setpoint
 * (see {@link ActionTrajectory}); negative setpoint speed flips the motion
 * direction with the setpoint magnitude preserved. The `'pure-pursuit'`
 * execution path lives in policy-session.ts on top of the engine's
 * TrajectoryFollower.
 */
export function toEnvAction(action: PolicyAction): EnvAction {
  if (action.kind === 'control') {
    return { control: { throttle: action.throttle, brake: action.brake, steer: action.steer } };
  }
  const next = action.points.find((pt) => pt.t > 0) ?? action.points[0]!;
  return next.speed < 0
    ? { targetSpeedMps: -next.speed, motionDirection: -1 }
    : { targetSpeedMps: next.speed, motionDirection: 1 };
}

/** The all-zero control fallback. */
export const ZERO_CONTROL: ActionControl = { kind: 'control', throttle: 0, brake: 0, steer: 0 };

/**
 * Resolve one decision's deadline verdict and the action to apply.
 *
 * Pure and deterministic: depends only on the arguments. `lastApplied` is
 * the last action actually applied this episode (policy or fallback), used
 * by 'repeat-last'; null before the first applied action.
 */
export function resolveDeadline(input: {
  readonly action: PolicyAction;
  readonly elapsedMs: number | null;
  readonly limitMs: number | null;
  readonly fallback: FallbackPolicy;
  readonly lastApplied: PolicyAction | null;
}): { readonly report: DeadlineReport; readonly apply: PolicyAction | null } {
  const miss = input.limitMs !== null && input.elapsedMs !== null && input.elapsedMs > input.limitMs;
  if (!miss) {
    return {
      report: { limitMs: input.limitMs, elapsedMs: input.elapsedMs, miss: false, applied: 'policy' },
      apply: input.action,
    };
  }
  const base: Omit<DeadlineReport, 'applied'> = { limitMs: input.limitMs, elapsedMs: input.elapsedMs, miss: true };
  switch (input.fallback) {
    case 'zero-control':
      return { report: { ...base, applied: 'zero-control' }, apply: ZERO_CONTROL };
    case 'scripted':
      return { report: { ...base, applied: 'scripted' }, apply: null };
    case 'repeat-last':
      return input.lastApplied === null
        ? { report: { ...base, applied: 'scripted' }, apply: null }
        : { report: { ...base, applied: 'repeat-last' }, apply: input.lastApplied };
  }
}

/** Encode a {@link DeadlineReport} into its compact wire form (`dl`). */
export function encodeDeadlineReport(report: DeadlineReport): Record<string, unknown> {
  return { lim: report.limitMs, el: report.elapsedMs, miss: report.miss ? 1 : 0, ap: report.applied };
}

const wireDeadlineSchema = z.object({
  lim: z.number().nullable(),
  el: z.number().nullable(),
  miss: z.union([z.literal(0), z.literal(1)]),
  ap: z.union([z.literal('policy'), z.literal('repeat-last'), z.literal('zero-control'), z.literal('scripted')]),
});

export function decodeDeadlineReport(wire: unknown): DeadlineReport {
  const doc = wireDeadlineSchema.parse(wire);
  return { limitMs: doc.lim, elapsedMs: doc.el, miss: doc.miss === 1, applied: doc.ap };
}

/** Encode a {@link FrameBundleRef} into its compact wire form (`fb`). */
export function encodeFrameBundleRef(ref: FrameBundleRef): Record<string, unknown> {
  return {
    shm: ref.shmName,
    tick: ref.simTick,
    cams: ref.cameras.map((c) => [c.id, c.digest, c.byteOffset, c.byteLength, c.width, c.height, c.format]),
  };
}

const wireCameraTuple = z.tuple([
  z.string(),
  z.string(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.string(),
]);
const wireFrameBundleSchema = z.object({ shm: z.string(), tick: z.number().int(), cams: z.array(wireCameraTuple) });

export function decodeFrameBundleRef(wire: unknown): FrameBundleRef {
  const doc = wireFrameBundleSchema.parse(wire);
  return {
    shmName: doc.shm,
    simTick: doc.tick,
    cameras: doc.cams.map(([id, digest, byteOffset, byteLength, width, height, format]) => ({
      id,
      digest,
      byteOffset,
      byteLength,
      width,
      height,
      format,
    })),
  };
}

/* --------------------------------------------------------- request schemas */

export const fallbackSchema = z.union([z.literal('repeat-last'), z.literal('zero-control'), z.literal('scripted')]);

/** `policy.hello` request fields. */
export const policyHelloSchema = z.object({ v: z.number().int().positive() });

/** `policy.reset` request fields (beyond the envelope). */
export const policyResetSchema = z.object({
  s: z.number().int().nonnegative().optional(),
  seed: z.union([z.number(), z.string()]).optional(),
  deadlineMs: z.number().positive().optional(),
  fallback: fallbackSchema.optional(),
});

/** One entry of a (possibly batched) `policy.act`. */
export const policyActStepSchema = z.object({
  a: wireActionSchema,
  elapsedMs: z.number().nonnegative().optional(),
});

/** `policy.act` request fields (beyond the envelope). */
export const policyActSchema = z.object({
  s: z.number().int().nonnegative().optional(),
  steps: z.array(policyActStepSchema).min(1),
  st: z.instanceof(Uint8Array).optional(),
  deadlineMs: z.number().positive().optional(),
});

/** `policy.close` request fields. */
export const policyCloseSchema = z.object({ s: z.number().int().nonnegative().optional() });
