/** Complete UI-independent authoring contracts for every v2 interaction form. */

import {
  CONTINUOUS_VERBS,
  DYNAMICS_CONSTRAINTS,
  DYNAMICS_SHAPES,
  InteractionSchema,
  SET_KEY_REGISTRY,
  VERBS,
  checkSetValue,
  type Condition,
  type Dynamics,
  type Interaction,
  type SetKeyDecl,
  type SetValue,
  type Trigger,
  type Verb,
} from '@simforge-oss/scenario';

/** A member of the canonical interaction union narrowed by its verb. */
export type InteractionForVerb<V extends Verb> = Extract<Interaction, { verb: V }>;
/** The exact target shape accepted by one verb. */
export type InteractionTargetForVerb<V extends Verb> = InteractionForVerb<V>['target'];
/** An interaction before a deterministic editor id is supplied. */
export type InteractionDraft<V extends Verb = Verb> = V extends Verb
  ? Omit<InteractionForVerb<V>, 'id'> & { readonly id?: string }
  : never;

export interface TargetVariant<V extends Verb = Verb> {
  readonly id: string;
  readonly label: string;
  readonly verb: V;
  readonly target: InteractionTargetForVerb<V>;
}

export interface SetTargetVariant extends TargetVariant<'set'> {
  readonly declaration: SetKeyDecl;
  /** `@world` for environment/control keys, otherwise a normal role id. */
  readonly actor: string;
}

/** A target variant retaining the relation between its verb and target. */
export type AnyTargetVariant = { [V in Verb]: TargetVariant<V> }[Verb];
type TargetVariantsByVerb = { readonly [V in Verb]: readonly TargetVariant<V>[] };

const ROLE = 'actor_1';
const OTHER_ROLE = 'actor_2';
const FEATURE = 'feature_1';

/** Every trigger form, with deterministic schema-legal defaults. */
export const TRIGGER_DEFAULTS: Readonly<Record<Trigger['kind'], Trigger>> = {
  at: { kind: 'at', t: 0 },
  after: { kind: 'after', of: 'interaction_1', event: 'start', delayS: 0 },
  when: { kind: 'when', condition: { kind: 'distance', from: ROLE, to: { role: OTHER_ROLE }, measure: 'alongLane', op: '<=', valueM: 12 }, byLatest: 10, ifNever: 'skip' },
  arrival: { kind: 'arrival', of: ROLE, at: { feature: FEATURE, at: 'entry' }, syncWith: OTHER_ROLE, ttc: 2 },
};

/** Every leaf and shallow logical condition form. Callers edit values directly. */
export const CONDITION_DEFAULTS: Readonly<Record<string, Condition>> = {
  distance: { kind: 'distance', from: ROLE, to: { role: OTHER_ROLE }, measure: 'alongLane', op: '<=', valueM: 12 },
  ttc: { kind: 'ttc', of: ROLE, to: OTHER_ROLE, op: '<=', valueS: 2 },
  headway: { kind: 'headway', of: ROLE, to: OTHER_ROLE, op: '<=', valueS: 1.5 },
  reaches: { kind: 'reaches', of: ROLE, region: { feature: FEATURE, at: 'entry' }, toleranceM: 1 },
  speed: { kind: 'speed', of: ROLE, op: '>=', valueKph: 30 },
  signal: { kind: 'signal', signal: { handle: 'signal_1' }, phase: 'green', minDurationS: 0 },
  visible: { kind: 'visible', of: ROLE, to: OTHER_ROLE, visible: true, minFraction: 0.5 },
  detected: { kind: 'detected', of: ROLE, by: OTHER_ROLE, sensor: 'camera_1', detected: true },
  standstill: { kind: 'standstill', of: ROLE, forS: 1 },
  collision: { kind: 'collision', of: ROLE, with: OTHER_ROLE },
  and: { kind: 'and', operands: [{ kind: 'distance', from: ROLE, to: { role: OTHER_ROLE }, measure: 'alongLane', op: '<=', valueM: 12 }, { kind: 'speed', of: ROLE, op: '>=', valueKph: 30 }] },
  or: { kind: 'or', operands: [{ kind: 'distance', from: ROLE, to: { role: OTHER_ROLE }, measure: 'alongLane', op: '<=', valueM: 12 }, { kind: 'collision', of: ROLE, with: OTHER_ROLE }] },
  not: { kind: 'not', operand: { kind: 'visible', of: ROLE, to: OTHER_ROLE, visible: true } },
};

/** All shape/constraint combinations; the editor never silently substitutes one. */
export const DYNAMICS_DEFAULTS: readonly Dynamics[] = DYNAMICS_SHAPES.flatMap((shape) =>
  DYNAMICS_CONSTRAINTS.map((constraint) => ({ shape, constraint, value: constraint === 'rate' ? 1 : 2 })),
);

const target = <V extends Verb>(id: string, label: string, verb: V, value: InteractionTargetForVerb<V>): TargetVariant<V> => ({ id, label, verb, target: value });

/** Every target discriminant accepted by each of the seven verbs. */
export const TARGET_VARIANTS = {
  speed: [target('speed.absolute', 'Absolute speed', 'speed', { mode: 'absolute', valueKph: 48 }), target('speed.delta', 'Speed delta', 'speed', { mode: 'delta', deltaKph: 10 }), target('speed.factor', 'Speed factor', 'speed', { mode: 'factor', factor: 1.1 }), target('speed.match', 'Match role speed', 'speed', { mode: 'match', role: OTHER_ROLE, offsetKph: 0 }), target('speed.stop', 'Stop', 'speed', { mode: 'stop' }), target('speed.resume', 'Resume', 'speed', { mode: 'resume' })],
  gap: [target('gap.time', 'Time gap', 'gap', { role: OTHER_ROLE, value: 1.5, unit: 'time' }), target('gap.distance', 'Distance gap', 'gap', { role: OTHER_ROLE, value: 12, unit: 'distance' })],
  changeLane: [target('lane.relative', 'Relative lane', 'changeLane', { mode: 'relative', dk: 1 }), target('lane.absolute', 'Absolute lane', 'changeLane', { mode: 'absolute', k: 1 }), target('lane.toRole', 'Lane of role', 'changeLane', { mode: 'toRole', role: OTHER_ROLE })],
  laneOffset: [target('laneOffset.center', 'Lane offset', 'laneOffset', { tFrac: 0, reference: 'lane_center' })],
  route: [
    target('route.turn', 'Feature turn', 'route', { mode: 'turn', feature: FEATURE, turn: 'left' }), target('route.nextJunction', 'Next junction', 'route', { mode: 'nextJunction', turn: 'straight' }), target('route.toFeature', 'To feature', 'route', { mode: 'toFeature', feature: FEATURE }), target('route.crossing', 'Crossing', 'route', { mode: 'crossing', feature: FEATURE, fromFrac: 0, toFrac: 1 }),
    target('route.polyline', 'Frame polyline', 'route', { mode: 'polyline', points: [{ laneOffset: 0, s: 0, tFrac: 0, headingOffsetRad: 0 }, { laneOffset: 0, s: 10, tFrac: 0, headingOffsetRad: 0 }] }), target('route.customRoute', 'Scene route', 'route', { mode: 'customRoute', points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] }), target('route.customTimedRoute', 'Timed scene route', 'route', { mode: 'customTimedRoute', points: [{ timeS: 0, x: 0, z: 0 }, { timeS: 1, x: 10, z: 0 }] }), target('route.lanePath', 'Lane path', 'route', { mode: 'lanePath', lanes: ['road_1_lane_-1'] }), target('route.acquire', 'Acquire pose', 'route', { mode: 'acquire', pose: { laneOffset: 0, s: 10, tFrac: 0, headingOffsetRad: 0 } }), target('route.nearMiss', 'Near miss', 'route', { mode: 'nearMiss', target: OTHER_ROLE, clearanceM: 0.5, pass: 'auto', minSpeedKph: 1.8, maxSpeedKph: 10.8 }),
  ],
  exist: [target('exist.present', 'Present', 'exist', { state: 'present' }), target('exist.absent', 'Absent', 'exist', { state: 'absent' })],
  set: [] as readonly TargetVariant<'set'>[],
} as const satisfies TargetVariantsByVerb;

/** Replace human wildcard markers with stable concrete ids suitable for a document draft. */
export function concreteSetKey(declaration: SetKeyDecl): string {
  return declaration.key.replace('<handle>', 'signal_1').replace('<id>', 'control_1').replace('<feature>', FEATURE).replace('<approach>', 'subject');
}

/** A legal value-bearing default for each declared set key. */
export function defaultSetValue(declaration: SetKeyDecl): SetValue {
  switch (declaration.valueType) {
    case 'boolean': return true;
    case 'number': return declaration.range ? (declaration.range[0] + declaration.range[1]) / 2 : 0;
    case 'enum': return declaration.values?.[0] ?? '';
    case 'string': return 'program_1';
  }
}

/** Every registry entry, including concrete representatives of all wildcard patterns. */
export const SET_TARGET_VARIANTS: readonly SetTargetVariant[] = SET_KEY_REGISTRY.map((declaration) => {
  const key = concreteSetKey(declaration);
  const value = defaultSetValue(declaration);
  const result = checkSetValue(key, value);
  if (!result.ok) throw new Error(`invalid editor set default for ${key}: ${result.message}`);
  return { id: `set.${key.replace(/[^A-Za-z0-9_-]/g, '_')}`, label: declaration.description, verb: 'set', target: { key, value }, declaration, actor: declaration.appliesTo === 'world' ? '@world' : ROLE };
});

/** The entire command palette in one deterministic order. */
export const INTERACTION_PALETTE: readonly AnyTargetVariant[] = [...TARGET_VARIANTS.speed, ...TARGET_VARIANTS.gap, ...TARGET_VARIANTS.changeLane, ...TARGET_VARIANTS.laneOffset, ...TARGET_VARIANTS.route, ...TARGET_VARIANTS.exist, ...SET_TARGET_VARIANTS];

/** Stable editor ids for a command created without an externally supplied id. */
export function interactionDraftId(verb: Verb, actor: string, ordinal = 0): string {
  const safeActor = actor.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]+/, 'actor_') || 'actor';
  const safeOrdinal = Number.isFinite(ordinal) ? Math.max(0, Math.floor(ordinal)) : 0;
  return `${verb}_${safeActor}_${safeOrdinal}`.slice(0, 64);
}

/** Parse and normalise an exact editor command through the canonical schema. */
export function authorInteraction<V extends Verb>(draft: InteractionDraft<V>): InteractionForVerb<V> {
  const id = draft.id ?? interactionDraftId(draft.verb, draft.actor);
  return InteractionSchema.parse({ ...draft, id }) as InteractionForVerb<V>;
}

/** Build a fully editable interaction from a palette target with explicit timing semantics. */
export function interactionFromTarget<V extends Verb>(options: {
  readonly id?: string; readonly actor: string; readonly ordinal?: number; readonly label?: string; readonly trigger?: Trigger; readonly until?: Trigger; readonly target: InteractionTargetForVerb<V>; readonly verb: V; readonly dynamics?: Dynamics; readonly maneuverDurationS?: number; readonly maneuverStyle?: 'cautious' | 'normal' | 'assertive';
}): InteractionForVerb<V> {
  const { id, ordinal, ...draft } = options;
  return authorInteraction({ ...draft, id: id ?? interactionDraftId(options.verb, options.actor, ordinal), trigger: options.trigger ?? TRIGGER_DEFAULTS.at } as unknown as InteractionDraft<V>);
}

/** Whether a verb needs dynamics before a document is structurally valid. */
export function requiresDynamics(verb: Verb): boolean { return CONTINUOUS_VERBS.includes(verb); }

/** Make a lossless editable copy when an inspector opens an existing interaction. */
export function cloneInteraction<V extends Verb>(interaction: InteractionForVerb<V>): InteractionForVerb<V> { return authorInteraction<V>({ ...interaction } as unknown as InteractionDraft<V>); }
