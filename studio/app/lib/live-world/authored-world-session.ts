import {
  isRoadActorKind,
  resolvePhysicsConfig,
  type LaneGraph,
  type SimScenarioInput,
} from '@simforge/engine';
import { WorldSession } from '@simforge/training-env/browser';

import type { ControlInput } from './types';

export function createAuthoredWorldSession(input: SimScenarioInput, graph: LaneGraph): WorldSession {
  return new WorldSession({ input, graph, mode: 'live' });
}

export function assertControllableActor(input: SimScenarioInput, actorId: string): void {
  const actor = input.actors.find((candidate) => candidate.id === actorId);
  if (!actor) throw new Error(`Cannot designate unknown authored actor ${actorId} as ego`);
  if (!isRoadActorKind(actor.kind)) {
    throw new Error(`Authored actor ${actorId} (${actor.kind}) is not a controllable road vehicle`);
  }
  if (actor.static) throw new Error(`Authored actor ${actorId} is static and has no controllable dynamics`);
  if (resolvePhysicsConfig(input).mode !== 'dynamic-v1') {
    throw new Error(`Authored actor ${actorId} cannot be driven because the world does not use dynamic-v1 physics`);
  }
}

export function applyEgoControl(
  world: WorldSession,
  actorId: string,
  input: ControlInput,
  sequence: number,
) {
  if (input.actorId !== actorId) {
    throw new Error(`Control target ${input.actorId} is not the designated ego ${actorId}`);
  }
  return world.applyCommand('drive-worker', sequence, {
    kind: 'act',
    actorId,
    action: {
      motionDirection: input.reverse ? -1 : 1,
      control: {
        steer: input.steer,
        throttle: input.throttle,
        brake: input.brake,
      },
    },
  });
}
