import {
  buildRoute,
  actorPhysicsBackends,
  DYNAMIC_V1_DEFAULT_SUBSTEP_S,
  runSimulation,
  resolvePhysicsConfig,
  toSceneXZ,
  type Condition,
  type Interaction,
  type Pose,
  type Route,
  type SimActor,
  type SimEvent,
  type SimScenarioInput,
  type SimTrace,
  type SignalProgram,
} from '@simforge/engine';

import {
  analyzeAsamCapabilities,
  assertDefaultControllerRules,
  finite,
  identifier,
  mapRule,
  mergeAsamWarnings,
  resolveScenario,
  xml,
} from './common.js';
import {
  AsamExportError,
  type AsamExportIssue,
  type AsamExportOptions,
  type AsamExportResult,
  type ResolvedAsamScenario,
} from './types.js';

function lines(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

type WorldElevation = NonNullable<AsamExportOptions['worldElevation']>;

function worldPosition(pose: Pose, elevation?: WorldElevation, actorId?: string): string {
  const y = -pose.z;
  const z = elevation?.({ x: pose.x, y, actorId }) ?? 0;
  return `<WorldPosition x="${finite(pose.x)}" y="${finite(y)}" z="${finite(z)}" h="${finite(pose.headingRad)}" p="0" r="0"/>`;
}

function routeXml(name: string, points: readonly Pose[], elevation?: WorldElevation, actorId?: string): string {
  return [
    `<Route name="${xml(name)}" closed="false">`,
    ...points.map((pose) => lines(`<Waypoint routeStrategy="shortest"><Position>${worldPosition(pose, elevation, actorId)}</Position></Waypoint>`, 2)),
    '</Route>',
  ].join('\n');
}

function traceWorldPosition(x: number, y: number, headingRad: number, elevation?: WorldElevation, actorId?: string): string {
  const z = elevation?.({ x, y, actorId }) ?? 0;
  return `<WorldPosition x="${finite(x)}" y="${finite(y)}" z="${finite(z)}" h="${finite(headingRad)}" p="0" r="0"/>`;
}

function trajectoryXml(actorId: string, trace: SimTrace, warmupSeconds: number, elevation?: WorldElevation): string {
  const track = trace.ticks.actors[actorId]!;
  const kinematicIndex = (index: number): number => (index === 0 && trace.ticks.t.length > 1 ? 1 : index);
  const motionSpeed = (index: number): number => {
    const sample = kinematicIndex(index);
    return track.speedMps[sample]! * (track.motionDirection?.[sample] ?? 1);
  };
  const vertices = trace.ticks.t.map((t, index) => {
    return [
      `<Vertex time="${finite(t + warmupSeconds)}">`,
      `  <Position>${traceWorldPosition(track.x[index]!, track.y[index]!, track.headingRad[kinematicIndex(index)]!, elevation, actorId)}</Position>`,
      `  <Motion speed_longitudinal="${finite(motionSpeed(index))}"/>`,
      '</Vertex>',
    ].join('\n');
  });
  return [
    `<Trajectory name="${xml(identifier('trajectory', actorId))}" closed="false">`,
    '  <Shape><Polyline>',
    ...vertices.map((vertex) => lines(vertex, 4)),
    '    <Interpolation/>',
    '  </Polyline></Shape>',
    '</Trajectory>',
  ].join('\n');
}

function followTrajectoryAction(actorId: string, trace: SimTrace, warmupSeconds: number, elevation?: WorldElevation): string {
  return [
    '<PrivateAction>',
    '  <RoutingAction>',
    '    <FollowTrajectoryAction>',
    '      <TimeReference><Timing domainAbsoluteRelative="absolute" scale="1" offset="0"/></TimeReference>',
    '      <TrajectoryFollowingMode followingMode="position"/>',
    '      <TrajectoryRef>',
    lines(trajectoryXml(actorId, trace, warmupSeconds, elevation), 8),
    '      </TrajectoryRef>',
    '    </FollowTrajectoryAction>',
    '  </RoutingAction>',
    '</PrivateAction>',
  ].join('\n');
}

function trafficSignalStateAction(headId: string, state: SignalProgram['phases'][number]['phase']): string {
  return `<GlobalAction><InfrastructureAction><TrafficSignalAction><TrafficSignalStateAction name="${xml(headId)}" state="${state}"/></TrafficSignalAction></InfrastructureAction></GlobalAction>`;
}

function environmentAction(input: SimScenarioInput): string {
  const conditions = input.operationalConditions;
  const time = {
    dawn: '2020-06-21T06:00:00Z',
    day: '2020-06-21T12:00:00Z',
    dusk: '2020-06-21T18:00:00Z',
    night: '2020-06-21T00:00:00Z',
  }[conditions.timeOfDay];
  const weather = {
    clear: { clouds: 'zeroOktas', precipitation: 'dry', intensity: 0, sunElevation: 1.0472, illuminance: 100_000 },
    overcast: { clouds: 'eightOktas', precipitation: 'dry', intensity: 0, sunElevation: 0.6, illuminance: 20_000 },
    rain: { clouds: 'eightOktas', precipitation: 'rain', intensity: 0.6, sunElevation: 0.45, illuminance: 10_000 },
  }[conditions.weather];
  const visibilityRange = Math.min(100_000, conditions.effects.visibilityRangeM);
  return [
    '<GlobalAction><EnvironmentAction>',
    '  <Environment name="uniscenarios_environment">',
    `    <TimeOfDay animation="false" dateTime="${time}"/>`,
    `    <Weather fractionalCloudCover="${weather.clouds}">`,
    `      <Sun azimuth="0" elevation="${finite(weather.sunElevation)}" illuminance="${finite(weather.illuminance)}"/>`,
    `      <Fog visualRange="${finite(visibilityRange)}"/>`,
    `      <Precipitation precipitationType="${weather.precipitation}" precipitationIntensity="${finite(weather.intensity)}"/>`,
    '    </Weather>',
    `    <RoadCondition frictionScaleFactor="${finite(conditions.effects.frictionScale)}">`,
    '      <Properties>',
    `        <Property name="uniscenarios.environment.trafficSpeedFactor" value="${finite(conditions.effects.trafficSpeedFactor)}"/>`,
    `        <Property name="uniscenarios.environment.visibilityClass" value="${xml(conditions.visibility)}"/>`,
    '      </Properties>',
    '    </RoadCondition>',
    '  </Environment>',
    '</EnvironmentAction></GlobalAction>',
  ].join('\n');
}

function compactSignalTracks(input: SimScenarioInput, trace: SimTrace) {
  return input.signalPrograms.map((program) => {
    const phases = trace.ticks.signals?.[program.id]?.phase;
    if (!phases || phases.length !== trace.ticks.t.length) {
      throw new AsamExportError([{
        code: 'missing_signal_replay_track',
        path: `signalPrograms.${program.id}`,
        reason: `simulation did not produce a complete logical signal track for ${program.id}`,
      }]);
    }
    return {
      programId: program.id,
      headIds: program.mapBinding?.headIds ?? [],
      changes: phases.flatMap((state, index) => index === 0 || state !== phases[index - 1]
        ? [{ t: trace.ticks.t[index]! + input.warmupSeconds, state }]
        : []),
    };
  });
}

function primaryPhysicalSignalController(program: SignalProgram): string {
  return program.mapBinding!.controllerHeadGroups![0]!.controllerId;
}

function routePoints(route: Route, sampleM: number): Pose[] {
  const count = Math.max(2, Math.ceil(route.lengthM / sampleM) + 1);
  const points: Pose[] = [];
  for (let i = 0; i < count; i += 1) {
    const pose = route.poseAt((route.lengthM * i) / (count - 1));
    const scene = toSceneXZ(pose.point);
    points.push({ x: scene.x, z: scene.z, headingRad: pose.headingRad });
  }
  return points;
}

function boundingBox(actor: SimActor): string {
  return [
    '<BoundingBox>',
    `  <Center x="0" y="0" z="${finite(actor.dims.h / 2)}"/>`,
    `  <Dimensions width="${finite(actor.dims.w)}" length="${finite(actor.dims.l)}" height="${finite(actor.dims.h)}"/>`,
    '</BoundingBox>',
  ].join('\n');
}

function actorEntity(actor: SimActor, name: string, trustedAmbientActorIds: ReadonlySet<string>): string {
  const driverProfile = actor.tags.find((tag) => tag.startsWith('driver-profile:'))?.slice('driver-profile:'.length);
  const properties = [
    `<Property name="uniscenarios.actorId" value="${xml(actor.id)}"/>`,
    `<Property name="uniscenarios.actorKind" value="${xml(actor.kind)}"/>`,
    ...(driverProfile
      ? [`<Property name="uniscenarios.driverProfile" value="${xml(driverProfile)}"/>`]
      : []),
    ...(trustedAmbientActorIds.has(actor.id)
      ? ['<Property name="uniscenarios.actorOrigin" value="canonical-ambient"/>']
      : []),
    ...actor.tags.map((tag) => `<Property name="uniscenarios.tag" value="${xml(tag)}"/>`),
  ];
  if (actor.kind === 'pedestrian' || actor.kind === 'sidewalk_robot' || actor.kind === 'drone' || actor.kind === 'animal') {
    const pedestrianCategory = actor.kind === 'animal' ? 'animal' : 'pedestrian';
    const mass = actor.kind === 'animal' ? 40 : actor.kind === 'sidewalk_robot' ? 70 : actor.kind === 'drone' ? 12 : 80;
    return [
      `<ScenarioObject name="${xml(name)}">`,
      `  <Pedestrian name="uniscenarios_${actor.kind}" mass="${mass}" pedestrianCategory="${pedestrianCategory}">`,
      lines(boundingBox(actor), 4),
      '    <Properties>',
      ...properties.map((property) => `      ${property}`),
      '    </Properties>',
      '  </Pedestrian>',
      '</ScenarioObject>',
    ].join('\n');
  }
  if (actor.kind === 'static_object') {
    return [
      `<ScenarioObject name="${xml(name)}">`,
      '  <MiscObject mass="1" name="uniscenarios_static_object" miscObjectCategory="obstacle">',
      lines(boundingBox(actor), 4),
      '    <Properties>',
      ...properties.map((property) => `      ${property}`),
      '    </Properties>',
      '  </MiscObject>',
      '</ScenarioObject>',
    ].join('\n');
  }
  const vehicleCategory = {
    vehicle: 'other',
    car: 'car',
    truck: 'heavyTruck',
    bus: 'bus',
    van: 'van',
    motorcycle: 'motorcycle',
    bicycle: 'bicycle',
    scooter: 'standupScooter',
  }[actor.kind];
  const wheel = Math.min(0.8, Math.max(0.3, actor.dims.h * 0.45));
  const track = Math.max(0.5, actor.dims.w * 0.84);
  const axleX = Math.max(0.5, actor.dims.l * 0.58);
  return [
    `<ScenarioObject name="${xml(name)}">`,
    `  <Vehicle name="uniscenarios_${actor.kind}" vehicleCategory="${vehicleCategory}">`,
    lines(boundingBox(actor), 4),
    '    <Performance maxSpeed="100" maxAcceleration="12" maxDeceleration="12"/>',
    '    <Axles>',
    `      <FrontAxle maxSteering="0.7" wheelDiameter="${finite(wheel)}" trackWidth="${finite(track)}" positionX="${finite(axleX)}" positionZ="${finite(wheel / 2)}"/>`,
    `      <RearAxle maxSteering="0" wheelDiameter="${finite(wheel)}" trackWidth="${finite(track)}" positionX="0" positionZ="${finite(wheel / 2)}"/>`,
    '    </Axles>',
    '    <Properties>',
    ...properties.map((property) => `      ${property}`),
    '    </Properties>',
    '  </Vehicle>',
    '</ScenarioObject>',
  ].join('\n');
}

function occluderEntity(input: SimScenarioInput, index: number): string {
  const o = input.occluders[index]!;
  const name = identifier('occluder', o.id);
  return [
    `<ScenarioObject name="${xml(name)}">`,
    `  <MiscObject mass="1" name="uniscenarios_occluder" miscObjectCategory="obstacle">`,
    '    <BoundingBox>',
    `      <Center x="0" y="0" z="${finite(o.obb.heightM / 2)}"/>`,
    `      <Dimensions width="${finite(o.obb.widthM)}" length="${finite(o.obb.lengthM)}" height="${finite(o.obb.heightM)}"/>`,
    '    </BoundingBox>',
    '    <Properties>',
    `      <Property name="uniscenarios.occluderId" value="${xml(o.id)}"/>`,
    ...(o.groupId ? [`      <Property name="uniscenarios.occluderGroupId" value="${xml(o.groupId)}"/>`] : []),
    '    </Properties>',
    '  </MiscObject>',
    '</ScenarioObject>',
  ].join('\n');
}

function speedAction(interaction: Extract<Interaction, { verb: 'speed' }>, actorName: string): string {
  const dynamics = interaction.dynamics;
  const target = interaction.target;
  let targetXml: string;
  if (target.mode === 'absolute' || target.mode === 'stop') {
    const value = target.mode === 'stop' ? 0 : target.value;
    targetXml = `<AbsoluteTargetSpeed value="${finite(value)}"/>`;
  } else if (target.mode === 'match') {
    targetXml = `<RelativeTargetSpeed entityRef="${xml(identifier('actor', target.actorId))}" value="${finite(target.offsetMps)}" speedTargetValueType="delta" continuous="true"/>`;
  } else {
    targetXml = `<RelativeTargetSpeed entityRef="${xml(actorName)}" value="${finite(target.value)}" speedTargetValueType="${target.mode}" continuous="false"/>`;
  }
  return [
    '<PrivateAction>',
    '  <LongitudinalAction>',
    '    <SpeedAction>',
    `      <SpeedActionDynamics dynamicsShape="${dynamics.shape}" dynamicsDimension="${dynamics.constraint}" value="${finite(dynamics.value)}"/>`,
    '      <SpeedActionTarget>',
    `        ${targetXml}`,
    '      </SpeedActionTarget>',
    '    </SpeedAction>',
    '  </LongitudinalAction>',
    '</PrivateAction>',
  ].join('\n');
}

function laneChangeAction(
  interaction: Extract<Interaction, { verb: 'changeLane' }>,
  actorName: string,
  effectiveDurationS?: number,
): string | AsamExportIssue {
  const dynamics = effectiveDurationS === undefined
    ? interaction.dynamics
    : { ...interaction.dynamics, shape: 'cubic' as const, constraint: 'time' as const, value: effectiveDurationS };
  if (interaction.target.mode !== 'left' && interaction.target.mode !== 'right') {
    if (interaction.target.mode === 'actorLane') {
      return [
        '<PrivateAction>',
        '  <LateralAction>',
        '    <LaneChangeAction>',
        `      <LaneChangeActionDynamics dynamicsShape="${dynamics.shape}" dynamicsDimension="${dynamics.constraint}" value="${finite(dynamics.value)}"/>`,
        '      <LaneChangeTarget>',
        `        <RelativeTargetLane entityRef="${xml(identifier('actor', interaction.target.actorId))}" value="0"/>`,
        '      </LaneChangeTarget>',
        '    </LaneChangeAction>',
        '  </LateralAction>',
        '</PrivateAction>',
      ].join('\n');
    }
    return {
      code: 'unsupported_lane_target',
      path: `interactions.${interaction.id}.target`,
      reason: `${interaction.target.mode} does not have a portable XML relative-lane representation`,
    };
  }
  const value = interaction.target.count * (interaction.target.mode === 'left' ? 1 : -1);
  return [
    '<PrivateAction>',
    '  <LateralAction>',
    '    <LaneChangeAction>',
    `      <LaneChangeActionDynamics dynamicsShape="${dynamics.shape}" dynamicsDimension="${dynamics.constraint}" value="${finite(dynamics.value)}"/>`,
    '      <LaneChangeTarget>',
    `        <RelativeTargetLane entityRef="${xml(actorName)}" value="${value}"/>`,
    '      </LaneChangeTarget>',
    '    </LaneChangeAction>',
    '  </LateralAction>',
    '</PrivateAction>',
  ].join('\n');
}

function vehicleLightAction(
  vehicleLightType: 'indicatorLeft' | 'indicatorRight' | 'warningLights' | 'reversingLights' | 'brakeLights',
  mode: 'on' | 'off' | 'flashing',
): string {
  const flashing = mode === 'flashing' ? ' flashingOnDuration="0.5" flashingOffDuration="0.5"' : '';
  return [
    '<PrivateAction>',
    '  <AppearanceAction>',
    '    <LightStateAction transitionTime="0">',
    `      <LightType><VehicleLight vehicleLightType="${vehicleLightType}"/></LightType>`,
    `      <LightState mode="${mode}"${flashing}/>`,
    '    </LightStateAction>',
    '  </AppearanceAction>',
    '</PrivateAction>',
  ].join('\n');
}

function doorAnimationAction(
  component: 'doorFrontLeft' | 'doorFrontRight' | 'trunk',
  value: string,
): string | null {
  const state = value === 'opening' || value === 'open' ? 1
    : value === 'closing' || value === 'closed' ? 0
      : null;
  if (state === null) return null;
  const duration = value === 'opening' || value === 'closing' ? 1 : 0;
  return [
    '<PrivateAction>',
    '  <AppearanceAction>',
    `    <AnimationAction loop="false" animationDuration="${duration}">`,
    `      <AnimationType><ComponentAnimation><VehicleComponent vehicleComponentType="${component}"/></ComponentAnimation></AnimationType>`,
    `      <AnimationState state="${state}"/>`,
    '    </AnimationAction>',
    '  </AppearanceAction>',
    '</PrivateAction>',
  ].join('\n');
}

function userDefinedAnimationAction(key: string, value: boolean | number | string): string {
  const type = `simforge:${key}:${String(value)}`;
  return [
    '<PrivateAction>',
    '  <AppearanceAction>',
    '    <AnimationAction loop="false" animationDuration="0">',
    `      <AnimationType><UserDefinedAnimation userDefinedAnimationType="${xml(type)}"/></AnimationType>`,
    '    </AnimationAction>',
    '  </AppearanceAction>',
    '</PrivateAction>',
  ].join('\n');
}

function setAppearanceActions(
  resolved: ResolvedAsamScenario,
  interaction: Extract<Interaction, { verb: 'set' }>,
): string[] | AsamExportIssue {
  const actor = resolved.input.actors.find((candidate) => candidate.id === interaction.actorId)!;
  const { key, value } = interaction.target;
  if (key.startsWith('lights.') || key.startsWith('doors.')) {
    if (actor.kind === 'pedestrian' || actor.kind === 'animal' || actor.kind === 'static_object') {
      return {
        code: 'unsupported_appearance_actor',
        path: `interactions.${interaction.id}.target.key`,
        reason: `${key} requires an XML Vehicle entity, but ${actor.id} is ${actor.kind}`,
      };
    }
  }
  if (key.startsWith('doors.') && !['car', 'truck', 'bus', 'van'].includes(actor.kind)) {
    return {
      code: 'unsupported_appearance_actor',
      path: `interactions.${interaction.id}.target.key`,
      reason: `${key} requires a door-capable vehicle class, but ${actor.id} is ${actor.kind}`,
    };
  }
  if (key === 'lights.reverse' && ['bicycle', 'scooter', 'motorcycle'].includes(actor.kind)) {
    return {
      code: 'unsupported_appearance_actor',
      path: `interactions.${interaction.id}.target.key`,
      reason: `${key} is not defined for the ${actor.kind} semantic class`,
    };
  }
  if (key === 'lights.indicator') {
    if (value === 'left') {
      return [vehicleLightAction('indicatorLeft', 'flashing'), vehicleLightAction('indicatorRight', 'off')];
    }
    if (value === 'right') {
      return [vehicleLightAction('indicatorLeft', 'off'), vehicleLightAction('indicatorRight', 'flashing')];
    }
    if (value === 'hazard') return [vehicleLightAction('warningLights', 'flashing')];
    if (value === 'off' || value === 'none' || value === false) {
      return [
        vehicleLightAction('indicatorLeft', 'off'),
        vehicleLightAction('indicatorRight', 'off'),
        vehicleLightAction('warningLights', 'off'),
      ];
    }
  }
  if (key === 'lights.reverse' && typeof value === 'boolean') {
    return [vehicleLightAction('reversingLights', value ? 'on' : 'off')];
  }
  if (key === 'lights.brake' && typeof value === 'boolean') {
    return [vehicleLightAction('brakeLights', value ? 'on' : 'off')];
  }
  const doorComponent = key === 'doors.left' ? 'doorFrontLeft'
    : key === 'doors.right' ? 'doorFrontRight'
      : key === 'doors.rear' ? 'trunk'
        : null;
  if (doorComponent && typeof value === 'string') {
    const action = doorAnimationAction(doorComponent, value);
    if (action) return [action];
  }
  if (key.startsWith('pose.')) return [userDefinedAnimationAction(key, value)];
  if (key === 'lights.emergency' || key === 'audio.horn') {
    return [userDefinedAnimationAction(key, value)];
  }
  return {
    code: 'unsupported_set_action',
    path: `interactions.${interaction.id}.target.key`,
    reason: `${key} has no standard XML 1.4 action with equivalent semantics`,
  };
}

function interactionActions(
  resolved: ResolvedAsamScenario,
  interaction: Interaction,
  options: AsamExportOptions,
  effectiveLateralDurations: ReadonlyMap<string, number> = new Map(),
): string[] | AsamExportIssue {
  const actorName = resolved.actorNames.get(interaction.actorId)!;
  switch (interaction.verb) {
    case 'speed':
      return [speedAction(interaction, actorName)];
    case 'changeLane': {
      const action = laneChangeAction(interaction, actorName, effectiveLateralDurations.get(interaction.id));
      return typeof action === 'string' ? [action] : action;
    }
    case 'route': {
      if (interaction.target.kind === 'nextJunction') {
        return {
          code: 'dynamic_next_junction_requires_trajectory_replay',
          path: `interactions.${interaction.id}.target`,
          reason: 'a live-position next-junction turn cannot be represented faithfully as a precomputed OSC action; use trajectory-replay export',
        };
      }
      const built = buildRoute(options.graph, interaction.target);
      if (!built.ok) {
        return { code: built.error.code, path: `interactions.${interaction.id}.target`, reason: built.error.reason };
      }
      const sampleM = options.routeSampleM ?? 20;
      return [[
        '<PrivateAction>',
        '  <RoutingAction>',
        '    <AssignRouteAction>',
        lines(routeXml(identifier('route_event', interaction.id), routePoints(built.route, sampleM), options.worldElevation, interaction.actorId), 6),
        '    </AssignRouteAction>',
        '  </RoutingAction>',
        '</PrivateAction>',
      ].join('\n')];
    }
    case 'exist': {
      const body = interaction.target.state === 'absent'
        ? '<DeleteEntityAction/>'
        : `<AddEntityAction><Position>${worldPosition(resolved.actors.find((a) => a.actor.id === interaction.actorId)!.actor.initial.pose, options.worldElevation, interaction.actorId)}</Position></AddEntityAction>`;
      return [`<GlobalAction><EntityAction entityRef="${xml(actorName)}">${body}</EntityAction></GlobalAction>`];
    }
    case 'set': {
      return setAppearanceActions(resolved, interaction);
    }
    case 'gap':
      return {
        code: 'unsupported_gap_dynamics',
        path: `interactions.${interaction.id}`,
        reason: 'XML LongitudinalDistanceAction cannot preserve SimForge transition shape and dimension',
      };
    case 'laneOffset':
      if (interaction.target.mode === 'meters' && interaction.dynamics.shape === 'step') {
        return [[
          '<PrivateAction>',
          '  <LateralAction>',
          '    <LaneOffsetAction continuous="false">',
          '      <LaneOffsetActionDynamics dynamicsShape="step"/>',
          `      <LaneOffsetTarget><AbsoluteTargetLaneOffset value="${finite(interaction.target.value)}"/></LaneOffsetTarget>`,
          '    </LaneOffsetAction>',
          '  </LateralAction>',
          '</PrivateAction>',
        ].join('\n')];
      }
      return {
        code: 'unsupported_lane_offset_dynamics',
        path: `interactions.${interaction.id}`,
        reason: 'XML LaneOffsetAction cannot preserve SimForge transition dimension and value',
      };
  }
}

interface LeafConditionXml { triggeringActor?: string; xml: string }

function leafCondition(resolved: ResolvedAsamScenario, condition: Condition): LeafConditionXml | AsamExportIssue {
  const actor = (id: string): string => resolved.actorNames.get(id) ?? identifier('actor', id);
  switch (condition.kind) {
    case 'distance':
      return {
        triggeringActor: actor(condition.a),
        // OSC has rising-edge conditions but no distance dead-band. Export the
        // exact deterministic entry threshold used by the native engine.
        xml: `<RelativeDistanceCondition entityRef="${xml(actor(condition.b))}" relativeDistanceType="${condition.mode === 'euclidean' ? 'euclidianDistance' : 'longitudinal'}" freespace="false" rule="${mapRule(condition.cmp)}" value="${finite(condition.cmp === 'lte' ? Math.max(0, condition.value - (condition.hysteresis ?? 0)) : condition.value + (condition.hysteresis ?? 0))}" coordinateSystem="${condition.mode === 'euclidean' ? 'entity' : 'road'}"/>`,
      };
    case 'ttc':
      return {
        triggeringActor: actor(condition.a),
        xml: `<TimeToCollisionCondition freespace="false" rule="${mapRule(condition.cmp)}" value="${finite(condition.value)}"><TimeToCollisionConditionTarget><EntityRef entityRef="${xml(actor(condition.b))}"/></TimeToCollisionConditionTarget></TimeToCollisionCondition>`,
      };
    case 'headway':
      return {
        triggeringActor: actor(condition.a),
        xml: `<TimeHeadwayCondition entityRef="${xml(actor(condition.b))}" freespace="false" rule="${mapRule(condition.cmp)}" value="${finite(condition.value)}" coordinateSystem="road" relativeDistanceType="longitudinal"/>`,
      };
    case 'speed':
      return { triggeringActor: actor(condition.actorId), xml: `<SpeedCondition rule="${mapRule(condition.cmp)}" value="${finite(condition.value)}"/>` };
    case 'standstill':
      return { triggeringActor: actor(condition.actorId), xml: `<StandStillCondition duration="${finite(condition.durationS)}"/>` };
    case 'signal':
      {
        const program = resolved.input.signalPrograms.find((candidate) => candidate.id === condition.signalId)!;
      return {
        xml: `<TrafficSignalControllerCondition trafficSignalControllerRef="${xml(primaryPhysicalSignalController(program))}" phase="${xml(condition.phase)}"/>`,
      };
      }
    case 'collision':
      if (!condition.a || !condition.b) {
        return { code: 'unsupported_collision_scope', path: 'condition', reason: 'XML export requires both collision participants' };
      }
      return { triggeringActor: actor(condition.a), xml: `<CollisionCondition><EntityRef entityRef="${xml(actor(condition.b))}"/></CollisionCondition>` };
    case 'reaches':
    case 'visible':
    // `detected` is a PERCEPTION predicate: whether a sensor on the observer currently detects the
    // target, given fog attenuation, glare, range and field of view. ASAM has no sensor model, so
    // there is nothing to map it onto -- and silently degrading it to `visible` would export a
    // geometric line-of-sight test in place of a detection test, turning a perception scenario into
    // an occlusion one. Refuse it instead.
    case 'detected':
    case 'and':
    case 'or':
    case 'not':
      return { code: 'unsupported_condition', path: 'condition', reason: `${condition.kind} has no exact XML 1.4 mapping in this profile` };
  }
}

function conditionElement(name: string, leaf: LeafConditionXml): string {
  if (leaf.triggeringActor) {
    return `<Condition name="${xml(name)}" delay="0" conditionEdge="rising"><ByEntityCondition><TriggeringEntities triggeringEntitiesRule="any"><EntityRef entityRef="${xml(leaf.triggeringActor)}"/></TriggeringEntities><EntityCondition>${leaf.xml}</EntityCondition></ByEntityCondition></Condition>`;
  }
  return `<Condition name="${xml(name)}" delay="0" conditionEdge="rising"><ByValueCondition>${leaf.xml}</ByValueCondition></Condition>`;
}

function whenGroups(
  resolved: ResolvedAsamScenario,
  interaction: Interaction & { trigger: Extract<Interaction['trigger'], { kind: 'when' }> },
): string[] | AsamExportIssue {
  const condition = interaction.trigger.condition;
  const groups: Condition[][] = condition.kind === 'or'
    ? condition.of.map((leaf) => [leaf])
    : condition.kind === 'and'
      ? [condition.of]
      : condition.kind === 'not'
        ? []
        : [[condition]];
  if (condition.kind === 'not') {
    return { code: 'unsupported_condition', path: `interactions.${interaction.id}.trigger.condition`, reason: 'XML Trigger has no generic logical NOT' };
  }
  const output: string[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    const leaves: string[] = [];
    for (const [leafIndex, condition] of group.entries()) {
      const rendered = leafCondition(resolved, condition);
      if ('code' in rendered) return { ...rendered, path: `interactions.${interaction.id}.trigger.condition` };
      leaves.push(conditionElement(`${interaction.id}_${groupIndex}_${leafIndex}`, rendered));
    }
    output.push(`<ConditionGroup>${leaves.join('')}</ConditionGroup>`);
  }
  if (interaction.trigger.ifNever === 'fire') {
    output.push(`<ConditionGroup><Condition name="${xml(`${interaction.id}_latest`)}" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="${finite(resolved.input.warmupSeconds + Math.max(0, interaction.trigger.byLatest))}" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup>`);
  } else {
    return {
      code: 'unsupported_when_deadline',
      path: `interactions.${interaction.id}.trigger`,
      reason: 'ifNever=skip cannot be bounded in XML without an additional state variable and guard',
    };
  }
  return output;
}

function startTrigger(resolved: ResolvedAsamScenario, interaction: Interaction): string | AsamExportIssue {
  const trigger = interaction.trigger;
  if (trigger.kind === 'at') {
    return `<StartTrigger><ConditionGroup><Condition name="${xml(`${interaction.id}_start`)}" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="${finite(resolved.input.warmupSeconds + Math.max(0, trigger.t))}" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger>`;
  }
  if (trigger.kind === 'after') {
    const parent = resolved.interactionNames.get(trigger.interactionId)!;
    return `<StartTrigger><ConditionGroup><Condition name="${xml(`${interaction.id}_after`)}" delay="${finite(trigger.delayS)}" conditionEdge="rising"><ByValueCondition><StoryboardElementStateCondition storyboardElementRef="${xml(parent)}" storyboardElementType="event" state="completeState"/></ByValueCondition></Condition></ConditionGroup></StartTrigger>`;
  }
  if (trigger.kind === 'when') {
    const groups = whenGroups(resolved, interaction as never);
    return Array.isArray(groups) ? `<StartTrigger>${groups.join('')}</StartTrigger>` : groups;
  }
  return { code: 'unsupported_arrival_trigger', path: `interactions.${interaction.id}.trigger`, reason: 'arrival triggers must be resolved while materializing the concrete instance' };
}

function validateXmlProfile(input: SimScenarioInput, executionMode: 'actions' | 'trajectory-replay'): void {
  const issues: AsamExportIssue[] = [];
  const headOwners = new Map<string, number>();
  const controllerOwners = new Map<string, number>();
  const programsById = new Map(input.signalPrograms.map((program) => [program.id, program]));
  if (executionMode === 'trajectory-replay') {
    for (const [path, seconds] of [['warmupSeconds', input.warmupSeconds], ['clipSeconds', input.clipSeconds]] as const) {
      const ticks = seconds / input.dt;
      if (Math.abs(ticks - Math.round(ticks)) > 1e-9) {
        issues.push({
          code: 'non_integral_replay_duration',
          path,
          reason: `${path}=${seconds} is not an integer number of dt=${input.dt} fixed steps; exporting the rounded engine trace would change the authored clock`,
        });
      }
    }
  }
  if (executionMode === 'actions') {
    for (const [i, control] of input.roadControls.entries()) {
      issues.push({
        code: 'unsupported_road_control',
        path: `roadControls.${i}`,
        reason: `road control ${control.id} is not emitted by the XML 1.4 actions profile; exporting without its stop/yield semantics would change external execution`,
      });
    }
  }
  for (const [i, prop] of input.props.entries()) {
    issues.push({
      code: 'unsupported_prop',
      path: `props.${i}`,
      reason: prop.collidable
        ? `prop ${prop.id} has collision geometry that is not emitted by the XML 1.4 profile`
        : `prop ${prop.id} is not emitted by the XML 1.4 profile; its identity, pose, geometry, and attachment semantics would be lost`,
    });
  }
  const conditions = input.operationalConditions;
  const hasMaterialOperationalConditions = conditions.weather !== 'clear'
    || conditions.timeOfDay !== 'day'
    || conditions.traffic !== 'moderate'
    || conditions.visibility !== 'unrestricted'
    || conditions.effects.visibilityRangeM !== 10_000
    || conditions.effects.frictionScale !== 1
    || conditions.effects.trafficSpeedFactor !== 1;
  if (executionMode === 'actions' && hasMaterialOperationalConditions) {
    issues.push({
      code: 'unsupported_operational_conditions',
      path: 'operationalConditions',
      reason: 'action-mode XML does not emit weather, time-of-day, surface, or ambient-traffic conditions; use trajectory replay for baked motion or remove the authored conditions',
    });
  }
  for (const [i, actor] of input.actors.entries()) {
    if (actor.kind === 'static_object' && !actor.static) {
      issues.push({
        code: 'unsupported_moving_misc_object',
        path: `actors.${i}.kind`,
        reason: 'the XML profile exports static_object as MiscObject and does not substitute vehicle motion semantics',
      });
    }
    if (actor.static && actor.initial.speedMps > 1e-9) {
      issues.push({
        code: 'invalid_static_actor_speed',
        path: `actors.${i}.initial.speedMps`,
        reason: 'a static actor cannot preserve a non-zero initial speed',
      });
    }
    if (executionMode === 'actions' && actor.tags.includes('motion:reverse')) {
      issues.push({
        code: 'unsupported_reverse_motion',
        path: `actors.${i}.tags`,
        reason: 'XML controller actions do not preserve signed reverse travel; use trajectory-replay',
      });
    }
  }
  for (const [i, interaction] of input.interactions.entries()) {
    const actor = input.actors.find((candidate) => candidate.id === interaction.actorId);
    if (executionMode === 'actions' && actor?.static && interaction.verb !== 'exist' && interaction.verb !== 'set') {
      issues.push({
        code: 'unsupported_static_actor_action',
        path: `interactions.${i}`,
        reason: `${interaction.verb} cannot be applied to an XML MiscObject without substituting movable-object semantics`,
      });
    }
    if (executionMode === 'trajectory-replay' && interaction.verb === 'set') {
      const replayableAppearance = interaction.target.key.startsWith('pose.') || [
        'lights.indicator',
        'lights.reverse',
        'lights.brake',
        'doors.left',
        'doors.right',
        'doors.rear',
        'lights.emergency',
        'audio.horn',
      ].includes(interaction.target.key);
      const embodiedByReplay = interaction.target.key.startsWith('rules.') ||
        interaction.target.key.startsWith('signal:');
      if (!replayableAppearance && !embodiedByReplay) {
        issues.push({
          code: 'unsupported_set_action',
          path: `interactions.${interaction.id}.target.key`,
          reason: `${interaction.target.key} has no standard XML 1.4 action with equivalent semantics`,
        });
      }
    }
    if (executionMode === 'actions' && interaction.until) {
      issues.push({
        code: 'unsupported_until',
        path: `interactions.${i}.until`,
        reason: 'XML Event does not provide an equivalent generic stop condition for this action profile',
      });
    }
    if (executionMode === 'actions' && interaction.trigger.kind === 'when') {
      for (const signal of signalConditions(interaction.trigger.condition)) {
        const program = programsById.get(signal.signalId);
        if (!program) {
          issues.push({
            code: 'unknown_signal_program',
            path: `interactions.${i}.trigger.condition`,
            reason: `signal condition references unknown program ${signal.signalId}`,
          });
        } else if (!program.phases.some((phase) => phase.phase === signal.phase)) {
          issues.push({
            code: 'unknown_signal_phase',
            path: `interactions.${i}.trigger.condition`,
            reason: `${signal.phase} is not a phase of signal program ${signal.signalId}`,
          });
        }
      }
    }
  }
  for (const [i, program] of input.signalPrograms.entries()) {
    if (executionMode === 'actions' && !program.loop) {
      issues.push({
        code: program.mapBinding?.timingSource === 'authored'
          ? 'unsupported_authored_signal_timeline'
          : 'unsupported_finite_signal_program',
        path: `signalPrograms.${i}.loop`,
        reason: program.mapBinding?.timingSource === 'authored'
          ? 'bounded authored controller clips require trajectory-replay signal-state actions; action-mode TrafficSignalController cycles cannot preserve their [start,end) ownership'
          : 'XML TrafficSignalController cycles; a finite non-looping program needs explicit storyboard state',
      });
    }
    if (!program.mapBinding) {
      issues.push({
        code: 'missing_signal_map_binding',
        path: `signalPrograms.${i}.mapBinding`,
        reason: 'XML TrafficSignalController.name must reference a concrete road-network controller',
      });
    } else if (!program.mapBinding.controllerHeadGroups || program.mapBinding.controllerHeadGroups.length === 0) {
      issues.push({
        code: 'missing_signal_controller_head_groups',
        path: `signalPrograms.${i}.mapBinding.controllerHeadGroups`,
        reason: 'flattened controller/head ids do not preserve authoritative OpenDRIVE controller-stage membership',
      });
    } else {
      if (executionMode === 'actions') {
        const programGroupHeadOwners = new Map<string, number>();
        for (const [groupIndex, group] of program.mapBinding.controllerHeadGroups.entries()) {
          const owner = controllerOwners.get(group.controllerId);
          if (owner !== undefined) {
            issues.push({
              code: 'duplicate_signal_controller_binding',
              path: `signalPrograms.${i}.mapBinding.controllerHeadGroups.${groupIndex}.controllerId`,
              reason: `${group.controllerId} is already defined by signalPrograms.${owner}; action-mode phase ownership is ambiguous`,
            });
          } else {
            controllerOwners.set(group.controllerId, i);
          }
          for (const [headIndex, headId] of group.headIds.entries()) {
            const groupOwner = programGroupHeadOwners.get(headId);
            if (groupOwner !== undefined) {
              issues.push({
                code: 'duplicate_signal_group_membership',
                path: `signalPrograms.${i}.mapBinding.controllerHeadGroups.${groupIndex}.headIds.${headIndex}`,
                reason: `${headId} is already assigned to controller group ${program.mapBinding.controllerHeadGroups[groupOwner]!.controllerId}; ASAM requires each dynamic signal to belong to exactly one signal group`,
              });
            } else {
              programGroupHeadOwners.set(headId, groupIndex);
            }
          }
        }
      }
      for (const [headIndex, headId] of program.mapBinding.headIds.entries()) {
        const owner = headOwners.get(headId);
        if (owner !== undefined) {
          issues.push({
            code: 'duplicate_signal_head_binding',
            path: `signalPrograms.${i}.mapBinding.headIds.${headIndex}`,
            reason: `${headId} is already controlled by signalPrograms.${owner}`,
          });
        } else {
          headOwners.set(headId, i);
        }
      }
    }
    if (executionMode === 'actions') {
      const phases = new Set<string>();
      for (const [phaseIndex, phase] of program.phases.entries()) {
        if (phases.has(phase.phase)) {
          issues.push({
            code: 'duplicate_signal_phase_name',
            path: `signalPrograms.${i}.phases.${phaseIndex}.phase`,
            reason: `XML controller phase references require unique names; ${phase.phase} occurs more than once`,
          });
        }
        phases.add(phase.phase);
      }
    }
    const offset = normalizedSignalOffset(program);
    const splitPhase = xmlSignalPhases(program)[0]!.semantic;
    if (executionMode === 'actions' && offset > 1e-9 && !isPhaseBoundary(program, offset) && input.interactions.some((interaction) =>
      interaction.trigger.kind === 'when' && conditionReferencesSignalPhase(
        interaction.trigger.condition,
        program.id,
        splitPhase,
      ))) {
      issues.push({
        code: 'unsupported_offset_signal_condition',
        path: `signalPrograms.${i}.offsetS`,
        reason: 'an intra-phase offset splits one semantic phase across the controller cycle boundary, so a single XML phase-name condition cannot preserve it',
      });
    }
  }
  if (issues.length > 0) throw new AsamExportError(issues);
}

/**
 * Resolve the runtime's authoritative lateral duration before emitting an OSC
 * action. This also makes missing multi-lane neighbours fail closed instead of
 * exporting a count the engine could not execute. Freeform actors retain the
 * legacy action path because they have no map-lane topology to preflight.
 */
function preflightLateralActionDurations(input: SimScenarioInput, options: AsamExportOptions): ReadonlyMap<string, number> {
  const candidates = input.interactions.filter((interaction): interaction is Interaction & { verb: 'changeLane' } => {
    if (interaction.verb !== 'changeLane') return false;
    const actor = input.actors.find((item) => item.id === interaction.actorId);
    return actor?.behavior.route.kind !== 'polyline';
  });
  if (candidates.length === 0) return new Map();
  const simulation = runSimulation(input, { graph: options.graph, guards: 'collect' });
  const issues: AsamExportIssue[] = [];
  const durations = new Map<string, number>();
  for (const interaction of candidates) {
    const aborted = simulation.trace.events.find((event): event is Extract<SimEvent, { kind: 'interaction_aborted' }> => event.kind === 'interaction_aborted' && event.interactionId === interaction.id);
    const planned = simulation.trace.events.find((event): event is Extract<SimEvent, { kind: 'lateral_maneuver_planned' }> => event.kind === 'lateral_maneuver_planned' && event.interactionId === interaction.id);
    const completed = simulation.trace.events.find((event) => event.kind === 'interaction_completed' && event.interactionId === interaction.id);
    if (aborted || !planned || !completed) {
      issues.push({
        code: aborted?.reason === 'rejected' ? 'lane_change_target_unreachable' : 'lateral_action_not_conformance_proven',
        path: `interactions.${interaction.id}`,
        reason: aborted
          ? `runtime aborts this lane change (${aborted.reason}); OSC action export would diverge`
          : 'runtime did not plan and complete this lane change in the authoritative replay',
      });
      continue;
    }
    durations.set(interaction.id, planned.effectiveDurationS);
  }
  if (issues.length > 0) throw new AsamExportError(issues);
  return durations;
}

function signalConditions(condition: Condition): Extract<Condition, { kind: 'signal' }>[] {
  if (condition.kind === 'signal') return [condition];
  if (condition.kind === 'and' || condition.kind === 'or') return condition.of.flatMap(signalConditions);
  if (condition.kind === 'not') return signalConditions(condition.of);
  return [];
}

function conditionReferencesSignalPhase(
  condition: Condition,
  signalId: string,
  phase: SignalProgram['phases'][number]['phase'],
): boolean {
  if (condition.kind === 'signal') return condition.signalId === signalId && condition.phase === phase;
  if (condition.kind === 'and' || condition.kind === 'or') {
    return condition.of.some((leaf) => conditionReferencesSignalPhase(leaf, signalId, phase));
  }
  return condition.kind === 'not' && conditionReferencesSignalPhase(condition.of, signalId, phase);
}

function normalizedSignalOffset(program: SignalProgram): number {
  const cycle = program.phases.reduce((sum, phase) => sum + phase.durationS, 0);
  return ((program.offsetS % cycle) + cycle) % cycle;
}

function isPhaseBoundary(program: SignalProgram, offset: number): boolean {
  let elapsed = 0;
  for (const phase of program.phases) {
    if (Math.abs(offset - elapsed) <= 1e-9) return true;
    elapsed += phase.durationS;
  }
  return false;
}

interface XmlSignalPhase {
  readonly durationS: number;
  readonly name: string;
  readonly semantic: SignalProgram['phases'][number]['phase'];
}

/** Rotate/split a cycle so ASAM t=0 matches engine t=-warmupSeconds. */
function xmlSignalPhases(program: SignalProgram): XmlSignalPhase[] {
  const offset = normalizedSignalOffset(program);
  let phaseStart = 0;
  let activeIndex = 0;
  for (const [index, phase] of program.phases.entries()) {
    if (offset < phaseStart + phase.durationS - 1e-9) {
      activeIndex = index;
      break;
    }
    phaseStart += phase.durationS;
  }
  const intoPhase = offset - phaseStart;
  const active = program.phases[activeIndex]!;
  if (Math.abs(intoPhase) <= 1e-9) {
    return program.phases.map((_, index) => {
      const source = program.phases[(activeIndex + index) % program.phases.length]!;
      return { name: source.phase, semantic: source.phase, durationS: source.durationS };
    });
  }
  const result: XmlSignalPhase[] = [{
    name: active.phase,
    semantic: active.phase,
    durationS: active.durationS - intoPhase,
  }];
  for (let index = activeIndex + 1; index < activeIndex + program.phases.length; index += 1) {
    const source = program.phases[index % program.phases.length]!;
    if (index % program.phases.length === activeIndex) break;
    result.push({ name: source.phase, semantic: source.phase, durationS: source.durationS });
  }
  result.push({
    name: `${active.phase}__cycle_wrap`,
    semantic: active.phase,
    durationS: intoPhase,
  });
  return result;
}

function signalSemantics(
  phase: SignalProgram['phases'][number]['phase'],
): 'attention_stop' | 'caution' | 'fallback' | 'go' | 'stop' {
  switch (phase) {
    case 'green':
    case 'green_arrow':
    case 'proceed':
      return 'go';
    case 'yellow':
    case 'yellow_arrow':
      return 'attention_stop';
    case 'flashing_yellow':
    // A flashing yellow ARROW is the permissive-left indication: proceed after yielding, which is
    // the same advisory semantics as a flashing yellow head.
    case 'flashing_yellow_arrow':
      return 'caution';
    case 'off':
      return 'fallback';
    case 'red':
    case 'flashing_red':
    // A flashing red ARROW is stop-and-proceed, carrying the same stop authority as a flashing red
    // head; ASAM has no stop-and-proceed distinction, so both map to `stop`.
    case 'flashing_red_arrow':
    case 'red_x':
    case 'stop':
      return 'stop';
  }
}

export function exportOpenScenarioXml14(
  input: SimScenarioInput,
  options: AsamExportOptions,
): AsamExportResult {
  const executionMode = options.executionMode ?? 'actions';
  const capabilities = analyzeAsamCapabilities(
    input,
    executionMode === 'trajectory-replay' ? 'xml-1.4-trajectory-replay' : 'xml-1.4-actions',
  );
  if (executionMode === 'actions') assertDefaultControllerRules(input, false);
  validateXmlProfile(input, executionMode);
  const effectiveLateralDurations = executionMode === 'actions'
    ? preflightLateralActionDurations(input, options)
    : new Map<string, number>();
  let replayTrace: SimTrace | null = null;
  if (executionMode === 'trajectory-replay') {
    try {
      const simulation = runSimulation(input, {
        graph: options.graph,
        // Export is a faithful replay operation, not a tier-2 acceptance run.
        // The normal simulation/validation pipeline owns feasibility gates;
        // runtime/arrival errors are still rejected below.
        guards: 'skip',
        includeWarmupTrace: true,
      });
      const errors = simulation.issues.filter((issue) => issue.severity === 'error');
      if (errors.length > 0) {
        throw new AsamExportError(errors.map((issue, index) => ({
          code: 'trajectory_replay_simulation_error',
          path: issue.path ?? `simulation.issues.${index}`,
          reason: issue.reason,
        })));
      }
      replayTrace = simulation.trace;
    } catch (error) {
      if (error instanceof AsamExportError) throw error;
      throw new AsamExportError([{
        code: 'trajectory_replay_failed',
        path: 'input',
        reason: error instanceof Error ? error.message : String(error),
      }]);
    }
  }
  const resolved = resolveScenario(input, options, false);
  const issues: AsamExportIssue[] = [];
  const actorEvents = new Map<string, string[]>();
  const replaySignalInit: string[] = [];
  for (const actor of resolved.actors) actorEvents.set(actor.actor.id, []);

  if (executionMode === 'actions') {
    for (const { interaction, name } of resolved.interactions) {
      const actions = interactionActions(resolved, interaction, options, effectiveLateralDurations);
      const trigger = startTrigger(resolved, interaction);
      if (!Array.isArray(actions)) issues.push(actions);
      if (typeof trigger !== 'string') issues.push(trigger);
      if (!Array.isArray(actions) || typeof trigger !== 'string') continue;
      actorEvents.get(interaction.actorId)!.push([
        `<Event name="${xml(name)}" priority="overwrite" maximumExecutionCount="1">`,
        ...actions.map((action, i) => lines(`<Action name="${xml(`${name}_action_${i}`)}">${action}</Action>`, 2)),
        lines(trigger, 2),
        '</Event>',
      ].join('\n'));
    }
  } else {
    const trace = replayTrace!;
    for (const { interaction, name } of resolved.interactions) {
      if (
        interaction.verb !== 'set' ||
        interaction.target.key.startsWith('rules.') ||
        interaction.target.key.startsWith('signal:')
      ) continue;
      const fired = trace.events.find((event) =>
        event.kind === 'trigger_fired' && event.interactionId === interaction.id);
      if (!fired) continue;
      const actions = setAppearanceActions(resolved, interaction);
      if (!Array.isArray(actions)) {
        issues.push(actions);
        continue;
      }
      const trigger = `<StartTrigger><ConditionGroup><Condition name="${xml(`${interaction.id}_replay`)}" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="${finite(input.warmupSeconds + fired.t)}" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger>`;
      actorEvents.get(interaction.actorId)!.push([
        `<Event name="${xml(name)}" priority="overwrite" maximumExecutionCount="1">`,
        ...actions.map((action, i) => lines(`<Action name="${xml(`${name}_action_${i}`)}">${action}</Action>`, 2)),
        lines(trigger, 2),
        '</Event>',
      ].join('\n'));
    }
    for (const actor of input.actors) {
      const track = trace.ticks.actors[actor.id]!;
      if (track.present[0] === 0 && track.present.some((present) => present === 1)) {
        issues.push({
          code: 'unsupported_trajectory_spawn',
          path: `actors.${actor.id}.presentAtStart`,
          reason: 'trajectory replay cannot atomically add an absent entity and start its timed trajectory',
        });
      }
      for (let index = 1; index < track.present.length; index += 1) {
        if (track.present[index - 1] !== 1 || track.present[index] !== 0) continue;
        const name = identifier('event', `${actor.id}_trajectory_despawn_${index}`);
        const action = `<GlobalAction><EntityAction entityRef="${xml(identifier('actor', actor.id))}"><DeleteEntityAction/></EntityAction></GlobalAction>`;
        const at = input.warmupSeconds + trace.ticks.t[index]!;
        const trigger = `<StartTrigger><ConditionGroup><Condition name="${xml(`${name}_start`)}" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="${finite(at)}" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger>`;
        actorEvents.get(actor.id)!.push([
          `<Event name="${xml(name)}" priority="overwrite" maximumExecutionCount="1">`,
          lines(`<Action name="${xml(`${name}_action`)}">${action}</Action>`, 2),
          lines(trigger, 2),
          '</Event>',
        ].join('\n'));
        break;
      }
    }
    const headTracks = new Map<string, readonly SignalProgram['phases'][number]['phase'][]>();
    for (const [programIndex, program] of input.signalPrograms.entries()) {
      // Portable authored controls have no physical OpenDRIVE head id. Their
      // behavioral effect is already baked into actor trajectories; only map
      // heads can be emitted as OpenSCENARIO TrafficSignalState actions.
      if (!program.mapBinding) continue;
      const phaseTrack = trace.ticks.signals?.[program.id]?.phase;
      if (!phaseTrack || phaseTrack.length !== trace.ticks.t.length) {
        issues.push({
          code: 'missing_signal_replay_track',
          path: `signalPrograms.${programIndex}`,
          reason: `simulation did not produce a complete phase track for ${program.id}`,
        });
        continue;
      }
      for (const [headIndex, headId] of program.mapBinding!.headIds.entries()) {
        const existing = headTracks.get(headId);
        if (existing && existing.some((phase, index) => phase !== phaseTrack[index])) {
          issues.push({
            code: 'conflicting_signal_head_replay',
            path: `signalPrograms.${programIndex}.mapBinding.headIds.${headIndex}`,
            reason: `${headId} is assigned incompatible phase timelines by multiple signal programs`,
          });
          continue;
        }
        headTracks.set(headId, phaseTrack);
      }
    }
    const changes = new Map<number, string[]>();
    for (const [headId, phaseTrack] of [...headTracks.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      replaySignalInit.push(trafficSignalStateAction(headId, phaseTrack[0]!));
      for (let index = 1; index < phaseTrack.length; index += 1) {
        if (phaseTrack[index] === phaseTrack[index - 1]) continue;
        const action = trafficSignalStateAction(headId, phaseTrack[index]!);
        const atIndex = changes.get(index);
        if (atIndex) atIndex.push(action);
        else changes.set(index, [action]);
      }
    }
    const signalEventActor = input.actors[0]?.id;
    if (changes.size > 0 && !signalEventActor) {
      issues.push({
        code: 'signal_replay_without_actor',
        path: 'actors',
        reason: 'scheduled XML signal-state actions require a storyboard maneuver group',
      });
    } else if (signalEventActor) {
      for (const [index, actions] of [...changes.entries()].sort(([a], [b]) => a - b)) {
        const name = identifier('event', `signal_replay_${index}`);
        const at = input.warmupSeconds + trace.ticks.t[index]!;
        const trigger = `<StartTrigger><ConditionGroup><Condition name="${xml(`${name}_start`)}" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="${finite(at)}" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger>`;
        actorEvents.get(signalEventActor)!.push([
          `<Event name="${xml(name)}" priority="overwrite" maximumExecutionCount="1">`,
          ...actions.map((action, actionIndex) => lines(`<Action name="${xml(`${name}_action_${actionIndex}`)}">${action}</Action>`, 2)),
          lines(trigger, 2),
          '</Event>',
        ].join('\n'));
      }
    }
  }
  if (issues.length > 0) throw new AsamExportError(issues);

  const initPrivate = resolved.actors.flatMap(({ actor, name, routeName, points }) => {
    if (executionMode === 'trajectory-replay') {
      const trace = replayTrace!;
      const track = trace.ticks.actors[actor.id]!;
      if (track.present[0] !== 1) return [];
      const actions = [
        '<PrivateAction><TeleportAction><Position>',
        lines(traceWorldPosition(track.x[0]!, track.y[0]!, track.headingRad[0]!, options.worldElevation, actor.id), 4),
        '</Position></TeleportAction></PrivateAction>',
      ];
      if (!actor.static) actions.push(followTrajectoryAction(actor.id, trace, input.warmupSeconds, options.worldElevation));
      return [[
        `<Private entityRef="${xml(name)}">`,
        ...actions.map((action) => lines(action, 2)),
        '</Private>',
      ].join('\n')];
    }
    if (!actor.presentAtStart) return [];
    if (actor.static) {
      return [[
        `<Private entityRef="${xml(name)}">`,
        '  <PrivateAction><TeleportAction><Position>',
        lines(worldPosition(actor.initial.pose, options.worldElevation, actor.id), 6),
        '  </Position></TeleportAction></PrivateAction>',
        '</Private>',
      ].join('\n')];
    }
    return [[
      `<Private entityRef="${xml(name)}">`,
      '  <PrivateAction><TeleportAction><Position>',
      lines(worldPosition(actor.initial.pose, options.worldElevation, actor.id), 6),
      '  </Position></TeleportAction></PrivateAction>',
      '  <PrivateAction><RoutingAction><AssignRouteAction>',
      lines(routeXml(routeName, points, options.worldElevation, actor.id), 6),
      '  </AssignRouteAction></RoutingAction></PrivateAction>',
      '  <PrivateAction><LongitudinalAction><SpeedAction>',
      '    <SpeedActionDynamics dynamicsShape="step" dynamicsDimension="time" value="0"/>',
      `    <SpeedActionTarget><AbsoluteTargetSpeed value="${finite(actor.initial.speedMps)}"/></SpeedActionTarget>`,
      '  </SpeedAction></LongitudinalAction></PrivateAction>',
      '</Private>',
    ].join('\n')];
  });
  const initOccluders = input.occluders.map((o) => {
    const name = identifier('occluder', o.id);
    return `<Private entityRef="${xml(name)}"><PrivateAction><TeleportAction><Position>${worldPosition({ x: o.obb.center.x, z: o.obb.center.z, headingRad: o.obb.headingRad }, options.worldElevation, o.id)}</Position></TeleportAction></PrivateAction></Private>`;
  });
  const controllers = executionMode === 'trajectory-replay' ? [] : input.signalPrograms.flatMap((program) =>
    program.mapBinding!.controllerHeadGroups!.map((group) => [
      `<TrafficSignalController name="${xml(group.controllerId)}">`,
      ...xmlSignalPhases(program).map((phase) => [
        `  <Phase name="${xml(phase.name)}" duration="${finite(phase.durationS)}" semantics="${signalSemantics(phase.semantic)}">`,
        ...group.headIds.map((headId) => `    <TrafficSignalState trafficSignalId="${xml(headId)}" state="${phase.semantic}"/>`),
        '  </Phase>',
      ].join('\n')),
      '</TrafficSignalController>',
    ].join('\n')),
  );

  const maneuverGroups = resolved.actors.flatMap(({ actor, name }) => {
    const events = actorEvents.get(actor.id)!;
    if (events.length === 0) return [];
    return [[
      `<ManeuverGroup name="${xml(identifier('group', actor.id))}" maximumExecutionCount="1">`,
      `  <Actors selectTriggeringEntities="false"><EntityRef entityRef="${xml(name)}"/></Actors>`,
      `  <Maneuver name="${xml(identifier('maneuver', actor.id))}">`,
      ...events.map((event) => lines(event, 4)),
      '  </Maneuver>',
      '</ManeuverGroup>',
    ].join('\n')];
  });

  const date = options.headerDate ?? '1970-01-01T00:00:00.000Z';
  const physics = resolvePhysicsConfig(input);
  const inputActorBackends = actorPhysicsBackends(input.actors, physics);
  const replaySignalTracks = replayTrace ? compactSignalTracks(input, replayTrace) : null;
  const headerProperties = [
    `<Property name="uniscenarios.executionMode" value="${executionMode}"/>`,
    `<Property name="uniscenarios.export.profile" value="${capabilities.report.profile}"/>`,
    `<Property name="uniscenarios.export.intent" value="${capabilities.report.intent}"/>`,
    `<Property name="uniscenarios.input.schemaVersion" value="${input.schemaVersion}"/>`,
    `<Property name="uniscenarios.input.seed" value="${xml(String(input.seed))}"/>`,
    `<Property name="uniscenarios.physics.mode" value="${physics.mode}"/>`,
    `<Property name="uniscenarios.physics.substepS" value="${finite(physics.substepS ?? (physics.mode === 'dynamic-v1' ? DYNAMIC_V1_DEFAULT_SUBSTEP_S : input.dt))}"/>`,
    `<Property name="uniscenarios.physics.actorBackends" value="${xml(Object.entries(inputActorBackends).sort(([a], [b]) => a.localeCompare(b)).map(([actorId, backend]) => `${actorId}:${backend.mode}:${backend.reason}:${backend.profile}`).join(','))}"/>`,
    `<Property name="uniscenarios.export.constructCapabilities.v1" value="${xml(JSON.stringify(capabilities.report.constructs ?? []))}"/>`,
    ...(replayTrace ? [
      `<Property name="uniscenarios.trajectoryReplay.inputHash" value="${xml(replayTrace.header.inputHash)}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.engineVersion" value="${xml(replayTrace.header.engineVersion)}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.mapId" value="${xml(replayTrace.header.mapId)}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.dt" value="${finite(replayTrace.header.dt)}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.warmupSeconds" value="${finite(replayTrace.header.warmupSeconds)}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.clipSeconds" value="${finite(replayTrace.header.clipSeconds)}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.physics.mode" value="${xml(replayTrace.header.physics.mode)}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.physics.substepS" value="${finite(replayTrace.header.physics.substepS)}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.physics.solver" value="${xml(replayTrace.header.physics.solver)}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.physics.solverVersion" value="${xml(replayTrace.header.physics.solverVersion)}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.physics.vehicleProfileDigest" value="${xml(replayTrace.header.physics.vehicleProfileDigest ?? 'none')}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.physics.actorBackends" value="${xml(Object.entries(replayTrace.header.physics.actorBackends ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([actorId, backend]) => `${actorId}:${backend.mode}:${backend.reason}:${backend.profile}`).join(','))}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.actorIds.v1" value="${xml(JSON.stringify(replayTrace.header.actorIds))}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.authoredActorIds.v1" value="${xml(JSON.stringify(input.actors.map((actor) => actor.id)))}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.actorMetadata.v1" value="${xml(JSON.stringify(replayTrace.header.actorMetadata ?? {}))}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.interactions.v1" value="${xml(JSON.stringify(input.interactions))}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.events.v1" value="${xml(JSON.stringify(replayTrace.events))}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.signals.v1" value="${xml(JSON.stringify(replaySignalTracks))}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.environment.v1" value="${xml(JSON.stringify(input.operationalConditions))}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.surfacePatches.v1" value="${xml(JSON.stringify(input.surfacePatches))}"/>`,
      `<Property name="uniscenarios.trajectoryReplay.occluders.v1" value="${xml(JSON.stringify(input.occluders))}"/>`,
      ...(input.perception
        ? [`<Property name="uniscenarios.trajectoryReplay.perception.v1" value="${xml(JSON.stringify(input.perception))}"/>`]
        : []),
      // OpenSCENARIO has no posture for a body on the ground: the polyline
      // carries where it slid to, and nothing in the standard says it is prone.
      // Declare it, so a consumer replaying this file knows the difference
      // between a pedestrian standing still and one that was run over.
      ...Object.entries(replayTrace.ticks.actors)
        .filter(([, track]) => track.downSinceS != null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([actorId, track]) =>
          `<Property name="uniscenarios.trajectoryReplay.knockedDownAtS.${xml(actorId)}" value="${finite(track.downSinceS!)}"/>`),
    ] : []),
    ...Object.entries(options.provenance ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, value]) => `<Property name="uniscenarios.provenance.${xml(key)}" value="${xml(String(value))}"/>`,
    ),
    ...(options.nearMissCriteria ?? input.nearMissCriteria?.map((criterion) => ({ ...criterion })) ?? []).flatMap((criterion, index) => {
      const prefix = `uniscenarios.nearMiss.${index}`;
      return [
        `<Property name="${prefix}.pedestrian" value="${xml(criterion.pedestrianId)}"/>`,
        `<Property name="${prefix}.target" value="${xml(criterion.targetId)}"/>`,
        `<Property name="${prefix}.clearanceM" value="${finite(criterion.clearanceM)}"/>`,
        `<Property name="${prefix}.toleranceM" value="${finite(criterion.toleranceM ?? 0.15)}"/>`,
        `<Property name="${prefix}.pass" value="${criterion.pass ?? 'auto'}"/>`,
        ...(criterion.planHash ? [`<Property name="${prefix}.planHash" value="${xml(criterion.planHash)}"/>`] : []),
      ];
    }),
    ...input.signalPrograms.flatMap((program) => [
      `<Property name="uniscenarios.signal.${xml(program.id)}.timingSource" value="${xml(program.mapBinding!.timingSource)}"/>`,
      `<Property name="uniscenarios.signal.${xml(program.id)}.junctionId" value="${xml(program.mapBinding!.junctionId)}"/>`,
      `<Property name="uniscenarios.signal.${xml(program.id)}.controllerIds" value="${xml(program.mapBinding!.controllerIds.join(','))}"/>`,
      `<Property name="uniscenarios.signal.${xml(program.id)}.headIds" value="${xml(program.mapBinding!.headIds.join(','))}"/>`,
      `<Property name="uniscenarios.signal.${xml(program.id)}.controllerHeadGroups" value="${xml(program.mapBinding!.controllerHeadGroups!.map((group) => `${group.controllerId}:${group.headIds.join('+')}`).join(';'))}"/>`,
    ]),
  ];
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OpenSCENARIO>',
    `  <FileHeader revMajor="1" revMinor="4" date="${xml(date)}" description="${xml(options.description ?? 'Concrete SimForge scenario instance')}" author="${xml(options.author ?? 'SimForge')}">`,
    ...(headerProperties.length > 0 ? [
      '    <Properties>',
      ...headerProperties.map((property) => `      ${property}`),
      '    </Properties>',
    ] : []),
    '  </FileHeader>',
    '  <ParameterDeclarations/>',
    '  <CatalogLocations/>',
    '  <RoadNetwork>',
    `    <LogicFile filepath="${xml(options.roadFile ?? `${input.mapId}.xodr`)}"/>`,
    ...(controllers.length > 0 ? ['    <TrafficSignals>', ...controllers.map((controller) => lines(controller, 6)), '    </TrafficSignals>'] : []),
    '  </RoadNetwork>',
    '  <Entities>',
    ...resolved.actors.map(({ actor, name }) => lines(actorEntity(actor, name, new Set(options.trustedAmbientActorIds ?? [])), 4)),
    ...input.occluders.map((_, i) => lines(occluderEntity(input, i), 4)),
    '  </Entities>',
    '  <Storyboard>',
    '    <Init><Actions>',
    ...(executionMode === 'trajectory-replay' ? [lines(environmentAction(input), 6)] : []),
    ...replaySignalInit.map((action) => lines(action, 6)),
    ...initPrivate.map((action) => lines(action, 6)),
    ...initOccluders.map((action) => lines(action, 6)),
    '    </Actions></Init>',
    ...(maneuverGroups.length > 0 ? [
      '    <Story name="uniscenarios_story">',
      '      <Act name="uniscenarios_act">',
      ...maneuverGroups.map((group) => lines(group, 8)),
      '        <StartTrigger><ConditionGroup><Condition name="act_start" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="0" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StartTrigger>',
      '      </Act>',
      '    </Story>',
    ] : []),
    `    <StopTrigger><ConditionGroup><Condition name="scenario_end" delay="0" conditionEdge="none"><ByValueCondition><SimulationTimeCondition value="${finite(input.warmupSeconds + input.clipSeconds)}" rule="greaterOrEqual"/></ByValueCondition></Condition></ConditionGroup></StopTrigger>`,
    '  </Storyboard>',
    '</OpenSCENARIO>',
    '',
  ].join('\n');

  return {
    format: 'xosc-1.4',
    standard: 'ASAM OpenSCENARIO XML 1.4.0',
    extension: '.xosc',
    mediaType: 'application/xml',
    content,
    profile: capabilities.report.profile,
    intent: capabilities.report.intent,
    capabilityReport: capabilities.report,
    warnings: mergeAsamWarnings(resolved.warnings, capabilities.warnings, [
      ...((options.nearMissCriteria?.length || input.nearMissCriteria?.length) ? [{
        code: 'near_miss_criterion_metadata',
        path: 'FileHeader.Properties',
        reason: 'OSC 1.4 preserves the executable condition and pedestrian trajectory; exact OBB-clearance acceptance remains SimForge metadata and must be re-evaluated from the simulator trace',
      }] : []),
      ...input.interactions.flatMap((interaction) =>
        interaction.verb === 'set' && interaction.target.key.startsWith('pose.')
          ? [{
              code: 'user_defined_animation',
              path: `interactions.${interaction.id}.target.key`,
              reason: `${interaction.target.key} is preserved with XML UserDefinedAnimation and requires a simulator-specific animation implementation`,
            }]
          : []),
    ]),
  };
}
