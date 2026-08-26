import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { hashTree, sha256 } from './closure.js';
import { buildMaterialBindingPlan } from './material-binding.js';

const execFileAsync = promisify(execFile);
export const FBX_TILER_REVISION = 4;

export interface GridDefinition {
  originX: number;
  originZ: number;
  cellSize: number;
}

export interface GridCell {
  x: number;
  z: number;
}

export function assignGridCell(x: number, z: number, grid: GridDefinition): GridCell {
  if (![x, z, grid.originX, grid.originZ, grid.cellSize].every(Number.isFinite) || grid.cellSize <= 0) {
    throw new Error('grid coordinates and positive cellSize must be finite');
  }
  return {
    x: Math.floor((x - grid.originX) / grid.cellSize),
    z: Math.floor((z - grid.originZ) / grid.cellSize),
  };
}

export interface FbxToTilesOptions {
  sourceDir: string;
  workDir: string;
  blender?: string;
  cellSize?: number;
}

export interface StageResult {
  inputDigest: string;
  toolFingerprint: string;
  outputDigest: string;
  outputDir: string;
  cacheKey: string;
}

async function blenderVersion(blender: string): Promise<string> {
  const { stdout } = await execFileAsync(blender, ['--version']);
  const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) throw new Error(`could not determine Blender version from ${blender}`);
  return firstLine;
}

async function scriptPath(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../scripts/fbx-to-tiles.py'),
    path.resolve(here, '../../scripts/fbx-to-tiles.py'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the source-tree/build-tree alternative.
    }
  }
  throw new Error('fbx-to-tiles.py is missing from @simforge/map-pipeline');
}

export async function fbxToTiles(options: FbxToTilesOptions): Promise<StageResult> {
  const sourceDir = path.resolve(options.sourceDir);
  const blender = options.blender ?? process.env.SIMFORGE_BLENDER ?? 'blender';
  const cellSize = options.cellSize ?? 100;
  const inputDigest = await hashTree(sourceDir);
  const version = await blenderVersion(blender);
  const toolFingerprint = sha256(`fbx-to-tiles\0${FBX_TILER_REVISION}\0${version}\0cell=${cellSize}`);
  const cacheKey = sha256(`${inputDigest}\0${toolFingerprint}`);
  const outputDir = path.resolve(options.workDir, 'fbx-to-tiles', cacheKey);
  const receiptPath = path.join(outputDir, 'stage.json');
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { outputDigest?: string };
    if (typeof receipt.outputDigest === 'string') {
      return { inputDigest, toolFingerprint, outputDigest: receipt.outputDigest, outputDir, cacheKey };
    }
  } catch {
    // A missing/incomplete cache entry is rebuilt below.
  }

  await mkdir(outputDir, { recursive: true });
  const bindingPlan = await buildMaterialBindingPlan(sourceDir);
  if (bindingPlan.unresolvedTextures.length > 0) {
    throw new Error(`materials.json has ${bindingPlan.unresolvedTextures.length} unresolved texture references`);
  }
  const bindingPlanPath = path.join(outputDir, 'material-bindings.json');
  await writeFile(bindingPlanPath, `${JSON.stringify(bindingPlan)}\n`);
  await execFileAsync(blender, [
    '--background',
    '--factory-startup',
    '--python',
    await scriptPath(),
    '--',
    '--source', sourceDir,
    '--output', outputDir,
    '--material-bindings', bindingPlanPath,
    '--cell-size', String(cellSize),
  ], { maxBuffer: 16 * 1024 * 1024 });
  try {
    await access(path.join(outputDir, 'inventory.json'));
  } catch {
    throw new Error(`Blender tiler exited without producing inventory.json for ${sourceDir}`);
  }
  const outputDigest = await hashTree(outputDir);
  const receipt = { schema: 'simforge.map-pipeline-stage.v1', stage: 'fbx-to-tiles', inputDigest, toolFingerprint, outputDigest };
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  return { inputDigest, toolFingerprint, outputDigest, outputDir, cacheKey };
}
