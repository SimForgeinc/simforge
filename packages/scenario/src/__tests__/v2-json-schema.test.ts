/**
 * Drift guard and contract checks for the three published v2 JSON Schemas.
 *
 * The committed files are what agents decode against and what non-TypeScript
 * consumers validate with, so "the zod schema changed and nobody regenerated"
 * has to be a red test, not a support ticket.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ANCHOR_JSON_SCHEMA_PATH,
  INTERACTIONS_JSON_SCHEMA_PATH,
  TEMPLATE_JSON_SCHEMA_PATH,
  buildAllV2JsonSchemas,
  buildAnchorJsonSchema,
  buildInteractionsJsonSchema,
  buildTemplateJsonSchema,
} from '../json-schema-v2.js';
import { VERBS } from '../schema/v2/interactions.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (relative: string) => readFileSync(join(packageRoot, relative), 'utf8');

describe('published v2 JSON Schemas', () => {
  it('match the committed files (run `pnpm run schema` if this fails)', () => {
    for (const [relative, document] of buildAllV2JsonSchemas()) {
      expect(`${JSON.stringify(document, null, 2)}\n`, relative).toBe(read(relative));
    }
  });

  it('are deterministic', () => {
    expect(JSON.stringify(buildTemplateJsonSchema())).toBe(JSON.stringify(buildTemplateJsonSchema()));
  });

  it('stay small enough to use as a decoding grammar', () => {
    // The recursive expression AST is shared through $defs rather than inlined;
    // without that this file is 2.4 MB and unusable.
    for (const [relative] of buildAllV2JsonSchemas()) {
      expect(read(relative).length, relative).toBeLessThan(200_000);
    }
  });

  it('name the shared definitions readably', () => {
    const schema = buildTemplateJsonSchema() as { $defs: Record<string, unknown> };
    for (const name of ['Expr', 'NumberOrExpr', 'Range', 'FramePose', 'Trigger', 'Condition']) {
      expect(Object.keys(schema.$defs)).toContain(name);
    }
  });

  it('close every object to unknown keys except the extension bags', () => {
    const schema = buildTemplateJsonSchema() as {
      additionalProperties: boolean;
      properties: Record<string, { additionalProperties?: unknown; $ref?: string }>;
      $defs: Record<string, { additionalProperties?: unknown }>;
    };
    const deref = (node: { additionalProperties?: unknown; $ref?: string }) =>
      node.$ref ? schema.$defs[node.$ref.replace('#/$defs/', '')]! : node;
    expect(schema.additionalProperties).toBe(false);
    expect(deref(schema.properties.meta!).additionalProperties).toBe(false);
    expect(deref(schema.properties.extensions!).additionalProperties).toEqual({});
  });

  it('requires only version, meta and anchor — everything else has a default', () => {
    const schema = buildTemplateJsonSchema() as { required: string[] };
    expect([...schema.required].sort()).toEqual(['anchor', 'meta', 'scenarioVersion']);
  });

  it('publishes the anchor alone as the LLM emission target', () => {
    const schema = buildAnchorJsonSchema() as {
      $id: string;
      properties: Record<string, unknown>;
      description: string;
    };
    expect(schema.$id).toMatch(/logical-anchor\.v2\.schema\.json$/);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'corridor',
      'features',
      'id',
      'pin',
      'policy',
    ]);
    expect(schema.description).toMatch(/no coordinates, no road ids/);
    // Nothing map-specific is expressible.
    expect(JSON.stringify(schema)).not.toMatch(/roadId|laneId|"x"|"z"/);
  });

  it('publishes the interaction list alone, with all seven verbs', () => {
    const schema = buildInteractionsJsonSchema() as {
      type: string;
      items: { anyOf?: unknown[]; $ref?: string };
    };
    expect(schema.type).toBe('array');
    const text = JSON.stringify(schema, null, 2);
    for (const verb of VERBS) {
      expect(text, verb).toContain(`"const": "${verb}"`);
    }
  });

  it('documents the structural rules JSON Schema cannot express', () => {
    for (const build of [buildTemplateJsonSchema, buildInteractionsJsonSchema]) {
      const description = (build() as { description: string }).description;
      expect(description).toMatch(/`dynamics` is REQUIRED on the continuous verbs/);
      expect(description).toMatch(/`byLatest` is REQUIRED/);
      expect(description).toMatch(/one axis has one owner/);
    }
  });

  it('describes the expression forms an author may write', () => {
    const description = (buildTemplateJsonSchema() as { description: string }).description;
    expect(description).toMatch(/lane\.speedLimitKph/);
    expect(description).toMatch(/clamp\/min\/max\/abs/);
  });

  it('gives every schema its own \\$id under one base', () => {
    const ids = buildAllV2JsonSchemas().map(([, doc]) => (doc as { $id: string }).$id);
    expect(new Set(ids).size).toBe(3);
    // schemas.uniscenarios.dev is a FROZEN wire identifier (published $id in stored
    // documents); the SimForge rebrand deliberately does not touch it. See
    // docs/engineering/simcloud-sync.md FROZEN_CONTRACT.
    for (const id of ids) expect(id).toMatch(/^https:\/\/schemas\.uniscenarios\.dev\//);
  });

  it('exports the committed paths it writes', () => {
    expect(buildAllV2JsonSchemas().map(([p]) => p)).toEqual([
      TEMPLATE_JSON_SCHEMA_PATH,
      ANCHOR_JSON_SCHEMA_PATH,
      INTERACTIONS_JSON_SCHEMA_PATH,
    ]);
  });
});
