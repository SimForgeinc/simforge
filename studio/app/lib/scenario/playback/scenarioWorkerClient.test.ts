import { describe, expect, it, vi } from 'vitest';

const preparation = vi.hoisted(() => ({
  gallery: new Promise<never>(() => {}),
}));

vi.mock('../../asset-gallery/editor-bridge', () => ({
  primeGalleryEntriesForDocument: () => preparation.gallery,
}));
vi.mock('../carla-objects', () => ({
  primeCarlaObjectsForDocument: async () => [],
}));
vi.mock('@simforge-oss/asset-catalog', () => ({
  listExternalCatalogEntries: () => [],
}));

import { ScenarioWorkerClient } from './scenarioWorkerClient';

describe('ScenarioWorkerClient preparation lifecycle', () => {
  it('reports the asset-catalog phase when priming stops making progress', async () => {
    const client = new ScenarioWorkerClient();

    await expect(client.prepare(
      { roles: [] } as never,
      {} as never,
      { version: 1, preset: 'off', seed: 'test' },
      undefined,
      { materializeOnly: true, timeoutMs: 5 },
    )).rejects.toThrow('Scenario preparation stopped making progress for 5 ms during asset catalog.');

    client.dispose();
  });
});
