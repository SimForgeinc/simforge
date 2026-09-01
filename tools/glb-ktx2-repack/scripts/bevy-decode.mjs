#!/usr/bin/env node
/**
 * Prepare a repacked (KTX2) production tile for Bevy render-core.
 *
 * bevy_gltf supports neither EXT_meshopt_compression nor
 * KHR_mesh_quantization, so geometry must be decoded asset-side. This is
 * the sensor-corpus geometry decode (scripts/renderer-spike/FINDINGS.md §1)
 * minus the WebP->PNG step, which the KTX2 repack makes unnecessary:
 *
 *   1. gltf-transform optimize  — decodes EXT_meshopt, no re-compression,
 *      no texture work, no instancing/join/simplify/weld.
 *   2. gltf-transform dequantize — int16 -> f32 vertex attributes.
 *   3. gltf-transform unweld     — permit splits at tangent discontinuities.
 *   4. gltf-transform tangents   — bake MikkTSpace tangents so normal-map
 *      shading is not dependent on renderer-specific runtime generation.
 *   5. gltf-transform weld       — re-index only identical tangent vertices.
 *
 * Output keeps standards-compliant KHR_texture_basisu references: the
 * renderer's vendored bevy_gltf (renderer/vendor/bevy_gltf) loads that
 * syntax natively, so no flattened texture.source cache copy exists.
 *
 *   node tools/glb-ktx2-repack/scripts/bevy-decode.mjs <in.ktx2.glb> <out.glb>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GLTF_TRANSFORM_VERSION = '4.4.2'; // matches .corpus manifest + config/map-derivative-toolchain.json family

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: bevy-decode.mjs <in.ktx2.glb> <out.glb>');
  process.exit(2);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bevy-decode-'));
const step1 = path.join(tmpDir, 'step1.glb');
const step2 = path.join(tmpDir, 'step2.glb');
const step3 = path.join(tmpDir, 'step3.glb');
const step4 = path.join(tmpDir, 'step4.glb');
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
  run(['unweld', step2, step3]);
  run(['tangents', step3, step4]);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  run(['weld', step4, output]);
  console.log(`${path.basename(output)}: geometry decoded, MikkTSpace tangents authored, KHR_texture_basisu references preserved`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
