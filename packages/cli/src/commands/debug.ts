/**
 * `uniscenarios debug <scenario.json>` — one agent-facing compile/run/inspect command.
 *
 * This is deliberately a reporting adapter around the canonical materializer
 * and sim-engine. It owns no scenario semantics and no vehicle motion logic.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { materializeMapBound, type InstanceManifest } from '@simforge/compiler';
import type { ScenarioTemplateV2 } from '@simforge/scenario';
import {
  buildLaneGraph,
  parseSimScenarioInput,
  runSimulation,
  traceDigest,
  traceToSceneFrame,
  type SceneTrace,
  type SimEvent,
  type SimScenarioInput,
  type SimTrace,
  type TopologyIndex,
} from '@simforge/engine';

import { CliError, EXIT } from '../errors.js';
import { checkInvariants, type InvariantResidualReport } from '../invariants.js';
import { loadMap, type MapBundle } from '@simforge/compiler';
import { materialize } from '../materialize.js';
import { emit } from '../output.js';
import { findSite, matchOnMap } from '@simforge/compiler';
import { detectKind, readInstance, readTemplate, writeJsonFile, writeTraceFile, type InstanceFile } from '@simforge/compiler';
import { runHeadlessSumo, type HeadlessSumoResult } from '../sumo-headless.js';
import { instanceFile } from './instantiate.js';
import { metricsSummary } from './simulate.js';

export interface DebugOptions {
  readonly file: string;
  readonly mapId?: string;
  readonly siteId?: string;
  readonly draw?: number;
  readonly seed?: string;
  readonly provider: 'native' | 'sumo';
  readonly durationSeconds?: number;
  readonly sampleSeconds?: number;
  readonly ambientCount?: number;
  readonly out?: string;
  readonly compare?: string;
  readonly positionToleranceM?: number;
  readonly speedToleranceMps?: number;
  readonly failOnCollision: boolean;
  readonly failOnRoadDeparture: boolean;
  readonly failOnFallback: boolean;
  readonly failOnNeverFired: boolean;
  readonly pretty: boolean;
}

export interface DebugPathSample {
  readonly t: number;
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly accelerationMps2: number;
  readonly laneRsl: string | null;
  readonly roadId: string | null;
  readonly routeS: number;
  readonly present: boolean;
  readonly physics?: Record<string, number>;
}

interface DebugReport {
  readonly schema: 'uniscenarios.scenario-debug.v1';
  readonly input: {
    readonly source: string;
    readonly kind: 'template' | 'instance';
    readonly mapId: string;
    readonly provider: 'native' | 'sumo';
    readonly inputHash: string;
    readonly traceDigest: string;
    readonly durationSeconds: number;
    readonly sampleSeconds: number;
  };
  readonly compile: {
    readonly milliseconds: number;
    readonly feasible: boolean;
    readonly manifest: InstanceManifest | null;
  };
  readonly performance: {
    readonly nativeMilliseconds: number;
    readonly nativeTicksPerSecond: number;
    readonly simulatedSecondsPerWallSecond: number;
    readonly sumo: HeadlessSumoResult['runtime'] | null;
  };
  readonly summary: Record<string, unknown>;
  readonly actors: Record<string, readonly DebugPathSample[]>;
  readonly ambientActors: HeadlessSumoResult['paths'];
  readonly signals: Record<string, readonly { t: number; phase: string }[]>;
  readonly interactions: readonly Record<string, unknown>[];
  readonly diagnostics: Record<string, unknown>;
  readonly metrics: Record<string, unknown>;
  readonly invariants: readonly InvariantResidualReport[];
  readonly comparison: Record<string, unknown> | null;
  readonly acceptance: {
    readonly ok: boolean;
    readonly failures: readonly { code: string; reason: string }[];
  };
}

const MAPLESS_GRAPH = buildLaneGraph({
  schemaVersion: 1,
  mapName: 'mapless-cli-debug',
  source: { xodrSha256: 'mapless' },
  lanes: {},
  gates: [],
  junctions: {},
} satisfies TopologyIndex);

export async function debugScenario(options: DebugOptions): Promise<number> {
  validateOptions(options);
  const resolvedFile = await resolveScenarioFile(options.file);
  const resolvedOptions = { ...options, file: resolvedFile };
  const compileAt = performance.now();
  const compiled = await compileInput(resolvedOptions);
  const compileMilliseconds = performance.now() - compileAt;
  const input = options.durationSeconds === undefined
    ? compiled.instance.input
    : parseSimScenarioInput({ ...compiled.instance.input, clipSeconds: options.durationSeconds });
  const sampleSeconds = options.sampleSeconds ?? input.dt;

  const simulationAt = performance.now();
  const result = runSimulation(input, {
    graph: compiled.bundle?.graph ?? MAPLESS_GRAPH,
    guards: 'collect',
  });
  const nativeMilliseconds = performance.now() - simulationAt;
  const sceneTrace = traceToSceneFrame(result.trace);
  const sampleIndices = sampleIndexes(sceneTrace.ticks.t, sampleSeconds);
  const actors = actorPaths(sceneTrace, sampleIndices);
  const signals = signalPaths(sceneTrace, sampleIndices);

  const sumo = options.provider === 'sumo'
    ? await runHeadlessSumo({
        mapId: input.mapId,
        durationSeconds: input.clipSeconds,
        sampleSeconds: Math.max(0.02, sampleSeconds),
        actorCount: options.ambientCount ?? 32,
        seed: options.seed ?? input.seed,
        authoredTrace: sceneTrace,
      })
    : null;
  const invariants = compiled.template
    ? checkInvariants({
        template: compiled.template,
        trace: result.trace,
        scope: { params: {}, clip: { seconds: input.clipSeconds } },
        arrival: compiled.instance.manifest?.arrival ?? [],
        speedLimitKph: null,
      })
    : [];
  const diagnostics = buildDiagnostics(input, result.trace, result.issues);
  const interactions = buildInteractionReport(input, result.trace.events);
  const comparison = options.compare
    ? await compareReport(options.compare, actors, sumo?.paths ?? {}, options.positionToleranceM ?? 0.001, options.speedToleranceMps ?? 0.001)
    : null;
  const failures = acceptanceFailures({
    options,
    feasible: compiled.instance.manifest?.feasible ?? true,
    result,
    invariants,
    diagnostics,
    comparison,
  });
  const actorSummary = Object.fromEntries(Object.entries(actors).map(([id, samples]) => [id, summarizeActor(samples)]));
  const report: DebugReport = {
    schema: 'uniscenarios.scenario-debug.v1',
    input: {
      source: path.resolve(options.file),
      kind: compiled.kind,
      mapId: input.mapId,
      provider: options.provider,
      inputHash: result.trace.header.inputHash,
      traceDigest: traceDigest(result.trace),
      durationSeconds: input.clipSeconds,
      sampleSeconds,
    },
    compile: {
      milliseconds: round(compileMilliseconds),
      feasible: compiled.instance.manifest?.feasible ?? true,
      manifest: compiled.instance.manifest ?? null,
    },
    performance: {
      nativeMilliseconds: round(nativeMilliseconds),
      nativeTicksPerSecond: round(result.trace.metrics.ticksSimulated / Math.max(0.001, nativeMilliseconds / 1_000)),
      simulatedSecondsPerWallSecond: round(input.clipSeconds / Math.max(0.001, nativeMilliseconds / 1_000)),
      sumo: sumo?.runtime ?? null,
    },
    summary: {
      ok: failures.length === 0,
      actorCount: Object.keys(actors).length,
      ambientActorCount: Object.keys(sumo?.paths ?? {}).length,
      signalCount: Object.keys(signals).length,
      interactionCount: input.interactions.length,
      collisionCount: result.trace.metrics.collisions.length,
      roadDepartureCount: countEvents(result.trace.events, 'road_departure_prevented'),
      neverFiredCount: result.trace.metrics.triggerNeverFired.length,
      actorMotion: actorSummary,
    },
    actors,
    ambientActors: sumo?.paths ?? {},
    signals,
    interactions,
    diagnostics,
    metrics: metricsSummary(result.trace),
    invariants,
    comparison,
    acceptance: { ok: failures.length === 0, failures },
  };

  if (options.out) {
    const out = path.resolve(options.out);
    await Promise.all([
      writeJsonFile(path.join(out, 'report.json'), report),
      writeJsonFile(path.join(out, 'summary.json'), {
        schema: report.schema,
        input: report.input,
        compile: report.compile,
        performance: report.performance,
        summary: report.summary,
        diagnostics: report.diagnostics,
        metrics: report.metrics,
        invariants: report.invariants,
        comparison: report.comparison,
        acceptance: report.acceptance,
      }),
      writeJsonFile(path.join(out, 'paths.json'), {
        schema: report.schema,
        frame: 'scene',
        actors: report.actors,
        ambientActors: report.ambientActors,
        signals: report.signals,
      }),
      writeJsonFile(path.join(out, 'input.json'), input),
      writeJsonFile(path.join(out, 'compiled-instance.json'), compiled.instance),
      writeTraceFile(path.join(out, 'trace.json.gz'), result.trace),
    ]);
    emit({
      ...report.summary,
      schema: report.schema,
      input: report.input,
      performance: report.performance,
      acceptance: report.acceptance,
      out,
      files: ['report.json', 'summary.json', 'paths.json', 'input.json', 'compiled-instance.json', 'trace.json.gz'],
    }, options);
  } else {
    emit(report, options);
  }
  return failures.length === 0 ? EXIT.ok : EXIT.validationFindings;
}

/** Follow a checked-in Studio/gallery descriptor to its concrete instance or template. */
async function resolveScenarioFile(file: string): Promise<string> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return file;
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return file;
  const record = json as Record<string, unknown>;
  if (record['scenarioVersion'] === 2 || record['kind'] === 'scenario-instance' || typeof record['mapId'] === 'string') return file;
  for (const key of ['instance', 'runtimeTemplate', 'template'] as const) {
    const ref = record[key];
    if (typeof ref !== 'string' || ref.length === 0) continue;
    const resolved = path.resolve(path.dirname(file), ref);
    if (existsSync(resolved)) return resolved;
  }
  return file;
}

function validateOptions(options: DebugOptions): void {
  if (options.durationSeconds !== undefined && !(options.durationSeconds > 0)) {
    throw new CliError('bad_value', '--duration must be greater than zero', { path: '--duration' });
  }
  if (options.sampleSeconds !== undefined && (!(options.sampleSeconds > 0) || options.sampleSeconds > 10)) {
    throw new CliError('bad_value', '--sample must be in (0, 10] seconds', { path: '--sample' });
  }
  if (options.ambientCount !== undefined && (!Number.isInteger(options.ambientCount) || options.ambientCount < 0 || options.ambientCount > 128)) {
    throw new CliError('bad_value', '--ambient-count must be an integer from 0 to 128', { path: '--ambient-count' });
  }
}

async function compileInput(options: DebugOptions): Promise<{
  kind: 'template' | 'instance';
  instance: InstanceFile;
  template: ScenarioTemplateV2 | null;
  bundle: MapBundle | null;
}> {
  const kind = await detectKind(options.file);
  if (kind === 'instance') {
    const instance = await readInstance(options.file);
    if (options.mapId && options.mapId !== instance.input.mapId) {
      throw new CliError('map_mismatch', `input uses ${instance.input.mapId}, not ${options.mapId}`, { path: '--map' });
    }
    // Concrete polyline-only simulations have no lane/topology dependency.
    // Keeping this path mapless lets the CLI author and execute basic smoke
    // scenarios on any machine, before large map artifacts are downloaded.
    const bundle = isMapIndependentInstance(instance.input, options.provider)
      ? null
      : await loadMap(instance.input.mapId);
    return { kind, instance, template: null, bundle };
  }
  const template = await readTemplate(options.file);
  const pinnedMap = template.anchor.pin?.mapId;
  const mapId = options.mapId ?? pinnedMap;
  if (!mapId) throw new CliError('missing_option', 'a portable template needs --map', { path: '--map' });
  const bundle = await loadMap(mapId);
  const mapBound = template.roles.length > 0 && template.roles.every((role) => role.kind === 'scene_absolute');
  const product = mapBound
    ? materializeMapBound(template, bundle, materializeOptions(options))
    : await (async () => {
        const matched = options.siteId
          ? await findSite(template, mapId, options.siteId)
          : await firstMatchedSite(template, mapId);
        return materialize(template, matched.bundle, matched.site, materializeOptions(options));
      })();
  return { kind, instance: instanceFile(product), template, bundle };
}

function isMapIndependentInstance(input: SimScenarioInput, provider: DebugOptions['provider']): boolean {
  if (provider !== 'native') return false;
  return input.actors.every((actor) =>
    actor.initial.laneRef === undefined
    && actor.behavior.route.kind === 'polyline')
    && input.interactions.every((interaction) =>
      interaction.verb !== 'route' && interaction.verb !== 'changeLane');
}

function materializeOptions(options: DebugOptions): { drawIndex?: number; seed?: string } {
  return {
    ...(options.draw === undefined ? {} : { drawIndex: options.draw }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  };
}

async function firstMatchedSite(template: ScenarioTemplateV2, mapId: string) {
  const match = await matchOnMap(template, mapId);
  const site = match.report.sites[0];
  if (!site) {
    throw new CliError('no_site', `no executable site matched on ${mapId}`, {
      path: '--map',
      detail: { failureSummary: match.report.failureSummary },
      exitCode: EXIT.validationFindings,
    });
  }
  return { bundle: match.bundle, site };
}

function sampleIndexes(times: readonly number[], everySeconds: number): number[] {
  const indexes: number[] = [];
  let next = 0;
  for (let index = 0; index < times.length; index += 1) {
    if (times[index]! + 1e-9 < next && index !== times.length - 1) continue;
    indexes.push(index);
    next += everySeconds;
  }
  if (indexes.at(-1) !== times.length - 1) indexes.push(times.length - 1);
  return indexes;
}

function actorPaths(trace: SceneTrace, indexes: readonly number[]): Record<string, readonly DebugPathSample[]> {
  return Object.fromEntries(Object.entries(trace.ticks.actors).sort(([a], [b]) => a.localeCompare(b)).map(([id, track]) => {
    const samples = indexes.map((index, ordinal): DebugPathSample => {
      const priorIndex = indexes[Math.max(0, ordinal - 1)]!;
      const elapsed = trace.ticks.t[index]! - trace.ticks.t[priorIndex]!;
      const acceleration = elapsed > 0 ? (track.speedMps[index]! - track.speedMps[priorIndex]!) / elapsed : 0;
      const laneRsl = track.laneRsl[index] ?? null;
      const physics = track.physics
        ? Object.fromEntries(Object.entries(track.physics).map(([key, values]) => [key, round(values[index] ?? 0)]))
        : undefined;
      return {
        t: round(trace.ticks.t[index]!),
        x: round(track.x[index]!),
        z: round(track.z[index]!),
        headingRad: round(track.headingRad[index]!),
        speedMps: round(track.speedMps[index]!),
        accelerationMps2: round(acceleration),
        laneRsl,
        roadId: laneRsl?.split(':')[0] ?? null,
        routeS: round(track.s[index]!),
        present: track.present[index] === 1,
        ...(physics ? { physics } : {}),
      };
    });
    return [id, samples];
  }));
}

function signalPaths(trace: SceneTrace, indexes: readonly number[]): Record<string, readonly { t: number; phase: string }[]> {
  return Object.fromEntries(Object.entries(trace.ticks.signals ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, track]) => [id, indexes.map((index) => ({
    t: round(trace.ticks.t[index]!),
    phase: track.phase[index] ?? 'off',
  }))]));
}

function buildInteractionReport(input: SimScenarioInput, events: readonly SimEvent[]): readonly Record<string, unknown>[] {
  return input.interactions.map((interaction) => ({
    ...interaction,
    events: events.filter((event) =>
      ('interactionId' in event && event.interactionId === interaction.id)
      || ('byInteractionId' in event && event.byInteractionId === interaction.id)
      || ('preemptedInteractionId' in event && event.preemptedInteractionId === interaction.id)),
  }));
}

function buildDiagnostics(input: SimScenarioInput, trace: SimTrace, issues: readonly { severity: string; code: string; reason: string }[]): Record<string, unknown> {
  const actorBackends = trace.header.physics.actorBackends ?? {};
  const roadDepartures = trace.events.filter((event) => event.kind === 'road_departure_prevented');
  const laneChangeRejections = trace.events.filter((event) => event.kind === 'lane_change_rejected');
  const crashes = trace.events.filter((event) => event.kind === 'crash_disabled');
  return {
    issues,
    collisions: trace.metrics.collisions,
    roadDepartures,
    laneChangeRejections,
    crashes,
    neverFired: trace.metrics.triggerNeverFired,
    preemptions: trace.events.filter((event) => event.kind === 'preemption'),
    fallbacks: Object.entries(actorBackends).filter(([, backend]) => backend.mode !== 'dynamic-v1' && backend.mode !== 'fixed-static-v1').map(([actorId, backend]) => ({ actorId, ...backend })),
    routes: Object.fromEntries(input.actors.map((actor) => {
      const track = trace.ticks.actors[actor.id]!;
      return [actor.id, {
        authored: actor.behavior.route,
        initialLane: actor.initial.laneRef?.rsl ?? null,
        observedLanes: [...new Set(track.laneRsl.filter((lane): lane is string => lane !== null))],
        routeDistanceM: round((track.s.at(-1) ?? 0) - (track.s[0] ?? 0)),
        backend: actorBackends[actor.id] ?? null,
      }];
    })),
  };
}

function summarizeActor(samples: readonly DebugPathSample[]): Record<string, unknown> {
  const present = samples.filter((sample) => sample.present);
  const first = present[0];
  const last = present.at(-1);
  return {
    samples: samples.length,
    start: first ? { x: first.x, z: first.z, laneRsl: first.laneRsl } : null,
    end: last ? { x: last.x, z: last.z, laneRsl: last.laneRsl } : null,
    displacementM: first && last ? round(Math.hypot(last.x - first.x, last.z - first.z)) : 0,
    maxSpeedMps: round(Math.max(0, ...present.map((sample) => sample.speedMps))),
    observedLanes: [...new Set(present.map((sample) => sample.laneRsl).filter((lane): lane is string => lane !== null))],
  };
}

async function compareReport(
  file: string,
  actors: Record<string, readonly DebugPathSample[]>,
  ambientActors: HeadlessSumoResult['paths'],
  positionToleranceM: number,
  speedToleranceMps: number,
): Promise<Record<string, unknown>> {
  let prior: DebugReport;
  try {
    prior = JSON.parse(await readFile(file, 'utf8')) as DebugReport;
  } catch (error) {
    throw new CliError('comparison_unreadable', error instanceof Error ? error.message : String(error), { path: file });
  }
  if (prior.schema !== 'uniscenarios.scenario-debug.v1') {
    throw new CliError('comparison_invalid', 'comparison file is not a scenario debug report', { path: file });
  }
  const actorIds = [...new Set([...Object.keys(prior.actors), ...Object.keys(actors)])].sort();
  const actorDiffs = actorIds.map((actorId) => compareSamples(actorId, prior.actors[actorId] ?? [], actors[actorId] ?? []));
  const ambientIds = [...new Set([...Object.keys(prior.ambientActors), ...Object.keys(ambientActors)])].sort();
  const ambientDiffs = ambientIds.map((actorId) => compareSamples(actorId, prior.ambientActors[actorId] ?? [], ambientActors[actorId] ?? []));
  const all = [...actorDiffs, ...ambientDiffs];
  const mismatch = all.some((diff) => diff.sampleCountChanged || diff.maxPositionDeltaM > positionToleranceM || diff.maxSpeedDeltaMps > speedToleranceMps);
  return {
    baseline: path.resolve(file),
    ok: !mismatch,
    tolerances: { positionM: positionToleranceM, speedMps: speedToleranceMps },
    actors: actorDiffs,
    ambientActors: ambientDiffs,
  };
}

function compareSamples(actorId: string, prior: readonly { x: number; z: number; speedMps: number }[], current: readonly { x: number; z: number; speedMps: number }[]) {
  const count = Math.min(prior.length, current.length);
  let maxPositionDeltaM = 0;
  let maxSpeedDeltaMps = 0;
  for (let index = 0; index < count; index += 1) {
    maxPositionDeltaM = Math.max(maxPositionDeltaM, Math.hypot(current[index]!.x - prior[index]!.x, current[index]!.z - prior[index]!.z));
    maxSpeedDeltaMps = Math.max(maxSpeedDeltaMps, Math.abs(current[index]!.speedMps - prior[index]!.speedMps));
  }
  return { actorId, sampleCountChanged: prior.length !== current.length, priorSamples: prior.length, currentSamples: current.length, maxPositionDeltaM: round(maxPositionDeltaM), maxSpeedDeltaMps: round(maxSpeedDeltaMps) };
}

function acceptanceFailures(context: {
  options: DebugOptions;
  feasible: boolean;
  result: ReturnType<typeof runSimulation>;
  invariants: readonly InvariantResidualReport[];
  diagnostics: Record<string, unknown>;
  comparison: Record<string, unknown> | null;
}): { code: string; reason: string }[] {
  const failures: { code: string; reason: string }[] = [];
  if (!context.feasible) failures.push({ code: 'compile_infeasible', reason: 'materialization feasibility checks failed' });
  if (context.result.issues.some((issue) => issue.severity === 'error')) failures.push({ code: 'engine_error', reason: 'the engine reported one or more errors' });
  const violated = context.invariants.filter((invariant) => invariant.essentiality === 'required' && invariant.status === 'violated');
  if (violated.length > 0) failures.push({ code: 'required_invariant_violated', reason: `${violated.length} required invariant(s) failed` });
  if (context.options.failOnCollision && context.result.trace.metrics.collisions.length > 0) failures.push({ code: 'collision', reason: `${context.result.trace.metrics.collisions.length} collision(s) occurred` });
  if (context.options.failOnRoadDeparture && countEvents(context.result.trace.events, 'road_departure_prevented') > 0) failures.push({ code: 'road_departure', reason: 'one or more road departures were prevented' });
  if (context.options.failOnFallback && Array.isArray(context.diagnostics['fallbacks']) && context.diagnostics['fallbacks'].length > 0) failures.push({ code: 'physics_fallback', reason: 'one or more actors used a fallback backend' });
  if (context.options.failOnNeverFired && context.result.trace.metrics.triggerNeverFired.length > 0) failures.push({ code: 'trigger_never_fired', reason: `${context.result.trace.metrics.triggerNeverFired.length} trigger(s) never fired` });
  if (context.comparison && context.comparison['ok'] !== true) failures.push({ code: 'comparison_mismatch', reason: 'the run differs from the comparison report outside tolerance' });
  return failures;
}

function countEvents(events: readonly SimEvent[], kind: SimEvent['kind']): number {
  return events.filter((event) => event.kind === kind).length;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
