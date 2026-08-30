import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RenderWorkerConfigSchema } from './config.js';
import { chownWorkspace, configuredContainerIdentity } from './workspace.js';

function config(options: Record<string, unknown>) {
  return RenderWorkerConfigSchema.parse({
    workerId: 'worker-1',
    instanceId: 'instance-1',
    engine: { id: 'carla', options },
    control: { kind: 'http', baseUrl: 'https://example.test' },
    scratchDir: '/scratch',
    cacheDir: '/cache',
    gpuLockPath: '/run/gpu.lock',
  });
}

describe('container workspace ownership', () => {
  it('defaults containerGid to containerUid', () => {
    expect(configuredContainerIdentity(config({ containerUid: 1000 }))).toEqual({ uid: 1000, gid: 1000 });
    expect(configuredContainerIdentity(config({}))).toBeUndefined();
  });

  it('rejects invalid container identities', () => {
    expect(() => configuredContainerIdentity(config({ containerUid: -1 }))).toThrow(/containerUid/);
    expect(() => configuredContainerIdentity(config({ containerUid: 1000, containerGid: 1.5 }))).toThrow(/containerGid/);
  });

  it('recursively applies the configured identity', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'simforge-workspace-'));
    const nested = join(workspace, 'inputs');
    const input = join(nested, 'scenario.xosc');
    await mkdir(nested);
    await writeFile(input, 'scenario', { mode: 0o600 });

    const identity = { uid: process.getuid!(), gid: process.getgid!() };
    await chownWorkspace(workspace, identity);

    for (const path of [workspace, nested, input]) {
      const metadata = await stat(path);
      expect({ uid: metadata.uid, gid: metadata.gid }).toEqual(identity);
    }
  });
});
