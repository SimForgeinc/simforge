import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return path.resolve(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function copyOrLink(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await link(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(source, destination);
  }
}

function firstAnimationName(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error('animation asset is not a GLB');
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/[\0 ]+$/u, ''));
  const name = json.animations?.[0]?.name;
  if (typeof name !== 'string' || name.length === 0) throw new Error('animation GLB has no named clip');
  return name;
}

const manifestPath = option('--manifest');
const cacheRoot = option('--cache');
const outputRoot = option('--out');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const approved = manifest.filter((entry) => entry.status === 'completed').sort((left, right) => left.catalogId.localeCompare(right.catalogId));
if (approved.length !== 51) throw new Error(`expected 51 VisQA-approved completed assets, found ${approved.length}`);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const catalog = {};
const sourceFiles = new Map();
for (const entry of approved) {
  const source = path.join(cacheRoot, entry.catalogId, 'refined.glb');
  const relative = `models/${entry.catalogId}/model.glb`;
  const rawBytes = await readFile(source);
  sourceFiles.set(relative, source);
  const normalizedHeight = Number(entry.bounds?.normalized?.h);
  catalog[entry.catalogId] = {
    model: {
      glbPath: relative,
      attribution: 'Generated with Meshy for SimForge',
      source: 'meshy-refined',
    },
    tintable: false,
    scaleToDims: false,
    uniformScale: Number(entry.scaleApplied),
    yawOffsetRad: Math.PI / 2,
    groundOffsetM: normalizedHeight / 2,
    approvedManifestSha256: entry.sha256,
    sourceSha256: sha256(rawBytes),
    targetBounds: entry.bounds.target,
    normalizedBounds: entry.bounds.normalized,
    animations: {},
  };
  if (entry.catalogId.startsWith('pedestrian.')) {
    for (const motion of ['idle', 'walk', 'run']) {
      const animationSource = path.join(cacheRoot, entry.catalogId, `${motion}.glb`);
      const animationBytes = await readFile(animationSource);
      const animationRelative = `models/${entry.catalogId}/animations/${motion}.glb`;
      sourceFiles.set(animationRelative, animationSource);
      catalog[entry.catalogId].animations[motion] = {
        glbPath: animationRelative,
        clip: firstAnimationName(animationBytes),
        sha256: sha256(animationBytes),
      };
    }
  }
}

for (const [alias, canonicalId] of Object.entries({
  'pedestrian.adult_standing': 'pedestrian.adult',
  'pedestrian.adult_walking': 'pedestrian.adult',
  'pedestrian.child_standing': 'pedestrian.child',
  'pedestrian.child_walking': 'pedestrian.child',
})) {
  catalog[alias] = {
    ...catalog[canonicalId],
    legacyAliasOf: canonicalId,
  };
}
const catalogRelative = 'catalog-models.json';
const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);

await writeFile(path.join(outputRoot, catalogRelative), catalogBytes);
for (const [relative, source] of sourceFiles) await copyOrLink(source, path.join(outputRoot, relative));

const members = { [catalogRelative]: { sha256: sha256(catalogBytes), bytes: catalogBytes.byteLength } };
for (const [relative] of [...sourceFiles].sort(([left], [right]) => left.localeCompare(right))) {
  const file = path.join(outputRoot, relative);
  members[relative] = { sha256: sha256(await readFile(file)), bytes: (await stat(file)).size };
}
const closure = { schema: 'simforge.actor-assets-closure/v1', members };
const closureBytes = Buffer.from(canonical(closure));
const digest = sha256(closureBytes);
await writeFile(path.join(outputRoot, 'closure.json'), closureBytes);
await writeFile(path.join(outputRoot, 'closure-digest.txt'), `${digest}\n`);
process.stdout.write(`${JSON.stringify({ digest, assets: approved.length, members: Object.keys(members).length, bytes: Object.values(members).reduce((sum, member) => sum + member.bytes, 0) })}\n`);
