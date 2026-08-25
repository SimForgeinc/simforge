#!/usr/bin/env node
/**
 * Prepare a repacked (KTX2) production tile for Bevy render-core.
 *
 * bevy_gltf 0.19 supports neither EXT_meshopt_compression nor
 * KHR_mesh_quantization nor the KHR_texture_basisu *syntax* (it does decode
 * raw KTX2 referenced from texture.source — bevyengine/bevy#19104). This is
 * the sensor-corpus geometry decode (scripts/renderer-spike/FINDINGS.md §1)
 * minus the WebP->PNG step, which the KTX2 repack makes unnecessary:
 *
 *   1. gltf-transform optimize  — decodes EXT_meshopt, no re-compression,
 *      no texture work, no instancing/join/simplify/weld.
 *   2. gltf-transform dequantize — int16 -> f32 vertex attributes.
 *   3. flatten KHR_texture_basisu.source into texture.source and drop the
 *      extension so bevy_gltf resolves the KTX2 images.
 *
 *   node tools/glb-ktx2-repack/scripts/bevy-decode.mjs <in.ktx2.glb> <out.glb>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseGlb, writeGlb } from '../src/glb.mjs';

const GLTF_TRANSFORM_VERSION = '4.4.2'; // matches .corpus manifest + config/map-derivative-toolchain.json family

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: bevy-decode.mjs <in.ktx2.glb> <out.glb>');
  process.exit(2);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevy-decode-'));
const step1 = path.join(tmpDir, 'step1.glb');
const step2 = path.join(tmpDir, 'step2.glb');
const run = (args) => {
  const result = spawnSync('npx', ['-y', `@gltf-transform/cli@${GLTF_TRANSFORM_VERSION}`, ...args], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`gltf-transform ${args[0]} failed (${result.status})`);
  }
};

try {
  run([
    'optimize', input, step1,
    '--compress', 'false',
    '--texture-compress', 'false',
    '--instance', 'false',
    '--join', 'false',
    '--simplify', 'false',
    '--weld', 'false',
  ]);
  run(['dequantize', step1, step2]);

  const { json, bin } = parseGlb(fs.readFileSync(step2));
  let flattened = 0;
  for (const texture of json.textures ?? []) {
    const source = texture.extensions?.KHR_texture_basisu?.source;
    if (Number.isInteger(source)) {
      texture.source = source;
      delete texture.extensions.KHR_texture_basisu;
      if (Object.keys(texture.extensions).length === 0) delete texture.extensions;
      flattened++;
    }
  }
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    if (json[key]) {
      json[key] = json[key].filter((e) => e !== 'KHR_texture_basisu');
      if (json[key].length === 0) delete json[key];
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, writeGlb(json, bin));
  console.log(`${path.basename(output)}: geometry decoded, ${flattened} textures flattened to core source`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
