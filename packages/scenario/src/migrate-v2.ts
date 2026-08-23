/**
 * v1 scene → v2 template migration, and version dispatch between the two.
 *
 * ## The honest version of this migration
 *
 * A v1 document is a **scene**: entities at absolute scene coordinates on one
 * named map. A v2 document is a **template**: a predicate over road structure
 * plus frame-relative choreography, which is a strictly different kind of
 * claim. Converting the first into the second requires answering
 * "which lane, how far along the reference path, how far across it" for every
 * entity — and that answer lives in the lane graph, in `map-intel`, which this
 * package deliberately does not depend on.
 *
 * So the migration does **not** guess. It preserves every v1 pose verbatim in
 * `scene_absolute` roles, pins the anchor to the source map with **no site id**
 * (v1 had none to preserve), and returns a list of {@link MigrationNote}s
 * saying exactly what a human or `map-intel` still has to do. The resulting
 * template is valid, loadable and editable; it is also honestly marked as
 * non-portable until it is rebound, and `validateTemplate` reports
 * `non_portable_role` for every role until then.
 *
 * The alternative — inventing `(k, s, tFrac)` from `laneRef.s` and a guessed
 * lane width — would produce a template that *looks* portable and silently
 * places actors in the wrong lane on every other map. A migration that says
 * "I cannot do this part" is worth more than one that quietly does it wrong.
 *
 * ## What is preserved, what is dropped
 *
 * | v1 | v2 | note |
 * |---|---|---|
 * | `meta` | `meta` | verbatim; `tags` gains `migrated:v1` |
 * | `map` | `sourceMap` + `anchor.pin.mapId` | `xodrSha256` → `pin.topologyDigest` |
 * | `entities[].pose` | `roles[].pose` (`scene_absolute`) | verbatim, non-portable |
 * | `entities[].laneRef` | `roles[].laneRef` | verbatim; still road-relative |
 * | `entities[].kind` | `actor.class` | `vehicle` → `car` (v1 could not say truck/bus) |
 * | `entities[].id` | `roles[].id` | rewritten when it is not a legal v2 id (ULIDs start with a digit) |
 * | `routes`/`triggers`/`lightPrograms`/`parameters` | — | reserved and required-empty in v1, so nothing to carry |
 * | — | `choreography` | empty timeline at the default 20 s clip |
 * | — | `metricSubject` | v1 had no ego concept; left unset, reported |
 */

import { ScenarioMigrationError } from './errors.js';
import { runMigrations, type ScenarioMigration } from './migrate.js';
import { V2_ID_PATTERN } from './schema/v2/common.js';
import {
  SCENARIO_TEMPLATE_VERSION,
  ScenarioTemplateV2Schema,
  type ScenarioTemplateV2,
} from './schema/v2/template.js';
import { parseTemplate } from './serialize.js';
import type { ScenarioV1 } from './schema/v1.js';

/** The template schema version this build reads and writes. */
export const CURRENT_TEMPLATE_VERSION = SCENARIO_TEMPLATE_VERSION;

/** Something the migration could not do, or did in a way you should know about. */
export interface MigrationNote {
  severity: 'info' | 'warning' | 'error';
  /** Stable code, e.g. `legacy_pose_absolute`. */
  code: string;
  /** Path into the *output* document. */
  path: string;
  message: string;
}

/** Outcome of {@link migrateToTemplate}. */
export interface TemplateMigrationResult {
  template: ScenarioTemplateV2;
  /** `scenarioVersion` found in the input. */
  fromVersion: number;
  /** True when a conversion step ran (i.e. the input was v1). */
  migrated: boolean;
  /** Everything the migration wants a human to know. Never silently empty. */
  notes: MigrationNote[];
  /**
   * True when the template contains non-portable data and cannot be matched
   * onto another map until an author rebinds it.
   */
  needsRebinding: boolean;
}

/** Which parser a file wants, from its `scenarioVersion` alone. */
export function detectScenarioKind(json: unknown): 'scene-v1' | 'template-v2' | 'unknown' {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'unknown';
  const version = (json as { scenarioVersion?: unknown }).scenarioVersion;
  if (version === 1) return 'scene-v1';
  if (version === 2) return 'template-v2';
  return 'unknown';
}

const note = (
  severity: MigrationNote['severity'],
  code: string,
  path: string,
  message: string,
): MigrationNote => ({ severity, code, path, message });

/** Make a v1 entity id into a legal v2 role id, keeping it recognisable. */
function toRoleId(entityId: string, taken: Set<string>): string {
  let candidate = V2_ID_PATTERN.test(entityId) ? entityId : `r${entityId}`;
  candidate = candidate.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  if (!/^[A-Za-z]/.test(candidate)) candidate = `r${candidate}`.slice(0, 64);
  let unique = candidate;
  let n = 2;
  while (taken.has(unique)) unique = `${candidate.slice(0, 60)}-${n++}`;
  taken.add(unique);
  return unique;
}

/**
 * Convert raw v1 JSON into raw v2 JSON, appending notes.
 *
 * Raw in, raw out, exactly like every other migration step: it has to be able
 * to read a shape no current schema describes.
 */
export function v1ToTemplateV2(
  raw: Record<string, unknown>,
  notes: MigrationNote[] = [],
): Record<string, unknown> {
  const source = raw as unknown as ScenarioV1;
  const map = source.map;
  if (!map || typeof map.mapId !== 'string') {
    throw new ScenarioMigrationError('v1 document has no map; cannot pin the migrated template', 1);
  }

  const taken = new Set<string>();
  const roles = (source.entities ?? []).map((entity, index) => {
    const id = toRoleId(entity.id, taken);
    if (id !== entity.id) {
      notes.push(
        note(
          'info',
          'id_rewritten',
          `roles.${index}.id`,
          `entity id "${entity.id}" is not a legal v2 role id (they must start with a letter); renamed to "${id}"`,
        ),
      );
    }
    notes.push(
      note(
        'warning',
        'legacy_pose_absolute',
        `roles.${index}.pose`,
        `role "${id}" keeps its absolute scene pose and cannot be retargeted; converting it to a frame pose (k, s, tFrac) needs the map's lane graph, which this package does not have`,
      ),
    );
    if (entity.laneRef) {
      notes.push(
        note(
          'info',
          'legacy_lane_ref',
          `roles.${index}.laneRef`,
          `role "${id}" carries a v1 laneRef (road ${entity.laneRef.roadId}, lane ${entity.laneRef.laneId}); it is road-relative, not frame-relative, so map-intel's anchor-lift still has to convert it`,
        ),
      );
    }
    if (entity.kind === 'vehicle') {
      notes.push(
        note(
          'info',
          'actor_class_widened',
          `roles.${index}.actor.class`,
          `v1 only knew "vehicle", so role "${id}" became a "car"; set actor.class if it is a truck, bus or motorcycle`,
        ),
      );
    }
    return {
      id,
      kind: 'scene_absolute',
      actor: {
        class: entity.kind === 'pedestrian' ? 'pedestrian' : 'car',
        catalogId: entity.model.catalogId,
        ...(entity.dims ? { dims: entity.dims } : {}),
      },
      ...(entity.label !== undefined ? { label: entity.label } : {}),
      pose: entity.pose,
      ...(entity.laneRef ? { laneRef: entity.laneRef } : {}),
      ...(entity.extensions ? { extensions: entity.extensions } : {}),
    };
  });

  notes.push(
    note(
      'warning',
      'anchor_pinned_no_site',
      'anchor.pin',
      `pinned to map "${map.mapId}" with no siteId: v1 documents predate site matching, so there is no site to preserve. Run the matcher (or pick a site in the editor) before this template can be retargeted.`,
    ),
  );
  if (roles.length > 0) {
    notes.push(
      note(
        'warning',
        'metric_subject_missing',
        'metricSubject',
        'v1 had no ego concept, so no metricSubject could be inferred; set it to the role whose metrics decide criticality',
      ),
    );
  }
  notes.push(
    note(
      'info',
      'clip_defaulted',
      'choreography',
      'v1 had no timeline; the template gets an empty choreography at the default 20 s clip',
    ),
  );

  const template: Record<string, unknown> = {
    scenarioVersion: SCENARIO_TEMPLATE_VERSION,
    meta: {
      ...source.meta,
      tags: ['migrated:v1'],
    },
    sourceMap: { ...map },
    anchor: {
      features: [],
      pin: {
        mapId: map.mapId,
        ...(map.xodrSha256 ? { topologyDigest: map.xodrSha256 } : {}),
      },
    },
    roles,
    props: [],
    choreography: { interactions: [] },
    invariants: [],
    variants: [],
  };
  if (source.extensions) template.extensions = { ...source.extensions };
  return template;
}

/** The migration chain that ends at a v2 template. */
export const TEMPLATE_MIGRATIONS: ScenarioMigration[] = [
  {
    from: 1,
    to: 2,
    description: 'v1 scene -> v2 template (absolute poses preserved as scene_absolute roles)',
    up: (rawDoc) => v1ToTemplateV2(rawDoc),
  },
];

/**
 * Read a v1 or v2 document and return a validated v2 template.
 *
 * Reuses the v1 migration driver — the version dispatch, the "newer than this
 * build" message and the "step did not stamp its version" guard are all already
 * tested there.
 *
 * @throws {ScenarioMigrationError} If the input has no usable version.
 * @throws {ScenarioValidationError} If the result is not a valid template.
 */
export function migrateToTemplate(json: unknown): TemplateMigrationResult {
  const notes: MigrationNote[] = [];
  const chain: ScenarioMigration[] = [
    {
      ...(TEMPLATE_MIGRATIONS[0] as ScenarioMigration),
      up: (rawDoc) => v1ToTemplateV2(rawDoc, notes),
    },
  ];
  const result = runMigrations(json, {
    migrations: chain,
    targetVersion: CURRENT_TEMPLATE_VERSION,
    // `runMigrations` is typed against the v1 document because that is what its
    // own callers want; the validator is an injection point precisely so a
    // different target schema can be plugged in here.
    validate: ((raw: unknown) => parseTemplate(raw)) as unknown as (raw: unknown) => ScenarioV1,
  });
  const template = result.doc as unknown as ScenarioTemplateV2;
  return {
    template,
    fromVersion: result.fromVersion,
    migrated: result.migrated,
    notes,
    needsRebinding: template.roles.some((role) => role.kind === 'scene_absolute'),
  };
}

/** Validate an already-parsed object as a v2 template. Re-exported for convenience. */
export { parseTemplate, serializeTemplate } from './serialize.js';

/** The v2 template schema, re-exported so callers need one import. */
export { ScenarioTemplateV2Schema };
