import {
  buildRoute,
  toSceneXZ,
  type Interaction,
  type Pose,
  type Route,
  type SimScenarioInput,
} from '@simforge-oss/engine';

import {
  AsamExportError,
  type AsamExportIssue,
  type AsamCapabilityEntry,
  type AsamCapabilityReport,
  type AsamConstructCapabilityEntry,
  type AsamExportOptions,
  type AsamExportProfile,
  type AsamExportWarning,
  type ResolvedAsamScenario,
  type ResolvedInteraction,
} from './types.js';

type CapabilityDecision = Omit<AsamCapabilityEntry, 'path'>;

const decision = (
  disposition: CapabilityDecision['disposition'],
  fidelity: CapabilityDecision['fidelity'],
  reason: string,
): CapabilityDecision => ({ disposition, fidelity, reason });

/**
 * The `satisfies` constraint deliberately makes a new SimScenarioInput field a
 * compile failure until every ASAM profile declares how it is handled.
 */
function capabilityDecisions(profile: AsamExportProfile): Record<keyof SimScenarioInput, CapabilityDecision> {
  const replay = profile === 'xml-1.4-trajectory-replay' || profile === 'xml-1.3-esmini-trajectory-replay';
  const xmlActions = profile === 'xml-1.4-actions' || profile === 'xml-1.3-esmini-actions';
  return {
    schemaVersion: decision('extension', 'metadata-only', 'recorded as SimForge provenance, not an ASAM schema version'),
    mapId: decision('preserved', 'exact', 'represented by the referenced road-network file'),
    clipSeconds: decision('preserved', 'exact', 'represented by the storyboard/scenario duration'),
    warmupSeconds: decision('preserved', 'exact', 'represented by shifting the ASAM clock origin'),
    dt: replay
      ? decision('extension', 'metadata-only', 'recorded as replay sampling provenance; vertices use this sampling interval')
      : decision('omitted', 'none', 'engine integration timestep has no editable ASAM action equivalent'),
    seed: replay
      ? decision('extension', 'metadata-only', 'recorded as replay provenance; stochastic outcomes are baked into the trace')
      : decision('omitted', 'none', 'engine random seed has no portable editable ASAM action equivalent'),
    physics: decision('extension', 'metadata-only', 'motion/physics mode and solver provenance are retained in SimForge Properties; editable ASAM behavior is not claimed to preserve the selected solver'),
    operationalConditions: replay
      ? decision('derived', 'approximate', 'weather, time, visibility and scene friction use standard Environment fields plus exact extension metadata; traffic effects are baked into sampled motion')
      : decision('omitted', 'none', 'this profile does not emit environment/weather/traffic declarations'),
    // Localised surface patches (ice/water/gravel over a bounded region) have no ASAM equivalent:
    // OpenSCENARIO road conditions are scene-wide, so a per-region friction field cannot be expressed
    // without silently promoting it to the whole scene, which would change the scenario.
    surfacePatches: replay
      ? decision('derived', 'approximate', 'reduced-grip regions are baked into sampled motion and retained as exact extension metadata; localized grip is not a standard OpenSCENARIO road condition')
      : decision('omitted', 'none', 'ASAM road conditions are scene-wide; a bounded low-grip region has no portable equivalent and promoting it to the whole scene would alter the scenario'),
    metricSubject: decision('omitted', 'none', 'SimForge metric evaluation is outside the exported execution model'),
    actors: replay
      ? decision('derived', 'approximate', 'identity and geometry are preserved; motion is a sampled simulation trace')
      : decision('preserved', xmlActions ? 'approximate' : 'approximate', 'entities, initial state, route, and supported controller behavior are mapped to standard constructs'),
    interactions: replay
      ? decision('derived', 'approximate', 'outcomes are baked into trajectories; causal triggers and authoring intent are flattened')
      : decision('preserved', 'approximate', 'supported actions and triggers are mapped; unsupported variants reject export'),
    signalPrograms: replay
      ? decision('derived', 'approximate', 'sampled signal-head states are replayed; authored cycle semantics are flattened')
      : xmlActions
        ? decision('preserved', 'approximate', 'mapped to traffic-signal controller phases after profile validation')
        : decision('omitted', 'none', 'the concrete DSL profile has no traffic-light program mapping'),
    roadControls: replay
      ? decision('derived', 'approximate', 'stop/yield responses are baked into sampled actor motion; portable lane-control declarations are flattened')
      : decision('omitted', 'none', 'road-control declarations are not emitted by the current actions profiles'),
    props: decision('omitted', 'none', 'render-catalog props are not emitted by the current profiles'),
    occluders: decision('preserved', 'approximate', 'exported as stationary bounding-box objects without catalog appearance'),
    occlusionPairs: decision('omitted', 'none', 'line-of-sight evaluation pairs are not an ASAM execution concept'),
    nearMissCriteria: decision('extension', 'metadata-only', 'executable triggers/trajectories are standard; exact OBB-clearance acceptance is retained in SimForge Properties'),
    // OpenSCENARIO can state fog visual range, precipitation and sun position,
    // but it has no portable notion of *whether a sensor reported an actor*.
    // Replaying a trace bakes the late reaction into the trajectory; the reason
    // for it does not survive, so the declaration is retained as provenance
    // rather than claimed as executable behaviour.
    perception: replay
      ? decision('derived', 'approximate', 'sensor-driven reactions are baked into the sampled trajectories; the detection channel and its causes are retained only as SimForge provenance')
      : decision('extension', 'metadata-only', 'sensor mounts, detection thresholds and declared map/percept divergence are retained in SimForge Properties; ASAM has no portable sensor-detection execution model'),
  } satisfies Record<keyof SimScenarioInput, CapabilityDecision>;
}

function fieldHasMaterialValue(input: SimScenarioInput, path: keyof SimScenarioInput): boolean {
  switch (path) {
    case 'physics': return input.physics !== undefined;
    case 'metricSubject': return input.metricSubject !== undefined;
    case 'interactions': return input.interactions.length > 0;
    case 'signalPrograms': return input.signalPrograms.length > 0;
    case 'roadControls': return input.roadControls.length > 0;
    case 'props': return input.props.length > 0;
    case 'occluders': return input.occluders.length > 0;
    case 'occlusionPairs': return input.occlusionPairs.length > 0;
    case 'nearMissCriteria': return (input.nearMissCriteria?.length ?? 0) > 0;
    case 'perception': return input.perception !== undefined;
    default: return true;
  }
}

function constructCapabilities(
  input: SimScenarioInput,
  profile: AsamExportProfile,
): AsamConstructCapabilityEntry[] {
  const replay = profile === 'xml-1.4-trajectory-replay' || profile === 'xml-1.3-esmini-trajectory-replay';
  const xml = profile.startsWith('xml-');
  const constructs: AsamConstructCapabilityEntry[] = [];

  for (const [index, actor] of input.actors.entries()) {
    constructs.push({
      sourcePath: `actors.${index}`,
      sourceId: actor.id,
      kind: 'actor',
      disposition: replay ? 'derived' : 'preserved',
      fidelity: replay ? 'approximate' : 'approximate',
      representation: replay ? 'standard-trajectory' : 'standard-entity',
      reason: replay
        ? 'exact actor identity and sampled signed motion are emitted; controller intent is replaced by the authoritative simulation outcome'
        : 'identity, dimensions, initial state and supported controller semantics are emitted as standard OpenSCENARIO constructs',
    });
  }
  for (const [index, interaction] of input.interactions.entries()) {
    constructs.push({
      sourcePath: `interactions.${index}`,
      sourceId: interaction.id,
      kind: 'interaction',
      disposition: replay ? 'derived' : 'preserved',
      fidelity: 'approximate',
      representation: replay ? 'simulated-outcome' : 'profile-action',
      reason: replay
        ? 'the interaction id, actor, verb and exact trace events are retained while its physical result is represented by sampled trajectories'
        : 'the supported action and trigger are lowered to the selected editable profile',
    });
  }
  for (const [index, program] of input.signalPrograms.entries()) {
    constructs.push({
      sourcePath: `signalPrograms.${index}`,
      sourceId: program.id,
      kind: 'signal-program',
      disposition: replay ? 'derived' : 'preserved',
      fidelity: replay ? 'approximate' : 'approximate',
      representation: replay ? 'standard-signal-state' : 'profile-signal-controller',
      reason: replay
        ? 'exact logical indications and physical-head state transitions are retained; authored cycle causality is flattened'
        : 'the authored cycle is represented by standard traffic-signal controller phases after validation',
    });
  }

  constructs.push({
    sourcePath: 'operationalConditions',
    kind: 'environment',
    disposition: replay && xml ? 'derived' : 'extension',
    fidelity: replay && xml ? 'approximate' : 'metadata-only',
    representation: replay && xml ? 'standard-environment' : 'simforge-property',
    reason: replay && xml
      ? 'weather, time of day, visibility and scene friction are emitted as standard Environment fields and exact SimForge metadata; traffic density effects remain baked into motion'
      : 'environment intent is retained only as SimForge metadata in this profile',
  });
  for (const [index, patch] of input.surfacePatches.entries()) {
    constructs.push({
      sourcePath: `surfacePatches.${index}`,
      sourceId: patch.id,
      kind: 'surface-patch',
      disposition: replay ? 'derived' : 'extension',
      fidelity: replay ? 'approximate' : 'metadata-only',
      representation: replay ? 'simulated-outcome' : 'simforge-property',
      reason: replay
        ? 'localized grip effects are baked into sampled motion and the exact authored patch is retained as metadata because OpenSCENARIO has only scene-wide road friction'
        : 'the exact authored patch is metadata-only because OpenSCENARIO has no localized road-friction field',
    });
  }
  for (const [index, occluder] of input.occluders.entries()) {
    constructs.push({
      sourcePath: `occluders.${index}`,
      sourceId: occluder.id,
      kind: 'occluder',
      disposition: 'preserved',
      fidelity: 'approximate',
      representation: 'standard-entity',
      reason: 'identity, pose and collision dimensions are emitted; catalog appearance is not portable',
    });
  }
  if (input.perception) {
    constructs.push({
      sourcePath: 'perception',
      kind: 'perception',
      disposition: replay ? 'derived' : 'extension',
      fidelity: replay ? 'approximate' : 'metadata-only',
      representation: replay ? 'simulated-outcome' : 'simforge-property',
      reason: replay
        ? 'perception-driven reactions are baked into trajectories and the authored configuration is retained as exact metadata'
        : 'OpenSCENARIO has no portable sensor-detection execution model; the authored configuration is retained as metadata',
    });
  }
  constructs.push({
    sourcePath: 'physics',
    kind: 'physics',
    disposition: 'extension',
    fidelity: 'metadata-only',
    representation: 'simforge-property',
    reason: 'the selected SimForge solver and resolved backend provenance are retained without claiming equivalent external-simulator physics',
  });
  return constructs;
}

export function analyzeAsamCapabilities(
  input: SimScenarioInput,
  profile: AsamExportProfile,
): { report: AsamCapabilityReport; warnings: AsamExportWarning[] } {
  const decisions = capabilityDecisions(profile);
  const fields = (Object.keys(decisions) as Array<keyof SimScenarioInput>).map((path) => ({
    path,
    ...decisions[path],
  }));
  const summary: Record<AsamCapabilityEntry['disposition'], number> = {
    preserved: 0,
    derived: 0,
    extension: 0,
    omitted: 0,
  };
  for (const field of fields) summary[field.disposition] += 1;
  const replay = profile === 'xml-1.4-trajectory-replay' || profile === 'xml-1.3-esmini-trajectory-replay';
  const intent = replay ? 'trajectory-replay' : 'editable-semantic';
  const constructs = constructCapabilities(input, profile);
  const warnings = fields.flatMap((field): AsamExportWarning[] => {
    if (!fieldHasMaterialValue(input, field.path)) return [];
    if (field.disposition === 'omitted') {
      return [{ code: 'field_omitted', path: field.path, reason: field.reason }];
    }
    if (field.disposition === 'derived') {
      return [{ code: 'semantic_intent_flattened', path: field.path, reason: field.reason }];
    }
    return [];
  });
  if (!replay) {
    for (const [index, actor] of input.actors.entries()) {
      if (actor.initial.laneRef) {
        warnings.push({
          code: 'lane_reference_flattened',
          path: `actors.${index}.initial.laneRef`,
          reason: 'the resolved world pose/route is exported, but the engine lane reference is not editable in this ASAM profile',
        });
      }
      if (profile === 'dsl-2.2-actions' && actor.tags.length > 0) {
        warnings.push({
          code: 'actor_tags_omitted',
          path: `actors.${index}.tags`,
          reason: 'free-form SimForge actor tags have no field in the concrete DSL entity declaration profile',
        });
      }
    }
  }
  for (const [index, actor] of input.actors.entries()) {
    const catalog = actor.tags.find((tag) => tag.startsWith('catalog:'));
    if (catalog) {
      warnings.push({
        code: 'catalog_appearance_approximate',
        path: `actors.${index}.tags`,
        reason: `${catalog.slice('catalog:'.length)} is exported with semantic class and dimensions, but its procedural Studio appearance is not portable OpenSCENARIO catalog geometry`,
      });
    }
  }
  for (const interaction of input.interactions) {
    if (interaction.verb !== 'set') continue;
    if (interaction.target.key === 'lights.emergency' || interaction.target.key === 'audio.horn') {
      warnings.push({
        code: 'nonportable_emergency_cue',
        path: `interactions.${interaction.id}.target.key`,
        reason: `${interaction.target.key} is retained as a user-defined XML appearance cue where supported; external simulators are not required to render light, siren, or horn output`,
      });
    }
  }
  return {
    report: {
      profile,
      intent,
      roundTrip: 'not-supported',
      fields,
      constructs,
      summary,
      externalSimulatorValidation: 'not-verified',
    },
    warnings,
  };
}

export function mergeAsamWarnings(...groups: ReadonlyArray<readonly AsamExportWarning[]>): AsamExportWarning[] {
  const seen = new Set<string>();
  return groups.flatMap((group) => group.filter((warning) => {
    const key = `${warning.code}\0${warning.path}\0${warning.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

const DSL_KEYWORDS = new Set([
  'action', 'actor', 'and', 'as', 'bool', 'call', 'cover', 'default', 'def', 'do',
  'else', 'emit', 'enum', 'event', 'extend', 'false', 'float', 'hard', 'if', 'import',
  'in', 'inherits', 'int', 'is', 'it', 'keep', 'list', 'modifier', 'not', 'of', 'on',
  'one_of', 'or', 'parallel', 'range', 'record', 'remove_default', 'scenario', 'serial',
  'string', 'struct', 'true', 'uint', 'until', 'var', 'wait', 'with',
]);

export function identifier(prefix: string, raw: string): string {
  let stem = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!stem || /^[0-9]/.test(stem) || DSL_KEYWORDS.has(stem)) stem = `id_${stem || 'unnamed'}`;
  return `${prefix}_${stem}`;
}

export function finite(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`cannot serialize non-finite number ${value}`);
  if (Object.is(value, -0)) return '0';
  const rounded = Math.round(value * 1e9) / 1e9;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function mapRule(cmp: 'lte' | 'gte'): 'lessOrEqual' | 'greaterOrEqual' {
  return cmp === 'lte' ? 'lessOrEqual' : 'greaterOrEqual';
}

function dynamicsDuration(interaction: Interaction): number | null {
  if (!('dynamics' in interaction)) return 0;
  if (interaction.dynamics.shape === 'step') return 0;
  return interaction.dynamics.constraint === 'time' ? interaction.dynamics.value : null;
}

/** Resolve `at`/`after` triggers to absolute time for the DSL profile. */
export function resolveStaticStartTimes(
  interactions: readonly Interaction[],
  timelineOffsetS = 0,
): { times: Map<string, number>; issues: AsamExportIssue[] } {
  const byId = new Map(interactions.map((interaction) => [interaction.id, interaction]));
  const times = new Map<string, number>();
  const visiting = new Set<string>();
  const issues: AsamExportIssue[] = [];

  const visit = (interaction: Interaction): number | null => {
    const cached = times.get(interaction.id);
    if (cached !== undefined) return cached;
    const path = `interactions.${interaction.id}.trigger`;
    if (visiting.has(interaction.id)) {
      issues.push({ code: 'trigger_cycle', path, reason: 'after() dependency cycle is not exportable' });
      return null;
    }
    visiting.add(interaction.id);
    let value: number | null = null;
    if (interaction.trigger.kind === 'at') {
      value = timelineOffsetS + Math.max(0, interaction.trigger.t);
    } else if (interaction.trigger.kind === 'after') {
      const parent = byId.get(interaction.trigger.interactionId);
      if (!parent) {
        issues.push({ code: 'unknown_interaction', path, reason: `unknown interaction ${interaction.trigger.interactionId}` });
      } else {
        const parentStart = visit(parent);
        const duration = dynamicsDuration(parent);
        if (duration === null) {
          issues.push({
            code: 'non_static_after',
            path,
            reason: `after(${parent.id}) depends on a ${parent.verb} action whose duration is constrained by ${'dynamics' in parent ? parent.dynamics.constraint : 'runtime state'}`,
          });
        } else if (parentStart !== null) {
          value = parentStart + duration + interaction.trigger.delayS;
        }
      }
    } else {
      issues.push({
        code: 'unsupported_trigger',
        path,
        reason: `${interaction.trigger.kind} triggers are not in the concrete DSL 2.2 export profile`,
      });
    }
    visiting.delete(interaction.id);
    if (value !== null) times.set(interaction.id, value);
    return value;
  };

  for (const interaction of interactions) visit(interaction);
  return { times, issues };
}

function sampledRoutePoses(
  input: SimScenarioInput,
  actorIndex: number,
  options: AsamExportOptions,
): { route: Route; points: Pose[] } | AsamExportIssue {
  const actor = input.actors[actorIndex]!;
  const built = buildRoute(options.graph, actor.behavior.route);
  if (!built.ok) {
    return {
      code: built.error.code,
      path: `actors.${actorIndex}.behavior.route`,
      reason: built.error.reason,
    };
  }
  if (built.route.lengthM <= 1e-6) {
    return {
      code: 'route_too_short',
      path: `actors.${actorIndex}.behavior.route`,
      reason: 'ASAM routes require at least two distinct world positions',
    };
  }
  const step = options.routeSampleM ?? 20;
  if (!Number.isFinite(step) || step <= 0) {
    return { code: 'bad_route_sample', path: 'routeSampleM', reason: 'route sample distance must be positive' };
  }
  const count = Math.max(2, Math.ceil(built.route.lengthM / step) + 1);
  const points: Pose[] = [];
  for (let i = 0; i < count; i += 1) {
    const pose = built.route.poseAt((built.route.lengthM * i) / (count - 1));
    const scene = toSceneXZ(pose.point);
    points.push({ x: scene.x, z: scene.z, headingRad: pose.headingRad });
  }
  return { route: built.route, points };
}

export function resolveScenario(
  input: SimScenarioInput,
  options: AsamExportOptions,
  includeStaticTimes: boolean,
): ResolvedAsamScenario {
  const issues: AsamExportIssue[] = [];
  const warnings: AsamExportWarning[] = [];
  const actorNames = new Map<string, string>();
  const interactionNames = new Map<string, string>();
  const allNames = new Set<string>();

  for (const [i, actor] of input.actors.entries()) {
    const name = identifier('actor', actor.id);
    if (allNames.has(name)) {
      issues.push({ code: 'identifier_collision', path: `actors.${i}.id`, reason: `${actor.id} normalizes to duplicate ${name}` });
    }
    allNames.add(name);
    actorNames.set(actor.id, name);
  }
  for (const [i, interaction] of input.interactions.entries()) {
    const name = identifier('event', interaction.id);
    if (allNames.has(name)) {
      issues.push({ code: 'identifier_collision', path: `interactions.${i}.id`, reason: `${interaction.id} normalizes to duplicate ${name}` });
    }
    allNames.add(name);
    interactionNames.set(interaction.id, name);
  }

  const actors = input.actors.flatMap((actor, i) => {
    const resolved = sampledRoutePoses(input, i, options);
    if ('code' in resolved) {
      issues.push(resolved);
      return [];
    }
    return [{
      actor,
      name: actorNames.get(actor.id)!,
      routeName: identifier('route', actor.id),
      route: resolved.route,
      points: resolved.points,
    }];
  });

  let staticTimes = new Map<string, number>();
  if (includeStaticTimes) {
    // ASAM execution begins at SimForge' unrecorded warm-up origin. This
    // preserves pre-roll actions and makes the recorded t=0 occur at
    // ASAM t=warmupSeconds instead of silently dropping the warm-up.
    const resolved = resolveStaticStartTimes(input.interactions, input.warmupSeconds);
    staticTimes = resolved.times;
    issues.push(...resolved.issues);
  }
  const interactions: ResolvedInteraction[] = input.interactions.map((interaction) => ({
    interaction,
    name: interactionNames.get(interaction.id)!,
    ...(staticTimes.has(interaction.id) ? { startTimeS: staticTimes.get(interaction.id)! } : {}),
  }));

  if (issues.length > 0) throw new AsamExportError(issues);
  return { input, actors, interactions, actorNames, interactionNames, warnings };
}

export function assertDefaultControllerRules(
  input: SimScenarioInput,
  allowCollisionAvoidance: boolean,
): void {
  const issues: AsamExportIssue[] = [];
  for (const [i, actor] of input.actors.entries()) {
    const rules = actor.behavior.rules;
    const changed: string[] = [];
    if (!rules.obeySignals) changed.push('obeySignals');
    if (!rules.yield) changed.push('yield');
    if (!rules.yieldToVehicles) changed.push('yieldToVehicles');
    if (!rules.yieldToPedestrians) changed.push('yieldToPedestrians');
    if (rules.aggression !== 0.5) changed.push('aggression');
    if (rules.speedFactor !== 1) changed.push('speedFactor');
    if (!allowCollisionAvoidance && !rules.collisionAvoidance) changed.push('collisionAvoidance');
    if (changed.length > 0) {
      issues.push({
        code: 'unsupported_controller_rules',
        path: `actors.${i}.behavior.rules`,
        reason: `no standard behavior preserves non-default ${changed.join(', ')}`,
      });
    }
    if (
      actor.behavior.cruiseSpeedMps !== undefined &&
      Math.abs(actor.behavior.cruiseSpeedMps - actor.initial.speedMps) > 1e-9
    ) {
      issues.push({
        code: 'unsupported_cruise_controller',
        path: `actors.${i}.behavior.cruiseSpeedMps`,
        reason: 'a cruise target different from initial speed needs an implementation-specific controller',
      });
    }
  }
  if (issues.length > 0) throw new AsamExportError(issues);
}
