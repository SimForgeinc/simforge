/**
 * JSON Schema projection of the zod schema.
 *
 * The zod schema is the source of truth; this exists so non-TypeScript
 * consumers (editors' `$schema` autocomplete, a Python exporter, CI validators)
 * get the same contract for free. Cross-field checks that JSON Schema cannot
 * express — entity-id uniqueness, `modifiedAt >= createdAt` — are documented in
 * `description` rather than silently dropped.
 */

import { z } from 'zod';

import { ScenarioV1ObjectSchema, SCENARIO_VERSION } from './schema/v1.js';

/** Canonical `$id` for the emitted schema. */
export const JSON_SCHEMA_ID =
  'https://schemas.uniscenarios.dev/scenario.v1.schema.json';

/** Where the generated file lives, relative to the package root. */
export const JSON_SCHEMA_PATH = 'schema/scenario.v1.schema.json';

/** Build the JSON Schema document. Deterministic — safe to diff against the committed copy. */
export function buildJsonSchema(): Record<string, unknown> {
  const base = z.toJSONSchema(ScenarioV1ObjectSchema, { io: 'input' }) as Record<string, unknown>;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: JSON_SCHEMA_ID,
    title: `SimForge scenario, schema v${SCENARIO_VERSION}`,
    description:
      'Authoring format for SimForge (.scenario.json). Positions are metres in the y-up scene frame; headings are radians CCW about +Y from +X. Two constraints are not expressible here and are enforced by the reference implementation: entity ids must be unique within a document, and meta.modifiedAt must not precede meta.createdAt.',
    ...base,
  };
}
