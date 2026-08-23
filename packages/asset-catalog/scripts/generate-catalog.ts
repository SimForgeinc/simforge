/**
 * Emit `catalog.json` from the code catalog, validating it on the way out.
 *
 * The JSON is the artefact non-three.js consumers (agents, tooling, other
 * services) read; keeping it generated means the code is the single source of
 * truth and the two can never disagree.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG } from '../src/catalog.js';
import { catalogSchema } from '../src/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'catalog.json');

const parsed = catalogSchema.parse(CATALOG);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

const byClass = new Map<string, number>();
for (const entry of parsed) byClass.set(entry.class, (byClass.get(entry.class) ?? 0) + 1);
const summary = [...byClass.entries()].map(([cls, n]) => `${cls}=${n}`).join(' ');
process.stdout.write(`catalog.json: ${parsed.length} entries (${summary})\n`);
