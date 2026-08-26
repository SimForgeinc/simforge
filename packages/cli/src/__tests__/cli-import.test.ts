/**
 * `simforge import` end to end, through the real binary.
 *
 * The fixtures are the OpenSCENARIO conformance goldens in
 * `packages/openscenario/conformance/` — real XML 1.4 files that ship with the
 * repo, so the command's contract (JSON summary, findings → exit 2, translated
 * template on `--out`) is asserted against honest input, not a hand-written
 * minimal document.
 */

import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa, type ExecaError } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';

import { DEV_ASSETS, REPO_ROOT } from '@simforge/compiler/node';

const BIN = path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'simforge.js');
const FIXTURE = path.join(REPO_ROOT, 'packages', 'openscenario', 'conformance', 'actor-despawn.xosc');
const haveArtifacts = existsSync(path.join(DEV_ASSETS, 'yale-st-palo-alto-ca'));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function simforge(...args: string[]): Promise<Run> {
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

interface ImportSummary {
  ok: boolean;
  standard: string;
  stats: { actors: number; rolesTranslated: number };
  map: { status: string; selectedMapVersionId: string | null; diagnostic: { code: string } | null };
  capabilities: { supported: number; approximated: number; unsupported: number };
  lossy: string[];
  validation: { ok: boolean; counts: { error: number }; issues: Array<{ severity: string }> } | null;
  findings: Array<{ kind: string; code: string }>;
  out: string | null;
}

const tmpFiles: string[] = [];
afterAll(async () => {
  await Promise.all(tmpFiles.map((f) => rm(f, { force: true })));
});

describe('simforge import', () => {
  it('appears in the machine-readable command surface', async () => {
    const run = await simforge();
    expect(run.code).toBe(0);
    const payload = json<{ commands: Array<{ name: string }> }>(run);
    expect(payload.commands.map((c) => c.name)).toContain('import');
  });

  it('reports an unresolved map identity as findings with exit 2', async () => {
    const run = await simforge('import', FIXTURE);
    // The conformance golden references `conformance-map.xodr`, which is not a
    // dev-assets map — exactly the "ran and found something wrong" case.
    expect(run.code).toBe(2);
    const payload = json<ImportSummary>(run);
    expect(payload.ok).toBe(false);
    expect(payload.standard).toBe('ASAM OpenSCENARIO 1.4');
    expect(payload.stats.actors).toBeGreaterThan(0);
    expect(payload.map.status).toBe('unresolved');
    expect(payload.map.diagnostic?.code).toBe('logic_file_not_found');
    expect(payload.findings.map((f) => f.code)).toContain('logic_file_not_found');
    expect(payload.validation).toBeNull();
    expect(payload.out).toBeNull();
  });

  it('rejects a missing input file as a structured command error', async () => {
    const run = await simforge('import', '/nonexistent/scene.xosc');
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { code: string; path: string };
    expect(error.code).toBe('file_not_found');
    expect(error.path).toBe('/nonexistent/scene.xosc');
  });

  it('reports an unsupported major version as findings with exit 2', async () => {
    const bad = path.join(os.tmpdir(), `simforge-import-bad-${Date.now()}.xosc`);
    tmpFiles.push(bad);
    await writeFile(bad, '<OpenSCENARIO><FileHeader revMajor="9"/></OpenSCENARIO>', 'utf8');
    const run = await simforge('import', bad);
    // A wrong version parses; it is a finding about the input, not a command
    // failure — the same exit-2 contract as every other import finding.
    expect(run.code).toBe(2);
    const payload = json<ImportSummary>(run);
    expect(payload.findings.map((f) => f.code)).toContain('version_unsupported');
  });

  it('rejects input that is not XML at all as a command error', async () => {
    const bad = path.join(os.tmpdir(), `simforge-import-junk-${Date.now()}.xosc`);
    tmpFiles.push(bad);
    await writeFile(bad, 'this is not xml', 'utf8');
    const run = await simforge('import', bad);
    expect(run.code).toBe(1);
    const error = JSON.parse(run.stderr) as { code: string };
    expect(error.code).toBe('malformed_xml');
  });

  it.skipIf(!haveArtifacts)('translates against --map, writes the draft, and reports what was lossy', async () => {
    const out = path.join(os.tmpdir(), `simforge-import-${Date.now()}.template.json`);
    tmpFiles.push(out);
    const run = await simforge('import', FIXTURE, '--map', 'yale-st-palo-alto-ca', '--out', out);
    // Storyboard semantics are not translatable, so findings exist even on a
    // successful translation — exit 2 says "read me", not "failed".
    expect(run.code).toBe(2);
    const payload = json<ImportSummary>(run);
    expect(payload.map.status).toBe('resolved');
    expect(payload.map.selectedMapVersionId).toBe('yale-st-palo-alto-ca');
    expect(payload.stats.rolesTranslated).toBe(payload.stats.actors);
    expect(payload.capabilities.unsupported).toBeGreaterThan(0);
    expect(payload.lossy.length).toBeGreaterThan(0);
    expect(payload.findings.map((f) => f.kind)).toContain('feature');
    expect(payload.out).toBe(path.resolve(out));

    const document = JSON.parse(await readFile(out, 'utf8')) as {
      scenarioVersion: number;
      anchor: { pin: { mapId: string } };
      roles: Array<{ kind: string }>;
      extensions: { openScenarioImport: { source: { sha256: string } } };
    };
    expect(document.scenarioVersion).toBe(2);
    expect(document.anchor.pin.mapId).toBe('yale-st-palo-alto-ca');
    expect(document.roles.every((r) => r.kind === 'scene_absolute')).toBe(true);
    expect(document.extensions.openScenarioImport.source.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The draft must be a first-class citizen of the pipeline it feeds.
    const validated = await simforge('template', 'validate', out);
    expect(validated.code).toBe(0);
  });

  it.skipIf(!haveArtifacts)('renders the same result under --pretty without changing the verdict', async () => {
    const run = await simforge('import', FIXTURE, '--map', 'yale-st-palo-alto-ca', '--pretty');
    expect(run.code).toBe(2);
    expect(run.stdout).toContain('lossy:');
    expect(run.stdout).toContain('ASAM OpenSCENARIO 1.4');
  });
});
