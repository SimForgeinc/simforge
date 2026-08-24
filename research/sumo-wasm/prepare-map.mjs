import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const [inputArgument, outputArgument, mapIdArgument] = process.argv.slice(2);
if (!inputArgument || !outputArgument) {
  console.error('usage: node prepare-map.mjs <map.xodr> <output-directory> [map-id]');
  process.exit(2);
}
const input = resolve(inputArgument);
const output = resolve(outputArgument);
await mkdir(output, { recursive: true });
const networkPath = join(output, `${basename(input, '.xodr')}.net.xml`);
const mapId = mapIdArgument || basename(dirname(input));

execFileSync('netconvert', [
  '--opendrive-files', input,
  '--output-file', networkPath,
  '--opendrive.import-all-lanes', 'false',
  '--geometry.remove', 'false',
  '--junctions.join', 'false',
  '--no-warnings', 'true',
], { stdio: 'inherit' });

const network = await readFile(networkPath);
const xml = network.toString('utf8');
const location = xml.match(/<location\s+([^>]+)\/>/)?.[1] ?? '';
const netOffset = attribute(location, 'netOffset')?.split(',').map(Number) ?? [0, 0];
const compressed = gzipSync(network, { level: 9 });
const compressedPath = `${networkPath}.gz`;
await writeFile(compressedPath, compressed);

const sumoHome = process.env.SUMO_HOME;
if (!sumoHome) throw new Error('SUMO_HOME must point at the pinned SUMO 1.27.1 package/source tree');
const candidatePath = join(output, '.route-candidates.rou.xml');
const tripPath = join(output, '.route-candidates.trips.xml');
execFileSync(process.env.PYTHON || 'python3', [
  join(sumoHome, 'tools/randomTrips.py'),
  '-n', networkPath,
  '-r', candidatePath,
  '-o', tripPath,
  '-e', '128',
  '-p', '.5',
  '--seed', '2711',
  '--validate',
  '--fringe-factor', '4',
  '--min-distance', '35',
  '--max-distance', '8000',
], { stdio: 'inherit', env: { ...process.env, SUMO_HOME: sumoHome } });
const candidateXml = await readFile(candidatePath, 'utf8');
await unlink(candidatePath);
await unlink(tripPath);
const routeCandidates = [...candidateXml.matchAll(/<route edges="([^"]+)"\s*\/>/g)]
  .map((match) => decodeXml(match[1]).trim().split(/\s+/))
  .filter((edges) => edges.length >= 2)
  .slice(0, 256);
if (routeCandidates.length < 16) throw new Error(`Only ${routeCandidates.length} valid SUMO routes were generated for ${mapId}`);

const manifest = {
  schema: 'uniscenarios.sumo-network.v1',
  mapId,
  sourceOpenDrive: basename(input),
  // Keep this raw: the lean browser kernel deliberately excludes zlib. HTTP
  // transport may still apply content encoding without changing this asset.
  networkFile: basename(networkPath),
  networkBytes: network.byteLength,
  compressedBytes: compressed.byteLength,
  sha256: createHash('sha256').update(network).digest('hex'),
  sumoLocation: {
    netOffset: attribute(location, 'netOffset') ?? '0,0',
    convBoundary: attribute(location, 'convBoundary') ?? '',
    origBoundary: attribute(location, 'origBoundary') ?? '',
    projParameter: attribute(location, 'projParameter') ?? '',
  },
  // For local OpenDRIVE coordinates SUMO applies netOffset while importing.
  // A map-specific registration process may replace rotation/scale.
  worldFromNetwork: {
    translationX: -(netOffset[0] || 0),
    translationY: netOffset[1] || 0,
    rotationDegrees: 0,
    scale: 1,
    invertY: true,
  },
  routeCandidates,
};
await writeFile(join(output, 'sumo-network-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));

function attribute(source, name) {
  return source.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function decodeXml(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
