/**
 * The typed key registry behind the `set` verb.
 *
 * `set` is the discrete-state escape valve — indicators, doors, a flagger's
 * paddle, a signal phase, and the behaviour switches that decide whether a
 * challenger actually commits. Left open it becomes a stringly-typed dumping
 * ground that no engine can implement completely; so the legal keys are **data**
 * (this file), each with a value type, an axis, and the actor kinds it applies
 * to, and anything else is rejected with the near-miss suggestion.
 *
 * The most important entry is `rules.collisionAvoidance`. Per
 * `docs/research/interactions-and-edge-cases.md` §three make-or-break features,
 * without the ability to turn it off, every generated critical scenario
 * silently degrades into a safe one because the challenger chickens out.
 *
 * Wildcard keys (`signal:<handle>.phase`) are matched by pattern, since the
 * handles come from the map, not from the schema.
 */

import { z } from 'zod';

/** Value domain of a settable key. */
export const SetValueTypeSchema = z.enum(['boolean', 'number', 'enum', 'string']);

/** Who a key may be set on. */
export const SetTargetKindSchema = z.enum(['vehicle', 'vru', 'any_actor', 'world']);

/** One registry entry. */
export const SetKeyDeclSchema = z.strictObject({
  /** Literal key, or the human form of `pattern` when one is present. */
  key: z.string().min(1).max(100),
  /**
   * Regex source for wildcard keys (`signal:<handle>.phase`). When present,
   * `key` is documentation and matching goes through the pattern.
   */
  pattern: z.string().min(1).optional(),
  valueType: SetValueTypeSchema,
  /** Legal values, for `enum`. */
  values: z.array(z.string().min(1)).optional(),
  /** Legal range, for `number`. */
  range: z.tuple([z.number(), z.number()]).optional(),
  unit: z.string().max(32).optional(),
  appliesTo: SetTargetKindSchema,
  description: z.string().min(1).max(400),
});

/** A registry entry. */
export type SetKeyDecl = z.infer<typeof SetKeyDeclSchema>;

/** The registry itself, so a consumer can validate a hand-edited copy. */
export const SetKeyRegistrySchema = z.array(SetKeyDeclSchema);

const decl = (d: SetKeyDecl): SetKeyDecl => d;

/**
 * Every key the `set` verb accepts.
 *
 * Grouped by namespace: `rules.*` (behaviour switches), `lights.*`, `doors.*`,
 * `pose.*` (articulated state), `signal:*` (traffic control), `env.*`.
 */
export const SET_KEY_REGISTRY: readonly SetKeyDecl[] = [
  decl({
    key: 'rules.collisionAvoidance',
    valueType: 'boolean',
    appliesTo: 'any_actor',
    description:
      'Whether the actor brakes/steers to avoid a collision. Set false to make a challenger commit; without this every generated critical scenario degrades into a safe one.',
  }),
  decl({
    key: 'rules.yield',
    valueType: 'boolean',
    appliesTo: 'any_actor',
    description:
      'Master right-of-way yielding switch. False is appropriate for uncontrolled rolling objects and deliberate non-yielding actors; class-specific yield switches remain independently available.',
  }),
  decl({
    key: 'control:<id>.indication',
    pattern: '^control:[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}\\.indication$',
    valueType: 'enum',
    values: ['green', 'yellow', 'red', 'flashing_yellow', 'flashing_red', 'off', 'green_arrow', 'yellow_arrow', 'red_x', 'proceed', 'stop'],
    appliesTo: 'world',
    description: 'Set a portable authored traffic control indication, including work-zone signals, lane-use arrows/X, and human stop/proceed direction.',
  }),
  decl({
    key: 'rules.obeySignals',
    valueType: 'boolean',
    appliesTo: 'any_actor',
    description: 'Whether the actor stops for red lights and stop signs. False models a red-light violator.',
  }),
  decl({
    key: 'rules.obeySpeedLimit',
    valueType: 'boolean',
    appliesTo: 'vehicle',
    description: 'Whether the actor caps its speed at the posted limit.',
  }),
  decl({
    key: 'rules.yieldToVehicles',
    valueType: 'boolean',
    appliesTo: 'any_actor',
    description: 'Whether the actor yields right of way to conflicting vehicles.',
  }),
  decl({
    key: 'rules.yieldToPedestrians',
    valueType: 'boolean',
    appliesTo: 'vehicle',
    description: 'Whether the actor yields to pedestrians in and approaching crossings.',
  }),
  decl({
    key: 'rules.aggression',
    valueType: 'number',
    range: [0, 1],
    appliesTo: 'any_actor',
    description: 'Gap acceptance and headway preference, 0 = timid, 1 = aggressive.',
  }),
  decl({
    key: 'rules.laneKeeping',
    valueType: 'boolean',
    appliesTo: 'vehicle',
    description: 'Whether the actor holds its lane centre between explicit lateral interactions.',
  }),
  decl({
    key: 'rules.reactionTimeS',
    valueType: 'number',
    range: [0, 3],
    unit: 's',
    appliesTo: 'any_actor',
    description: 'Perception-reaction delay applied to the actor\'s reactive behaviours.',
  }),

  decl({
    key: 'motion.gear',
    valueType: 'enum',
    values: ['forward', 'reverse'],
    appliesTo: 'vehicle',
    // Kept under the registry's 400-char limit; the rationale for gear-as-discrete-state rather
    // than a negative `speed` target lives in the reverse implementation, not here.
    description:
      'Direction of travel. `reverse` backs the vehicle rear-first along its path, keeping its heading, at a governed low speed. Select it at a standstill; a shift at speed is held until the vehicle stops.',
  }),

  decl({
    key: 'lights.indicator',
    valueType: 'enum',
    values: ['off', 'left', 'right', 'hazard'],
    appliesTo: 'vehicle',
    description: 'Turn-indicator state. An unindicated cut-in is a different scenario from an indicated one.',
  }),
  decl({
    key: 'lights.headlights',
    valueType: 'enum',
    values: ['off', 'drl', 'low', 'high'],
    appliesTo: 'vehicle',
    description: 'Headlight state.',
  }),
  decl({
    key: 'lights.brake',
    valueType: 'boolean',
    appliesTo: 'vehicle',
    description: 'Force brake lights independently of deceleration (phantom-brake bait).',
  }),
  decl({
    key: 'lights.reverse',
    valueType: 'boolean',
    appliesTo: 'vehicle',
    description: 'Reverse lamps.',
  }),
  decl({
    key: 'lights.emergency',
    valueType: 'enum',
    values: ['off', 'flashing', 'flashing_siren'],
    appliesTo: 'vehicle',
    description: 'Emergency-vehicle beacons, optionally with siren.',
  }),
  decl({
    key: 'audio.horn',
    valueType: 'boolean',
    appliesTo: 'vehicle',
    description: 'Vehicle horn state. This is trace-visible and exporters warn when the target profile cannot preserve audio.',
  }),

  decl({
    key: 'doors.left',
    valueType: 'enum',
    values: ['closed', 'opening', 'open', 'closing'],
    appliesTo: 'vehicle',
    description: 'Kerbside/offside left door state — the door-zone scenario for cyclists.',
  }),
  decl({
    key: 'doors.right',
    valueType: 'enum',
    values: ['closed', 'opening', 'open', 'closing'],
    appliesTo: 'vehicle',
    description: 'Right door state.',
  }),
  decl({
    key: 'doors.rear',
    valueType: 'enum',
    values: ['closed', 'opening', 'open', 'closing'],
    appliesTo: 'vehicle',
    description: 'Rear door/tailgate state.',
  }),

  decl({
    key: 'pose.paddle',
    valueType: 'enum',
    values: ['stowed', 'stop', 'slow'],
    appliesTo: 'vru',
    description: 'Flagger paddle state in a work zone.',
  }),
  decl({
    key: 'pose.stopArm',
    valueType: 'enum',
    values: ['retracted', 'extending', 'extended'],
    appliesTo: 'vehicle',
    description: 'School-bus stop arm.',
  }),
  decl({
    key: 'pose.gesture',
    valueType: 'enum',
    values: ['none', 'wave_through', 'halt', 'point', 'phone'],
    appliesTo: 'vru',
    description: 'Upper-body gesture; drives the intent cue a perception stack may or may not read.',
  }),
  decl({
    key: 'pose.headingLookDeg',
    valueType: 'number',
    range: [-180, 180],
    unit: 'deg',
    appliesTo: 'vru',
    description: 'Gaze direction relative to travel direction — the "did they look?" cue.',
  }),

  decl({
    key: 'signal:<handle>.phase',
    pattern: '^signal:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\\.phase$',
    valueType: 'enum',
    // `off` is the blackout — a dark head, which reverts the junction to an
    // all-way stop rather than to no control. The arrows are the turn-logic
    // indications; a flashing yellow arrow is what makes a protected left
    // permissive, which is the whole reason the FYA exists.
    values: [
      'green', 'yellow', 'red', 'flashing_yellow', 'flashing_red', 'off',
      'green_arrow', 'yellow_arrow', 'red_x', 'flashing_yellow_arrow', 'flashing_red_arrow',
    ],
    appliesTo: 'world',
    description: 'Force a traffic signal to a phase, including a blackout (`off`). The handle comes from the map catalog.',
  }),
  decl({
    key: 'signal:<handle>.program',
    pattern: '^signal:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\\.program$',
    valueType: 'string',
    appliesTo: 'world',
    description: 'Switch a signal to a named program (e.g. night flashing).',
  }),
  decl({
    key: 'signal:feature:<feature>:<approach>.phase',
    pattern: '^signal:feature:[A-Za-z][A-Za-z0-9_-]{0,63}:(subject|ego|opposing|left|right)\\.phase$',
    valueType: 'enum',
    values: [
      'green', 'yellow', 'red', 'flashing_yellow', 'flashing_red', 'off',
      'green_arrow', 'yellow_arrow', 'red_x', 'flashing_yellow_arrow', 'flashing_red_arrow',
    ],
    appliesTo: 'world',
    description: 'Force the signal bound to a portable junction feature and relative approach, including a blackout (`off`).',
  }),
  decl({
    key: 'signal:feature:<feature>:<approach>.program',
    pattern: '^signal:feature:[A-Za-z][A-Za-z0-9_-]{0,63}:(subject|ego|opposing|left|right)\\.program$',
    valueType: 'string',
    appliesTo: 'world',
    description: 'Switch the signal bound to a portable junction feature and relative approach to a named program.',
  }),

  decl({
    key: 'env.weather',
    valueType: 'enum',
    values: [
      'clear',
      'cloudy',
      'overcast',
      'light_rain',
      'heavy_rain',
      'wet_road',
      'fog_light',
      'fog_dense',
      'snow',
      'sleet',
    ],
    appliesTo: 'world',
    description: 'Change weather mid-clip (a squall arriving), overriding `environment.weather`.',
  }),
  decl({
    key: 'env.frictionScale',
    valueType: 'number',
    range: [0.1, 1.2],
    appliesTo: 'world',
    description: 'Tyre-road friction multiplier; drives the friction-patch scenarios.',
  }),
  decl({
    key: 'env.fogDensity',
    valueType: 'number',
    range: [0, 1],
    appliesTo: 'world',
    description: 'Fog density, 0 = clear.',
  }),
  decl({
    key: 'env.rainIntensity',
    valueType: 'number',
    range: [0, 1],
    appliesTo: 'world',
    description: 'Rain intensity, 0 = dry.',
  }),
];

const LITERAL_KEYS = new Map(
  SET_KEY_REGISTRY.filter((d) => !d.pattern).map((d) => [d.key, d] as const),
);
const PATTERN_KEYS = SET_KEY_REGISTRY.filter((d) => d.pattern).map(
  (d) => [new RegExp(d.pattern as string), d] as const,
);

/** Look up a key in the registry, honouring wildcard patterns. */
export function lookupSetKey(key: string): SetKeyDecl | undefined {
  const literal = LITERAL_KEYS.get(key);
  if (literal) return literal;
  for (const [pattern, d] of PATTERN_KEYS) {
    if (pattern.test(key)) return d;
  }
  return undefined;
}

/** Namespace of a key (`rules`, `lights`, `doors`, `pose`, `signal`, `env`). */
export function setKeyNamespace(key: string): string {
  if (key.startsWith('signal:')) return 'signal';
  if (key.startsWith('control:')) return 'control';
  const dot = key.indexOf('.');
  return dot < 0 ? key : key.slice(0, dot);
}

/** Every literal key, sorted — for error messages and editor autocomplete. */
export function knownSetKeys(): string[] {
  return SET_KEY_REGISTRY.map((d) => d.key).sort();
}

/** Cheap edit-distance suggestion for a mistyped key. */
export function suggestSetKey(key: string): string | undefined {
  const candidates = knownSetKeys();
  let best: { key: string; score: number } | undefined;
  for (const candidate of candidates) {
    const score = levenshtein(key.toLowerCase(), candidate.toLowerCase());
    if (!best || score < best.score) best = { key: candidate, score };
  }
  return best && best.score <= Math.max(3, Math.floor(key.length / 3)) ? best.key : undefined;
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (cur[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j] as number;
  }
  return prev[b.length] as number;
}

/** The value shapes `set` accepts. */
export const SetValueSchema = z.union([z.boolean(), z.number().finite(), z.string().max(200)]);
/** A `set` value. */
export type SetValue = z.infer<typeof SetValueSchema>;

/** Why a `set` value was rejected. `ok` carries no reason. */
export type SetValueCheck =
  | { ok: true }
  | { ok: false; code: 'unknown_set_key' | 'set_value_type' | 'set_value_range'; message: string };

/** Validate a `key`/`value` pair against the registry. */
export function checkSetValue(key: string, value: SetValue): SetValueCheck {
  const declared = lookupSetKey(key);
  if (!declared) {
    const suggestion = suggestSetKey(key);
    return {
      ok: false,
      code: 'unknown_set_key',
      message: `unknown set key "${key}"${suggestion ? `; did you mean "${suggestion}"?` : ''}`,
    };
  }
  switch (declared.valueType) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, code: 'set_value_type', message: `"${key}" takes a boolean` };
    case 'number': {
      if (typeof value !== 'number') {
        return { ok: false, code: 'set_value_type', message: `"${key}" takes a number` };
      }
      if (declared.range && (value < declared.range[0] || value > declared.range[1])) {
        return {
          ok: false,
          code: 'set_value_range',
          message: `"${key}" must be within [${declared.range[0]}, ${declared.range[1]}], got ${value}`,
        };
      }
      return { ok: true };
    }
    case 'enum': {
      if (typeof value !== 'string' || !declared.values?.includes(value)) {
        return {
          ok: false,
          code: 'set_value_type',
          message: `"${key}" takes one of: ${declared.values?.join(', ')}`,
        };
      }
      return { ok: true };
    }
    case 'string':
      return typeof value === 'string'
        ? { ok: true }
        : { ok: false, code: 'set_value_type', message: `"${key}" takes a string` };
  }
}
