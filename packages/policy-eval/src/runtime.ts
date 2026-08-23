/**
 * Runtime resolution of the RL environment stack for policy-eval.
 *
 * policy-eval deliberately takes no static workspace dependency on
 * `@uniscenarios/rl-env` / `@uniscenarios/cli`: the eval protocol must keep
 * working from a split worktree (the hardening lanes branch from main before
 * the rl-env WIP lands) and must reuse rl-env's own node_modules for
 * transitive imports, exactly like `scripts/rl/reactive-env-server.mjs`
 * does with `createRequire`.
 *
 * Resolution order for the rl-env root:
 *   1. `UNISCENARIOS_RL_ENV` environment variable;
 *   2. `<repoRoot>/packages/rl-env` (normal monorepo layout);
 *   3. `$UNISCENARIOS_TRAINING_GRADE/packages/rl-env` when that variable
 *      names the training-grade checkout that carries the built rl stack.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MapBundle, MatchedSite, MaterializeOptions, MaterializeResult } from './rl-bridge-types.js';
import type { EnvSession } from './rl-bridge-types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The narrow surface policy-eval consumes. Everything is resolved through
 * the runtime loader below; these types document the contract without
 * coupling the package graph to the rl workspace.
 */
export interface RlRuntime {
  readonly rlEnvRoot: string;
  readTemplate(file: string): Promise<unknown>;
  findSite(
    template: unknown,
    mapId: string,
    siteId: string,
  ): Promise<{ bundle: MapBundle; site: MatchedSite }>;
  materialize(template: unknown, bundle: MapBundle, site: MatchedSite, options: MaterializeOptions): MaterializeResult;
  availableMaps(): string[];
  EnvSession: new (options: {
    input: unknown;
    graph: unknown;
    runOptions?: Record<string, unknown>;
    episode?: Record<string, unknown>;
  }) => EnvSession;
  encodeStepResult(result: unknown): Record<string, unknown>;
  decodeAction(action: unknown): Record<string, unknown>;
  serveSocket(server: unknown, socketPath: string): { once(event: string, cb: (...args: unknown[]) => void): void };
}

let cached: Promise<RlRuntime> | null = null;

export function resolveRlRuntime(): Promise<RlRuntime> {
  if (cached) return cached;
  cached = (async (): Promise<RlRuntime> => {
    const roots = [
      process.env['UNISCENARIOS_RL_ENV'],
      path.resolve(HERE, '..', '..', '..', 'packages', 'rl-env'),
      process.env['UNISCENARIOS_TRAINING_GRADE'] === undefined
        ? undefined
        : path.join(process.env['UNISCENARIOS_TRAINING_GRADE'], 'packages', 'rl-env'),
    ].filter((r): r is string => r !== undefined && existsSync(path.join(r, 'dist', 'index.js')));
    const rlEnvRoot = roots[0];
    if (rlEnvRoot === undefined) {
      throw new Error(
        'no @uniscenarios/rl-env dist found; set UNISCENARIOS_RL_ENV to a checkout with packages/rl-env/dist',
      );
    }
    const req = createRequire(path.join(rlEnvRoot, 'package.json'));
    const cli = (await import(pathToFileURL(req.resolve('@uniscenarios/cli')).href)) as {
      readTemplate: RlRuntime['readTemplate'];
      findSite: RlRuntime['findSite'];
      materialize: RlRuntime['materialize'];
      availableMaps: RlRuntime['availableMaps'];
    };
    const envServer = (await import(pathToFileURL(path.join(rlEnvRoot, 'dist', 'env-server.js')).href)) as {
      encodeStepResult: RlRuntime['encodeStepResult'];
      decodeAction: RlRuntime['decodeAction'];
      serveSocket: RlRuntime['serveSocket'];
    };
    const sessionMod = (await import(pathToFileURL(path.join(rlEnvRoot, 'dist', 'index.js')).href)) as {
      EnvSession: RlRuntime['EnvSession'];
    };
    return { rlEnvRoot, ...cli, ...envServer, EnvSession: sessionMod.EnvSession };
  })();
  return cached;
}
