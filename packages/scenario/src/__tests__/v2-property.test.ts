/**
 * Property coverage for v2, the counterpart of `history-property.test.ts`.
 *
 * v1's property test fuzzes the *operation log*, because v1's hard invariant is
 * "undo restores the bytes". v2 has no operation log — the editor still edits
 * v1 scenes, and a template op-log would be inventing a surface nobody consumes
 * yet — so the invariants worth fuzzing are the ones the whole layer rests on:
 *
 * 1. **Canonical form is a fixed point.** Parsing normalises (expressions become
 *    ASTs, defaults materialise). Serialising a parsed template and parsing it
 *    again must produce byte-identical text, or every save churns the diff and
 *    replay keys stop matching.
 * 2. **The validator is total.** For any *schema-valid* template — including
 *    nonsense ones — `validateTemplate` returns issues instead of throwing.
 *    Tier 1 runs on every keystroke; an exception there takes the editor down.
 * 3. **The validator is deterministic.** Same input, byte-identical report,
 *    with no dependence on `Map` iteration order.
 * 4. **Every issue is well-formed**: a known code, a path that points into the
 *    document, a non-empty message.
 * 5. **Expression round-trips survive composition** at depth.
 */

import { describe, expect, it } from 'vitest';

import {
  ISSUE_CODES,
  validateTemplate,
  type ClauseResult,
} from '../validate/index.js';
import { evaluateExpr, parseExpr, printExpr, type Expr } from '../expr/index.js';
import { ScenarioTemplateV2Schema, type ScenarioTemplateV2Input } from '../schema/v2/template.js';
import { parseTemplate, serializeTemplate } from '../serialize.js';
import { seededRandom } from './fixtures.js';
import { ltapMapContext, T0 } from './v2-fixtures.js';

const ISSUE_CODE_SET = new Set<string>(ISSUE_CODES);

const pick = <T>(rnd: () => number, items: readonly T[]): T =>
  items[Math.floor(rnd() * items.length)] as T;

const round = (value: number, dp = 3): number => Number(value.toFixed(dp));

/** A random but always schema-valid template. */
function randomTemplateInput(rnd: () => number): ScenarioTemplateV2Input {
  const roleCount = 1 + Math.floor(rnd() * 4);
  const roleIds = Array.from({ length: roleCount }, (_, i) => `r${i}`);
  const paramIds = ['pA', 'pB'];
  const clipSeconds = round(6 + rnd() * 40, 1);

  const numberOrExpr = (base: number): number | string =>
    rnd() < 0.35
      ? pick(rnd, [
          `param.${pick(rnd, paramIds)}`,
          `clamp(${round(base)}, 1, 90)`,
          `min(param.pA, ${round(base)})`,
          `0.9 * lane.speedLimitKph`,
          `${round(base)} + junction.sizeM / 4`,
        ])
      : round(base);

  const roles = roleIds.map((id, index) => {
    const actor = { class: pick(rnd, ['car', 'truck', 'pedestrian', 'bicycle'] as const) };
    const kind = pick(rnd, [
      'on_reference',
      'lane_offset',
      'opposing',
      'conflicting_gate',
      'relative_to',
    ] as const);
    const pose = {
      s: numberOrExpr(-120 + rnd() * 240),
      ...(rnd() < 0.5 ? { tFrac: round(rnd() * 1.6 - 0.8) } : {}),
      ...(rnd() < 0.3 ? { headingOffsetRad: round(rnd() * 2 - 1) } : {}),
    };
    const common = {
      id,
      actor,
      ...(rnd() < 0.4 ? { initialSpeedKph: numberOrExpr(10 + rnd() * 60) } : {}),
      ...(rnd() < 0.2 ? { essentiality: pick(rnd, ['preferred', 'cosmetic'] as const) } : {}),
    };
    switch (kind) {
      case 'lane_offset':
        return {
          ...common,
          kind,
          k: Math.floor(rnd() * 5) - 2,
          onMissing: pick(rnd, ['clamp', 'drop', 'fail'] as const),
          pose,
        };
      case 'opposing':
        return { ...common, kind, k: Math.floor(rnd() * 2), pose };
      case 'conflicting_gate':
        return {
          ...common,
          kind,
          feature: pick(rnd, ['jx', 'ghost']),
          from: pick(rnd, ['opposing', 'from_left', 'from_right'] as const),
          turn: pick(rnd, ['left', 'right', 'straight'] as const),
          ...(rnd() < 0.7
            ? {
                arriveAtConflict: {
                  relativeTo: pick(rnd, roleIds),
                  deltaT: numberOrExpr(rnd() * 3 - 1.5),
                },
              }
            : {}),
        };
      case 'relative_to':
        return {
          ...common,
          kind,
          ref: pick(rnd, roleIds),
          dLane: Math.floor(rnd() * 3) - 1,
          dsM: numberOrExpr(rnd() * 60 - 30),
        };
      default:
        return { ...common, kind: 'on_reference' as const, pose };
    }
  });

  const trigger = () =>
    pick(rnd, [
      { kind: 'at', t: numberOrExpr(round(rnd() * clipSeconds)) },
      { kind: 'after', of: `i${Math.floor(rnd() * 3)}`, delayS: round(rnd() * 3) },
      {
        kind: 'when',
        condition: pick(rnd, [
          { kind: 'ttc', of: pick(rnd, roleIds), to: pick(rnd, roleIds), op: '<', valueS: 2 },
          { kind: 'speed', of: pick(rnd, roleIds), op: '>', valueKph: numberOrExpr(30) },
          {
            kind: 'and',
            operands: [
              { kind: 'standstill', of: pick(rnd, roleIds), forS: 1 },
              { kind: 'collision', of: pick(rnd, roleIds) },
            ],
          },
        ]),
        ...(rnd() < 0.8 ? { byLatest: round(rnd() * clipSeconds) } : {}),
      },
      {
        kind: 'arrival',
        of: pick(rnd, roleIds),
        at: rnd() < 0.5 ? { feature: 'jx' } : { role: pick(rnd, roleIds) },
        syncWith: pick(rnd, roleIds),
        ttc: numberOrExpr(1.5),
      },
    ]);

  const dynamics = () => ({
    shape: pick(rnd, ['step', 'linear', 'sinusoidal', 'cubic'] as const),
    constraint: pick(rnd, ['rate', 'time', 'distance'] as const),
    value: numberOrExpr(1 + rnd() * 4),
  });

  const interactionCount = Math.floor(rnd() * 6);
  const interactions = Array.from({ length: interactionCount }, (_, index) => {
    const base = {
      id: `i${index}`,
      actor: rnd() < 0.1 ? '@world' : pick(rnd, roleIds),
      trigger: trigger(),
      ...(rnd() < 0.25 ? { until: { kind: 'at' as const, t: round(rnd() * clipSeconds) } } : {}),
    };
    switch (pick(rnd, [
      'speed',
      'gap',
      'changeLane',
      'laneOffset',
      'route',
      'exist',
      'set',
    ] as const)) {
      case 'gap':
        return {
          ...base,
          verb: 'gap' as const,
          target: {
            role: pick(rnd, roleIds),
            value: numberOrExpr(1.5),
            unit: pick(rnd, ['time', 'distance'] as const),
          },
          ...(rnd() < 0.85 ? { dynamics: dynamics() } : {}),
        };
      case 'changeLane':
        return {
          ...base,
          verb: 'changeLane' as const,
          target: { mode: 'relative' as const, dk: rnd() < 0.5 ? 1 : -1 },
          ...(rnd() < 0.85 ? { dynamics: dynamics() } : {}),
        };
      case 'laneOffset':
        return {
          ...base,
          verb: 'laneOffset' as const,
          target: { tFrac: numberOrExpr(round(rnd() - 0.5, 2)) },
          ...(rnd() < 0.85 ? { dynamics: dynamics() } : {}),
        };
      case 'route':
        return {
          ...base,
          verb: 'route' as const,
          target: pick(rnd, [
            { mode: 'turn', feature: 'jx', turn: pick(rnd, ['left', 'right', 'straight'] as const) },
            { mode: 'toFeature', feature: 'jx' },
            { mode: 'polyline', points: [{ s: 0 }, { s: round(rnd() * 30) }] },
          ]),
        };
      case 'exist':
        return {
          ...base,
          verb: 'exist' as const,
          target: { state: pick(rnd, ['present', 'absent'] as const) },
        };
      case 'set':
        return {
          ...base,
          verb: 'set' as const,
          target: pick(rnd, [
            { key: 'rules.collisionAvoidance', value: rnd() < 0.5 },
            { key: 'rules.aggression', value: round(rnd(), 2) },
            { key: 'lights.indicator', value: pick(rnd, ['off', 'left', 'right'] as const) },
            { key: 'env.frictionScale', value: round(0.2 + rnd() * 0.9, 2) },
            { key: 'rules.notAKey', value: true },
          ]),
        };
      default:
        return {
          ...base,
          verb: 'speed' as const,
          target: pick(rnd, [
            { mode: 'absolute', valueKph: numberOrExpr(20 + rnd() * 50) },
            { mode: 'stop' },
            { mode: 'match', role: pick(rnd, roleIds) },
          ]),
          ...(rnd() < 0.85 ? { dynamics: dynamics() } : {}),
        };
    }
  });

  return {
    scenarioVersion: 2,
    meta: {
      name: `Fuzz ${round(rnd() * 1000)}`,
      createdAt: T0,
      modifiedAt: T0,
      appVersion: '0.0.1',
      ...(rnd() < 0.5 ? { archetype: 'C3.ltap-od' } : {}),
    },
    params: {
      declarations: [
        { id: 'pA', type: 'continuous', range: [10, 60], default: 30, tier: 1 },
        { id: 'pB', type: 'discrete', values: [1, 2, 3] },
      ],
      constraints: rnd() < 0.5 ? [{ left: 'param.pA', op: '<=', right: 60 }] : [],
    },
    environment: {
      ...(rnd() < 0.5 ? { weather: pick(rnd, ['clear', 'heavy_rain', 'fog_dense'] as const) } : {}),
      ...(rnd() < 0.3 ? { frictionScale: numberOrExpr(0.8) } : {}),
    },
    anchor: {
      corridor: {
        throughLanesSameDir: { value: [1, 1 + Math.floor(rnd() * 3)] },
        ...(rnd() < 0.5
          ? { speedLimitKph: { value: [30, 60], essentiality: 'preferred' as const } }
          : {}),
      },
      features:
        rnd() < 0.85
          ? [{ id: 'jx', kind: 'junction' as const, arms: { value: [3, 4] as [number, number] } }]
          : [],
      ...(rnd() < 0.15 ? { pin: { mapId: 'yale-street' } } : {}),
    },
    roles: roles as never,
    props:
      rnd() < 0.3
        ? [
            {
              id: 'p0',
              catalogId: 'vehicle.parked.van',
              pose: { s: numberOrExpr(-20), tFrac: 0.9 },
              ...(rnd() < 0.6
                ? { occludes: { observer: pick(rnd, roleIds), target: pick(rnd, roleIds) } }
                : {}),
              ...(rnd() < 0.5 ? { targetRevealToConflictS: numberOrExpr(0.9) } : {}),
            },
          ]
        : [],
    choreography: { clipSeconds, interactions: interactions as never },
    invariants:
      rnd() < 0.6
        ? [
            {
              id: 'inv0',
              kind: 'ttc' as const,
              of: pick(rnd, roleIds),
              to: pick(rnd, roleIds),
              range: [1.2, 2.5] as [number, number],
            },
          ]
        : [],
    ...(rnd() < 0.8 ? { metricSubject: pick(rnd, roleIds) } : {}),
  };
}

function wellFormed(issue: ClauseResult): void {
  expect(ISSUE_CODE_SET.has(issue.code), issue.code).toBe(true);
  expect(['error', 'warning', 'info']).toContain(issue.severity);
  expect(issue.message.length).toBeGreaterThan(0);
  expect(issue.path).toBeTypeOf('string');
  // Paths address the document, never a foreign namespace.
  if (issue.path !== '') {
    expect(issue.path.split('.')[0]).toMatch(
      /^(meta|sourceMap|params|environment|anchor|roles|props|choreography|invariants|variants|metricSubject|scenarioVersion)$/,
    );
  }
}

describe('random v2 templates', () => {
  const SEEDS = 120;

  it(`round-trip to a canonical fixed point across ${SEEDS} seeds`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = seededRandom(seed);
      const input = randomTemplateInput(rnd);
      const parsed = ScenarioTemplateV2Schema.safeParse(input);
      if (!parsed.success) continue; // random ids can collide; those are schema errors, not our subject
      const once = serializeTemplate(parsed.data);
      const twice = serializeTemplate(parseTemplate(JSON.parse(once)));
      expect(twice, `seed ${seed}`).toBe(once);
    }
  });

  it('never throws from the validator, with or without a map', () => {
    const map = ltapMapContext();
    let checked = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const parsed = ScenarioTemplateV2Schema.safeParse(randomTemplateInput(seededRandom(seed)));
      if (!parsed.success) continue;
      checked++;
      const bare = validateTemplate(parsed.data);
      const withMap = validateTemplate(parsed.data, map);
      for (const issue of [...bare.issues, ...withMap.issues]) wellFormed(issue);
      expect(bare.mapChecked).toBe(false);
      expect(withMap.mapChecked).toBe(true);
      // Map checks only ever add findings; they never mask a document defect.
      const bareCodes = bare.issues.map((i) => `${i.code}@${i.path}`);
      const mapCodes = new Set(withMap.issues.map((i) => `${i.code}@${i.path}`));
      for (const code of bareCodes) expect(mapCodes.has(code), `seed ${seed}: ${code}`).toBe(true);
    }
    expect(checked).toBeGreaterThan(SEEDS * 0.8);
  });

  it('is deterministic: the same template validates to the same report', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const parsed = ScenarioTemplateV2Schema.safeParse(randomTemplateInput(seededRandom(seed)));
      if (!parsed.success) continue;
      const a = validateTemplate(parsed.data, ltapMapContext());
      const b = validateTemplate(parseTemplate(JSON.parse(serializeTemplate(parsed.data))), ltapMapContext());
      expect(JSON.stringify(b), `seed ${seed}`).toBe(JSON.stringify(a));
    }
  });

  it('finds the seeded defects it is supposed to find', () => {
    // The generator deliberately emits bad set keys, missing dynamics, missing
    // byLatest and dangling `after` references; over 120 seeds each must show up,
    // otherwise this test is only proving the happy path.
    const seen = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const parsed = ScenarioTemplateV2Schema.safeParse(randomTemplateInput(seededRandom(seed)));
      if (!parsed.success) continue;
      for (const issue of validateTemplate(parsed.data, ltapMapContext()).issues) seen.add(issue.code);
    }
    for (const code of [
      'unknown_set_key',
      'dynamics_required',
      'bylatest_required',
      'interaction_ref_unknown',
      'feature_ref_unknown',
      'self_reference',
      'occluder_pair_missing',
      'role_unbound',
    ]) {
      expect(seen, code).toContain(code);
    }
  });
});

describe('random expressions', () => {
  const SCOPE = {
    lane: { speedLimitKph: 48, widthM: 3.1 },
    junction: { sizeM: 22 },
    clip: { seconds: 20 },
    params: { pA: 30, pB: 2 },
  };

  function randomExpr(rnd: () => number, depth = 0): string {
    if (depth > 3 || rnd() < 0.3) {
      return pick(rnd, [
        String(round(rnd() * 100)),
        'lane.speedLimitKph',
        'lane.widthM',
        'junction.sizeM',
        'clip.seconds',
        'param.pA',
        'param.pB',
      ]);
    }
    const left = randomExpr(rnd, depth + 1);
    const right = randomExpr(rnd, depth + 1);
    return pick(rnd, [
      `(${left} + ${right})`,
      `(${left} - ${right})`,
      `(${left} * ${right})`,
      `clamp(${left}, 1, 90)`,
      `min(${left}, ${right})`,
      `max(${left}, ${right})`,
      `abs(${left})`,
      `-(${left})`,
    ]);
  }

  it('print/parse is a value-preserving normal form over 300 samples', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = seededRandom(seed * 7919);
      const source = randomExpr(rnd);
      const ast: Expr = parseExpr(source);
      const printed = printExpr(ast);
      expect(parseExpr(printed), source).toEqual(ast);
      expect(printExpr(parseExpr(printed)), source).toBe(printed);
      expect(evaluateExpr(parseExpr(printed), SCOPE), source).toBe(evaluateExpr(ast, SCOPE));
    }
  });
});
