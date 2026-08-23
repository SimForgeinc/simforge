/**
 * Emit every published JSON Schema from the zod source of truth.
 *
 * Run with `pnpm --filter @simforge/scenario schema`. The outputs
 * are committed, and `src/__tests__/json-schema.test.ts` /
 * `src/__tests__/v2-json-schema.test.ts` fail if they drift — so a schema can
 * never quietly fall behind the zod source of truth.
 *
 * `io: 'input'` throughout, because the files describe what may be *written* to
 * disk: defaulted keys (v1's reserved blocks, v2's `params`/`environment`) are
 * optional, and v2 expressions may still be strings.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildJsonSchema, JSON_SCHEMA_PATH } from '../src/json-schema.js';
import { buildAllV2JsonSchemas } from '../src/json-schema-v2.js';

const here = dirname(fileURLToPath(import.meta.url));

const outputs: Array<[string, Record<string, unknown>]> = [
  [JSON_SCHEMA_PATH, buildJsonSchema()],
  ...buildAllV2JsonSchemas(),
];

for (const [relative, document] of outputs) {
  const out = join(here, '..', relative);
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`wrote ${out}\n`);
}
