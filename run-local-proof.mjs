// Local browser-render harness proof for the campaign browserfix (BulkRenders3).
// Runs the REAL engine adapter (with the cherry-picked groundY/map-detail fix)
// against the REAL frozen intent + playback bundle + full map tile closure of
// failing campaign job usrj_1f4f114ce0ab488990deaf49 (doc uscn_34a024fc, Richmond).
// Clip is shortened and the camera set reduced for wall-time; geometry and
// video-only artifact behavior are what this proves.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRenderEngine } from './packages/browser-renderer/dist/index.js';

const PROOF = '/home/path/tmp/campaign/browserfix-proof';
const intent = JSON.parse(await fs.readFile(path.join(PROOF, 'intent.json'), 'utf8'));

// Shrink: 4s clip, chase + cam0 + cam3 only (chase is excluded from rig camera count).
const keep = new Set(['chase-cam-trailing', 'pronto-cam0', 'pronto-cam3']);
intent.renderSpec.sources = intent.renderSpec.sources.filter((s) => keep.has(s.sensorId));
intent.renderSpec.clip = { startSeconds: 0, endSeconds: 4 };
intent.sensorHost.sensorRig = { rigId: 'authored', cameras: 2, lidars: 0, radars: 0 };

const files = {
  'scenario.xosc': path.join(PROOF, 'scenario.xosc'),
  'map.manifest': path.join(PROOF, 'map/3d/manifest.json'),
  'playback.bundle': path.join(PROOF, 'playback.bundle'),
};
const inputs = new Map();
for (const [id, p] of Object.entries(files)) {
  const bytes = await fs.readFile(p);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  inputs.set(id, { inputId: id, path: p, sha256, sizeBytes: bytes.byteLength });
}
// Exercise the map.assets/<relative> materialization path exactly as the
// control plane will deliver it (paths relative to the manifest's directory).
const mapRoot = path.join(PROOF, 'map/3d');
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walk(p); continue; }
    const rel = path.relative(mapRoot, p);
    if (rel === 'manifest.json') continue;
    const stat = await fs.stat(p);
    inputs.set(`map.assets/${rel}`, { inputId: `map.assets/${rel}`, path: p, sha256: 'f'.repeat(64), sizeBytes: stat.size });
  }
}
await walk(mapRoot);
console.log('inputs:', inputs.size);
// keep intent asset declarations consistent with materialized files
for (const asset of intent.assets) {
  const input = inputs.get(asset.assetId);
  asset.sha256 = input.sha256;
  asset.sizeBytes = input.sizeBytes;
}

const workspace = path.join(PROOF, 'workspace');
await fs.rm(workspace, { recursive: true, force: true });

const engine = createRenderEngine({
  engineVersion: 'browserfix-local-proof',
  chromiumExecutablePath: '/opt/google/chrome/chrome',
  chromiumExtraArgs: ['--use-gl=angle', '--use-angle=gl-egl', '--no-sandbox'],
});

const context = {
  jobId: 'local-proof',
  attempt: 1,
  intent,
  intentSha256: 'f'.repeat(64),
  schedules: [],
  inputs,
  workspace,
  signal: new AbortController().signal,
  reportProgress: async (record) => {
    if ((record.completed ?? 0) % 24 === 0) console.log(`progress ${record.completed}/${record.total}`);
  },
};

const started = Date.now();
try {
  const manifest = await engine.execute(context);
  console.log('WALL_S', (Date.now() - started) / 1000);
  console.log(JSON.stringify(manifest.artifacts.map((a) => ({
    role: a.identity.role, sensor: a.identity.sensorId, path: a.relativePath, bytes: a.sizeBytes,
  })), null, 1));
  console.log('WARNINGS', JSON.stringify(manifest.warnings));
} catch (error) {
  console.log('WALL_S', (Date.now() - started) / 1000);
  console.error('RENDER_FAILED:', error?.message ?? error);
  process.exitCode = 1;
}
