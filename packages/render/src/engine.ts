import type { RenderIntentV1 } from '@simforge-oss/scenario';

import type { RenderArtifactManifest } from './artifacts.js';
import { EngineCapabilityDeclarationSchema, type EngineCapabilityDeclaration } from './capabilities.js';
import type { RenderProgressRecord } from './progress.js';
import type { FixedSchedule } from './schedule.js';

export interface RenderInputFile {
  readonly inputId: string;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface RenderExecutionContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly intent: RenderIntentV1;
  readonly intentSha256: string;
  readonly executionPackageControlSha256: string;
  readonly schedules: readonly FixedSchedule[];
  readonly inputs: ReadonlyMap<string, RenderInputFile>;
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly reportProgress: (record: RenderProgressRecord) => Promise<void>;
}

/**
 * The only backend plug-in boundary. Adapters must either return a validated
 * manifest for real files or throw; there is no successful empty/default path.
 */
export interface RenderEngineAdapter {
  readonly capabilities: EngineCapabilityDeclaration;
  execute(context: RenderExecutionContext): Promise<RenderArtifactManifest>;
  close?(): Promise<void>;
}

export type RenderEngineAdapterModule = {
  createRenderEngine(options: Readonly<Record<string, unknown>>): Promise<RenderEngineAdapter> | RenderEngineAdapter;
};

export async function loadRenderEngine(
  moduleSpecifier: string,
  options: Readonly<Record<string, unknown>> = {},
): Promise<RenderEngineAdapter> {
  if (moduleSpecifier.length === 0) throw new Error('engine module specifier is required');
  // Adapter selection is operator configuration, so the module cannot be statically imported.
  const imported = await import(moduleSpecifier) as Partial<RenderEngineAdapterModule>;
  if (typeof imported.createRenderEngine !== 'function') {
    throw new TypeError(`${moduleSpecifier} must export createRenderEngine(options)`);
  }
  const adapter = await imported.createRenderEngine(options);
  if (!adapter || typeof adapter.execute !== 'function' || !adapter.capabilities) {
    throw new TypeError(`${moduleSpecifier} returned an invalid render engine adapter`);
  }
  EngineCapabilityDeclarationSchema.parse(adapter.capabilities);
  return adapter;
}
