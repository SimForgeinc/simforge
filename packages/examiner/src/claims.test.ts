/**
 * claims.v1 schema contract: valid claim sets parse, malformed ones reject,
 * and the JSON-Schema twin stays structurally aligned with the zod tree.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAIMS_SCHEMA_ID,
  CLAIMS_V1_JSON_SCHEMA,
  claimSchema,
  claimSetSchema,
} from './claims.js';

const base = {
  id: 'c1',
  actorIds: ['ped'],
  tickRange: { fromTS: 1, toTS: 2 },
  checkable: 'deterministic',
};

describe('claims.v1', () => {
  it('accepts one claim of each proposition type', () => {
    const claims = [
      { ...base, type: 'visibility', state: 'occluded' },
      {
        ...base,
        type: 'causal-trigger',
        cause: { kind: 'trigger-fired', interactionId: 'a', actorId: 'ped' },
        effect: { kind: 'conflict-genesis', metric: 'ttc' },
        relation: 'causes',
      },
      { ...base, type: 'intent', verb: 'speed', interactionId: 'a' },
      { ...base, type: 'spatial', relation: 'ahead-of' },
      { ...base, type: 'spatial', relation: 'within-distance', valueM: 5 },
    ];
    for (const c of claims) expect(claimSchema.safeParse(c).success).toBe(true);
  });

  it('rejects structural violations', () => {
    const bad = [
      { ...base, type: 'visibility' }, // missing state
      { ...base, type: 'spatial', relation: 'within-distance' }, // valueM required
      { ...base, type: 'spatial', relation: 'diagonal' }, // unknown relation
      { ...base, type: 'intent', verb: 'teleport' }, // unknown verb
      { ...base, type: 'causal-trigger', cause: { kind: 'trigger-fired' } }, // effect missing
      { ...base, actorIds: [], type: 'visibility', state: 'visible' }, // empty actorIds
      { ...base, type: 'visibility', state: 'visible', tickRange: { fromTS: 2, toTS: 2 } }, // empty range
      { type: 'visibility', state: 'visible' }, // missing envelope fields
    ];
    for (const c of bad) expect(claimSchema.safeParse(c).success).toBe(false);
  });

  it('validates the set envelope', () => {
    const ok = {
      schema: CLAIMS_SCHEMA_ID,
      scenarioId: 's',
      claims: [{ ...base, type: 'visibility', state: 'visible' }],
    };
    expect(claimSetSchema.safeParse(ok).success).toBe(true);
    expect(claimSetSchema.safeParse({ ...ok, schema: 'claims.v2' }).success).toBe(false);
    expect(claimSetSchema.safeParse({ ...ok, claims: 'nope' }).success).toBe(false);
  });

  it('exposes a JSON Schema with the four proposition oneOfs', () => {
    const defs = CLAIMS_V1_JSON_SCHEMA.schema.$defs;
    expect(Object.keys(defs).sort()).toEqual(
      ['causalTrigger', 'claim', 'eventRef', 'intent', 'spatial', 'tickRange', 'visibility'].sort(),
    );
    expect(defs.claim.oneOf).toHaveLength(4);
    expect(CLAIMS_V1_JSON_SCHEMA.name).toBe('claims_v1');
  });
});
