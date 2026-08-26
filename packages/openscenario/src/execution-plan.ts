import type { AsamConstructCapabilityEntry } from './export/types.js';
import { operationalConditionsSchema, type OperationalConditions, type SimEvent, type SimTrace } from '@simforge-oss/engine';

import { readXml, XmlReadError, type XmlElement } from './replay/xml.js';

type XmlNode = Record<string, unknown>;
type ParsedXml = readonly XmlNode[];

/** Separate from the deliberately small interactive-import limit: execution
 * packages contain one vertex per actor per fixed tick. */
export const MAX_OPENSCENARIO_EXECUTION_PLAN_BYTES = 64 * 1024 * 1024;
export interface OpenScenarioExecutionPlanOptions {
  /**
   * Evidence supplied by the caller that verified the source bytes. A decoder
   * must not recompute and thereby self-attest the digest of bytes it was handed.
   */
  readonly sourceSha256: string;
}

export interface OpenScenarioPlanSample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly headingRad: number;
  /** Signed longitudinal speed: negative means authored rear-first motion. */
  readonly speedMps: number;
  readonly present: boolean;
}

export interface OpenScenarioPlanActor {
  readonly id: string;
  readonly entityName: string;
  readonly kind: string;
  readonly static: boolean;
  readonly dims: { readonly l: number; readonly w: number; readonly h: number };
  readonly tags: readonly string[];
  readonly samples: readonly OpenScenarioPlanSample[];
}

export interface OpenScenarioSignalChange {
  readonly t: number;
  readonly state: string;
}

export interface OpenScenarioPlanSignal {
  readonly programId: string;
  readonly headIds: readonly string[];
  readonly changes: readonly OpenScenarioSignalChange[];
}

export interface OpenScenarioEnvironmentPlan {
  readonly authored: OperationalConditions;
  readonly standard: {
    readonly dateTime: string;
    readonly fractionalCloudCover: string;
    readonly precipitationType: string;
    readonly precipitationIntensity: number;
    readonly sunAzimuthRad: number;
    readonly sunElevationRad: number;
    readonly sunIlluminanceLux: number;
    readonly fogVisualRangeM: number;
    readonly frictionScaleFactor: number;
    readonly trafficSpeedFactor: number;
    readonly visibilityClass: string;
  };
}

export interface OpenScenarioExecutionPlan {
  readonly version: 1;
  readonly sourceSha256: string;
  readonly standard: 'ASAM OpenSCENARIO XML 1.4.0';
  readonly executionMode: 'trajectory-replay';
  readonly inputHash: string;
  readonly mapId: string;
  readonly dt: number;
  readonly warmupSeconds: number;
  readonly clipSeconds: number;
  readonly stopTimeS: number;
  readonly roadFile: string;
  readonly actorIds: readonly string[];
  readonly authoredActorIds: readonly string[];
  readonly actorMetadata: NonNullable<SimTrace['header']['actorMetadata']>;
  readonly actors: readonly OpenScenarioPlanActor[];
  readonly interactions: readonly unknown[];
  readonly events: readonly SimEvent[];
  readonly signals: readonly OpenScenarioPlanSignal[];
  readonly physicalSignals: Readonly<Record<string, readonly OpenScenarioSignalChange[]>>;
  readonly environment: OpenScenarioEnvironmentPlan;
  readonly surfacePatches: readonly unknown[];
  readonly occluders: readonly unknown[];
  readonly perception: unknown | null;
  readonly constructCapabilities: readonly AsamConstructCapabilityEntry[];
}

export interface OpenScenarioPlanDifference {
  readonly code: string;
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface OpenScenarioTraceComparison {
  readonly schema: 'uniscenario.openscenario-plan-parity/v1';
  readonly status: 'passed' | 'failed';
  readonly source: {
    readonly traceInputHash: string;
    readonly planInputHash: string;
    readonly xoscSha256: string;
  };
  readonly tolerances: {
    readonly positionM: number;
    readonly headingRad: number;
    readonly speedMps: number;
    readonly timeS: number;
  };
  readonly compared: {
    readonly actors: number;
    readonly actorSamples: number;
    readonly signals: number;
    readonly events: number;
  };
  readonly maxima: {
    readonly positionM: number;
    readonly headingRad: number;
    readonly speedMps: number;
    readonly timeS: number;
  };
  readonly differences: readonly OpenScenarioPlanDifference[];
}

export class OpenScenarioExecutionPlanError extends Error {
  override readonly name = 'OpenScenarioExecutionPlanError';
  constructor(readonly code: string, readonly path: string, message: string) {
    super(message);
  }
}


function nodeName(node: XmlNode): string | null {
  return Object.keys(node).find((key) => key !== ':@' && key !== '#text' && key !== '?xml') ?? null;
}

function children(node: XmlNode): ParsedXml {
  const name = nodeName(node);
  return name && Array.isArray(node[name]) ? node[name] as ParsedXml : [];
}

function attrs(node: XmlNode): Record<string, string> {
  const value = node[':@'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/^@_/, ''), decodeXmlAttribute(String(item))]));
}

function descendants(nodes: ParsedXml, name: string): XmlNode[] {
  const output: XmlNode[] = [];
  for (const node of nodes) {
    if (nodeName(node) === name) output.push(node);
    output.push(...descendants(children(node), name));
  }
  return output;
}

function first(nodes: ParsedXml, name: string): XmlNode | null {
  return descendants(nodes, name)[0] ?? null;
}

function finite(raw: string | undefined, path: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new OpenScenarioExecutionPlanError('invalid_number', path, `${path} must be finite`);
  return value;
}

function preserveOrderElement(element: XmlElement): XmlNode {
  const content: XmlNode[] = element.children.map(preserveOrderElement);
  if (element.text !== '') content.push({ '#text': element.text });
  return {
    [element.name]: content,
    ...(Object.keys(element.attributes).length > 0
      ? { ':@': Object.fromEntries(Object.entries(element.attributes).map(([name, value]) => [`@_${name}`, value])) }
      : {}),
  };
}

const TRAJECTORY_REPLAY_ELEMENTS: Readonly<Record<string, true>> = Object.fromEntries([
  'OpenSCENARIO', 'FileHeader', 'Properties', 'Property', 'ParameterDeclarations', 'CatalogLocations',
  'RoadNetwork', 'LogicFile', 'Entities', 'ScenarioObject', 'Vehicle', 'Pedestrian', 'MiscObject',
  'BoundingBox', 'Center', 'Dimensions', 'Performance', 'Axles', 'FrontAxle', 'RearAxle',
  'Storyboard', 'Init', 'Actions', 'GlobalAction', 'EnvironmentAction', 'Environment', 'TimeOfDay',
  'Weather', 'Sun', 'Fog', 'Precipitation', 'RoadCondition', 'InfrastructureAction',
  'TrafficSignalAction', 'TrafficSignalStateAction', 'Private', 'PrivateAction', 'TeleportAction',
  'Position', 'WorldPosition', 'RoutingAction', 'FollowTrajectoryAction', 'TimeReference', 'Timing',
  'TrajectoryFollowingMode', 'TrajectoryRef', 'Trajectory', 'Shape', 'Polyline', 'Vertex', 'Motion',
  'Interpolation', 'Story', 'Act', 'ManeuverGroup', 'Actors', 'EntityRef', 'Maneuver', 'Event',
  'Action', 'StartTrigger', 'ConditionGroup', 'Condition', 'ByValueCondition',
  'SimulationTimeCondition', 'EntityAction', 'DeleteEntityAction', 'AppearanceAction',
  'LightStateAction', 'LightType', 'VehicleLight', 'LightState', 'AnimationAction', 'AnimationType',
  'ComponentAnimation', 'VehicleComponent', 'AnimationState', 'UserDefinedAnimation', 'StopTrigger',
].map((name) => [name, true]));
function elementDescendants(node: XmlElement, name: string): XmlElement[] {
  return [
    ...(node.name === name ? [node] : []),
    ...node.children.flatMap((child) => elementDescendants(child, name)),
  ];
}

function profileError(code: string, node: XmlElement, message: string): never {
  throw new OpenScenarioExecutionPlanError(code, node.name, message);
}

function onlyElementChildren(node: XmlElement, allowed: readonly string[], code: string): void {
  const names = new Set(allowed);
  if (node.text.trim() !== '' || node.children.some((child) => !names.has(child.name))) {
    profileError(code, node, `<${node.name}> contains content outside the trajectory-replay profile`);
  }
}

function singleElementChild(node: XmlElement, name: string, code: string): XmlElement {
  const matches = node.children.filter((child) => child.name === name);
  if (matches.length !== 1) profileError(code, node, `<${node.name}> must contain exactly one <${name}>`);
  return matches[0]!;
}

function validateReplayTrigger(trigger: XmlElement): void {
  onlyElementChildren(trigger, ['ConditionGroup'], 'unsupported_trigger');
  const group = singleElementChild(trigger, 'ConditionGroup', 'unsupported_trigger');
  onlyElementChildren(group, ['Condition'], 'unsupported_trigger');
  const condition = singleElementChild(group, 'Condition', 'unsupported_trigger');
  if (condition.attributes.delay !== '0' || condition.attributes.conditionEdge !== 'none') {
    profileError('unsupported_trigger', condition, 'trajectory-replay triggers require delay=0 and conditionEdge=none');
  }
  onlyElementChildren(condition, ['ByValueCondition'], 'unsupported_trigger');
  const byValue = singleElementChild(condition, 'ByValueCondition', 'unsupported_trigger');
  onlyElementChildren(byValue, ['SimulationTimeCondition'], 'unsupported_trigger');
  const time = singleElementChild(byValue, 'SimulationTimeCondition', 'unsupported_trigger');
  if (time.attributes.rule !== 'greaterOrEqual') {
    profileError('unsupported_trigger', time, 'trajectory-replay time triggers require greaterOrEqual');
  }
}

function validateEventAction(action: XmlElement): void {
  onlyElementChildren(action, ['GlobalAction', 'PrivateAction'], 'unsupported_action');
  if (action.children.length !== 1) profileError('unsupported_action', action, 'event Action must contain exactly one profile action');
  const wrapper = action.children[0]!;
  if (wrapper.name === 'GlobalAction') {
    onlyElementChildren(wrapper, ['InfrastructureAction', 'EntityAction'], 'unsupported_action');
    if (wrapper.children.length !== 1) profileError('unsupported_action', wrapper, 'GlobalAction must contain exactly one profile action');
    const global = wrapper.children[0]!;
    if (global.name === 'InfrastructureAction') {
      onlyElementChildren(global, ['TrafficSignalAction'], 'unsupported_action');
      const traffic = singleElementChild(global, 'TrafficSignalAction', 'unsupported_action');
      onlyElementChildren(traffic, ['TrafficSignalStateAction'], 'unsupported_action');
      singleElementChild(traffic, 'TrafficSignalStateAction', 'unsupported_action');
      return;
    }
    onlyElementChildren(global, ['DeleteEntityAction'], 'unsupported_action');
    singleElementChild(global, 'DeleteEntityAction', 'unsupported_action');
    return;
  }
  onlyElementChildren(wrapper, ['AppearanceAction'], 'unsupported_action');
  const appearance = singleElementChild(wrapper, 'AppearanceAction', 'unsupported_action');
  onlyElementChildren(appearance, ['LightStateAction', 'AnimationAction'], 'unsupported_action');
  if (appearance.children.length !== 1) profileError('unsupported_action', appearance, 'AppearanceAction must contain exactly one profile action');
}

function validateTrajectoryReplayProfile(root: XmlElement): void {
  for (const action of elementDescendants(root, 'Action')) validateEventAction(action);
  for (const trigger of [...elementDescendants(root, 'StartTrigger'), ...elementDescendants(root, 'StopTrigger')]) {
    validateReplayTrigger(trigger);
  }
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (TRAJECTORY_REPLAY_ELEMENTS[node.name] !== true) {
      profileError('unsupported_element', node, `<${node.name}> is not defined by the trajectory-replay profile`);
    }
    pending.push(...node.children);
  }
}

function parseDocument(content: string): ParsedXml {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OPENSCENARIO_EXECUTION_PLAN_BYTES) {
    throw new OpenScenarioExecutionPlanError('invalid_size', 'document', `XOSC must contain 1..${MAX_OPENSCENARIO_EXECUTION_PLAN_BYTES} UTF-8 bytes`);
  }
  if (/<!DOCTYPE\b/i.test(content) || /<!ENTITY\b/i.test(content)) {
    throw new OpenScenarioExecutionPlanError('xml_declarations_forbidden', 'document', 'DTD and entity declarations are forbidden');
  }
  let document: XmlElement;
  try {
    document = readXml(content);
  } catch (cause) {
    if (cause instanceof XmlReadError) {
      throw new OpenScenarioExecutionPlanError('malformed_xml', 'document', cause.message);
    }
    throw cause;
  }
  if (document.name !== 'OpenSCENARIO') {
    throw new OpenScenarioExecutionPlanError('not_openscenario', 'document', 'OpenSCENARIO root is missing');
  }
  validateTrajectoryReplayProfile(document);
  return [preserveOrderElement(document)];
}

function properties(nodes: ParsedXml): Map<string, string> {
  const output = new Map<string, string>();
  for (const property of descendants(nodes, 'Property')) {
    const value = attrs(property);
    if (!value.name || value.value === undefined) continue;
    if (output.has(value.name)) {
      throw new OpenScenarioExecutionPlanError('duplicate_property', `FileHeader.Properties.${value.name}`, `duplicate property ${value.name}`);
    }
    output.set(value.name, value.value);
  }
  return output;
}

function requiredProperty(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined) throw new OpenScenarioExecutionPlanError('missing_replay_metadata', `FileHeader.Properties.${name}`, `${name} is required for fail-closed trajectory replay`);
  return value;
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&#x([0-9a-f]+);|&#([0-9]+);|&(quot|apos|lt|gt|amp);/gi, (match, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' } as const)[named!.toLowerCase() as 'quot' | 'apos' | 'lt' | 'gt' | 'amp'] ?? match;
  });
}

function jsonProperty<T>(values: ReadonlyMap<string, string>, name: string): T {
  const raw = requiredProperty(values, name);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new OpenScenarioExecutionPlanError('invalid_replay_metadata', `FileHeader.Properties.${name}`, `${name} is not valid JSON`);
  }
}

function scopedProperty(nodes: ParsedXml, name: string): string | null {
  for (const property of descendants(nodes, 'Property')) {
    const value = attrs(property);
    if (value.name === name) return value.value ?? null;
  }
  return null;
}

function scopedProperties(nodes: ParsedXml, name: string): string[] {
  return descendants(nodes, 'Property').flatMap((property) => {
    const value = attrs(property);
    return value.name === name && value.value !== undefined ? [value.value] : [];
  });
}

function eventTime(event: XmlNode): number {
  const time = first(children(event), 'SimulationTimeCondition');
  if (!time) throw new OpenScenarioExecutionPlanError('missing_event_time', `Storyboard.Event.${attrs(event).name ?? 'unnamed'}`, 'replay events must use an absolute SimulationTimeCondition');
  return finite(attrs(time).value, `Storyboard.Event.${attrs(event).name ?? 'unnamed'}.time`);
}

function extractPhysicalSignals(xml: ParsedXml): Readonly<Record<string, readonly OpenScenarioSignalChange[]>> {
  const byHead = new Map<string, OpenScenarioSignalChange[]>();
  const init = first(xml, 'Init');
  for (const action of init ? descendants(children(init), 'TrafficSignalStateAction') : []) {
    const value = attrs(action);
    if (!value.name || value.state === undefined) continue;
    byHead.set(value.name, [{ t: 0, state: value.state }]);
  }
  for (const event of descendants(xml, 'Event')) {
    const t = eventTime(event);
    for (const action of descendants(children(event), 'TrafficSignalStateAction')) {
      const value = attrs(action);
      if (!value.name || value.state === undefined) continue;
      const changes = byHead.get(value.name) ?? [];
      changes.push({ t, state: value.state });
      byHead.set(value.name, changes);
    }
  }
  return Object.fromEntries([...byHead.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function deletionTimes(xml: ParsedXml): Map<string, number> {
  const output = new Map<string, number>();
  for (const event of descendants(xml, 'Event')) {
    const t = eventTime(event);
    for (const entityAction of descendants(children(event), 'EntityAction')) {
      if (!first(children(entityAction), 'DeleteEntityAction')) continue;
      const entityRef = attrs(entityAction).entityRef;
      if (entityRef) output.set(entityRef, t);
    }
  }
  return output;
}

const EXPORTED_IDENTIFIER_KEYWORDS = new Set([
  'action', 'actor', 'and', 'as', 'bool', 'call', 'cover', 'default', 'def', 'do',
  'else', 'emit', 'enum', 'event', 'extend', 'false', 'float', 'hard', 'if', 'import',
  'in', 'inherits', 'int', 'is', 'it', 'keep', 'list', 'modifier', 'not', 'of', 'on',
  'one_of', 'or', 'parallel', 'range', 'record', 'remove_default', 'scenario', 'serial',
  'string', 'struct', 'true', 'uint', 'until', 'var', 'wait', 'with',
]);

function exportedIdentifier(prefix: string, raw: string): string {
  let stem = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!stem || /^[0-9]/.test(stem) || EXPORTED_IDENTIFIER_KEYWORDS.has(stem)) stem = `id_${stem || 'unnamed'}`;
  return `${prefix}_${stem}`;
}

function validateAppearanceStateActions(
  xml: ParsedXml,
  interactions: readonly unknown[],
  events: readonly SimEvent[],
  warmupSeconds: number,
): void {
  const storyboardEvents = new Map<string, XmlNode>();
  for (const event of descendants(xml, 'Event')) {
    const name = attrs(event).name;
    if (!name) continue;
    if (storyboardEvents.has(name)) throw new OpenScenarioExecutionPlanError('duplicate_event', `Storyboard.Event.${name}`, `duplicate event ${name}`);
    storyboardEvents.set(name, event);
  }
  for (const interaction of interactions) {
    if (!interaction || typeof interaction !== 'object' || !('id' in interaction) || typeof interaction.id !== 'string'
      || !('verb' in interaction) || interaction.verb !== 'set' || !('target' in interaction)
      || !interaction.target || typeof interaction.target !== 'object' || !('key' in interaction.target)
      || typeof interaction.target.key !== 'string') continue;
    const key = interaction.target.key;
    if (key.startsWith('rules.') || key.startsWith('signal:')) continue;
    const fired = events.find((event) => event.kind === 'trigger_fired' && event.interactionId === interaction.id);
    if (!fired) continue;
    const name = exportedIdentifier('event', interaction.id);
    const exported = storyboardEvents.get(name);
    if (!exported || descendants(children(exported), 'AppearanceAction').length === 0) {
      throw new OpenScenarioExecutionPlanError('missing_state_action', `Storyboard.Event.${name}`, `${interaction.id} fired but has no executable appearance-state action`);
    }
    const actualTime = eventTime(exported);
    const expectedTime = fired.t + warmupSeconds;
    if (Math.abs(actualTime - expectedTime) > 1e-9) {
      throw new OpenScenarioExecutionPlanError('state_action_time_mismatch', `Storyboard.Event.${name}`, `${interaction.id} state action does not occur at its fired trace time`);
    }
  }
}

function trajectorySamples(privateNode: XmlNode, path: string): OpenScenarioPlanSample[] | null {
  const trajectory = first(children(privateNode), 'Trajectory');
  if (!trajectory) return null;
  const vertices = descendants(children(trajectory), 'Vertex');
  if (vertices.length === 0) throw new OpenScenarioExecutionPlanError('empty_trajectory', path, `${path} contains no vertices`);
  return vertices.map((vertex, index) => {
    const vertexPath = `${path}.vertices.${index}`;
    const position = first(children(vertex), 'WorldPosition');
    const motion = first(children(vertex), 'Motion');
    if (!position || !motion) throw new OpenScenarioExecutionPlanError('incomplete_vertex', vertexPath, 'every replay vertex requires WorldPosition and Motion');
    const v = attrs(vertex);
    const p = attrs(position);
    const m = attrs(motion);
    return {
      t: finite(v.time, `${vertexPath}.time`),
      x: finite(p.x, `${vertexPath}.x`),
      y: finite(p.y, `${vertexPath}.y`),
      z: finite(p.z ?? '0', `${vertexPath}.z`),
      headingRad: finite(p.h ?? '0', `${vertexPath}.h`),
      speedMps: finite(m.speed_longitudinal, `${vertexPath}.speed_longitudinal`),
      present: true,
    };
  });
}

function validateIncreasingSamples(samples: readonly OpenScenarioPlanSample[], path: string): void {
  for (let index = 1; index < samples.length; index += 1) {
    if (!(samples[index]!.t > samples[index - 1]!.t)) {
      throw new OpenScenarioExecutionPlanError('non_monotonic_trajectory', `${path}.samples.${index}.t`, 'trajectory times must be strictly increasing');
    }
  }
}

function environmentPlan(xml: ParsedXml, values: ReadonlyMap<string, string>): OpenScenarioEnvironmentPlan {
  const rawAuthored = jsonProperty<unknown>(values, 'uniscenarios.trajectoryReplay.environment.v1');
  const parsed = operationalConditionsSchema.safeParse(rawAuthored);
  if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(rawAuthored)) {
    throw new OpenScenarioExecutionPlanError('invalid_environment_metadata', 'FileHeader.Properties.uniscenarios.trajectoryReplay.environment.v1', 'environment metadata must be a complete canonical OperationalConditions value');
  }
  const authored: OperationalConditions = parsed.data;
  const environment = first(xml, 'Environment');
  const time = environment ? first(children(environment), 'TimeOfDay') : null;
  const weather = environment ? first(children(environment), 'Weather') : null;
  const fog = weather ? first(children(weather), 'Fog') : null;
  const sun = weather ? first(children(weather), 'Sun') : null;
  const precipitation = weather ? first(children(weather), 'Precipitation') : null;
  const road = environment ? first(children(environment), 'RoadCondition') : null;
  if (!environment || !time || !weather || !fog || !sun || !precipitation || !road) {
    throw new OpenScenarioExecutionPlanError('incomplete_environment', 'Storyboard.Init.EnvironmentAction', 'trajectory replay must emit time, weather, fog, precipitation and road friction');
  }
  const standard = {
    dateTime: attrs(time).dateTime ?? '',
    fractionalCloudCover: attrs(weather).fractionalCloudCover ?? '',
    precipitationType: attrs(precipitation).precipitationType ?? '',
    precipitationIntensity: finite(attrs(precipitation).precipitationIntensity, 'Environment.Weather.Precipitation.precipitationIntensity'),
    sunAzimuthRad: finite(attrs(sun).azimuth, 'Environment.Weather.Sun.azimuth'),
    sunElevationRad: finite(attrs(sun).elevation, 'Environment.Weather.Sun.elevation'),
    sunIlluminanceLux: finite(attrs(sun).illuminance, 'Environment.Weather.Sun.illuminance'),
    fogVisualRangeM: finite(attrs(fog).visualRange, 'Environment.Weather.Fog.visualRange'),
    frictionScaleFactor: finite(attrs(road).frictionScaleFactor, 'Environment.RoadCondition.frictionScaleFactor'),
    trafficSpeedFactor: finite(scopedProperty(children(road), 'uniscenarios.environment.trafficSpeedFactor') ?? undefined, 'Environment.RoadCondition.Properties.trafficSpeedFactor'),
    visibilityClass: scopedProperty(children(road), 'uniscenarios.environment.visibilityClass') ?? '',
  };
  const expected = {
    clear: { cloud: 'zeroOktas', precipitation: 'dry', intensity: 0, sunElevation: 1.0472, illuminance: 100_000 },
    overcast: { cloud: 'eightOktas', precipitation: 'dry', intensity: 0, sunElevation: 0.6, illuminance: 20_000 },
    rain: { cloud: 'eightOktas', precipitation: 'rain', intensity: 0.6, sunElevation: 0.45, illuminance: 10_000 },
  }[authored.weather];
  const expectedTime = { dawn: '2020-06-21T06:00:00Z', day: '2020-06-21T12:00:00Z', dusk: '2020-06-21T18:00:00Z', night: '2020-06-21T00:00:00Z' }[authored.timeOfDay];
  const mismatches = [
    standard.dateTime === expectedTime,
    standard.fractionalCloudCover === expected.cloud,
    standard.precipitationType === expected.precipitation,
    Math.abs(standard.precipitationIntensity - expected.intensity) <= 1e-9,
    Math.abs(standard.sunAzimuthRad) <= 1e-9,
    Math.abs(standard.sunElevationRad - expected.sunElevation) <= 1e-9,
    Math.abs(standard.sunIlluminanceLux - expected.illuminance) <= 1e-9,
    Math.abs(standard.fogVisualRangeM - Math.min(100_000, authored.effects.visibilityRangeM)) <= 1e-9,
    Math.abs(standard.frictionScaleFactor - authored.effects.frictionScale) <= 1e-9,
    Math.abs(standard.trafficSpeedFactor - authored.effects.trafficSpeedFactor) <= 1e-9,
    standard.visibilityClass === authored.visibility,
  ];
  if (mismatches.some((matches) => !matches)) {
    throw new OpenScenarioExecutionPlanError('environment_metadata_mismatch', 'Storyboard.Init.EnvironmentAction', 'standard environment fields disagree with exact SimForge environment metadata');
  }
  return { authored, standard };
}

function sameChanges(left: readonly OpenScenarioSignalChange[], right: readonly OpenScenarioSignalChange[]): boolean {
  return left.length === right.length && left.every((item, index) => item.state === right[index]!.state && Math.abs(item.t - right[index]!.t) <= 1e-9);
}

function assertUniqueLedgerIds(values: readonly unknown[], path: string): void {
  const ids = values.map((value) => value && typeof value === 'object' && 'id' in value ? value.id : null);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new OpenScenarioExecutionPlanError('invalid_replay_metadata', path, `${path} must contain unique string ids`);
  }
}

function validateCapabilities(
  capabilities: readonly AsamConstructCapabilityEntry[],
  actors: readonly string[],
  interactions: readonly unknown[],
  signals: readonly OpenScenarioPlanSignal[],
  surfacePatches: readonly unknown[],
  occluders: readonly unknown[],
  hasPerception: boolean,
): void {
  const byPath = new Map(capabilities.map((entry) => [entry.sourcePath, entry]));
  const idOf = (value: unknown): string | undefined => value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' ? value.id : undefined;
  const required: Array<{ path: string; id?: string }> = [
    ...actors.map((id, index) => ({ path: `actors.${index}`, id })),
    ...interactions.map((value, index) => ({ path: `interactions.${index}`, id: idOf(value) })),
    ...signals.map((value, index) => ({ path: `signalPrograms.${index}`, id: value.programId })),
    ...surfacePatches.map((value, index) => ({ path: `surfacePatches.${index}`, id: idOf(value) })),
    ...occluders.map((value, index) => ({ path: `occluders.${index}`, id: idOf(value) })),
    { path: 'operationalConditions' },
    { path: 'physics' },
    ...(hasPerception ? [{ path: 'perception' }] : []),
  ];
  const missing = required.filter(({ path, id }) => {
    const capability = byPath.get(path);
    return !capability || (id !== undefined && capability.sourceId !== id);
  }).map(({ path }) => path);
  if (missing.length > 0) throw new OpenScenarioExecutionPlanError('missing_capability_disposition', 'FileHeader.Properties.uniscenarios.export.constructCapabilities.v1', `missing dispositions for ${missing.join(', ')}`);
}

export function extractOpenScenarioExecutionPlan(
  content: string,
  options: OpenScenarioExecutionPlanOptions,
): OpenScenarioExecutionPlan {
  if (!/^[a-f0-9]{64}$/i.test(options.sourceSha256)) {
    throw new OpenScenarioExecutionPlanError('invalid_source_digest', 'sourceSha256', 'sourceSha256 must be a 64-character hexadecimal SHA-256 digest');
  }
  const xml = parseDocument(content);
  const header = first(xml, 'FileHeader');
  const headerAttrs = header ? attrs(header) : {};
  if (headerAttrs.revMajor !== '1' || headerAttrs.revMinor !== '4') {
    throw new OpenScenarioExecutionPlanError('unsupported_version', 'FileHeader', 'execution-plan extraction requires OpenSCENARIO XML 1.4');
  }
  const values = properties(header ? children(header) : []);
  if (requiredProperty(values, 'uniscenarios.executionMode') !== 'trajectory-replay') {
    throw new OpenScenarioExecutionPlanError('unsupported_execution_mode', 'FileHeader.Properties.uniscenarios.executionMode', 'execution-plan extraction requires trajectory-replay mode');
  }
  if (
    requiredProperty(values, 'uniscenarios.export.profile') !== 'xml-1.4-trajectory-replay'
    || requiredProperty(values, 'uniscenarios.export.intent') !== 'trajectory-replay'
  ) {
    throw new OpenScenarioExecutionPlanError('unknown_profile', 'FileHeader.Properties', 'unrecognized SimForge trajectory-replay profile markers');
  }
  const actorIds = jsonProperty<string[]>(values, 'uniscenarios.trajectoryReplay.actorIds.v1');
  const authoredActorIds = jsonProperty<string[]>(values, 'uniscenarios.trajectoryReplay.authoredActorIds.v1');
  if (!Array.isArray(actorIds) || actorIds.some((id) => typeof id !== 'string') || new Set(actorIds).size !== actorIds.length) {
    throw new OpenScenarioExecutionPlanError('invalid_actor_ids', 'FileHeader.Properties.uniscenarios.trajectoryReplay.actorIds.v1', 'actor ids must be a unique string array');
  }
  if (!Array.isArray(authoredActorIds) || authoredActorIds.some((id) => typeof id !== 'string')
    || authoredActorIds.length !== actorIds.length || new Set(authoredActorIds).size !== authoredActorIds.length
    || actorIds.some((id) => !authoredActorIds.includes(id))) {
    throw new OpenScenarioExecutionPlanError('invalid_authored_actor_ids', 'FileHeader.Properties.uniscenarios.trajectoryReplay.authoredActorIds.v1', 'authored actor ids must be an ordered permutation of the trace actor closure');
  }
  const interactions = jsonProperty<unknown[]>(values, 'uniscenarios.trajectoryReplay.interactions.v1');
  const events = jsonProperty<SimEvent[]>(values, 'uniscenarios.trajectoryReplay.events.v1');
  const signals = jsonProperty<OpenScenarioPlanSignal[]>(values, 'uniscenarios.trajectoryReplay.signals.v1');
  const surfacePatches = jsonProperty<unknown[]>(values, 'uniscenarios.trajectoryReplay.surfacePatches.v1');
  const occluders = jsonProperty<unknown[]>(values, 'uniscenarios.trajectoryReplay.occluders.v1');
  const actorMetadata = jsonProperty<NonNullable<SimTrace['header']['actorMetadata']>>(values, 'uniscenarios.trajectoryReplay.actorMetadata.v1');
  const capabilities = jsonProperty<AsamConstructCapabilityEntry[]>(values, 'uniscenarios.export.constructCapabilities.v1');
  if (![interactions, events, signals, surfacePatches, occluders, capabilities].every(Array.isArray)) {
    throw new OpenScenarioExecutionPlanError('invalid_replay_metadata', 'FileHeader.Properties', 'replay ledgers must be arrays');
  }
  assertUniqueLedgerIds(interactions, 'FileHeader.Properties.uniscenarios.trajectoryReplay.interactions.v1');
  assertUniqueLedgerIds(surfacePatches, 'FileHeader.Properties.uniscenarios.trajectoryReplay.surfacePatches.v1');
  assertUniqueLedgerIds(occluders, 'FileHeader.Properties.uniscenarios.trajectoryReplay.occluders.v1');
  validateCapabilities(capabilities, authoredActorIds, interactions, signals, surfacePatches, occluders, values.has('uniscenarios.trajectoryReplay.perception.v1'));

  const physicalSignals = extractPhysicalSignals(xml);
  const logicalSignalIds = new Set<string>();
  for (const signal of signals) {
    if (!signal || typeof signal.programId !== 'string' || !Array.isArray(signal.headIds) || !Array.isArray(signal.changes)) {
      throw new OpenScenarioExecutionPlanError('invalid_signal_metadata', 'FileHeader.Properties.uniscenarios.trajectoryReplay.signals.v1', 'signal ledger is malformed');
    }
    if (logicalSignalIds.has(signal.programId) || new Set(signal.headIds).size !== signal.headIds.length
      || signal.changes.length === 0
      || signal.changes.some((change, index) => !change || !Number.isFinite(change.t) || typeof change.state !== 'string'
        || (index === 0 ? Math.abs(change.t) > 1e-9 : change.t <= signal.changes[index - 1]!.t))) {
      throw new OpenScenarioExecutionPlanError('invalid_signal_metadata', `signals.${signal.programId}`, 'signal ids/head ids must be unique and changes must begin at t=0 in strictly increasing order');
    }
    logicalSignalIds.add(signal.programId);
    for (const headId of signal.headIds) {
      const physical = physicalSignals[headId];
      if (!physical || !sameChanges(signal.changes, physical)) {
        throw new OpenScenarioExecutionPlanError('signal_state_mismatch', `signals.${signal.programId}.${headId}`, 'logical signal ledger and physical OpenSCENARIO state actions disagree');
      }
    }
  }
  const expectedHeadIds = signals.flatMap((signal) => signal.headIds).sort();
  const physicalHeadIds = Object.keys(physicalSignals).sort();
  if (JSON.stringify(expectedHeadIds) !== JSON.stringify(physicalHeadIds)) {
    throw new OpenScenarioExecutionPlanError('signal_head_closure_mismatch', 'Storyboard', 'physical signal actions do not exactly match the logical signal head closure');
  }

  const stopTrigger = first(xml, 'StopTrigger');
  const stopCondition = stopTrigger ? first(children(stopTrigger), 'SimulationTimeCondition') : null;
  const stopTimeS = finite(stopCondition ? attrs(stopCondition).value : undefined, 'Storyboard.StopTrigger.time');
  const dt = finite(requiredProperty(values, 'uniscenarios.trajectoryReplay.dt'), 'FileHeader.Properties.uniscenarios.trajectoryReplay.dt');
  const inputHash = requiredProperty(values, 'uniscenarios.trajectoryReplay.inputHash');
  const mapId = requiredProperty(values, 'uniscenarios.trajectoryReplay.mapId');
  const effectiveWarmup = finite(
    requiredProperty(values, 'uniscenarios.trajectoryReplay.warmupSeconds'),
    'FileHeader.Properties.uniscenarios.trajectoryReplay.warmupSeconds',
  );
  const clipSeconds = finite(
    requiredProperty(values, 'uniscenarios.trajectoryReplay.clipSeconds'),
    'FileHeader.Properties.uniscenarios.trajectoryReplay.clipSeconds',
  );
  if (dt <= 0 || effectiveWarmup < 0 || clipSeconds <= 0 || stopTimeS <= 0) {
    throw new OpenScenarioExecutionPlanError('invalid_replay_clock', 'FileHeader.Properties', 'dt and clip duration must be positive and warmup must be non-negative');
  }
  if (Math.abs(effectiveWarmup + clipSeconds - stopTimeS) > 1e-8) {
    throw new OpenScenarioExecutionPlanError('duration_mismatch', 'Storyboard.StopTrigger.time', 'warmup + clip duration does not match the OpenSCENARIO stop time');
  }
  validateAppearanceStateActions(xml, interactions, events, effectiveWarmup);
  const road = first(xml, 'LogicFile');
  const roadFile = road ? attrs(road).filepath : undefined;
  if (!roadFile) throw new OpenScenarioExecutionPlanError('missing_road_file', 'RoadNetwork.LogicFile', 'road file is required');

  const deletes = deletionTimes(xml);
  const privateByEntity = new Map(descendants(xml, 'Private').map((node) => [attrs(node).entityRef, node]));
  const actors: OpenScenarioPlanActor[] = [];
  for (const [entityIndex, entity] of descendants(xml, 'ScenarioObject').entries()) {
    const entityName = attrs(entity).name;
    const id = scopedProperty(children(entity), 'uniscenarios.actorId');
    if (!id) continue; // occluders and other fixed scene objects are not trace actors
    if (!entityName) throw new OpenScenarioExecutionPlanError('missing_entity_name', `Entities.${entityIndex}`, 'trace actor entity name is required');
    const privateNode = privateByEntity.get(entityName);
    if (!privateNode) throw new OpenScenarioExecutionPlanError('missing_actor_init', `Storyboard.Init.${entityName}`, 'trace actor has no private initialization');
    const dynamicSamples = trajectorySamples(privateNode, `actors.${id}`);
    if (actorMetadata[id]?.static === false && !dynamicSamples) {
      throw new OpenScenarioExecutionPlanError('missing_trajectory', `actors.${id}`, `dynamic actor ${id} has no trajectory`);
    }
    const init = first(children(privateNode), 'TeleportAction');
    const initWorld = init ? first(children(init), 'WorldPosition') : null;
    if (!initWorld) throw new OpenScenarioExecutionPlanError('missing_actor_pose', `Storyboard.Init.${entityName}`, 'trace actor requires an initial WorldPosition');
    const initial = attrs(initWorld);
    const entityKindNode = ['Vehicle', 'Pedestrian', 'MiscObject']
      .map((name) => first(children(entity), name))
      .find((node): node is XmlNode => node !== null);
    const kind = scopedProperty(children(entity), 'uniscenarios.actorKind')
      ?? (entityKindNode ? nodeName(entityKindNode) : null)
      ?? 'unknown';
    const dimensionsNode = first(children(entity), 'Dimensions');
    if (!dimensionsNode) throw new OpenScenarioExecutionPlanError('missing_actor_dimensions', `Entities.${entityName}.BoundingBox`, 'actor dimensions are required');
    const dimensions = attrs(dimensionsNode);
    const dims = {
      l: finite(dimensions.length, `Entities.${entityName}.Dimensions.length`),
      w: finite(dimensions.width, `Entities.${entityName}.Dimensions.width`),
      h: finite(dimensions.height, `Entities.${entityName}.Dimensions.height`),
    };
    const tags = scopedProperties(children(entity), 'uniscenarios.tag');
    let samples = dynamicSamples ?? [{
      t: 0,
      x: finite(initial.x, `actors.${id}.initial.x`),
      y: finite(initial.y, `actors.${id}.initial.y`),
      z: finite(initial.z ?? '0', `actors.${id}.initial.z`),
      headingRad: finite(initial.h ?? '0', `actors.${id}.initial.h`),
      speedMps: 0,
      present: true,
    }];
    validateIncreasingSamples(samples, `actors.${id}`);
    if (dynamicSamples && (
      Math.abs(samples[0]!.t) > 1e-9
      || Math.abs(samples.at(-1)!.t - stopTimeS) > 1e-8
      || samples.slice(1).some((sample, index) => Math.abs((sample.t - samples[index]!.t) - dt) > 1e-8)
    )) {
      throw new OpenScenarioExecutionPlanError('invalid_actor_timeline', `actors.${id}.samples`, 'trajectory must cover [0, stopTime] on the declared fixed dt');
    }
    const deletion = deletes.get(entityName);
    if (deletion !== undefined) samples = samples.map((sample) => ({ ...sample, present: sample.t < deletion }));
    const metadata = actorMetadata[id];
    if (!metadata || metadata.kind !== kind || metadata.static !== (dynamicSamples === null)
      || JSON.stringify(metadata.dims) !== JSON.stringify(dims)
      || JSON.stringify(metadata.tags) !== JSON.stringify(tags)) {
      throw new OpenScenarioExecutionPlanError('actor_metadata_mismatch', `Entities.${entityName}`, 'standard entity fields disagree with exact actor metadata');
    }
    actors.push({ id, entityName, kind, static: dynamicSamples === null, dims, tags, samples });
  }
  const parsedIds = actors.map((actor) => actor.id).sort();
  const expectedIds = [...actorIds].sort();
  if (JSON.stringify(parsedIds) !== JSON.stringify(expectedIds)) {
    throw new OpenScenarioExecutionPlanError('actor_identity_mismatch', 'Entities', 'trajectory actors do not exactly match the embedded actor-id closure');
  }
  const dynamicTimeline = actors.find((actor) => !actor.static)?.samples.map((sample) => sample.t)
    ?? Array.from({ length: Math.round(stopTimeS / dt) + 1 }, (_, index) => index * dt);
  const expandedActors = actors.map((actor): OpenScenarioPlanActor => {
    if (!actor.static) {
      if (actor.samples.length !== dynamicTimeline.length || actor.samples.some((sample, index) => Math.abs(sample.t - dynamicTimeline[index]!) > 1e-9)) {
        throw new OpenScenarioExecutionPlanError('actor_timeline_mismatch', `actors.${actor.id}.samples`, 'all actor trajectories must share one fixed-step timeline');
      }
      return actor;
    }
    const initial = actor.samples[0]!;
    const deletion = deletes.get(actor.entityName);
    return {
      ...actor,
      samples: dynamicTimeline.map((t) => ({ ...initial, t, present: deletion === undefined || t < deletion })),
    };
  });

  return {
    version: 1,
    sourceSha256: options.sourceSha256,
    standard: 'ASAM OpenSCENARIO XML 1.4.0',
    executionMode: 'trajectory-replay',
    inputHash,
    mapId,
    dt,
    warmupSeconds: effectiveWarmup,
    clipSeconds,
    stopTimeS,
    roadFile,
    actorIds,
    authoredActorIds,
    actorMetadata,
    actors: expandedActors,
    interactions,
    events,
    signals,
    physicalSignals,
    environment: environmentPlan(xml, values),
    surfacePatches,
    occluders,
    perception: values.has('uniscenarios.trajectoryReplay.perception.v1')
      ? jsonProperty<unknown>(values, 'uniscenarios.trajectoryReplay.perception.v1')
      : null,
    constructCapabilities: capabilities,
  };
}

function angleDifference(left: number, right: number): number {
  return Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
}

function signalStateAt(changes: readonly OpenScenarioSignalChange[], t: number): string | null {
  let state: string | null = null;
  for (const change of changes) {
    if (change.t > t + 1e-9) break;
    state = change.state;
  }
  return state;
}

export function compareTraceToOpenScenarioPlan(
  trace: SimTrace,
  plan: OpenScenarioExecutionPlan,
  tolerances: Partial<OpenScenarioTraceComparison['tolerances']> = {},
): OpenScenarioTraceComparison {
  const limits = { positionM: 1e-8, headingRad: 1e-8, speedMps: 1e-8, timeS: 1e-8, ...tolerances };
  const differences: OpenScenarioPlanDifference[] = [];
  const maxima = { positionM: 0, headingRad: 0, speedMps: 0, timeS: 0 };
  const difference = (code: string, path: string, expected: unknown, actual: unknown) => differences.push({ code, path, expected, actual });
  if (trace.header.inputHash !== plan.inputHash) difference('input_hash_mismatch', 'source.inputHash', trace.header.inputHash, plan.inputHash);
  if (trace.header.mapId !== plan.mapId) difference('map_id_mismatch', 'source.mapId', trace.header.mapId, plan.mapId);
  if (Math.abs(trace.header.dt - plan.dt) > limits.timeS) difference('dt_mismatch', 'source.dt', trace.header.dt, plan.dt);
  if (Math.abs(trace.header.warmupSeconds - plan.warmupSeconds) > limits.timeS) difference('warmup_mismatch', 'source.warmupSeconds', trace.header.warmupSeconds, plan.warmupSeconds);
  if (Math.abs(trace.header.clipSeconds - plan.clipSeconds) > limits.timeS) difference('clip_duration_mismatch', 'source.clipSeconds', trace.header.clipSeconds, plan.clipSeconds);
  const expectedIds = [...trace.header.actorIds].sort();
  const actualIds = [...plan.actorIds].sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) difference('actor_closure_mismatch', 'actors', expectedIds, actualIds);
  if (JSON.stringify(trace.events) !== JSON.stringify(plan.events)) difference('event_ledger_mismatch', 'events', trace.events, plan.events);
  if (JSON.stringify(trace.header.actorMetadata ?? {}) !== JSON.stringify(plan.actorMetadata)) {
    difference('actor_metadata_mismatch', 'actorMetadata', trace.header.actorMetadata ?? {}, plan.actorMetadata);
  }
  if (JSON.stringify(trace.header.operationalConditions ?? null) !== JSON.stringify(plan.environment.authored)) {
    difference('environment_mismatch', 'environment.authored', trace.header.operationalConditions ?? null, plan.environment.authored);
  }

  let sampleCount = 0;
  for (const actorId of expectedIds) {
    const track = trace.ticks.actors[actorId];
    const actor = plan.actors.find((candidate) => candidate.id === actorId);
    if (!track || !actor) continue;
    if (actor.samples.length !== trace.ticks.t.length) {
      difference('sample_count_mismatch', `actors.${actorId}.samples`, trace.ticks.t.length, actor.samples.length);
      continue;
    }
    for (let index = 0; index < trace.ticks.t.length; index += 1) {
      sampleCount += 1;
      const expectedT = trace.ticks.t[index]! + trace.header.warmupSeconds;
      const sample = actor.samples[index]!;
      const timeError = Math.abs(sample.t - expectedT);
      const positionError = Math.hypot(sample.x - track.x[index]!, sample.y - track.y[index]!);
      const headingError = angleDifference(sample.headingRad, track.headingRad[index]!);
      const signedSpeed = track.speedMps[index]! * (track.motionDirection?.[index] ?? 1);
      const speedError = Math.abs(sample.speedMps - signedSpeed);
      maxima.timeS = Math.max(maxima.timeS, timeError);
      maxima.positionM = Math.max(maxima.positionM, positionError);
      maxima.headingRad = Math.max(maxima.headingRad, headingError);
      maxima.speedMps = Math.max(maxima.speedMps, speedError);
      const path = `actors.${actorId}.samples.${index}`;
      if (timeError > limits.timeS) difference('sample_time_mismatch', `${path}.t`, expectedT, sample.t);
      if (positionError > limits.positionM) difference('sample_position_mismatch', `${path}.position`, [track.x[index], track.y[index]], [sample.x, sample.y]);
      if (headingError > limits.headingRad) difference('sample_heading_mismatch', `${path}.headingRad`, track.headingRad[index], sample.headingRad);
      if (speedError > limits.speedMps) difference('sample_signed_speed_mismatch', `${path}.speedMps`, signedSpeed, sample.speedMps);
      const expectedPresent = track.present[index] === 1;
      if (sample.present !== expectedPresent) difference('sample_presence_mismatch', `${path}.present`, expectedPresent, sample.present);
    }
  }

  const signalIds = Object.keys(trace.ticks.signals ?? {}).sort();
  const planSignalIds = plan.signals.map((signal) => signal.programId).sort();
  if (JSON.stringify(signalIds) !== JSON.stringify(planSignalIds)) difference('signal_closure_mismatch', 'signals', signalIds, planSignalIds);
  for (const signalId of signalIds) {
    const track = trace.ticks.signals![signalId]!;
    const signal = plan.signals.find((candidate) => candidate.programId === signalId);
    if (!signal) {
      difference('signal_missing', `signals.${signalId}`, 'present', 'missing');
      continue;
    }
    for (let index = 0; index < trace.ticks.t.length; index += 1) {
      const t = trace.ticks.t[index]! + trace.header.warmupSeconds;
      const actual = signalStateAt(signal.changes, t);
      if (actual !== track.phase[index]) difference('signal_state_mismatch', `signals.${signalId}.${index}`, track.phase[index], actual);
    }
  }

  return {
    schema: 'uniscenario.openscenario-plan-parity/v1',
    status: differences.length === 0 ? 'passed' : 'failed',
    source: { traceInputHash: trace.header.inputHash, planInputHash: plan.inputHash, xoscSha256: plan.sourceSha256 },
    tolerances: limits,
    compared: { actors: expectedIds.length, actorSamples: sampleCount, signals: signalIds.length, events: trace.events.length },
    maxima,
    differences,
  };
}
