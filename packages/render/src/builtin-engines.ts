import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RenderIntentV1Schema } from '@simforge-oss/scenario';

import { RenderArtifactManifestSchema, type RenderArtifactManifest } from './artifacts.js';
import { ENGINE_CAPABILITIES_V1_SCHEMA, type EngineCapabilityDeclaration } from './capabilities.js';
import { loadRenderEngine, type RenderEngineAdapter, type RenderExecutionContext } from './engine.js';
import { parseProgressJsonl } from './progress.js';

export type BuiltinRenderEngineId = 'browser' | 'carla' | 'native';

const CARLA_CAPABILITIES: EngineCapabilityDeclaration = {
  schema: ENGINE_CAPABILITIES_V1_SCHEMA,
  engineId: 'uniscenarios-carla',
  engineVersion: 'native-v1',
  backend: 'carla',
  protocolVersion: 1,
  capabilities: [
    'openscenario.1_4',
    'timing.fixed_step',
    'environment.authored',
    'sensor.rgb',
    'sensor.depth',
    'sensor.semantic',
    'sensor.instance',
    'sensor.lidar',
    'sensor.radar',
    'artifact.video',
    'artifact.sensor_video',
    'artifact.sensor_archive',
    'artifact.manifest',
    'artifact.trace',
    'artifact.annotations',
    'map.static_semantics',
    'control.native',
    'divergence.classified',
  ],
  modalities: ['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar'],
  limits: {
    maxSimultaneousSensors: 64,
    maxWidth: 8192,
    maxHeight: 8192,
    maxFramesPerSecond: 240,
  },
  requiresGpu: true,
};

class CarlaProcessEngine implements RenderEngineAdapter {
  readonly capabilities = CARLA_CAPABILITIES;

  constructor(
    private readonly binary: string,
    private readonly host: string,
    private readonly port: number,
  ) {}

  async execute(context: RenderExecutionContext): Promise<RenderArtifactManifest> {
    await mkdir(context.workspace, { recursive: true });
    const intentPath = join(context.workspace, 'render-intent.json');
    const packagePath = join(context.workspace, 'input-package.json');
    const progressPath = join(context.workspace, 'carla-progress.jsonl');
    const manifestPath = join(context.workspace, 'render-artifact-manifest.json');
    await writeFile(intentPath, `${JSON.stringify(RenderIntentV1Schema.parse(context.intent))}\n`, { mode: 0o600 });
    await writeFile(packagePath, `${JSON.stringify({
      intentSha256: context.intentSha256,
      inputs: [...context.inputs.values()],
    })}\n`, { mode: 0o600 });

    const child = spawn(this.binary, [
      '--host', this.host,
      '--port', String(this.port),
      'run-intent',
      '--intent', intentPath,
      '--package', packagePath,
      '--output', context.workspace,
      '--progress', progressPath,
      '--manifest', manifestPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-16_384); });
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    const terminate = (): void => {
      child.kill('SIGTERM');
      const hardKill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      hardKill.unref();
    };
    context.signal.addEventListener('abort', terminate, { once: true });

    let consumedLines = 0;
    const forwardProgress = async (): Promise<void> => {
      let text: string;
      try {
        text = await readFile(progressPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const lines = text.split('\n');
      const completeLineCount = text.endsWith('\n') ? lines.length - 1 : lines.length - 1;
      for (; consumedLines < completeLineCount; consumedLines++) {
        const line = lines[consumedLines];
        if (line && line.trim().length > 0) await context.reportProgress(parseProgressJsonl(line));
      }
    };

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    while (!result) {
      result = await Promise.race([
        exit,
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 250);
          timer.unref();
        }),
      ]);
      await forwardProgress();
    }
    context.signal.removeEventListener('abort', terminate);
    await forwardProgress();
    if (result.code !== 0) {
      throw new Error(`CARLA renderer exited code=${String(result.code)} signal=${String(result.signal)} stdout=${stdout} stderr=${stderr}`);
    }
    return RenderArtifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  }
}

export async function loadBuiltinRenderEngine(
  engineId: BuiltinRenderEngineId,
  options: Readonly<Record<string, unknown>> = {},
): Promise<RenderEngineAdapter> {
  if (engineId === 'browser') {
    const moduleSpecifier = typeof options.module === 'string'
      ? options.module
      : process.env.UNISCENARIOS_BROWSER_ENGINE_MODULE ?? './web/index.js';
    const { module: _module, ...engineOptions } = options;
    return loadRenderEngine(moduleSpecifier, engineOptions);
  }
  if (engineId === 'native') {
    const moduleSpecifier = typeof options.module === 'string'
      ? options.module
      : process.env.SIMFORGE_NATIVE_ENGINE_MODULE ?? '@simforge-oss/render/native';
    const { module: _module, ...engineOptions } = options;
    return loadRenderEngine(moduleSpecifier, engineOptions);
  }
  const binary = typeof options.binary === 'string'
    ? options.binary
    : process.env.UNISCENARIOS_CARLA_BINARY ?? 'simforge-oss-carla-api';
  const host = typeof options.host === 'string'
    ? options.host
    : process.env.CARLA_HOST ?? '127.0.0.1';
  const configuredPort = typeof options.port === 'number'
    ? options.port
    : Number(process.env.CARLA_PORT ?? 2000);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
    throw new Error(`Invalid CARLA port: ${String(configuredPort)}`);
  }
  return new CarlaProcessEngine(binary, host, configuredPort);
}
