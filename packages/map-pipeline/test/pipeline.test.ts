import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assembleClosure, assignGridCell, fbxToTiles, materializeRegistryPayload, runMapPipeline } from '../src/index.js';

const temporaryRoots: string[] = [];
let sourceDir: string;

beforeAll(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'simforge-map-pipeline-test-'));
  temporaryRoots.push(root);
  sourceDir = path.join(root, 'source');
  await mkdir(sourceDir, { recursive: true });
  const fixtureScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'generate-synthetic-fbx.py');
  execFileSync('blender', [
    '--background',
    '--factory-startup',
    '--python', fixtureScript,
    '--', path.join(sourceDir, 'synthetic.fbx'),
  ], { stdio: 'pipe' });
  expect((await stat(path.join(sourceDir, 'synthetic.fbx'))).size).toBeLessThan(5 * 1024 * 1024);
}, 120_000);
afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('grid assignment', () => {
  const grid = { originX: -100, originZ: -200, cellSize: 100 };

  it.each([
    { point: [-100, -200], expected: { x: 0, z: 0 } },
    { point: [-0.001, -100.001], expected: { x: 0, z: 0 } },
    { point: [0, -100], expected: { x: 1, z: 1 } },
    { point: [-100.001, -200.001], expected: { x: -1, z: -1 } },
    { point: [250, 50], expected: { x: 3, z: 2 } },
  ])('assigns $point to the stable half-open grid cell', ({ point, expected }) => {
    expect(assignGridCell(point[0]!, point[1]!, grid)).toEqual(expected);
  });
});

describe('FBX tiling and closure assembly', () => {
  it('produces identical viewer-only closure bytes in two clean work directories', async () => {
    const workA = await mkdtemp(path.join(os.tmpdir(), 'simforge-map-pipeline-a-'));
    const workB = await mkdtemp(path.join(os.tmpdir(), 'simforge-map-pipeline-b-'));
    temporaryRoots.push(workA, workB);
    const tilesA = await fbxToTiles({ sourceDir, workDir: workA, cellSize: 100 });
    const tilesB = await fbxToTiles({ sourceDir, workDir: workB, cellSize: 100 });
    const closureA = await assembleClosure({ tiles: tilesA, sourceDir, workDir: workA, mapName: 'synthetic-city' });
    const closureB = await assembleClosure({ tiles: tilesB, sourceDir, workDir: workB, mapName: 'synthetic-city' });

    expect(tilesA.outputDigest).toBe(tilesB.outputDigest);
    expect(closureA.closureDigest).toBe(closureB.closureDigest);
    expect(closureA.viewerOnly).toBe(true);
    expect(closureA.closure.metadata).toEqual({ viewerOnly: true });
    const memberPaths = Object.keys(closureA.closure.members);
    expect(memberPaths).toEqual(expect.arrayContaining([
      '3d/manifest.json',
      '3d/semantics.json',
      '3d/tiles/road.glb',
      '3d/tiles/tile_0_1.lod0.glb',
    ]));
    expect(memberPaths.some((member) => /^3d\/tiles\/tile_\d+_\d+\.lod0\.glb$/.test(member))).toBe(true);
    expect(memberPaths.some((member) => /^3d\/tiles\/veg_\d+_\d+\.lod0\.glb$/.test(member))).toBe(true);
    expect(await readFile(path.join(workA, 'closure-assemble', closureA.cacheKey, 'closure.json')))
      .toEqual(await readFile(path.join(workB, 'closure-assemble', closureB.cacheKey, 'closure.json')));
  }, 180_000);

  it('builds registry-ready browser, KTX2, and native corpus closures', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'simforge-map-pipeline-derived-'));
    const payloadDir = await mkdtemp(path.join(os.tmpdir(), 'simforge-map-pipeline-payload-'));
    temporaryRoots.push(workDir, payloadDir);
    const result = await runMapPipeline({
      sourceDir,
      name: 'synthetic-city',
      workDir,
      ktxBinDir: '/home/path/simforge-assets/tools/KTX-Software-4.4.2-Linux-x86_64/bin',
    });
    expect(result.derived.map((artifact) => artifact.kind)).toEqual([
      'browser-optimized',
      'ktx2',
      'native-corpus',
    ]);
    for (const artifact of result.derived) {
      expect(artifact.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.registryPath).toBe(`derived/${artifact.kind}-${artifact.fingerprint}.json`);
      expect(artifact.closure.metadata).toEqual({ viewerOnly: true });
    }
    const nativeStage = result.stages.nativeCorpus;
    if (!nativeStage) throw new Error('native corpus stage was not built');
    for (const memberPath of Object.keys(nativeStage.closure.members)) {
      if (!memberPath.endsWith('.glb')) continue;
      const bytes = await readFile(path.join(nativeStage.outputDir, memberPath));
      expect(bytes.includes(Buffer.from('EXT_texture_webp'))).toBe(false);
      expect(bytes.includes(Buffer.from('EXT_meshopt_compression'))).toBe(false);
    }
    await materializeRegistryPayload(result, payloadDir);
    for (const artifact of [result.canonical, ...result.derived]) {
      await expect(stat(path.join(payloadDir, artifact.registryPath))).resolves.toBeDefined();
      for (const member of Object.values(artifact.closure.members)) {
        await expect(stat(path.join(payloadDir, 'blobs', 'sha256', member.sha256.slice(0, 2), member.sha256)))
          .resolves.toBeDefined();
      }
    }
  }, 180_000);
});
