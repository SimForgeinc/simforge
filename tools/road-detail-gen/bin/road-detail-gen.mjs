#!/usr/bin/env node
/**
 * road-detail-gen — deterministic simforge.road-detail/v1 sidecar generator.
 *
 * Derives a splat mask (variant weights + wear + marking erosion) and a
 * decal overlay from a map bundle's lane graph, seeded and reproducible:
 * the sidecar records sha256 digests of the raw RGBA payloads.
 *
 *   node tools/road-detail-gen/bin/road-detail-gen.mjs generate \
 *     --bundle ~/simforge-assets/map-bundles/easterbrook-discovery-school \
 *     --textures ~/simforge-assets/map-bundles/cc0-textures \
 *     --seed 1337 [--tile road] [--max-size 4096] [--out <dir>] \
 *     [--road-materials Asphalt1] \
 *     [--marking-materials LaneMarking1,LaneMarkingYellow1]
 *
 * Texture licensing: only CC0 (Poly Haven / ambientCG) or SimForge-authored
 * sources may be referenced (tools/glb-orm-repair/README.md). The decal
 * atlas is generated procedurally in-process (self-made).
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '../src/gen.mjs';
import { encodePngRgba } from '../src/png.mjs';
import { makeProjector, parseGeoReference } from '../src/geo.mjs';

const SCHEMA = 'simforge.road-detail/v1';
const TOOL_VERSION = '1.0.0';

function fail(msg) {
  process.stderr.write(`road-detail-gen: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const args = parseArgs(process.argv.slice(2));
if (args._[0] !== 'generate') {
  fail('usage: road-detail-gen generate --bundle <map-bundle> --textures <cc0 dir> [--seed N]');
}
if (!args.bundle) fail('--bundle is required');
if (!args.textures) fail('--textures is required');

const bundle = path.resolve(args.bundle);
const texturesDir = path.resolve(args.textures);
const tile = args.tile ?? 'road';
const seed = Number(args.seed ?? 1337) >>> 0;
const maxSize = Number(args['max-size'] ?? 4096);
const mapId = path.basename(bundle);
const outDir = path.resolve(args.out ?? path.join(bundle, 'browser', '3d', 'tiles', `${tile}.road-detail`));
const roadMaterials = (args['road-materials'] ?? 'Asphalt1').split(',').filter(Boolean);
const markingMaterials = (args['marking-materials'] ?? 'LaneMarking1,LaneMarkingYellow1')
  .split(',')
  .filter(Boolean);

// ---- inputs ----------------------------------------------------------------
const lanesPath = path.join(bundle, 'browser', 'lane-polygons.geojson.gz');
const topologyPath = path.join(bundle, 'browser', 'topology-index.json.gz');
const xodrCandidates = [path.join(bundle, 'xodr.xodr'), path.join(bundle, 'browser', 'map.xodr')];
const geojson = JSON.parse(gunzipSync(readFileSync(lanesPath)).toString('utf8'));
const topology = JSON.parse(gunzipSync(readFileSync(topologyPath)).toString('utf8'));
let xodrText = null;
for (const p of xodrCandidates) {
  try {
    xodrText = readFileSync(p, 'utf8');
    break;
  } catch {
    /* try next */
  }
}
if (xodrText === null) fail(`no xodr found at ${xodrCandidates.join(' or ')}`);

const project = makeProjector(parseGeoReference(xodrText));
const laneWidths = new Map(
  Object.entries(topology.lanes ?? {}).map(([rsl, lane]) => [rsl, lane.representativeWidthM]),
);

// ---- generate ----------------------------------------------------------------
const t0 = performance.now();
const result = generate({
  features: geojson.features,
  project,
  laneWidths,
  seed,
  maxSize,
});

// ---- write artifacts ---------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const splatPng = encodePngRgba(Buffer.from(result.splat), result.width, result.height);
const overlayPng = encodePngRgba(Buffer.from(result.overlay), result.width, result.height);
const atlasPng = encodePngRgba(Buffer.from(result.atlas.data), result.atlas.width, result.atlas.height);
writeFileSync(path.join(outDir, 'splat.png'), splatPng);
writeFileSync(path.join(outDir, 'decals.png'), overlayPng);
writeFileSync(path.join(outDir, 'atlas.png'), atlasPng);

// CC0 variant textures are copied next to the sidecar so the artifact dir is
// self-contained (paths in the sidecar resolve against the sidecar's dir).
const variantFiles = [
  'asphalt_02/asphalt_02_diff_1k.png',
  'asphalt_02/asphalt_02_nor_gl_1k.png',
  'asphalt_02/asphalt_02_arm_1k.png',
  'concrete_pavement/concrete_pavement_diff_1k.png',
  'concrete_pavement/concrete_pavement_nor_gl_1k.png',
  'concrete_pavement/concrete_pavement_arm_1k.png',
];
for (const rel of variantFiles) {
  copyFileSync(path.join(texturesDir, rel), path.join(outDir, path.basename(rel)));
}

const sidecar = {
  schema: SCHEMA,
  tileId: `${mapId}/${tile}`,
  seed,
  generator: { tool: 'road-detail-gen', version: TOOL_VERSION, maxSize },
  bounds: {
    minX: Math.round(result.bounds.minX * 1000) / 1000,
    minZ: Math.round(result.bounds.minZ * 1000) / 1000,
    maxX: Math.round(result.bounds.maxX * 1000) / 1000,
    maxZ: Math.round(result.bounds.maxZ * 1000) / 1000,
  },
  materials: { road: roadMaterials, marking: markingMaterials },
  splat: { texture: 'splat.png' },
  decalOverlay: { texture: 'decals.png' },
  decalAtlas: { texture: 'atlas.png' },
  variants: [
    {
      id: 'asphalt_02',
      role: 'a',
      baseColor: 'asphalt_02_diff_1k.png',
      normal: 'asphalt_02_nor_gl_1k.png',
      orm: 'asphalt_02_arm_1k.png',
      tilingPerMeter: 0.35,
      source: {
        provider: 'Poly Haven',
        url: 'https://polyhaven.com/a/asphalt_02',
        license: 'CC0',
      },
    },
    {
      id: 'concrete_pavement',
      role: 'b',
      baseColor: 'concrete_pavement_diff_1k.png',
      normal: 'concrete_pavement_nor_gl_1k.png',
      orm: 'concrete_pavement_arm_1k.png',
      tilingPerMeter: 0.5,
      source: {
        provider: 'Poly Haven',
        url: 'https://polyhaven.com/a/concrete_pavement',
        license: 'CC0',
      },
    },
  ],
  detailNormal: {
    texture: 'asphalt_02_nor_gl_1k.png',
    tilingPerMeter: 1.7,
    strength: 0.5,
  },
  params: {
    wearAlbedoDarken: 0.38,
    wearRoughnessDelta: -0.22,
    markingWearStrength: 0.85,
  },
  decals: result.decals,
  digests: {
    splatRgbaSha256: sha256(result.splat),
    decalOverlayRgbaSha256: sha256(result.overlay),
    atlasRgbaSha256: sha256(result.atlas.data),
  },
};
const sidecarPath = path.join(outDir, `${tile}.road-detail.json`);
writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

process.stdout.write(
  `${JSON.stringify({
    sidecar: sidecarPath,
    size: [result.width, result.height],
    lanes: result.laneCount,
    decals: result.decals.length,
    digests: sidecar.digests,
    durationMs: Math.round(performance.now() - t0),
  }, null, 2)}\n`,
);
