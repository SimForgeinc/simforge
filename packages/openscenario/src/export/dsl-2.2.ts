import { actorPhysicsBackends, DYNAMIC_V1_DEFAULT_SUBSTEP_S, resolvePhysicsConfig, type Interaction, type Pose, type SimActor, type SimScenarioInput } from '@simforge/engine';

import {
  analyzeAsamCapabilities,
  assertDefaultControllerRules,
  finite,
  identifier,
  mergeAsamWarnings,
  resolveScenario,
} from './common.js';
import {
  AsamExportError,
  type AsamExportIssue,
  type AsamExportOptions,
  type AsamExportResult,
  type ResolvedAsamScenario,
  type ResolvedInteraction,
} from './types.js';
import { assertOpenScenarioDsl22ProfileSyntax } from './dsl-2.2-syntax.js';

function indent(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function poseName(pathName: string, index: number): string {
  return `${pathName}_pose_${index}`;
}

function poseDeclaration(name: string, value: Pose): string {
  return [
    `${name}: pose_3d with:`,
    `    keep(it.position.x == ${finite(value.x)}m)`,
    `    keep(it.position.y == ${finite(-value.z)}m)`,
    '    keep(it.position.z == 0m)',
    '    keep(it.orientation.roll == 0rad)',
    '    keep(it.orientation.pitch == 0rad)',
    `    keep(it.orientation.yaw == ${finite(value.headingRad)}rad)`,
  ].join('\n');
}

function actorDeclaration(actor: SimActor, name: string): string {
  const type = actor.kind === 'pedestrian' ? 'person'
    : actor.kind === 'animal' ? 'animal'
      : actor.kind === 'static_object' ? 'stationary_object'
        : 'vehicle';
  const vehicleCategoryByKind: Partial<Record<SimActor['kind'], string>> = {
    vehicle: 'other',
    car: 'car',
    truck: 'heavy_truck',
    bus: 'bus',
    van: 'van',
    motorcycle: 'motorcycle',
    bicycle: 'bicycle',
    scooter: 'stand_up_scooter',
  };
  const vehicleCategory = vehicleCategoryByKind[actor.kind];
  const lines = [
    `${name}: ${type} with:`,
    ...(vehicleCategory ? [`    keep(it.vehicle_category == ${vehicleCategory})`] : []),
    '    keep(it.bounding_box.center.x == 0m)',
    '    keep(it.bounding_box.center.y == 0m)',
    `    keep(it.bounding_box.center.z == ${finite(actor.dims.h / 2)}m)`,
    `    keep(it.bounding_box.length == ${finite(actor.dims.l)}m)`,
    `    keep(it.bounding_box.width == ${finite(actor.dims.w)}m)`,
    `    keep(it.bounding_box.height == ${finite(actor.dims.h)}m)`,
    '    keep(it.center_of_gravity.x == 0m)',
    '    keep(it.center_of_gravity.y == 0m)',
    `    keep(it.center_of_gravity.z == ${finite(actor.dims.h / 2)}m)`,
    ...(actor.kind === 'static_object' ? [] : [
      `    keep(it.intended_infrastructure == [${actor.kind === 'pedestrian' || actor.kind === 'animal' ? 'sidewalk' : actor.kind === 'bicycle' || actor.kind === 'scooter' ? 'biking' : actor.kind === 'bus' ? 'bus' : 'driving'}])`,
    ]),
  ];
  return lines.join('\n');
}

function pathDeclaration(name: string, points: readonly Pose[]): string {
  return [
    ...points.flatMap((point, index) => [poseDeclaration(poseName(name, index), point), '']),
    `${name}: path = map_ref.create_path(points: [${points.map((_, index) => poseName(name, index)).join(', ')}], interpolation: straight_line)`,
  ].join('\n');
}

function occluderDeclaration(input: SimScenarioInput, index: number): string {
  const o = input.occluders[index]!;
  const name = identifier('occluder', o.id);
  const poseName = identifier('occluder_pose', o.id);
  return [
    `${name}: stationary_object with:`,
    '    keep(it.bounding_box.center.x == 0m)',
    '    keep(it.bounding_box.center.y == 0m)',
    `    keep(it.bounding_box.center.z == ${finite(o.obb.heightM / 2)}m)`,
    `    keep(it.bounding_box.length == ${finite(o.obb.lengthM)}m)`,
    `    keep(it.bounding_box.width == ${finite(o.obb.widthM)}m)`,
    `    keep(it.bounding_box.height == ${finite(o.obb.heightM)}m)`,
    '    keep(it.center_of_gravity.x == 0m)',
    '    keep(it.center_of_gravity.y == 0m)',
    `    keep(it.center_of_gravity.z == ${finite(o.obb.heightM / 2)}m)`,
    poseDeclaration(poseName, { x: o.obb.center.x, z: o.obb.center.z, headingRad: o.obb.headingRad }),
    `${name}.location(pose: ${poseName})`,
  ].join('\n');
}

function initialActorBranch(actor: SimActor, name: string, routeName: string, clipSeconds: number): string {
  const motion = [
    `${name}.follow_path(absolute: ${routeName}, duration: ${finite(clipSeconds)}s)${actor.behavior.rules.collisionAvoidance ? '' : ' with:'}`,
    ...(actor.behavior.rules.collisionAvoidance ? [] : ['    avoid_collisions(avoid: false)']),
  ].join('\n');
  return [
    'serial:',
    `    ${name}.assign_position(position: ${poseName(routeName, 0)}.position)`,
    `    ${name}.assign_orientation(orientation: ${poseName(routeName, 0)}.orientation)`,
    `    ${name}.assign_speed(speed: ${finite(actor.initial.speedMps)}mps)`,
    indent(motion, 4),
  ].join('\n');
}

function targetSpeed(
  interaction: Extract<Interaction, { verb: 'speed' }>,
  current: number | undefined,
): number | AsamExportIssue {
  switch (interaction.target.mode) {
    case 'absolute': return interaction.target.value;
    case 'stop': return 0;
    case 'delta':
      return current === undefined
        ? { code: 'unknown_prior_speed', path: `interactions.${interaction.id}.target`, reason: 'delta speed needs a statically known prior speed' }
        : Math.max(0, current + interaction.target.value);
    case 'factor':
      return current === undefined
        ? { code: 'unknown_prior_speed', path: `interactions.${interaction.id}.target`, reason: 'factor speed needs a statically known prior speed' }
        : current * interaction.target.value;
    case 'match':
      return { code: 'unsupported_relative_speed', path: `interactions.${interaction.id}.target`, reason: 'DSL same_as speed is a persistent constraint, not the engine’s instantaneous match target' };
  }
}

function speedAction(
  interaction: Extract<Interaction, { verb: 'speed' }>,
  actorName: string,
  current: number | undefined,
): { text: string; target: number } | AsamExportIssue {
  const target = targetSpeed(interaction, current);
  if (typeof target !== 'number') return target;
  const dynamics = interaction.dynamics;
  if (dynamics.shape === 'step' || current === target) {
    return { text: `${actorName}.assign_speed(speed: ${finite(target)}mps)`, target };
  }
  if (dynamics.shape !== 'linear') {
    return {
      code: 'unsupported_dynamics_shape',
      path: `interactions.${interaction.id}.dynamics.shape`,
      reason: `DSL 2.2 dynamic_profile cannot distinguish the engine's ${dynamics.shape} interpolation exactly`,
    };
  }
  if (current === undefined) {
    return { code: 'unknown_prior_speed', path: `interactions.${interaction.id}`, reason: 'linear transition needs a statically known prior speed' };
  }
  let rate: number;
  if (dynamics.constraint === 'rate') {
    rate = dynamics.value;
  } else if (dynamics.constraint === 'time') {
    rate = Math.abs(target - current) / dynamics.value;
  } else {
    rate = Math.abs(target * target - current * current) / (2 * dynamics.value);
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    return { code: 'invalid_speed_transition', path: `interactions.${interaction.id}.dynamics`, reason: 'transition does not imply a positive acceleration magnitude' };
  }
  return {
    text: `${actorName}.change_speed(target: ${finite(target)}mps, rate_profile: constant, rate_peak: ${finite(rate)}mpss)`,
    target,
  };
}

function interactionAction(
  resolved: ResolvedAsamScenario,
  entry: ResolvedInteraction,
  currentSpeed: number | undefined,
): { text: string; speed?: number } | AsamExportIssue {
  const interaction = entry.interaction;
  const actorName = resolved.actorNames.get(interaction.actorId)!;
  switch (interaction.verb) {
    case 'speed': {
      const action = speedAction(interaction, actorName, currentSpeed);
      return 'code' in action ? action : { text: action.text, speed: action.target };
    }
    case 'changeLane':
      if (interaction.target.mode !== 'left' && interaction.target.mode !== 'right') {
        return { code: 'unsupported_lane_target', path: `interactions.${interaction.id}.target`, reason: `${interaction.target.mode} is not a portable DSL relative lane target` };
      }
      if (interaction.dynamics.constraint !== 'time') {
        return { code: 'unsupported_lane_dynamics', path: `interactions.${interaction.id}.dynamics`, reason: 'DSL change_lane cannot preserve an engine rate/distance completion constraint without lane geometry state' };
      }
      return {
        text: `${actorName}.change_lane(num_of_lanes: ${interaction.target.count}, side: ${interaction.target.mode}, duration: ${finite(interaction.dynamics.value)}s)`,
      };
    case 'gap':
      if (interaction.dynamics.constraint !== 'time') {
        return { code: 'unsupported_gap_dynamics', path: `interactions.${interaction.id}.dynamics`, reason: 'DSL gap action only has an exact mapping for time-constrained transitions' };
      }
      return {
        text: `${actorName}.${interaction.mode === 'distance' ? 'change_space_gap' : 'change_time_gap'}(target: ${finite(interaction.value)}${interaction.mode === 'distance' ? 'm' : 's'}, direction: behind, reference: ${resolved.actorNames.get(interaction.target.actorId)!}, duration: ${finite(interaction.dynamics.value)}s)`,
      };
    case 'laneOffset':
      if (interaction.target.mode !== 'meters' || interaction.dynamics.constraint !== 'time') {
        return { code: 'unsupported_lane_offset', path: `interactions.${interaction.id}`, reason: 'DSL lateral() only exactly maps metre offsets with a time completion constraint' };
      }
      return {
        text: `${actorName}.move(duration: ${finite(interaction.dynamics.value)}s) with:\n    lateral(distance: ${finite(interaction.target.value)}m, at: end)`,
      };
    case 'route':
      return { code: 'unsupported_dynamic_route', path: `interactions.${interaction.id}`, reason: 'DSL follow_path is an ongoing behavior; replacing an active engine route needs explicit arbitration semantics' };
    case 'exist':
      return { code: 'unsupported_entity_lifecycle', path: `interactions.${interaction.id}`, reason: 'DSL 2.2 has no standard add/delete entity action equivalent' };
    case 'set':
      return { code: 'unsupported_set_action', path: `interactions.${interaction.id}`, reason: `${interaction.target.key} has no exact DSL 2.2 assignment/action mapping in the concrete profile` };
  }
}

function validateDslProfile(input: SimScenarioInput): void {
  const issues: AsamExportIssue[] = [];
  for (const [i, actor] of input.actors.entries()) {
    if (!actor.presentAtStart) {
      issues.push({ code: 'unsupported_entity_lifecycle', path: `actors.${i}.presentAtStart`, reason: 'DSL 2.2 has no standard dynamic spawn action' });
    }
    if (actor.tags.includes('motion:reverse')) {
      issues.push({
        code: 'unsupported_reverse_motion',
        path: `actors.${i}.tags`,
        reason: 'DSL follow_path does not define the engine reverse-driving controller semantics; use XML trajectory replay',
      });
    }
    if (actor.static && actor.initial.speedMps > 1e-9) {
      issues.push({
        code: 'invalid_static_actor_speed',
        path: `actors.${i}.initial.speedMps`,
        reason: 'a stationary_object cannot preserve a non-zero initial speed',
      });
    }
  }
  for (const [i, interaction] of input.interactions.entries()) {
    if (interaction.until) {
      issues.push({ code: 'unsupported_until', path: `interactions.${i}.until`, reason: 'the concrete DSL profile schedules actions explicitly and cannot preserve this condition exactly' });
    }
    const actor = input.actors.find((candidate) => candidate.id === interaction.actorId);
    if (actor?.static && interaction.verb !== 'exist') {
      issues.push({
        code: 'unsupported_static_actor_action',
        path: `interactions.${i}`,
        reason: `${interaction.verb} cannot be applied to a DSL stationary_object without substituting movable-object semantics`,
      });
    }
  }
  if (input.signalPrograms.length > 0) {
    issues.push({
      code: 'unsupported_signal_program',
      path: 'signalPrograms',
      reason: 'the concrete DSL profile has no standard traffic-light cycle action; controllerHeadGroups provenance is not an executable substitute',
    });
  }
  if (issues.length > 0) throw new AsamExportError(issues);
}

export function exportOpenScenarioDsl22(
  input: SimScenarioInput,
  options: AsamExportOptions,
): AsamExportResult {
  const capabilities = analyzeAsamCapabilities(input, 'dsl-2.2-actions');
  assertDefaultControllerRules(input, true);
  validateDslProfile(input);
  const resolved = resolveScenario(input, options, true);
  const issues: AsamExportIssue[] = [];

  const speedByActor = new Map(input.actors.map((actor) => [actor.id, actor.initial.speedMps]));
  const interactionBranches: Array<{ time: number; id: string; text: string }> = [];
  for (const entry of [...resolved.interactions].sort(
    (a, b) => (a.startTimeS ?? 0) - (b.startTimeS ?? 0) || a.interaction.id.localeCompare(b.interaction.id),
  )) {
    const action = interactionAction(resolved, entry, speedByActor.get(entry.interaction.actorId));
    if ('code' in action) {
      issues.push(action);
      continue;
    }
    if (action.speed !== undefined) speedByActor.set(entry.interaction.actorId, action.speed);
    interactionBranches.push({ time: entry.startTimeS!, id: entry.interaction.id, text: action.text });
  }
  if (issues.length > 0) throw new AsamExportError(issues);

  const physics = resolvePhysicsConfig(input);
  const inputActorBackends = actorPhysicsBackends(input.actors, physics);
  const content = [
    '# ASAM OpenSCENARIO DSL 2.2.0',
    '# Generated from a concrete SimForge scenario instance.',
    '# uniscenarios.export.profile=dsl-2.2-actions',
    '# uniscenarios.export.intent=editable-semantic',
    `# uniscenarios.input.schemaVersion=${input.schemaVersion}`,
    `# uniscenarios.physics.mode=${physics.mode}`,
    `# uniscenarios.physics.substepS=${physics.substepS ?? (physics.mode === 'dynamic-v1' ? DYNAMIC_V1_DEFAULT_SUBSTEP_S : input.dt)}`,
    `# uniscenarios.physics.actorBackends=${Object.entries(inputActorBackends).sort(([a], [b]) => a.localeCompare(b)).map(([actorId, backend]) => `${actorId}:${backend.mode}:${backend.reason}:${backend.profile}`).join(',')}`,
    ...Object.entries(options.provenance ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, value]) => `# uniscenarios.provenance.${key}=${String(value).replace(/[\r\n]/g, ' ')}`,
    ),
    'import osc.standard',
    '',
    'scenario uniscenarios_instance:',
    `    map_ref: map with:`,
    `        keep(it.map_file == "${(options.roadFile ?? `${input.mapId}.xodr`).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`,
    '',
    ...resolved.actors.flatMap(({ actor, name }) => [indent(actorDeclaration(actor, name), 4), '']),
    ...resolved.actors.flatMap(({ actor, name, routeName, points }) => actor.static
      ? [indent([
          poseDeclaration(identifier('initial_pose', actor.id), actor.initial.pose),
          `${name}.location(pose: ${identifier('initial_pose', actor.id)})`,
        ].join('\n'), 4), '']
      : [indent(pathDeclaration(routeName, points), 4), '']),
    ...input.occluders.flatMap((_, i) => [indent(occluderDeclaration(input, i), 4), '']),
    `    do parallel(duration: ${finite(input.warmupSeconds + input.clipSeconds)}s):`,
    ...resolved.actors.flatMap(({ actor, name, routeName }) => actor.static
      ? []
      : [indent(initialActorBranch(actor, name, routeName, input.warmupSeconds + input.clipSeconds), 8)]),
    ...interactionBranches.map((branch) => indent([
      `serial: # ${branch.id}`,
      ...(branch.time > 0 ? [`    wait elapsed(${finite(branch.time)}s)`] : []),
      indent(branch.text, 4),
    ].join('\n'), 8)),
    '',
  ].join('\n');

  // This is a deterministic parser for the concrete grammar profile emitted
  // above. Keeping it on the production path prevents a syntactically invalid
  // artifact from escaping merely because an optional external compiler is
  // unavailable.
  assertOpenScenarioDsl22ProfileSyntax(content);

  return {
    format: 'osc-2.2',
    standard: 'ASAM OpenSCENARIO DSL 2.2.0',
    extension: '.osc',
    mediaType: 'text/plain',
    content,
    profile: capabilities.report.profile,
    intent: capabilities.report.intent,
    capabilityReport: capabilities.report,
    warnings: mergeAsamWarnings(resolved.warnings, capabilities.warnings),
  };
}
