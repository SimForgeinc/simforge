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
  type PolicyHello,
} from './policy-step.js';
import type { EnvSession } from './session.js';

/**
 * ShmBridge production seam: given a session index and the engine tick of
 * the observation instant, return the latest rendered frame bundle for that
 * tick, or null when rendering is off or the bundle is not (yet) available.
 */
export type FrameBundleProvider = (sessionIndex: number, simTick: number) => FrameBundleRef | null;

export interface PolicySessionOptions {
  readonly frameBundleProvider?: FrameBundleProvider;
}

/** Per-env-session policy state; created by `policy.reset`, dropped by `policy.close`. */
interface PolicySessionState {
  deadlineMs: number | null;
  fallback: FallbackPolicy;
  lastApplied: PolicyAction | null;
  stateToken: Uint8Array;
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
      const result = session.step(apply === null ? {} : toEnvAction(apply));
      return { ...withFrameBundle(encodeStepResult(result), index), dl: encodeDeadlineReport(report) };
    });
    return { st: state.stateToken, rs };
  });

  server.registerOp('policy.close', (request: WireRequest) => {
    const fields = policyCloseSchema.parse(request);
    states.delete(fields.s ?? 0);
    return { closed: true };
  });
}
