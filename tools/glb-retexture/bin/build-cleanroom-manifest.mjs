#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parseGlb } from '../../glb-ktx2-repack/src/glb.mjs';

const [input, assetsRoot, output] = process.argv.slice(2);
if (!input || !assetsRoot || !output) {
  console.error('usage: build-cleanroom-manifest <road.glb> <cc0-textures-dir> <output.json>');
  process.exit(2);
}
const { json } = parseGlb(fs.readFileSync(input));
const replacements = {};
const needsReplacementAsset = [];
const isVendorPhoto = (name) => /^sign-_[0-9a-f-]+_front(?:_png_BaseColor|\.tga)?$/i.test(name);
const isNormal = (name) => /(?:norm|normal)(?:\.|_|$)/i.test(name);
const isOrm = (name) => /(?:aorm|orm|spec|glossiness)(?:\.|_|$)/i.test(name);
const entry = (file, materialClass, license = 'CC0-1.0') => ({ file, class: materialClass, scaleFactor: 1, license });

for (const image of json.images ?? []) {
  const name = image.name ?? '';
  if (isVendorPhoto(name)) continue;
  const lower = name.toLowerCase();
  let replacement;
  if (/sign|deadend|bikelane|leftoruturn|leftturn|roadwork/.test(lower)) {
    if (/back/.test(lower)) replacement = entry('cleanroom-procedural/sign-aluminum-back.png', 'sign-back');
    else {
      const key = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      replacement = entry(`fhwa-mutcd-renders/${key}.png`, 'mutcd-sign-face', 'US-Government-Public-Domain');
    }
  } else if (/lane.?marking|handicapped|cracks|oilpath/.test(lower)) {
    replacement = entry(/diff_1|yellow/.test(lower) ? 'cleanroom-procedural/lane-paint-yellow.png' : isNormal(name) ? 'cleanroom-procedural/flat-normal.png' : isOrm(name) ? 'cleanroom-procedural/neutral-orm.png' : 'cleanroom-procedural/lane-paint-white.png', 'lane-marking');
  } else if (/asphalt/.test(lower)) {
    replacement = entry(isNormal(name) ? 'asphalt_02/asphalt_02_nor_gl_1k.png' : isOrm(name) ? 'asphalt_02/asphalt_02_arm_1k.png' : 'asphalt_02/asphalt_02_diff_1k.png', /worn|crack/.test(lower) ? 'asphalt-worn' : 'asphalt-clean');
  } else if (/concrete|tactile/.test(lower)) {
    replacement = entry(isNormal(name) ? 'concrete_pavement/concrete_pavement_nor_gl_1k.png' : isOrm(name) ? 'concrete_pavement/concrete_pavement_arm_1k.png' : 'concrete_pavement/concrete_pavement_diff_1k.png', /tactile/.test(lower) ? 'tactile-paving' : 'concrete');
  } else if (/grass|median/.test(lower)) {
    replacement = entry(isNormal(name) ? 'forest_ground_04/forest_ground_04_nor_gl_1k.jpg' : isOrm(name) ? 'cleanroom-procedural/neutral-orm.png' : 'forest_ground_04/forest_ground_04_diff_1k.jpg', 'grass');
  } else if (/dirt/.test(lower)) {
    replacement = entry(isNormal(name) ? 'brown_mud_02/brown_mud_02_nor_gl_1k.jpg' : isOrm(name) ? 'cleanroom-procedural/neutral-orm.png' : 'brown_mud_02/brown_mud_02_diff_1k.jpg', 'dirt');
  } else if (/cobblestone|brick/.test(lower)) {
    replacement = entry(isNormal(name) ? 'cobblestone_floor_05/cobblestone_floor_05_nor_gl_1k.jpg' : isOrm(name) ? 'cleanroom-procedural/neutral-orm.png' : 'cobblestone_floor_05/cobblestone_floor_05_diff_1k.jpg', /brick/.test(lower) ? 'brick' : 'cobblestone');
  } else if (/sand/.test(lower)) {
    replacement = entry(isNormal(name) ? 'coast_sand_rocks_02/coast_sand_rocks_02_nor_gl_1k.jpg' : isOrm(name) ? 'cleanroom-procedural/neutral-orm.png' : 'coast_sand_rocks_02/coast_sand_rocks_02_diff_1k.jpg', 'sand');
  } else if (/gravel|rocksset/.test(lower)) {
    replacement = entry(isNormal(name) ? 'cleanroom-procedural/flat-normal.png' : isOrm(name) ? 'cleanroom-procedural/neutral-orm.png' : 'cleanroom-procedural/gravel-basecolor.png', 'gravel');
  } else if (/water/.test(lower)) {
    replacement = entry(isNormal(name) ? 'cleanroom-procedural/water-normal.png' : isOrm(name) ? 'cleanroom-procedural/neutral-orm.png' : 'cleanroom-procedural/water-basecolor.png', 'water');
  } else {
    replacement = entry(isNormal(name) ? 'cleanroom-procedural/flat-normal.png' : isOrm(name) ? 'cleanroom-procedural/neutral-orm.png' : 'cleanroom-procedural/neutral-prop-basecolor.png', 'neutral-prop');
    needsReplacementAsset.push(name);
  }
  if (!fs.existsSync(path.resolve(assetsRoot, replacement.file))) {
    throw new Error(`replacement does not exist for ${name}: ${replacement.file}`);
  }
  replacements[name] = replacement;
}
const document = {
  schemaVersion: 1,
  input,
  sourceManifest: path.resolve(assetsRoot, 'cleanroom-sources.json'),
  assetsRoot: path.resolve(assetsRoot),
  targetTexelDensity: '1024 px/m',
  replacements,
  needsReplacementAsset: needsReplacementAsset.sort(),
  preservedVendorPhotoTextures: (json.images ?? []).map((image) => image.name ?? '').filter(isVendorPhoto).sort(),
};
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(`${path.basename(input)}: ${Object.keys(replacements).length} RoadRunner images mapped; ${needsReplacementAsset.length} neutralized prop sheets`);
