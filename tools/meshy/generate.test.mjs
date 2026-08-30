import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  assetPaths,
  buildPreviewRequest,
  buildRefineRequest,
  creditUsage,
  download,
  manifestEntry,
  validateCatalog,
} from './generate.mjs';

const entry = {
  id: 'hazard.smoke_test',
  class: 'hazard',
  label: 'smoke-test road marker',
  description: 'A small neutral road marker.',
  dims: { l: 0.4, w: 0.4, h: 0.6 },
};
const asset = {
  prompt: 'A small neutral road marker.',
  texturePrompt: 'Neutral orange PBR material.',
};

test('builds the documented Meshy preview and refine request contract', () => {
  assert.deepEqual(buildPreviewRequest(entry, asset), {
    mode: 'preview',
    prompt: asset.prompt,
    model_type: 'standard',
    ai_model: 'latest',
    should_remesh: true,
    topology: 'triangle',
    target_polycount: 60_000,
    pose_mode: '',
    moderation: false,
    target_formats: ['glb'],
    auto_size: false,
  });
  assert.deepEqual(buildRefineRequest('preview-task-id', asset), {
    mode: 'refine',
    preview_task_id: 'preview-task-id',
    enable_pbr: true,
    texture_resolution: '2k',
    texture_prompt: asset.texturePrompt,
    ai_model: 'latest',
    moderation: false,
    remove_lighting: true,
    target_formats: ['glb'],
  });
});

test('validates catalog identifiers before using them as downloader paths', () => {
  assert.doesNotThrow(() => validateCatalog([entry], 'fixture'));
  assert.throws(
    () => validateCatalog([{ ...entry, id: '../../escape' }], 'fixture'),
    /Invalid catalog id/,
  );
  assert.throws(() => assetPaths('../../escape'), /Invalid catalog id/);

  const paths = assetPaths(entry.id, { cacheRoot: '/cache', outputRoot: '/output' });
  assert.equal(paths.rawModel, path.join('/cache', entry.id, 'refined.glb'));
  assert.equal(paths.model, path.join('/output', entry.id, 'model.glb'));
  assert.equal(paths.animations.walk, path.join('/output', entry.id, 'animations', 'walk.glb'));
});

test('emits the durable manifest schema', () => {
  assert.deepEqual(manifestEntry({
    catalogId: entry.id,
    stage: 'completed',
    tasks: {
      preview: { id: 'preview-id' },
      refine: { id: 'refine-id' },
    },
    output: {
      sha256: 'abc123',
      bounds: { normalized: entry.dims },
      scaleApplied: 0.5,
      animationSha256: {},
    },
  }), {
    catalogId: entry.id,
    meshyTaskIds: { preview: 'preview-id', refine: 'refine-id' },
    sha256: 'abc123',
    bounds: { normalized: entry.dims },
    scaleApplied: 0.5,
    status: 'completed',
    animationSha256: {},
  });
});

test('preserves credits consumed by superseded retry tasks', () => {
  assert.equal(creditUsage({
    assets: {
      [entry.id]: {
        priorConsumedCredits: 30,
        tasks: {
          preview: { consumedCredits: 20 },
          refine: { consumedCredits: 10 },
        },
      },
    },
  }), 60);
});

test('downloads a binary GLB to the resolved cache path', async () => {
  const glb = Buffer.alloc(24);
  glb.write('glTF', 0, 'ascii');
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'model/gltf-binary' });
    response.end(glb);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());

  const root = await mkdtemp(path.join(os.tmpdir(), 'simforge-meshy-smoke-'));
  try {
    const target = assetPaths(entry.id, { cacheRoot: root, outputRoot: root }).rawModel;
    const address = server.address();
    await download(`http://127.0.0.1:${address.port}/model.glb`, target);
    assert.deepEqual(await readFile(target), glb);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
