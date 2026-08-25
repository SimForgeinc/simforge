#!/usr/bin/env node
/** Validate every CARLA actor GLB referenced by vehicle and pedestrian manifests. */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { validateBytes } = createRequire(import.meta.url)('gltf-validator');

const here = dirname(fileURLToPath(import.meta.url));
const roots = process.argv.slice(2).length
  ? process.argv.slice(2).map((path) => resolve(path))
  : [resolve(here, '..'), resolve(here, '..', '..', 'pedestrians-carla')];
let checked = 0;
for (const root of roots) {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const entries = manifest.vehicles ?? manifest.pedestrians;
  if (!entries || typeof entries !== 'object') throw new Error(`${root}: no actor entries`);
  for (const [id, entry] of Object.entries(entries)) {
    const path = resolve(root, entry.file);
    const report = await validateBytes(new Uint8Array(await readFile(path)), {
      uri: path,
      maxIssues: 100,
    });
    const errors = report.issues.numErrors;
    const warnings = report.issues.numWarnings;
    if (errors || warnings) {
      throw new Error(`${id}: glTF validator reported ${errors} errors, ${warnings} warnings`);
    }
    checked++;
  }
}
console.log(`validated ${checked} CARLA actor GLBs: 0 errors, 0 warnings`);
