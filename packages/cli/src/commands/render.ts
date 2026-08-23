import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { parseRenderIntent, type RenderIntentV1 } from '@simforge/scenario';
import {
  RenderArtifactManifestSchema,
  RenderProgressRecordSchema,
  assertEngineSupportsIntent,
  createFixedSchedules,
  encodeProgressJsonl,
  hashFile,
  hashRenderIntent,
  loadBuiltinRenderEngine,
  type BuiltinRenderEngineId,
  type RenderInputFile,
  type RenderProgressRecord,
} from '@simforge/render';

import { CliError, EXIT } from '../errors.js';
import { emit } from '../output.js';

export interface RenderRunOptions {
  readonly intentPath: string;
  readonly engine: BuiltinRenderEngineId;
  readonly outDir: string;
  readonly inputsPath: string;
  readonly engineOptionsPath?: string;
  readonly pretty: boolean;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new CliError('read_failed', `could not read JSON ${path}`, {
      detail: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function localInputs(
  inputMapPath: string,
  intent: RenderIntentV1,
): Promise<ReadonlyMap<string, RenderInputFile>> {
  const raw = await readJson(inputMapPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CliError('bad_value', '--inputs must name a JSON object');
  const paths = raw as Record<string, unknown>;
  const expected = new Map<string, { sha256: string; sizeBytes: number }>([
    ['scenario.xosc', intent.scenarioRevision.openScenario],
    ...intent.assets.map((asset) => [asset.assetId, asset] as const),
  ]);
  const result = new Map<string, RenderInputFile>();
  for (const [inputId, digest] of expected) {
    const configuredPath = paths[inputId];
    if (typeof configuredPath !== 'string' || configuredPath.length === 0) {
      throw new CliError('missing_argument', `input map is missing "${inputId}"`);
    }
    const path = isAbsolute(configuredPath) ? configuredPath : resolve(dirname(inputMapPath), configuredPath);
    const actual = await hashFile(path);
    if (actual.sha256 !== digest.sha256 || actual.sizeBytes !== digest.sizeBytes) {
      throw new CliError('input_mismatch', `input ${inputId} does not match render intent`, {
        detail: { expected: digest, actual },
      });
    }
    result.set(inputId, { inputId, path, ...actual });
  }
  const extras = Object.keys(paths).filter((inputId) => !expected.has(inputId));
  if (extras.length > 0) throw new CliError('bad_value', 'input map contains entries absent from render intent', { detail: { extras } });
  return result;
}

export async function renderHash(intentPath: string, pretty: boolean): Promise<number> {
  const intent = parseRenderIntent(await readJson(intentPath));
  emit({ schema: intent.schema, intentId: intent.intentId, intentSha256: hashRenderIntent(intent) }, { pretty });
  return EXIT.ok;
}

export async function renderRun(options: RenderRunOptions): Promise<number> {
  const intent = parseRenderIntent(await readJson(options.intentPath));
  const intentSha256 = hashRenderIntent(intent);
  const inputs = await localInputs(options.inputsPath, intent);
  const engineOptionsRaw = options.engineOptionsPath ? await readJson(options.engineOptionsPath) : {};
  if (!engineOptionsRaw || typeof engineOptionsRaw !== 'object' || Array.isArray(engineOptionsRaw)) {
    throw new CliError('bad_value', '--engine-options must name a JSON object');
  }
  const engine = await loadBuiltinRenderEngine(options.engine, engineOptionsRaw as Record<string, unknown>);
  assertEngineSupportsIntent(engine.capabilities, intent);
  const workspace = resolve(options.outDir);
  await mkdir(workspace, { recursive: true });
  let sequence = 0;
  const reportProgress = async (candidate: RenderProgressRecord): Promise<void> => {
    const record = RenderProgressRecordSchema.parse({
      ...candidate,
      jobId: intent.intentId,
      attempt: 1,
      sequence,
      timestamp: new Date().toISOString(),
    });
    process.stderr.write(encodeProgressJsonl(record));
    sequence += 1;
  };
  const controller = new AbortController();
  const cancel = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
    controller.abort(new Error(`render canceled by ${signal}`));
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);

  try {
    await reportProgress({
      schema: 'uniscenario.render-progress/v1',
      event: 'job.started',
      jobId: intent.intentId,
      attempt: 1,
      sequence: 0,
      timestamp: new Date().toISOString(),
    });
    const manifest = RenderArtifactManifestSchema.parse(await engine.execute({
      jobId: intent.intentId,
      attempt: 1,
      intent,
      intentSha256,
      schedules: createFixedSchedules(intent),
      inputs,
      workspace,
      signal: controller.signal,
      reportProgress,
    }));
    if (manifest.intentSha256 !== intentSha256) throw new CliError('input_mismatch', 'engine returned a manifest for another intent');
    for (const artifact of manifest.artifacts) {
      const path = resolve(workspace, artifact.relativePath);
      if (path !== workspace && !path.startsWith(`${workspace}/`)) throw new CliError('bad_value', `artifact escapes output directory: ${artifact.relativePath}`);
      const digest = await hashFile(path);
      if (digest.sha256 !== artifact.sha256 || digest.sizeBytes !== artifact.sizeBytes) {
        throw new CliError('input_mismatch', `artifact does not match manifest: ${artifact.relativePath}`);
      }
    }
    if (manifest.artifacts.length === 0) throw new CliError('render_failed', 'engine produced no artifacts');
    const manifestPath = join(workspace, 'render-artifact-manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    emit({ intentSha256, manifestPath, artifactCount: manifest.artifacts.length }, { pretty: options.pretty });
    return EXIT.ok;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    await engine.close?.();
  }
}
