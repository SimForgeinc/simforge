import {
  SEMANTIC_LEDGER_SCHEMA,
  SEMANTIC_LEDGER_VERSION,
  type SemanticAction,
  type SemanticEvent,
  type SemanticLedger,
  type SemanticTrigger,
} from '@simforge/scenario';

import { contentHash } from '../core/hash.js';
import type { Interaction, SimScenarioInput } from '../schema/input.js';
import type { Route } from '../map/route.js';
import { axisOf } from '../sim/state.js';
import { gearOfMotionDirection, initialMotionDirection } from '../sim/gear.js';
import type { TriggerRuntime } from '../sim/triggers.js';
import type { SimEvent, SimTrace } from './trace.js';

export interface TriggerTruthTransition {
  readonly t: number;
  readonly value: boolean;
}

export interface BuildSemanticLedgerOptions {
  readonly trace: Omit<SimTrace, 'semanticLedger'>;
  readonly input: SimScenarioInput;
  readonly triggers: readonly TriggerRuntime[];
  readonly triggerTruthTransitions: ReadonlyMap<string, readonly TriggerTruthTransition[]>;
  readonly initialRouteRefs: ReadonlyMap<string, string>;
  readonly routeRefs: ReadonlyMap<string, readonly string[]>;
  readonly complete: boolean;
}

export function semanticRouteRef(route: unknown): string {
  return `route:${contentHash(route)}`;
}

/** Identity of the concrete path the engine actually owns, after map binding. */
export function semanticResolvedRouteRef(route: Route): string {
  const signature = route.isFreeform
    ? {
        kind: 'freeform',
        lengthM: route.lengthM,
        samples: Array.from({ length: 17 }, (_, index) => {
          const pose = route.poseAt((route.lengthM * index) / 16);
          return { x: pose.point.x, y: pose.point.y, headingRad: pose.headingRad };
        }),
      }
    : {
        kind: 'lane-route',
        legs: route.legs.map((leg) => ({
          rsl: leg.rsl,
          reversed: leg.reversed,
          sStart: leg.sStart,
          lengthM: leg.lengthM,
          turnRelation: leg.turnRelation,
        })),
      };
  return semanticRouteRef(signature);
}

function eventIdentity(event: SimEvent): { actorId?: string; interactionId?: string } {
  return {
    ...('actorId' in event ? { actorId: event.actorId } : {}),
    ...('interactionId' in event ? { interactionId: event.interactionId } : {}),
  };
}

function semanticEvent(event: SimEvent): SemanticEvent {
  const record = event as unknown as Record<string, unknown>;
  const payload = Object.fromEntries(
    Object.entries(record).filter(([key]) => !['t', 'kind', 'actorId', 'interactionId'].includes(key)),
  );
  return {
    t: event.t,
    kind: event.kind,
    ...eventIdentity(event),
    payload,
  };
}

function actionFor(
  interaction: Interaction,
  trigger: TriggerRuntime,
  events: readonly SimEvent[],
): SemanticAction {
  const fired = events.find((event) => event.kind === 'trigger_fired' && event.interactionId === interaction.id);
  const skipped = [...events].reverse().find((event) => event.kind === 'trigger_skipped' && event.interactionId === interaction.id);
  const rejected = [...events].reverse().find((event): event is Extract<SimEvent, { kind: 'lane_change_rejected' | 'route_change_rejected' }> =>
    (event.kind === 'lane_change_rejected' || event.kind === 'route_change_rejected')
    && event.interactionId === interaction.id,
  );
  const aborted = [...events].reverse().find((event): event is Extract<SimEvent, { kind: 'interaction_aborted' }> => event.kind === 'interaction_aborted' && event.interactionId === interaction.id);
  const preempted = [...events].reverse().find((event): event is Extract<SimEvent, { kind: 'preemption' }> => event.kind === 'preemption' && event.preemptedInteractionId === interaction.id);
  const released = [...events].reverse().find((event): event is Extract<SimEvent, { kind: 'released' }> => event.kind === 'released' && event.interactionId === interaction.id);
  const completed = [...events].reverse().find((event): event is Extract<SimEvent, { kind: 'interaction_completed' }> => event.kind === 'interaction_completed' && event.interactionId === interaction.id);

  let status: SemanticAction['status'] = trigger.status === 'pending'
    ? 'pending'
    : trigger.status === 'skipped'
      ? 'skipped'
      : 'active';
  let endT: number | null = trigger.endedAt;
  let reason: string | null = skipped && 'reason' in skipped ? skipped.reason : null;
  let preemptedByInteractionId: string | null = null;

  if (fired && ['route', 'exist', 'set'].includes(interaction.verb)) status = 'completed';
  if (completed) {
    status = 'completed';
    endT = completed.t;
    reason = 'complete';
  }
  if (released) {
    status = released.reason === 'complete' ? 'completed' : 'released';
    endT = released.t;
    reason = released.reason;
  }
  if (preempted) {
    status = 'preempted';
    endT = preempted.t;
    reason = 'preempted';
    preemptedByInteractionId = preempted.byInteractionId;
  }
  if (aborted) {
    status = 'aborted';
    endT = aborted.t;
    reason = aborted.reason;
  }
  if (rejected) {
    status = 'rejected';
    endT = rejected.t;
    reason = rejected.reason;
  }

  return {
    interactionId: interaction.id,
    actorId: interaction.actorId,
    verb: interaction.verb,
    axis: axisOf(interaction),
    status,
    startT: fired?.t ?? null,
    endT,
    forced: trigger.forced,
    reason,
    preemptedByInteractionId,
  };
}

function triggerFor(
  trigger: TriggerRuntime,
  events: readonly SimEvent[],
  truthTransitions: readonly TriggerTruthTransition[],
): SemanticTrigger {
  const skipped = [...events].reverse().find((event) =>
    event.kind === 'trigger_skipped' && event.interactionId === trigger.interaction.id,
  );
  return {
    interactionId: trigger.interaction.id,
    actorId: trigger.interaction.actorId,
    kind: trigger.interaction.trigger.kind,
    status: trigger.status,
    forced: trigger.forced,
    firedAt: trigger.firedAt,
    endedAt: trigger.endedAt,
    skipReason: skipped && 'reason' in skipped ? skipped.reason : null,
    truthTransitions: truthTransitions.map((transition) => ({ ...transition })),
  };
}

function initialActorState(actor: SimScenarioInput['actors'][number]): Record<string, string | boolean | number> {
  const direction = initialMotionDirection(actor.tags);
  return {
    'rules.obeySignals': actor.behavior.rules.obeySignals,
    'rules.yield': actor.behavior.rules.yield,
    'rules.yieldToVehicles': actor.behavior.rules.yieldToVehicles,
    'rules.yieldToPedestrians': actor.behavior.rules.yieldToPedestrians,
    'rules.collisionAvoidance': actor.behavior.rules.collisionAvoidance,
    'rules.aggression': actor.behavior.rules.aggression,
    'rules.speedFactor': actor.behavior.rules.speedFactor,
    'motion.gear': gearOfMotionDirection(direction),
    'motion.gearEngaged': gearOfMotionDirection(direction),
  };
}

/** Build the runtime-neutral semantic surface without changing simulation. */
export function buildSemanticLedger(options: BuildSemanticLedgerOptions): SemanticLedger {
  const { trace, input } = options;
  const actors = Object.fromEntries(input.actors.map((actor) => {
    const track = trace.ticks.actors[actor.id]!;
    const direction = track.motionDirection ?? track.speedMps.map(() => 1 as const);
    const velocityX: number[] = [];
    const velocityY: number[] = [];
    for (let index = 0; index < track.speedMps.length; index += 1) {
      const heading = track.headingRad[index]!;
      const longitudinal = track.physics?.vxBodyMps[index]
        ?? track.speedMps[index]! * direction[index]!;
      const lateral = track.physics?.vyBodyMps[index] ?? 0;
      velocityX.push(longitudinal * Math.cos(heading) - lateral * Math.sin(heading));
      velocityY.push(longitudinal * Math.sin(heading) + lateral * Math.cos(heading));
    }
    const routeRefs = options.routeRefs.get(actor.id) ?? track.s.map(() => semanticRouteRef(actor.behavior.route));
    return [actor.id, {
      kind: actor.kind,
      initialRouteRef: options.initialRouteRefs.get(actor.id) ?? semanticRouteRef(actor.behavior.route),
      initialState: initialActorState(actor),
      t: [...trace.ticks.t],
      x: [...track.x],
      y: [...track.y],
      headingRad: [...track.headingRad],
      velocityXMps: velocityX,
      velocityYMps: velocityY,
      speedMps: [...track.speedMps],
      motionDirection: [...direction],
      laneRsl: [...track.laneRsl],
      routeS: [...track.s],
      routeRef: [...routeRefs],
      present: track.present.map((value) => value === 0 ? 0 as const : 1 as const),
    }];
  }));

  const signals = Object.fromEntries(Object.entries(trace.ticks.signals ?? {}).map(([signalId, track]) => {
    const transitions: Array<{ t: number; phase: string }> = [];
    for (let index = 0; index < track.phase.length; index += 1) {
      if (index === 0 || track.phase[index] !== track.phase[index - 1]) {
        transitions.push({ t: trace.ticks.t[index]!, phase: track.phase[index]! });
      }
    }
    return [signalId, { phase: [...track.phase], transitions }];
  }));

  const declarations = Object.fromEntries(input.actors
    .filter((actor) => (actor.sensors?.length ?? 0) > 0)
    .map((actor) => [actor.id, structuredClone(actor.sensors ?? [])]));

  return {
    schema: SEMANTIC_LEDGER_SCHEMA,
    version: SEMANTIC_LEDGER_VERSION,
    source: {
      inputHash: trace.header.inputHash,
      producer: '../index.js',
      producerVersion: trace.header.engineVersion,
      mapId: trace.header.mapId,
      frame: 'xodr-local',
      dt: trace.header.dt,
      clipSeconds: trace.header.clipSeconds,
      motionAuthority: trace.header.physics.mode === 'dynamic-v1'
        ? 'uniscenarios-physics'
        : 'kinematic-replay',
      complete: options.complete,
    },
    actors,
    triggers: options.triggers.map((trigger) => triggerFor(
      trigger,
      trace.events,
      options.triggerTruthTransitions.get(trigger.interaction.id) ?? [],
    )),
    actions: input.interactions.map((interaction) => actionFor(
      interaction,
      options.triggers.find((trigger) => trigger.interaction.id === interaction.id)!,
      trace.events,
    )),
    events: trace.events.map(semanticEvent),
    signals,
    collisions: trace.metrics.collisions.map((collision) => ({
      t: collision.t,
      a: collision.a,
      b: collision.b,
      colliderA: collision.colliderA ?? null,
      colliderB: collision.colliderB ?? null,
    })),
    discreteState: trace.events
      .filter((event): event is Extract<SimEvent, { kind: 'state_set' }> => event.kind === 'state_set')
      .map((event) => ({ t: event.t, actorId: event.actorId, key: event.key, value: event.value })),
    environment: {
      operationalConditions: structuredClone(input.operationalConditions) as Record<string, unknown>,
      surfacePatches: structuredClone(input.surfacePatches),
      perception: input.perception ? structuredClone(input.perception) : null,
    },
    sensors: {
      declarations,
      channels: structuredClone(trace.ticks.sensors ?? {}) as Record<string, unknown>,
      mapDivergence: structuredClone(trace.ticks.mapDivergence ?? {}) as Record<string, unknown>,
    },
    invariants: (trace.metrics.invariantResiduals ?? []).map((result) => ({ ...result })),
  };
}
