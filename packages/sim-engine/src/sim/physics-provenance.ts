import type { ActorKind, ResolvedPhysicsConfig } from '../schema/input.js';
import type { ActorPhysicsBackendProvenance } from '../trace/trace.js';

/**
 * Report the backend an actor will actually execute. This is deliberately a
 * pure classifier shared by simulation, diagnostics, and exporters so those
 * surfaces cannot make broader fidelity claims than the engine.
 */
export function actorPhysicsBackend(
  actor: { readonly kind: ActorKind; readonly static: boolean; readonly tags: readonly string[] },
  physics: Pick<ResolvedPhysicsConfig, 'mode'>,
): ActorPhysicsBackendProvenance {
  if (actor.static || actor.kind === 'static_object') {
    return { mode: 'fixed-static-v1', reason: 'static-actor', profile: 'fixed-static' };
  }
  // The classifier must never claim more fidelity than the engine executes:
  // an explicit `kinematic-v1` selection runs the route choreography, so it
  // is reported as a selected kinematic backend.
  return physics.mode === 'kinematic-v1'
    ? { mode: 'kinematic-v1', reason: 'selected', profile: actor.kind }
    : { mode: 'dynamic-v1', reason: 'selected', profile: actor.kind };
}

export function actorPhysicsBackends(
  actors: readonly { readonly id: string; readonly kind: ActorKind; readonly static: boolean; readonly tags: readonly string[] }[],
  physics: Pick<ResolvedPhysicsConfig, 'mode'>,
): Record<string, ActorPhysicsBackendProvenance> {
  return Object.fromEntries(actors.map((actor) => [actor.id, actorPhysicsBackend(actor, physics)]));
}

export function physicsBackendCounts(
  backends: Readonly<Record<string, { readonly mode: ActorPhysicsBackendProvenance['mode'] }>>,
): { readonly dynamic: number; readonly kinematic: number; readonly fixed: number } {
  let dynamic = 0;
  let kinematic = 0;
  let fixed = 0;
  for (const backend of Object.values(backends)) {
    if (backend.mode === 'dynamic-v1') dynamic += 1;
    else if (backend.mode === 'fixed-static-v1') fixed += 1;
    else kinematic += 1;
  }
  return { dynamic, kinematic, fixed };
}
