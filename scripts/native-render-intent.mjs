#!/usr/bin/env node
/**
 * Build a `simforge.render-intent/v1` + input map + native camera schedule
 * for one catalog scenario, targeting the `native` engine.
 *
 * Usage:
 *   node scripts/native-render-intent.mjs --instance <instance.json> \
 *     --trace <trace.json.gz> --corpus-root <SCEN_SENSOR_CORPUS/map-id> \
 *     --out <dir> [--camera pronto-cam1] [--width 736] [--height 416]
 *     [--fps 24] [--ground-y 13]
 *
 * Conventions mirror scripts/w0/render-clip.mjs: dashcam POV pinned to the
 * ego pose, scene-space forward (cos(heading), -sin(heading)), y-up metres,
 * trace (x, y) mapping straight into GLB-world (x, z).
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

function argsOf(argv) {
  const map = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    map.set(key.slice(2), argv[i + 1]);
  }
  return map;
}

async function readJsonMaybeGzip(file) {
  if (file.endsWith('.gz')) return JSON.parse(gunzipSync(await fs.readFile(file)));
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

const sha256File = async (file) =>
  createHash('sha256').update(await fs.readFile(file)).digest('hex');

const args = argsOf(process.argv.slice(2));
const instancePath = args.get('instance');
const tracePath = args.get('trace');
const corpusRoot = args.get('corpus-root');
const outDir = path.resolve(args.get('out'));
if (!instancePath || !tracePath || !corpusRoot || !args.get('out')) {
  throw new Error('--instance, --trace, --corpus-root and --out are all required');
}
const width = Number(args.get('width') ?? 736);
const height = Number(args.get('height') ?? 416);
const fps = Math.max(1, Math.floor(Number(args.get('fps') ?? 24)));
const cameraId = args.get('camera') ?? 'pronto-cam1';
const groundY = Number(args.get('ground-y') ?? 12.99);

const instanceDoc = await readJsonMaybeGzip(instancePath);
const trace = await readJsonMaybeGzip(tracePath);
const input = instanceDoc.input;

// --- rig definition from the qualification program -------------------------
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const program = JSON.parse(await fs.readFile(path.join(repoRoot, 'qualification/render-qualification-program.v1.json'), 'utf8'));
const host = program.qualificationHost;
const rig = program.prontoRig;
const sensorById = new Map(rig.sensors.map((sensor) => [sensor.id, sensor]));
const cameraSensor = sensorById.get(cameraId);
if (!cameraSensor || cameraSensor.type !== 'dash_camera') throw new Error(`--camera ${cameraId} is not a rig dash camera`);

const actorId = input.actors[0]?.id ?? 'ego';

// --- sources ---------------------------------------------------------------
const video = { width, height, fps, container: 'mp4', codec: 'h264', quality: 'high' };
const mmToM = (mm) => mm / 1000;
const mountOf = (sensor) => ({
  position: {
    x: mmToM(sensor.sourceMountMm.longitudinal),
    y: mmToM(sensor.sourceMountMm.up),
    z: -mmToM(sensor.sourceMountMm.lateralRight),
  },
  rotation: {
    yawRad: ((sensor.rotationDeg?.yaw ?? 0) * Math.PI) / 180,
    pitchRad: ((sensor.rotationDeg?.pitch ?? 0) * Math.PI) / 180,
    rollRad: ((sensor.rotationDeg?.roll ?? 0) * Math.PI) / 180,
  },
});
const cameraAttributes = (sensor) => ({
  width,
  height,
  fps,
  horizontalFovDeg: sensor.horizontalFovDeg,
  nearM: 0.5,
  farM: 900,
});
// Rig JSON carries horizontal/vertical FOV at the top level; lidar/radar
// attribute blocks below follow the qualification program's canonical values.
const lidarAttributes = (sensor) => ({
  channels: 128,
  rangeM: 300,
  pointsPerSecond: 1_300_000,
  rotationFrequencyHz: 10,
  upperFovDeg: sensor.verticalFovDeg / 2,
  lowerFovDeg: -sensor.verticalFovDeg / 2,
});
const radarAttributes = (sensor) => ({
  horizontalFovDeg: sensor.horizontalFovDeg,
  verticalFovDeg: sensor.verticalFovDeg,
  rangeM: 300,
  pointsPerSecond: 1_500,
});

const sources = rig.sensors.map((sensor) => {
  const common = {
    actorId,
    sensorId: sensor.id,
    outputName: sensor.id.replace(/^pronto-/, 'cam').replace(/-/g, '_'),
    transform: mountOf(sensor),
  };
  if (sensor.type === 'dash_camera') {
    return { ...common, modality: 'rgb', attributes: cameraAttributes(sensor) };
  }
  if (sensor.type === 'lidar') return { ...common, modality: 'lidar', attributes: lidarAttributes(sensor) };
  return { ...common, modality: 'radar', attributes: radarAttributes(sensor) };
});

// --- route + tiles ----------------------------------------------------------
const times = trace.ticks.t;
const ego = trace.ticks.actors[actorId];
if (!ego) throw new Error(`trace lacks actor ${actorId}`);
const step = Math.max(1, Math.round(50 / fps));
const frameIndices = [];
for (let i = 0; i < times.length; i += step) frameIndices.push(i);

const margin = Number(args.get('tile-margin') ?? 25);
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
// The studio mirrors the simulation plane into GLB space: world_z = -trace_y
// and world_x = trace_x (verified against the w0 clip poses).
for (const i of frameIndices) {
  minX = Math.min(minX, ego.x[i]); maxX = Math.max(maxX, ego.x[i]);
  minZ = Math.min(minZ, -ego.y[i]); maxZ = Math.max(maxZ, -ego.y[i]);
}
minX -= margin; maxX += margin; minZ -= margin; maxZ += margin;

const sceneManifest = JSON.parse(await fs.readFile(path.join(corpusRoot, 'scene-manifest.json'), 'utf8'));
const coveringTiles = [];
for (const tile of sceneManifest.tiles) {
  const b = tile.bounds;
  const overlaps = b.min[0] <= maxX && b.max[0] >= minX && b.min[2] <= maxZ && b.max[2] >= minZ;
  if (overlaps) {
    const lodLevel = Number(args.get('lod') ?? 0);
    const chosen = tile.lods.find((l) => l.level === lodLevel) ?? tile.lods[0];
    coveringTiles.push({ id: tile.id, file: path.join(corpusRoot, chosen.file) });
  }
}
coveringTiles.sort((a, b) => a.id.localeCompare(b.id));
if (coveringTiles.length === 0) throw new Error('no corpus tiles cover the ego route');

// road.glb static layer always rides along (spike construction).
const roadLod = args.get('lod') === undefined ? 'tiles/road.glb' : `tiles/road.glb`;
const roadFile = path.join(corpusRoot, roadLod);
const glbs = [...coveringTiles.map((tile) => tile.file)];
if (!glbs.includes(roadFile)) glbs.unshift(roadFile);

// --- camera schedule --------------------------------------------------------
// Dashcam pinned to the selected rig camera's forward-center mount, following
// scripts/w0/render-clip.mjs povCameraAt (eyeHeight 1.45 m above ground).
const eyeHeight = 1.45;
const lookAheadM = 12;
const horizontalFov = cameraAttributes(cameraSensor).horizontalFovDeg;
const verticalFovDeg = (2 * Math.atan(Math.tan((horizontalFov * Math.PI) / 360) / (width / height)) * 180) / Math.PI;

const scheduleFrames = frameIndices.map((tickIndex) => {
  const x = ego.x[tickIndex];
  const z = -ego.y[tickIndex];
  const heading = ego.headingRad[tickIndex];
  const c = Math.cos(heading);
  // Mirrored plane flips the sign of the z component of forward.
  const s = Math.sin(heading);
  void s;
  const fwdX = c;
  const fwdZ = s;
  // Mount offset (forward x, up y) applied in the ego frame.
  const fwdOffset = mmToM(cameraSensor.sourceMountMm.longitudinal);
  const upOffset = mmToM(cameraSensor.sourceMountMm.up);
  const eyeY = groundY + eyeHeight + upOffset;
  const eyeX = x + fwdX * fwdOffset;
  const eyeZ = z + fwdZ * fwdOffset;
  return {
    frameIndex: tickIndex,
    tSeconds: times[tickIndex],
    cameras: [
      {
        sensorId: cameraId,
        width,
        height,
        fovDeg: Number(verticalFovDeg.toFixed(3)),
        eye: [Number(eyeX.toFixed(4)), Number(eyeY.toFixed(4)), Number(eyeZ.toFixed(4))],
        target: [Number((eyeX + fwdX * lookAheadM).toFixed(4)), Number((eyeY - (eyeHeight - 1.2) * 0.35).toFixed(4)), Number((eyeZ + fwdZ * lookAheadM).toFixed(4))],
      },
    ],
  };
});

await fs.mkdir(outDir, { recursive: true });
const schedulePath = path.join(outDir, 'native.camera-schedule.json');
await fs.writeFile(schedulePath, `${JSON.stringify({
  schema: 'simforge.native-camera-schedule/v1',
  profile: 'sensor',
  lighting: { sunElevDeg: 60, sunAzimDeg: 190, sunLux: 12000, ambient: 1.2 },
  frames: scheduleFrames,
}, null, 2)}\n`);

// --- scenario.xosc export ---------------------------------------------------
const xoscPath = path.join(outDir, 'scenario.xosc');
// The export pipeline needs dev-assets/topology-index.json.gz, which lives in
// the training-grade checkout; its CLI is version-compatible for xosc-1.4.
const exportCli = process.env.SIMFORGE_EXPORT_CLI
  ?? '/home/path/SimForge-training-grade/packages/cli/bin/simforge.js';
const exportCwd = path.dirname(path.dirname(path.dirname(exportCli)));
execFileSync(process.execPath, [
  exportCli, 'export', path.resolve(instancePath), '--format', 'xosc-1.4', '--out', xoscPath,
], { stdio: 'inherit', cwd: exportCwd });

// --- intent -----------------------------------------------------------------
const clipEnd = times[times.length - 1];
const mapSha = await sha256File(path.join(corpusRoot, 'scene-manifest.json'));
const slot = instanceDoc.catalogSlot ?? {};
const identity = String(slot.identity ?? 'native-e2e-scenario').slice(0, 100);

const tileAssets = [];
for (const glb of glbs) {
  const digest = await sha256File(glb);
  tileAssets.push({
    assetId: `map.tile.${path.basename(glb, '.glb')}`,
    kind: 'map',
    sha256: digest,
    sizeBytes: (await fs.stat(glb)).size,
  });
}
const scheduleAsset = {
  assetId: 'native.camera-schedule',
  kind: 'other',
  sha256: await sha256File(schedulePath),
  sizeBytes: (await fs.stat(schedulePath)).size,
};

const revisionId = String(instanceDoc.manifest?.revisionId ?? slot.identity ?? 'revision').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 100) || 'revision';
const intent = {
  schema: 'simforge.render-intent/v1',
  intentId: `native-e2e-${identity}`.slice(0, 120),
  scenarioRevision: {
    revisionId,
    scenarioSha256: await sha256File(tracePath),
    openScenario: { sha256: await sha256File(xoscPath), sizeBytes: (await fs.stat(xoscPath)).size },
    map: { mapId: input.mapId, revisionId: `${input.mapId}-corpus`, sha256: mapSha },
  },
  sensorHosts: sources.map((source) => ({
    sourceId: source.outputName,
    actorId: source.actorId,
    vehicleAsset: {
      catalogAssetId: 'vehicle.kia.carnival',
      carlaBlueprintId: 'vehicle.kia.carnival',
      carlaClassPath: '/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C',
      make: 'Kia',
      model: 'Carnival',
      baseType: 'van',
      sourceImage: {
        repository: 'ghcr.io/simforgeinc/carla-rfs-munich-belmont',
        indexSha256: 'f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5',
        linuxAmd64ManifestSha256: 'baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64',
      },
    },
  })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
  renderSpec: {
    schema: 'simforge.render-spec/v3',
    sources,
    clip: { startSeconds: 0, endSeconds: Number(clipEnd.toFixed(3)) },
    video,
    artifacts: ['video', 'frames', 'sensorArchive'],
    capabilityIntent: { required: ['timing.fixed_step'], preferred: [], fidelity: 'dataset' },
    authoredEnvironment: {},
  },
  assets: [...tileAssets, scheduleAsset],
  seed: Number.parseInt(String(slot.designDigest ?? '00000000').slice(0, 8), 16),
};

const intentPath = path.join(outDir, 'intent.json');
await fs.writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);

const inputs = {
  'scenario.xosc': xoscPath,
  'native.camera-schedule': schedulePath,
};
for (const asset of tileAssets) inputs[asset.assetId] = glbs.find((g) => asset.assetId === `map.tile.${path.basename(g, '.glb')}`);
await fs.writeFile(path.join(outDir, 'inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`);

console.log(JSON.stringify({
  intentPath,
  inputsPath: path.join(outDir, 'inputs.json'),
  scheduleFrames: scheduleFrames.length,
  tiles: coveringTiles.map((tile) => tile.id),
  glbCount: glbs.length,
  verticalFovDeg: Number(verticalFovDeg.toFixed(2)),
}, null, 2));
