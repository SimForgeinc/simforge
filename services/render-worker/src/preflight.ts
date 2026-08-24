import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

import type { RenderWorkerConfig } from './config.js';

/**
 * Fail-closed host-binary preflight (same spirit as the approval gate on the
 * revision + lockfile hash): the worker refuses to start unless every binary
 * its engine shells out to is executable, and lists everything missing at
 * once. The per-engine defaults are the AUDITED closure of subprocess calls:
 *
 * - carla: the engine binary (render-runtime CarlaProcessEngine spawn), plus
 *   the bridge's subprocess calls — ffmpeg (runtime/backend.py camera
 *   encoder, runtime/sensor_video.py raw-frame encode), ffprobe
 *   (runtime/executor.py frame-closed video verification), xmllint
 *   (runtime/validation.py OpenSCENARIO XSD validation).
 * - browser: the chromium executable (browser-renderer engine.ts
 *   playwright launch via CHROMIUM_EXECUTABLE_PATH).
 *
 * `config.requiredBinaries` extends (never replaces) the audited defaults.
 */
export function requiredWorkerBinaries(config: RenderWorkerConfig): string[] {
  const required = new Set<string>(config.requiredBinaries ?? []);
  if ('id' in config.engine) {
    if (config.engine.id === 'carla') {
      const binary = typeof config.engine.options.binary === 'string'
        ? config.engine.options.binary
        : process.env.UNISCENARIOS_CARLA_BINARY ?? 'uniscenarios-carla';
      for (const item of [binary, 'ffmpeg', 'ffprobe', 'xmllint']) required.add(item);
    }
    if (config.engine.id === 'browser') {
      const chromium = typeof config.engine.options.chromiumExecutablePath === 'string'
        ? config.engine.options.chromiumExecutablePath
        : process.env.CHROMIUM_EXECUTABLE_PATH ?? 'chromium';
      required.add(chromium);
    }
  }
  return [...required];
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolvable(binary: string): Promise<boolean> {
  if (isAbsolute(binary) || binary.includes('/')) return executable(binary);
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir && await executable(join(dir, binary))) return true;
  }
  return false;
}

/** Throws with the complete missing list; never a partial report. */
export async function assertWorkerBinaries(config: RenderWorkerConfig): Promise<void> {
  const missing: string[] = [];
  for (const binary of requiredWorkerBinaries(config)) {
    if (!await resolvable(binary)) missing.push(binary);
  }
  if (missing.length > 0) {
    throw new Error(
      `worker preflight failed: missing executable host binaries: ${missing.join(', ')} `
      + '(install them on the host or fix PATH; see services/render-worker/native/bootstrap-host.sh)',
    );
  }
}
