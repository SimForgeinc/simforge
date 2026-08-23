import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildJsonSchema, JSON_SCHEMA_PATH } from '../json-schema.js';
import { validScenario } from './fixtures.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('generated JSON Schema', () => {
  it('matches the committed file (run `pnpm run schema` if this fails)', () => {
    const committed = readFileSync(join(packageRoot, JSON_SCHEMA_PATH), 'utf8');
    expect(`${JSON.stringify(buildJsonSchema(), null, 2)}\n`).toBe(committed);
  });

  it('closes the document to unknown keys but leaves extensions open', () => {
    const schema = buildJsonSchema() as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { additionalProperties?: unknown; maxItems?: number }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.extensions!.additionalProperties).toEqual({});
    expect(schema.properties.meta!.additionalProperties).toBe(false);
  });

  it('marks the defaulted blocks optional and the real content required', () => {
    const schema = buildJsonSchema() as { required: string[] };
    expect(schema.required.sort()).toEqual(['map', 'meta', 'scenarioVersion']);
  });

  it('pins the reserved blocks to empty', () => {
    const schema = buildJsonSchema() as {
      properties: Record<string, { maxItems?: number; additionalProperties?: unknown }>;
    };
    expect(schema.properties.routes!.maxItems).toBe(0);
    expect(schema.properties.triggers!.maxItems).toBe(0);
    expect(schema.properties.lightPrograms!.maxItems).toBe(0);
    expect(schema.properties.parameters!.additionalProperties).toBe(false);
  });

  it('describes the fixture document', () => {
    // Cheap structural smoke test: every top-level key of a real document is
    // known to the schema.
    const schema = buildJsonSchema() as { properties: Record<string, unknown> };
    for (const key of Object.keys(validScenario())) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
  });
});
