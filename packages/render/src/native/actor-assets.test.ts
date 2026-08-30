import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { ensureActorAssets } from './actor-assets.js';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

it('materializes and verifies a digest-pinned actor asset closure', async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.actor-assets-test-'));
  const registry = path.join(root, 'registry');
  const cache = path.join(root, 'cache');
  const memberBytes = Buffer.from('{"vehicle.sedan":{"model":{"glbPath":"models/vehicle.sedan/model.glb"}}}\n');
  const memberDigest = digest(memberBytes);
  const closureBytes = Buffer.from(`{"members":{"catalog-models.json":{"bytes":${memberBytes.byteLength},"sha256":"${memberDigest}"}},"schema":"simforge.actor-assets-closure/v1"}`);
  const closureDigest = digest(closureBytes);
  await fs.mkdir(path.join(registry, 'blobs', 'sha256', memberDigest.slice(0, 2)), { recursive: true });
  await fs.mkdir(path.join(registry, 'actor-assets', 'closures'), { recursive: true });
  await fs.writeFile(path.join(registry, 'blobs', 'sha256', memberDigest.slice(0, 2), memberDigest), memberBytes);
  await fs.writeFile(path.join(registry, 'actor-assets', 'closures', `${closureDigest}.json`), closureBytes);

  const materialized = await ensureActorAssets({
    digest: closureDigest,
    baseUrl: new URL(`file://${registry}/`).href,
    cacheDir: cache,
  });
  expect(await fs.readFile(path.join(materialized, 'catalog-models.json'), 'utf8')).toBe(memberBytes.toString());
  expect((await fs.readFile(path.join(materialized, '.complete'), 'utf8')).trim()).toBe(closureDigest);
  await fs.rm(root, { recursive: true, force: true });
});
