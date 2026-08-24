/**
 * v1 → v2 migration.
 *
 * The contract under test is as much about what the migration *refuses* to do
 * as about what it does: no invented frame coordinates, no fabricated site id,
 * and a note for every piece of work it is handing back to a human.
 */

import { describe, expect, it } from 'vitest';

import { ScenarioMigrationError, ScenarioValidationError } from '../errors.js';
import { migrate, CURRENT_SCENARIO_VERSION, SCENARIO_MIGRATIONS } from '../migrate.js';
import {
  CURRENT_TEMPLATE_VERSION,
  TEMPLATE_MIGRATIONS,
  detectScenarioKind,
  migrateToTemplate,
  v1ToTemplateV2,
} from '../migrate-v2.js';
import { parseScenario, parseTemplate, serializeTemplate } from '../serialize.js';
import { validateTemplate } from '../validate/index.js';
import { validScenario } from './fixtures.js';
import { ltapTemplateInput } from './v2-fixtures.js';

/** A v1 document with the awkward bits: a ULID id, a laneRef, dims, extensions. */
function richV1() {
  return validScenario({
    entities: [
      {
        id: '01JQZ8YQ5H7X0K6R9C2B4N3M7P',
        kind: 'vehicle',
        label: 'lead car',
        model: { catalogId: 'sedan.generic' },
        pose: { position: { x: 118.25, y: 0, z: -402.5 }, headingRad: 1.5707963 },
        laneRef: { roadId: '17', section: 0, laneId: -1, s: 42.5, t: 0.1, headingOffsetRad: 0 },
        dims: { length: 4.6, width: 1.8, height: 1.45 },
        extensions: { 'tool.note': 'placed by hand' },
      },
      {
        id: 'ped-1',
        kind: 'pedestrian',
        model: { catalogId: 'ped.adult' },
        pose: { position: { x: 120, y: 0, z: -395 }, headingRad: 0 },
      },
    ],
    map: { mapId: 'yale-street', mapName: 'Yale Street', xodrSha256: 'ab'.repeat(32) },
  });
}

describe('version dispatch', () => {
  it('leaves the v1 lane untouched', () => {
    expect(CURRENT_SCENARIO_VERSION).toBe(1);
    expect(SCENARIO_MIGRATIONS).toHaveLength(0);
    expect(migrate(validScenario()).migrated).toBe(false);
  });

  it('tells a loader which parser a file wants', () => {
    expect(detectScenarioKind(validScenario())).toBe('scene-v1');
    expect(detectScenarioKind(ltapTemplateInput())).toBe('template-v2');
    for (const bad of [null, 42, [], {}, { scenarioVersion: '2' }]) {
      expect(detectScenarioKind(bad)).toBe('unknown');
    }
  });

  it('declares a chain that ends at v2', () => {
    expect(CURRENT_TEMPLATE_VERSION).toBe(2);
    expect(TEMPLATE_MIGRATIONS.map((m) => [m.from, m.to])).toEqual([[1, 2]]);
  });

  it('passes a v2 template through unmigrated', () => {
    const result = migrateToTemplate(ltapTemplateInput());
    expect(result.migrated).toBe(false);
    expect(result.fromVersion).toBe(2);
    expect(result.notes).toEqual([]);
    expect(result.needsRebinding).toBe(false);
  });

  it('refuses documents from a newer build', () => {
    expect(() => migrateToTemplate({ ...validScenario(), scenarioVersion: 9 })).toThrow(
      ScenarioMigrationError,
    );
  });

  it('refuses things that are not scenarios', () => {
    for (const bad of [null, 42, 'text', [], {}]) {
      expect(() => migrateToTemplate(bad)).toThrow(ScenarioMigrationError);
    }
  });
});

describe('v1 scene -> v2 template', () => {
  it('produces a valid template', () => {
    const { template, migrated, fromVersion } = migrateToTemplate(richV1());
    expect(migrated).toBe(true);
    expect(fromVersion).toBe(1);
    expect(template.scenarioVersion).toBe(2);
    expect(() => parseTemplate(JSON.parse(serializeTemplate(template)))).not.toThrow();
  });

  it('preserves every absolute pose bit-for-bit', () => {
    const source = richV1();
    const { template } = migrateToTemplate(source);
    template.roles.forEach((role, index) => {
      expect(role.kind).toBe('scene_absolute');
      if (role.kind === 'scene_absolute') {
        expect(role.pose).toEqual(source.entities[index]!.pose);
      }
    });
  });

  it('preserves the lane anchor, label, dims, catalog id and extensions', () => {
    const { template } = migrateToTemplate(richV1());
    const lead = template.roles[0]!;
    expect(lead.label).toBe('lead car');
    expect(lead.actor.catalogId).toBe('sedan.generic');
    expect(lead.actor.dims).toEqual({ length: 4.6, width: 1.8, height: 1.45 });
    expect(lead.extensions).toEqual({ 'tool.note': 'placed by hand' });
    expect(lead.kind === 'scene_absolute' && lead.laneRef?.roadId).toBe('17');
  });

  it('pins the anchor to the map but to no site, and says so', () => {
    const { template, notes } = migrateToTemplate(richV1());
    expect(template.anchor.pin).toEqual({
      mapId: 'yale-street',
      topologyDigest: 'ab'.repeat(32),
    });
    expect(template.anchor.pin?.siteId).toBeUndefined();
    expect(notes.map((n) => n.code)).toContain('anchor_pinned_no_site');
    expect(template.sourceMap?.mapName).toBe('Yale Street');
  });

  it('rewrites ids that are not legal v2 ids, and reports each rewrite', () => {
    const { template, notes } = migrateToTemplate(richV1());
    expect(template.roles[0]!.id).toBe('r01JQZ8YQ5H7X0K6R9C2B4N3M7P');
    expect(template.roles[1]!.id).toBe('ped-1');
    const rewrites = notes.filter((n) => n.code === 'id_rewritten');
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]!.message).toMatch(/must start with a letter/);
  });

  it('never collides two rewritten ids', () => {
    const doc = validScenario({
      entities: [
        {
          id: '1a',
          kind: 'vehicle',
          model: { catalogId: 'c' },
          pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 },
        },
        {
          id: 'r1a',
          kind: 'vehicle',
          model: { catalogId: 'c' },
          pose: { position: { x: 30, y: 0, z: 0 }, headingRad: 0 },
        },
      ],
    });
    const ids = migrateToTemplate(doc).template.roles.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('maps entity kinds conservatively and says what it could not know', () => {
    const { template, notes } = migrateToTemplate(richV1());
    expect(template.roles.map((r) => r.actor.class)).toEqual(['car', 'pedestrian']);
    expect(notes.filter((n) => n.code === 'actor_class_widened')).toHaveLength(1);
  });

  it('emits one loud note per unconvertible pose', () => {
    const { notes, needsRebinding } = migrateToTemplate(richV1());
    const poseNotes = notes.filter((n) => n.code === 'legacy_pose_absolute');
    expect(poseNotes).toHaveLength(2);
    expect(poseNotes.every((n) => n.severity === 'warning')).toBe(true);
    expect(poseNotes[0]!.message).toMatch(/needs the map's lane graph/);
    expect(notes.some((n) => n.code === 'legacy_lane_ref')).toBe(true);
    expect(needsRebinding).toBe(true);
  });

  it('leaves metricSubject unset and reports it, because v1 had no ego', () => {
    const { template, notes } = migrateToTemplate(richV1());
    expect(template.metricSubject).toBeUndefined();
    expect(notes.map((n) => n.code)).toContain('metric_subject_missing');
  });

  it('validates with exactly the warnings the migration promised', () => {
    const { template } = migrateToTemplate(richV1());
    const report = validateTemplate(template);
    const byCode = new Set(report.issues.map((i) => i.code));
    expect(byCode).toEqual(
      new Set(['non_portable_role', 'pin_site_unresolved', 'metric_subject_missing']),
    );
    // Warnings, not errors: the migrated document is usable, just not portable.
    expect(report.ok).toBe(true);
  });

  it('demands a pin when a template carries absolute poses without one', () => {
    const { template } = migrateToTemplate(richV1());
    const { pin: _dropped, ...anchorWithoutPin } = template.anchor;
    const unpinned = parseTemplate({ ...template, anchor: anchorWithoutPin });
    const report = validateTemplate(unpinned);
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('pin_required');
  });

  it('is idempotent: migrating the output again changes nothing', () => {
    const once = migrateToTemplate(richV1()).template;
    const twice = migrateToTemplate(once);
    expect(twice.migrated).toBe(false);
    expect(serializeTemplate(twice.template)).toBe(serializeTemplate(once));
  });

  it('carries an empty timeline at the default clip length', () => {
    const { template, notes } = migrateToTemplate(richV1());
    expect(template.choreography).toEqual({
      clipSeconds: 20,
      warmupSeconds: 5,
      interactions: [],
    });
    expect(notes.map((n) => n.code)).toContain('clip_defaulted');
  });

  it('keeps document-level extensions', () => {
    const source = { ...richV1(), extensions: { 'tool.x': 1 } };
    expect(migrateToTemplate(source).template.extensions).toEqual({ 'tool.x': 1 });
  });

  it('fails loudly rather than pinning to nothing when the map block is missing', () => {
    const { map: _dropped, ...noMap } = validScenario();
    expect(() => v1ToTemplateV2(noMap as unknown as Record<string, unknown>)).toThrow(
      /no map; cannot pin/,
    );
  });

  it('reports invalid output through the normal validation error', () => {
    const broken = { ...validScenario(), meta: { ...validScenario().meta, name: '' } };
    expect(() => migrateToTemplate(broken)).toThrow(ScenarioValidationError);
  });

  it('leaves the v1 document readable after migration', () => {
    const source = richV1();
    migrateToTemplate(source);
    expect(() => parseScenario(source)).not.toThrow();
  });
});
