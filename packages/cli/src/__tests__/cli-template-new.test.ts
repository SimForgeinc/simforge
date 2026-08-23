/**
 * `uniscenarios template new` end to end, through the real binary.
 *
 * The command's whole point is a *deterministic* skeleton an agent can start
 * from, so these assert byte-identical output, schema validity (by feeding the
 * skeleton straight back into `template validate`), and the structured-error
 * contract for bad flag combinations.
 */

import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa, type ExecaError } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';

import { DEV_ASSETS, REPO_ROOT } from '@simforge/compiler';

const BIN = path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'uniscenarios.js');
const haveArtifacts = existsSync(path.join(DEV_ASSETS, 'yale-street'));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function uniscenarios(...args: string[]): Promise<Run> {
  try {
    const r = await execa('node', [BIN, ...args], { reject: false, timeout: 60_000 });
    return { code: r.exitCode ?? 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as ExecaError;
    return { code: e.exitCode ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

function json<T = Record<string, unknown>>(run: Run): T {
  return JSON.parse(run.stdout) as T;
}

const tmpFiles: string[] = [];
afterAll(async () => {
  await Promise.all(tmpFiles.map((f) => rm(f, { force: true })));
});

describe('uniscenarios template new', () => {
  it('appears in the machine-readable command surface', async () => {
    const run = await uniscenarios();
    expect(run.code).toBe(0);
    const payload = json<{ commands: Array<{ name: string }> }>(run);
    expect(payload.commands.map((c) => c.name)).toContain('template new');
  });

  it('emits a schema-valid skeleton that template validate accepts', async () => {
    const run = await uniscenarios('template', 'new');
    expect(run.code).toBe(0);
    const payload = json<{
      ok: boolean;
      template: { scenarioVersion: number; roles: unknown[] };
      out: null;
    }>(run);
    expect(payload.ok).toBe(true);
    expect(payload.template.scenarioVersion).toBe(2);
    expect(payload.template.roles.length).toBeGreaterThan(0);
    expect(payload.out).toBeNull();

    const file = path.join(os.tmpdir(), `uniscenarios-new-${Date.now()}.json`);
    tmpFiles.push(file);
    await writeFile(file, JSON.stringify(payload.template, null, 2));
    const validated = await uniscenarios('template', 'validate', file);
    expect(validated.code).toBe(0);
    expect(json<{ ok: boolean }>(validated).ok).toBe(true);
  });

  it('is deterministic: identical flags produce byte-identical documents', async () => {
    const first = await uniscenarios('template', 'new');
    const second = await uniscenarios('template', 'new');
    expect(second.stdout).toBe(first.stdout);
  });

  it('writes the same document to --out as it prints', async () => {
    const out = path.join(os.tmpdir(), `uniscenarios-new-out-${Date.now()}.json`);
    tmpFiles.push(out);
    const printed = await uniscenarios('template', 'new');
    const written = await uniscenarios('template', 'new', '--out', out);
    expect(written.code).toBe(0);
    const onDisk = await readFile(out, 'utf8');
    expect(JSON.parse(onDisk)).toEqual(json<{ template: unknown }>(printed).template);
    expect(json<{ out: string }>(written).out).toBe(path.resolve(out));
  });

  it('rejects --site without --map as a structured command error', async () => {
    const run = await uniscenarios('template', 'new', '--site', 'some-site');
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { code: string; path: string };
    expect(error.code).toBe('missing_option');
    expect(error.path).toBe('--site');
  });

  it('reports unknown flags on stderr with exit 1', async () => {
    const run = await uniscenarios('template', 'new', '--naem', 'x');
    expect(run.code).toBe(1);
    const error = JSON.parse(run.stderr) as { code: string; path: string };
    expect(error.code).toBe('unknown_flag');
    expect(error.path).toBe('--naem');
  });

  it.skipIf(!haveArtifacts)('pre-binds --map/--site through anchor.pin', async () => {
    const run = await uniscenarios('template', 'new', '--map', 'yale-street', '--site', 'site-123');
    expect(run.code).toBe(0);
    const payload = json<{
      template: { sourceMap: { mapId: string }; anchor: { pin: { mapId: string; siteId?: string } } };
    }>(run);
    expect(payload.template.sourceMap.mapId).toBe('yale-street');
    expect(payload.template.anchor.pin).toEqual({ mapId: 'yale-street', siteId: 'site-123' });
  });

  it.skipIf(!haveArtifacts)('rejects an unknown map with the closed vocabulary attached', async () => {
    const run = await uniscenarios('template', 'new', '--map', 'not-a-map');
    expect(run.code).toBe(1);
    const error = JSON.parse(run.stderr) as { code: string; detail: { known: string[] } };
    expect(error.code).toBe('unknown_map');
    expect(error.detail.known).toContain('yale-street');
  });
});
