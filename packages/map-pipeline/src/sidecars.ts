import { gzipSync, gunzipSync } from 'node:zlib';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { CoordinateFrame, buildMapIntel, loadMapSources, asMapId } from '@simforge-oss/maps/node';
import { validateRoadwayConsistency } from '@simforge-oss/maps/topology';
import { TOPOLOGY_CONTENT_EPOCH, buildLanePolygonsLocal, buildMapTopologyIndex } from './ported/map-topology/build-topology-index.js';
import { canonicalJson, filesUnder, hashFile, sha256 } from './closure.js';
import { buildRoadwayConsistencyReport, serializeRoadwayConsistencyReport } from './roadway-consistency.js';
import { collection, extractXodrSemantics, type SemanticCollection } from './xodr-semantics.js';

export const ROAD_SIDECAR_REVISION = 'source-semantics-v4';
export const DEFAULT_SKY_PATH = path.join(os.homedir(), 'simforge-assets', 'hdri', 'clear-day-sky.hdr');

function gzipCanonical(value: unknown): Buffer {
  return gzipSync(Buffer.from(`${canonicalJson(value)}\n`), { level: 9 });
}

export async function resolveXodrPath(sourceDir: string, explicitPath?: string): Promise<string | undefined> {
  if (explicitPath !== undefined) return path.resolve(explicitPath);
  const candidates = (await filesUnder(sourceDir)).filter((file) => file.toLowerCase().endsWith('.xodr'));
  if (candidates.length > 1) throw new Error(`Ambiguous OpenDRIVE sources; specify xodrPath: ${candidates.join(', ')}`);
  return candidates[0] === undefined ? undefined : path.join(sourceDir, candidates[0]);
}

export async function resolveSkyPath(sourceDir: string): Promise<string> {
  const ownSky = (await filesUnder(sourceDir)).find((file) => file.toLowerCase().endsWith('env/sky.hdr') || file.toLowerCase() === 'sky.hdr');
  return ownSky === undefined ? path.resolve(process.env['SIMFORGE_DEFAULT_SKY'] ?? DEFAULT_SKY_PATH) : path.join(sourceDir, ownSky);
}

export async function writeSky(destinationDir: string, sourceDir: string): Promise<void> {
  const source = await resolveSkyPath(sourceDir);
  const destination = path.join(destinationDir, 'env', 'sky.hdr');
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}

export interface RoadSidecarOptions { sourceDir?: string; masterPath?: string }

/** Build source-derived, compiler-readable semantics without requiring a legacy pipeline. */
export async function writeRoadSidecars(contentDir: string, xodrPath: string, mapName: string, options: RoadSidecarOptions = {}): Promise<void> {
  const xodr = await readFile(path.resolve(xodrPath));
  const text = xodr.toString('utf8');
  const normalised = text.replace(/>\s*</g, '>\n<');
  const frame = CoordinateFrame.fromMapAssets(text);
  const topology = buildMapTopologyIndex({ mapName, xodr: normalised, xodrSha256: sha256(xodr), now: () => TOPOLOGY_CONTENT_EPOCH });
  const semantic = extractXodrSemantics(text, topology, frame);
  const sourceDir = options.sourceDir ?? path.dirname(path.resolve(xodrPath));
  const files = await filesUnder(sourceDir);
  const authoredSources: Record<string, { path: string; sha256: string }> = {};
  const optional = async <T>(name: string, suffix: string): Promise<T | null> => {
    let candidates = files.filter((file) => {
      const plain = file.replace(/\.gz$/i, '');
      return plain === suffix || plain.endsWith(`/${suffix}`) || (!suffix.includes('/') && plain.endsWith(`.${suffix}`));
    });
    if (name === 'map-geojson' && candidates.length === 0) {
      candidates = files.filter((file) => /\.geojson(?:\.gz)?$/i.test(file) && !/(?:signals|lane-polygons)\.geojson(?:\.gz)?$/i.test(file) && !file.startsWith('enrichment/'));
    }
    if (candidates.length > 1) throw new Error(`Ambiguous authored ${name}: ${candidates.join(', ')}`);
    if (!candidates[0]) return null;
    const bytes = await readFile(path.join(sourceDir, candidates[0]));
    authoredSources[name] = { path: candidates[0], sha256: sha256(bytes) };
    return JSON.parse((bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8')) as T;
  };
  const authoredSignals = await optional<SemanticCollection>('signals', 'signals.geojson');
  const authoredMap = await optional<SemanticCollection>('map-geojson', 'map.geojson');
  const authoredLanes = await optional<SemanticCollection>('lane-polygons', 'lane-polygons.geojson');
  const search = await optional<unknown>('search-index', 'search-index.json');
  const overlay = await optional<unknown>('overlay-payload', 'enrichment/overlay-payload.json');
  for (const candidate of [authoredSignals, authoredMap, authoredLanes]) {
    if (candidate && (candidate.type !== 'FeatureCollection' || !Array.isArray(candidate.features))) throw new Error('Invalid authored GeoJSON FeatureCollection');
  }
  // Authoring remains authoritative; XODR fills physical entities absent there.
  const authoredSignalIds = new Set(authoredSignals?.features.map((feature) => String(feature.properties.id)) ?? []);
  const signals = collection([...(authoredSignals?.features ?? []), ...semantic.signals.features.filter((feature) => !authoredSignalIds.has(String(feature.properties.id)))]);
  const lanes = authoredLanes ?? collection(buildLanePolygonsLocal(normalised).map((lane) => ({
    type: 'Feature', geometry: { type: 'Polygon', coordinates: [lane.ring.map((point) => frame.localToWgs84(point.x, point.y))] },
    properties: { feature_kind: 'lane', Type: 'Lane', LaneType: lane.laneType, road_id: String(lane.roadId), section_id: lane.section, lane_id: lane.laneId, is_junction: lane.isJunction, ...(lane.laneGuid ? { lane_guid: lane.laneGuid } : {}) },
  })));
  await mkdir(path.join(contentDir, 'derived'), { recursive: true });
  const emit = async (file: string, data: unknown) => writeFile(path.join(contentDir, file), gzipCanonical(data));
  await writeFile(path.join(contentDir, 'map.xodr'), xodr);
  const topologyBytes = gzipCanonical(topology);
  await writeFile(path.join(contentDir, 'topology-index.json.gz'), topologyBytes);
  await emit('lane-polygons.geojson.gz', lanes);
  await emit('signals.geojson.gz', signals);
  await emit('map.geojson.gz', authoredMap ?? semantic.mapGeojson);
  if (search) await emit('search-index.json.gz', search);
  if (overlay) {
    await mkdir(path.join(contentDir, 'enrichment'), { recursive: true });
    await writeFile(path.join(contentDir, 'enrichment', 'overlay-payload.json'), `${canonicalJson(overlay)}\n`);
  }
  const sources = await loadMapSources(contentDir);
  const intel = buildMapIntel({ ...sources, mapId: asMapId(mapName), mapAssetId: mapName, roadNames: semantic.roadNames });
  await emit('derived/locations.json.gz', intel.catalog);
  await emit('derived/topology-derived.json.gz', intel.derived);
  const local = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const lane of Object.values(topology.lanes)) for (const point of lane.polyline) {
    local.minX = Math.min(local.minX, point.x); local.minY = Math.min(local.minY, point.y);
    local.maxX = Math.max(local.maxX, point.x); local.maxY = Math.max(local.maxY, point.y);
  }
  if (!Object.values(local).every(Number.isFinite)) throw new Error('OpenDRIVE contains no positioned lanes');
  const corners = [[local.minX, local.minY], [local.minX, local.maxY], [local.maxX, local.minY], [local.maxX, local.maxY]]
    .map(([x, y]) => frame.localToWgs84(x!, y!));
  const bounds = {
    min_lat: Math.min(...corners.map((point) => point[1])), min_lng: Math.min(...corners.map((point) => point[0])),
    max_lat: Math.max(...corners.map((point) => point[1])), max_lng: Math.max(...corners.map((point) => point[0])),
  };
  const geography = { bounds, center: { lat: (bounds.min_lat + bounds.max_lat) / 2, lng: (bounds.min_lng + bounds.max_lng) / 2 } };
  const scale = Math.min(1216 / Math.max(1, local.maxX - local.minX), 656 / Math.max(1, local.maxY - local.minY));
  const centerX = (local.minX + local.maxX) / 2, centerY = (local.minY + local.maxY) / 2;
  const paths = Object.values(topology.lanes).map((lane) => {
    const points = lane.polyline.map((point) => `${(640 + (point.x - centerX) * scale).toFixed(2)},${(360 - (point.y - centerY) * scale).toFixed(2)}`).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${lane.laneType === 'driving' ? '#a6c1d6' : '#425769'}" stroke-width="${Math.max(0.75, 2.5 * scale).toFixed(2)}" stroke-linecap="round"/>`;
  });
  const thumbnail = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><path fill="#14202b" d="M0 0h1280v720H0z"/>${paths.join('')}</svg>`)).webp({ quality: 85 }).toBuffer();
  await writeFile(path.join(contentDir, 'derived', 'thumbnail.webp'), thumbnail);
  const masterDigest = options.masterPath ? (await hashFile(options.masterPath)).sha256 : null;
  const capabilities = {
    schema: 'simforge.map-source-capabilities.v1', revision: ROAD_SIDECAR_REVISION, mapId: mapName,
    coordinateConventions: { geojson: 'WGS84 longitude/latitude degrees', topology: 'OpenDRIVE-local metres', elevation: 'source-only; no inferred terrain heights' },
    sourceDigests: { xodr: sha256(xodr), master: masterDigest }, authoredSources,
    geography, thumbnail: { path: 'derived/thumbnail.webp', recipe: 'opendrive-lane-overview/v1' },
    counts: { lanes: Object.keys(topology.lanes).length, rawLanes: semantic.rawLaneCount, signals: signals.features.length, objects: semantic.objectCount, locations: intel.catalog.locations.length },
    applicability: semantic.applicability, unresolved: semantic.unresolved,
    optional: { searchIndex: search ? 'authored' : 'absent', enrichment: overlay ? 'authored' : 'absent', authoredMap: authoredMap ? 'available' : 'absent', terrainElevation: authoredMap ? 'source-only' : 'unavailable', objectOutlines: 'retained-source-xml; point-placement-only', visualEvidence: 'unavailable', runtimeEvidence: 'not-probed' },
    intelAudit: intel.audit, skippedLocationKinds: intel.skippedKinds,
  };
  const capabilityBytes = gzipCanonical(capabilities);
  await writeFile(path.join(contentDir, 'derived', 'source-capabilities.json.gz'), capabilityBytes);
  // Missing evidence is explicitly content-addressed, never represented as a
  // successful geometry audit. The wrapper requires review until real probes exist.
  const absentMasterDigest = sha256(Buffer.from(canonicalJson({ status: 'unavailable', evidence: 'final-road-geometry' })));
  const report = buildRoadwayConsistencyReport({ mapId: mapName, topology, validate: validateRoadwayConsistency, sourceDigests: {
    xodrSha256: sha256(xodr), topologySha256: sha256(topologyBytes), sourceRoadGeometrySha256: sha256(xodr), finalRoadSha256: masterDigest ?? absentMasterDigest, roadAuditSha256: sha256(capabilityBytes),
  } });
  await writeFile(path.join(contentDir, 'derived', 'roadway-consistency.json.gz'), serializeRoadwayConsistencyReport(report));
}
