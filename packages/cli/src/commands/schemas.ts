/**
 * `uniscenarios schemas [--name <id>] [--content]` — the LLM emission contract.
 *
 * The three v2 JSON Schemas plus the engine's `SimScenarioInput` are the whole
 * interface a generating model has to hit. Printing their *paths* by default
 * (and their content on request) keeps the common call cheap: a constrained
 * decoder wants the file, not 99 KB of JSON in a tool result.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANCHOR_JSON_SCHEMA_PATH,
  INTERACTIONS_JSON_SCHEMA_PATH,
  TEMPLATE_JSON_SCHEMA_PATH,
  buildAnchorJsonSchema,
  buildInteractionsJsonSchema,
  buildTemplateJsonSchema,
} from '@simforge/scenario';

import { CliError, EXIT } from '../errors.js';
import { emit, emitLines, pad } from '../output.js';
import { REPO_ROOT } from '@simforge/compiler';

const MODEL_PKG = path.join(REPO_ROOT, 'packages', 'scenario-model');

export interface SchemaEntry {
  readonly name: string;
  readonly title: string;
  readonly path: string;
  readonly exists: boolean;
  readonly description: string;
}

export const SCHEMAS: readonly SchemaEntry[] = [
  {
    name: 'template',
    title: 'ScenarioTemplate v2',
    path: path.join(MODEL_PKG, TEMPLATE_JSON_SCHEMA_PATH),
    exists: false,
    description: 'The whole authored document: anchor, roles, props, choreography, invariants.',
  },
  {
    name: 'anchor',
    title: 'LogicalAnchor v2',
    path: path.join(MODEL_PKG, ANCHOR_JSON_SCHEMA_PATH),
    exists: false,
    description: 'The predicate over road structure — the primary LLM emission target.',
  },
  {
    name: 'interactions',
    title: 'Choreography v2',
    path: path.join(MODEL_PKG, INTERACTIONS_JSON_SCHEMA_PATH),
    exists: false,
    description: 'The timeline alone: 7 verbs, 4 triggers, 11 conditions, dynamics.',
  },
].map((entry) => ({ ...entry, exists: existsSync(entry.path) }));

const BUILDERS: Record<string, () => unknown> = {
  template: buildTemplateJsonSchema,
  anchor: buildAnchorJsonSchema,
  interactions: buildInteractionsJsonSchema,
};

export interface SchemasOptions {
  readonly name?: string | undefined;
  readonly content: boolean;
  readonly pretty: boolean;
}

export async function schemas(options: SchemasOptions): Promise<number> {
  const selected = options.name
    ? SCHEMAS.filter((s) => s.name === options.name)
    : [...SCHEMAS];
  if (selected.length === 0) {
    throw new CliError('unknown_schema', `no schema named "${options.name}"`, {
      path: '--name',
      detail: { known: SCHEMAS.map((s) => s.name) },
    });
  }

  const entries: Array<Record<string, unknown>> = [];
  for (const entry of selected) {
    const record: Record<string, unknown> = { ...entry, exists: existsSync(entry.path) };
    if (options.content) {
      // Prefer the file on disk (that is what is published and drift-tested);
      // fall back to generating it so a fresh checkout still answers.
      record['schema'] = existsSync(entry.path)
        ? JSON.parse(await readFile(entry.path, 'utf8'))
        : BUILDERS[entry.name]?.();
    }
    entries.push(record);
  }

  const payload = { count: entries.length, schemas: entries };
  if (!options.pretty) {
    emit(payload, options);
    return EXIT.ok;
  }
  emitLines([
    ...selected.map(
      (s) => `${pad(s.name, 16)}${pad(existsSync(s.path) ? 'present' : 'missing', 10)}${s.path}`,
    ),
    '',
    ...selected.map((s) => `${pad(s.name, 16)}${s.description}`),
  ]);
  return EXIT.ok;
}

export { fileURLToPath };
