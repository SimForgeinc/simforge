/**
 * policy_step session handlers — the server glue for `policy.*` ops.
 *
 * Registers the policy_step protocol (see ./policy-step.ts) onto an
 * {@link EnvServer} through its additive extension seam
 * ({@link EnvServer.registerOp}). Stepping itself is delegated to the
 * existing {@link EnvSession} engine loop — this module owns only the
 * per-session policy state: deadline configuration, the fallback policy,
 * the last applied action ('repeat-last'), and the opaque recurrent state
 * token. World mutation ops (`world.*`) live elsewhere and are not touched
 * here.
 *
 * Determinism: no wall clock anywhere. Deadline misses are decided from the
 * request's declared `elapsedMs` (see policy-step.ts), so a replayed request
 * stream yields byte-identical responses.
 */

import { TrajectoryFollower, anchorPlanToWorld, type TrajectoryPlanPoint } from '@simforge/engine';

import { ENV_SERVER_PROTOCOL_VERSION, encodeStepResult, type EnvServer, type WireRequest } from './env-server.js';
import {
  FALLBACK_POLICIES,
  POLICY_STEP_PROTOCOL_VERSION,
  decodePolicyAction,
  encodeDeadlineReport,
  encodeFrameBundleRef,
  policyActSchema,
  policyCloseSchema,
  policyHelloSchema,
  policyResetSchema,
  resolveDeadline,
  toEnvAction,
  type FallbackPolicy,
  type FrameBundleRef,
  type PolicyAction,
  type TrajectoryExecution,
  type TrajectoryPoint,
  type PolicyHello,
} from './policy-step.js';
import type { EnvSession } from './session.js';
import type { EnvAction } from './types.js';

/**
 * ShmBridge production seam: given a session index and the engine tick of
 * the observation instant, return the latest rendered frame bundle for that
 * tick, or null when rendering is off or the bundle is not (yet) available.
 */
export type FrameBundleProvider = (sessionIndex: number, simTick: number) => FrameBundleRef | null;

export interface PolicySessionOptions {
  readonly frameBundleProvider?: FrameBundleProvider;
  /**
   * How trajectory actions drive the ego (see policy-step.ts
   * {@link TrajectoryExecution}). Default `'pure-pursuit'`; pass
   * `'speed-setpoint'` for the v1 reduction (regression comparability).
   */
  readonly trajectoryExecution?: TrajectoryExecution;
}

/** Per-env-session policy state; created by `policy.reset`, dropped by `policy.close`. */
interface PolicySessionState {
  deadlineMs: number | null;
  fallback: FallbackPolicy;
  lastApplied: PolicyAction | null;
  stateToken: Uint8Array;
  /** Trajectory executor; holds the anchored plan across acts (ZOH). */
  follower: TrajectoryFollower;
  /** Wire points of the held plan — byte-equal points keep the anchor. */
  heldPlan: readonly TrajectoryPoint[] | null;
}

/** Executor telemetry attached to a step frame as `ex` (pure-pursuit only). */
interface ExecutorFrame {
  /** Ego pose the command was computed from (world frame). */
  readonly x: number;
  readonly y: number;
  readonly h: number;
  readonly v: number;
  /** Signed cross-track error to the anchored plan, +left, metres. */
  readonly ct: number;
  /** Along-track arc position, metres. */
  readonly at: number;
  /** Plan age, seconds since issuance. */
  readonly age: number;
  /** Applied setpoints: speed, feedforward accel, direction. */
  readonly sp: number;
  readonly ax: number;
  readonly dir: 1 | -1;
  /** Pure-pursuit preview point + heading (world frame). */
  readonly px: number;
  readonly py: number;
  readonly ph: number;
}

function samePlan(a: readonly TrajectoryPoint[], b: readonly TrajectoryPoint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.x !== q.x || p.y !== q.y || p.heading !== q.heading || p.speed !== q.speed || p.t !== q.t) return false;
  }
  return true;
}

const EMPTY_TOKEN = new Uint8Array(0);

/**
 * Register the `policy.hello` / `policy.reset` / `policy.act` /
 * `policy.close` handlers on `server`. Call once per server instance.
 */
export function registerPolicySession(server: EnvServer, options: PolicySessionOptions = {}): void {
  const frameBundles = options.frameBundleProvider ?? null;
  const engineHz = server.info().engineHz;
  const states = new Map<number, PolicySessionState>();
  const trajExec: TrajectoryExecution = options.trajectoryExecution ?? 'pure-pursuit';

  const requireSession = (index: number): EnvSession => {
    const session = server.sessions[index];
    if (!session) throw new Error(`no session ${index} (server hosts ${server.sessions.length})`);
    return session;
  };

  const requireState = (index: number): PolicySessionState => {
    const state = states.get(index);
    if (!state) throw new Error(`policy.act before policy.reset on session ${index}`);
    return state;
  };

  /** Attach fb (frame-bundle ref) to one encoded step frame. */
  const withFrameBundle = (frame: Record<string, unknown>, sessionIndex: number): Record<string, unknown> => {
    if (!frameBundles) return { ...frame, fb: null };
    const tS = frame['t'] as number;
    const ref = frameBundles(sessionIndex, Math.round(tS * engineHz));
    return { ...frame, fb: ref ? encodeFrameBundleRef(ref) : null };
  };

  /**
   * Resolve the engine action (and executor telemetry) for one applied
   * policy action. Trajectories under `'pure-pursuit'` are anchored to the
   * world frame at the pose of the observation this act responds to and
   * tracked by the session's follower; byte-identical points hold the
   * existing anchor (zero-order hold on the plan across 10 Hz acts between
   * 0.5 Hz replans).
   */
  const executeAction = (
    session: EnvSession,
    state: PolicySessionState,
    action: PolicyAction,
  ): { envAction: EnvAction; ex: ExecutorFrame | null } => {
    if (action.kind === 'control' || trajExec === 'speed-setpoint') {
      return { envAction: toEnvAction(action), ex: null };
    }
    const pose = session.egoPose();
    if (!pose) throw new Error('policy.act on an un-reset env session');
    if (state.heldPlan === null || !samePlan(state.heldPlan, action.points)) {
      const egoPlan: TrajectoryPlanPoint[] = action.points.map((p) => ({
        x: p.x,
        y: p.y,
        headingRad: p.heading,
        speedMps: p.speed,
        tS: p.t,
      }));
      state.follower.setPlan(anchorPlanToWorld(egoPlan, { x: pose.x, y: pose.y, yawRad: pose.yawRad }), pose.tS);
      state.heldPlan = action.points;
    }
    const cmd = state.follower.command(pose, pose.tS);
    return {
      envAction: {
        targetSpeedMps: cmd.targetSpeedMps,
        targetAccelerationMps2: cmd.targetAccelerationMps2,
        motionDirection: cmd.motionDirection,
        previewPoint: cmd.previewPoint,
        previewHeadingRad: cmd.previewHeadingRad,
      },
      ex: {
        x: pose.x,
        y: pose.y,
        h: pose.yawRad,
        v: pose.speedMps,
        ct: cmd.crossTrackErrorM,
        at: cmd.alongTrackM,
        age: cmd.planAgeS,
        sp: cmd.targetSpeedMps,
        ax: cmd.targetAccelerationMps2,
        dir: cmd.motionDirection,
        px: cmd.previewPoint.x,
        py: cmd.previewPoint.y,
        ph: cmd.previewHeadingRad,
      },
    };
  };

  server.registerOp('policy.hello', (request: WireRequest) => {
    const { v } = policyHelloSchema.parse(request);
    if (v !== POLICY_STEP_PROTOCOL_VERSION) {
      throw new Error(`policy_step protocol mismatch: client v${v}, server v${POLICY_STEP_PROTOCOL_VERSION}`);
    }
    const info = server.info();
    const hello: PolicyHello = {
      proto: POLICY_STEP_PROTOCOL_VERSION,
      envProto: ENV_SERVER_PROTOCOL_VERSION,
      sessions: info.sessions,
      decisionHz: info.decisionHz,
      engineHz: info.engineHz,
      egos: info.egos,
      actions: ['trajectory', 'control'],
      fallbacks: FALLBACK_POLICIES,
      obs: { sv: info.obs.sv, bev: info.obs.bev, frameBundle: frameBundles !== null },
      trajExec,
    };
    return hello;
  });

  server.registerOp('policy.reset', (request: WireRequest) => {
    const fields = policyResetSchema.parse(request);
    const index = fields.s ?? 0;
    const session = requireSession(index);
    states.set(index, {
      deadlineMs: fields.deadlineMs ?? null,
      fallback: fields.fallback ?? 'scripted',
      lastApplied: null,
      stateToken: EMPTY_TOKEN,
      follower: new TrajectoryFollower(),
      heldPlan: null,
    });
    const result = session.reset(fields.seed);
    return { seed: fields.seed ?? null, st: EMPTY_TOKEN, ob: withFrameBundle(encodeStepResult(result), index) };
  });

  server.registerOp('policy.act', (request: WireRequest) => {
    const fields = policyActSchema.parse(request);
    const index = fields.s ?? 0;
    const session = requireSession(index);
    const state = requireState(index);
    if (fields.st !== undefined) state.stateToken = fields.st;

    // Batched entries apply sequentially to this session; a terminal step
    // mid-batch makes the *next* entry throw (post-episode stepping is
    // undefined), failing the whole request — clients stop at term/trunc.
    const rs = fields.steps.map((step) => {
      const { report, apply } = resolveDeadline({
        action: decodePolicyAction(step.a),
        elapsedMs: step.elapsedMs ?? null,
        limitMs: fields.deadlineMs ?? state.deadlineMs,
        fallback: state.fallback,
        lastApplied: state.lastApplied,
      });
      if (apply !== null) state.lastApplied = apply;
      const resolved = apply === null ? null : executeAction(session, state, apply);
      const result = session.step(resolved === null ? {} : resolved.envAction);
      const frame = { ...withFrameBundle(encodeStepResult(result), index), dl: encodeDeadlineReport(report) };
      return resolved?.ex ? { ...frame, ex: resolved.ex } : frame;
    });
    return { st: state.stateToken, rs };
  });

  server.registerOp('policy.close', (request: WireRequest) => {
    const fields = policyCloseSchema.parse(request);
    states.delete(fields.s ?? 0);
    return { closed: true };
  });
}
