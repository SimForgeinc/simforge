import type {
  OpenScenarioExecutionPlan,
  OpenScenarioPlanActor,
  OpenScenarioPlanSample,
  OpenScenarioSignalChange,
} from '@simforge-oss/openscenario';
import {
  ACTOR_KINDS,
  CONTROL_INDICATIONS,
  parseSimScenarioInput,
  TRACE_FORMAT_VERSION,
  type ControlIndication,
  type SceneTrace,
  type SimActor,
} from '@simforge-oss/engine';
import {
  resolvePlaybackCatalogId,
  type PlaybackActor,
  type PlaybackBundle,
  type PlaybackSignal,
} from './model';

const REPLAY_ENGINE_VERSION = 'openscenario-replay/v1';

/** Adapt a validated immutable OpenSCENARIO execution plan into canonical playback. */
export function playbackBundleFromReplay(
  plan: OpenScenarioExecutionPlan,
  input: { mapId: string; engineGraphDigest: string },
): PlaybackBundle {
  if (plan.mapId !== input.mapId) {
    throw new Error(`trajectory replay map ${JSON.stringify(plan.mapId)} does not match requested map ${JSON.stringify(input.mapId)}`);
  }
  if (input.engineGraphDigest.length === 0) throw new Error('engineGraphDigest must not be empty');

  const planActors = [...plan.actors].sort((a, b) => a.id.localeCompare(b.id));
  if (planActors.length === 0) throw new Error('trajectory replay contains no actors');
  const duplicateActor = planActors.find((actor, index) => index > 0 && actor.id === planActors[index - 1]!.id);
  if (duplicateActor) throw new Error(`trajectory replay contains duplicate actor id ${JSON.stringify(duplicateActor.id)}`);

  const times = replayTimes(plan);
  const actors = planActors.map(replayActor);
  const actorInputs = planActors.map((actor) => replayActorInput(actor, actors.find((candidate) => candidate.id === actor.id)!));
  const scenarioInput = parseSimScenarioInput({
    mapId: input.mapId,
    clipSeconds: plan.clipSeconds,
    warmupSeconds: plan.warmupSeconds,
    dt: plan.dt,
    seed: plan.inputHash,
    operationalConditions: plan.environment.authored,
    actors: actorInputs,
  });

  const actorMetadata = Object.fromEntries(actors.map((actor) => [actor.id, {
    kind: actor.kind,
    dims: actor.dims,
    static: actor.static,
    tags: actor.tags,
  }]));
  const trace: SceneTrace = {
    header: {
      traceVersion: TRACE_FORMAT_VERSION,
      engineVersion: REPLAY_ENGINE_VERSION,
      inputHash: plan.inputHash,
      source: 'openscenario-replay',
      sourceXoscSha256: plan.sourceSha256,
      seed: plan.inputHash,
      mapId: input.mapId,
      engineGraphDigest: input.engineGraphDigest,
      topologyDigest: input.engineGraphDigest,
      dt: plan.dt,
      clipSeconds: plan.clipSeconds,
      warmupSeconds: plan.warmupSeconds,
      frame: 'scene',
      actorIds: actors.map((actor) => actor.id),
      actorMetadata,
      metricSubject: null,
      operationalConditions: plan.environment.authored,
      physics: {
        mode: 'kinematic-v1',
        solver: 'uniscenarios-sim-engine',
        solverVersion: REPLAY_ENGINE_VERSION,
        substepS: plan.dt,
        vehicleProfileDigest: null,
      },
    },
    ticks: {
      t: times,
      actors: Object.fromEntries(planActors.map((actor) => [actor.id, replayActorTrack(actor, times)])),
      ...(plan.signals.length > 0 ? { signals: replaySignalTracks(plan, times) } : {}),
    },
    events: [...plan.events],
    metrics: {
      minTTC: null,
      minPathTTC: null,
      minPET: null,
      minDistance: [],
      requiredDecelMax: Object.fromEntries(actors.map((actor) => [actor.id, 0])),
      invariantResiduals: [],
      collisions: [],
      triggerNeverFired: [],
      clippedCriticality: false,
      ticksSimulated: times.length,
    },
  };
  const signals = replaySignals(plan);

  return {
    instance: {
      kind: 'scenario-instance',
      version: 1,
      manifest: {
        instanceId: `openscenario-replay:${plan.sourceSha256}`,
        inputHash: plan.inputHash,
        replayKey: { mapId: input.mapId, engineGraphDigest: input.engineGraphDigest },
        actors: actors.map((actor) => ({ id: actor.id })),
      },
      input: scenarioInput,
    },
    trace,
    actors,
    props: [],
    signals,
    source: {
      instanceName: `openscenario-replay:${plan.sourceSha256}`,
      traceName: `${plan.sourceSha256}.xosc`,
    },
    startTime: plan.warmupSeconds,
    endTime: plan.stopTimeS,
  };
}

function replayTimes(plan: OpenScenarioExecutionPlan): number[] {
  const values = new Set<number>([0, plan.stopTimeS]);
  for (const actor of plan.actors) for (const sample of actor.samples) values.add(sample.t);
  for (const signal of plan.signals) for (const change of signal.changes) values.add(change.t);
  for (const changes of Object.values(plan.physicalSignals)) for (const change of changes) values.add(change.t);
  return [...values].filter((time) => time >= 0 && time <= plan.stopTimeS).sort((a, b) => a - b);
}

function replayActor(actor: OpenScenarioPlanActor): PlaybackActor {
  if (!(ACTOR_KINDS as readonly string[]).includes(actor.kind)) {
    throw new Error(`actor ${JSON.stringify(actor.id)} has unsupported kind ${JSON.stringify(actor.kind)}`);
  }
  const catalogId = actor.tags.find((tag) => tag.startsWith('catalog:'))?.slice('catalog:'.length) ?? null;
  const visual = resolvePlaybackCatalogId(actor.kind as SimActor['kind'], catalogId);
  if (!visual) throw new Error(`actor ${JSON.stringify(actor.id)} requests unknown Studio catalog model ${JSON.stringify(catalogId)}`);
  const first = actor.samples[0];
  if (!first) throw new Error(`actor ${JSON.stringify(actor.id)} contains no trajectory samples`);
  return {
    id: actor.id,
    entityName: actor.entityName,
    kind: actor.kind as SimActor['kind'],
    static: actor.static,
    tags: actor.tags,
    catalogId: visual.catalogId,
    modelBasis: visual.modelBasis,
    dims: actor.dims,
    initial: { x: first.x, z: -first.y, headingRad: first.headingRad },
  };
}

function replayActorInput(actor: OpenScenarioPlanActor, playbackActor: PlaybackActor) {
  const first = actor.samples[0]!;
  const last = actor.samples.at(-1)!;
  const routePoints = first === last
    ? [{ x: first.x, z: -first.y }]
    : [{ x: first.x, z: -first.y }, { x: last.x, z: -last.y }];
  return {
    id: playbackActor.id,
    kind: playbackActor.kind,
    dims: playbackActor.dims,
    initial: {
      pose: { x: first.x, z: -first.y, headingRad: first.headingRad },
      speedMps: first.speedMps,
    },
    behavior: { route: { kind: 'polyline' as const, points: routePoints } },
    presentAtStart: first.present,
    static: actor.static,
    tags: actor.tags,
  };
}

function replayActorTrack(actor: OpenScenarioPlanActor, times: readonly number[]) {
  const sampled = times.map((time) => sampleReplayActor(actor.samples, time));
  return {
    x: sampled.map((sample) => sample.x),
    z: sampled.map((sample) => -sample.y),
    headingRad: sampled.map((sample) => sample.headingRad),
    speedMps: sampled.map((sample) => sample.speedMps),
    lateralOffsetM: times.map(() => 0),
    laneRsl: times.map(() => null),
    s: times.map(() => 0),
    present: sampled.map((sample) => sample.present ? 1 : 0),
  };
}

function sampleReplayActor(samples: readonly OpenScenarioPlanSample[], time: number): OpenScenarioPlanSample {
  const first = samples[0]!;
  const last = samples.at(-1)!;
  if (time <= first.t) return first;
  if (time >= last.t) return last;
  let upper = 1;
  while (samples[upper]!.t < time) upper += 1;
  const a = samples[upper - 1]!;
  const b = samples[upper]!;
  const alpha = (time - a.t) / (b.t - a.t);
  return {
    t: time,
    x: lerp(a.x, b.x, alpha),
    y: lerp(a.y, b.y, alpha),
    z: lerp(a.z, b.z, alpha),
    headingRad: a.headingRad + angleDelta(b.headingRad, a.headingRad) * alpha,
    speedMps: lerp(a.speedMps, b.speedMps, alpha),
    present: alpha < 1 ? a.present : b.present,
  };
}

function replaySignals(plan: OpenScenarioExecutionPlan): PlaybackSignal[] {
  return [...plan.signals]
    .sort((a, b) => a.programId.localeCompare(b.programId))
    .map((signal) => ({ id: signal.programId, headIds: signal.headIds, timingSource: 'authored' }));
}

function replaySignalTracks(plan: OpenScenarioExecutionPlan, times: readonly number[]) {
  return Object.fromEntries([...plan.signals]
    .sort((a, b) => a.programId.localeCompare(b.programId))
    .map((signal) => {
      const physical = signal.headIds.length > 0 ? plan.physicalSignals[signal.headIds[0]!] : undefined;
      const changes = physical ?? signal.changes;
      if (changes.length === 0 || changes[0]!.t > times[0]!) {
        throw new Error(`signal ${JSON.stringify(signal.programId)} has no state at replay start`);
      }
      return [signal.programId, {
        phase: times.map((time) => replayControlIndication(signal.programId, signalStateAt(changes, time))),
      }];
    }));
}

function signalStateAt(changes: readonly OpenScenarioSignalChange[], time: number): string {
  let index = changes.length - 1;
  while (index > 0 && changes[index]!.t > time) index -= 1;
  return changes[index]!.state;
}

function replayControlIndication(signalId: string, state: string): ControlIndication {
  if ((CONTROL_INDICATIONS as readonly string[]).includes(state)) return state as ControlIndication;
  throw new Error(`signal ${JSON.stringify(signalId)} has unsupported state ${JSON.stringify(state)}`);
}

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}
