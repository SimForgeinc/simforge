import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { buildMapTopologyIndex } from "../../packages/map-pipeline/src/ported/map-topology/build-topology-index";

export const STARTER_MAP = [
  "simforge-starter-road",
  "SimForge Starter Road",
  "Local demo",
] as const;

const STARTER_MAP_VERSION = 3;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROAD_GLB_FIXTURE = resolve(REPO_ROOT, "fixtures/yale-tile_0_0.lod3.glb");

const XODR = `<?xml version="1.0" standalone="yes"?>
<OpenDRIVE>
<header revMajor="1" revMinor="4" name="SimForge Starter Road" version="1.00" date="1970-01-01T00:00:00Z" north="20" south="-20" east="100" west="-100" vendor="SimForge"><geoReference><![CDATA[+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs]]></geoReference></header>
<road name="Starter Road" length="200" id="1" junction="-1">
<link/>
<type s="0" type="town"><speed max="50" unit="km/h"/></type>
<planView>
<geometry s="0" x="-100" y="0" hdg="0" length="200"><line/></geometry>
</planView>
<elevationProfile><elevation s="0" a="0" b="0" c="0" d="0"/></elevationProfile>
<lateralProfile/>
<lanes>
<laneOffset s="0" a="0" b="0" c="0" d="0"/>
<laneSection s="0">
<left>
<lane id="1" type="driving" level="false">
<link/>
<width sOffset="0" a="3.5" b="0" c="0" d="0"/>
<roadMark sOffset="0" type="broken" weight="standard" color="white" width="0.12" laneChange="both"/>
</lane>
</left>
<center>
<lane id="0" type="none" level="false">
<link/>
<roadMark sOffset="0" type="solid" weight="standard" color="yellow" width="0.15" laneChange="none"/>
</lane>
</center>
<right>
<lane id="-1" type="driving" level="false">
<link/>
<width sOffset="0" a="3.5" b="0" c="0" d="0"/>
<roadMark sOffset="0" type="broken" weight="standard" color="white" width="0.12" laneChange="both"/>
</lane>
</right>
</laneSection>
</lanes>
<objects/>
<signals/>
<surface/>
</road>
</OpenDRIVE>
`;

const EMPTY_FEATURE_COLLECTION = { type: "FeatureCollection" as const, features: [] };

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gzipJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(`${JSON.stringify(value)}\n`), { level: 9 });
}

/** Materialize the tiny, checked-source starter world used by a clean Studio checkout. */
export async function ensureStarterMapAssets(assetsRoot: string): Promise<void> {
  const mapRoot = resolve(assetsRoot, STARTER_MAP[0]);
  const markerPath = resolve(mapRoot, "starter-map-version.json");
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { version?: number };
    if (marker.version === STARTER_MAP_VERSION) return;
  } catch {
    // First boot or an older generated starter map: rebuild deterministically.
  }

  await mkdir(resolve(mapRoot, "3d/tiles"), { recursive: true });
  await mkdir(resolve(mapRoot, "derived"), { recursive: true });
  await copyFile(ROAD_GLB_FIXTURE, resolve(mapRoot, "3d/tiles/road.glb"));

  const roadGlb = await readFile(ROAD_GLB_FIXTURE);
  const manifest = {
    version: "1.2.0",
    generator: "simforge-starter-map",
    created: "1970-01-01T00:00:00.000Z",
    scene: {
      bounds: { min: [-110, -5, -20], max: [110, 20, 20] },
      totalTriangles: 12_649,
      gridDimensions: [1, 1],
      cellSize: [220, 40],
      origin: [-110, 0, -20],
      lodLevels: 1,
      coordinateSystem: "y-up",
    },
    tiles: [],
    staticLayers: [{
      id: "road",
      file: "tiles/road.glb",
      triangles: 12_649,
      fileSize: roadGlb.byteLength,
    }],
  };

  const xodrSha256 = sha256(XODR);
  const topology = buildMapTopologyIndex({
    mapName: STARTER_MAP[0],
    xodr: XODR,
    xodrSha256,
  });
  const topologyBytes = gzipJson(topology);
  const emptyGeoJsonBytes = gzipJson(EMPTY_FEATURE_COLLECTION);
  const mapGeoJson = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name: "Starter Road", highway: "residential" },
      geometry: { type: "LineString", coordinates: [[-100, 0], [100, 0]] },
    }],
  };
  const topologyDigest = sha256(topologyBytes);
  const catalogRevision = topologyDigest.slice(0, 32);
  const locations = {
    catalogVersion: 1,
    catalogRevision,
    mapId: STARTER_MAP[0],
    mapAssetId: STARTER_MAP[0],
    sourceHashes: {
      xodr: xodrSha256,
      "topology-index": topologyDigest,
      "lane-polygons": sha256(emptyGeoJsonBytes),
      signals: sha256(emptyGeoJsonBytes),
    },
    builtAt: "1970-01-01T00:00:00.000Z",
    locations: [],
    relations: [],
    stats: {
      locationCount: 0,
      byType: {},
      anchorQuality: {},
      relationCount: 0,
      handleCollisionsResolved: 0,
      handleLadderUsage: {},
    },
  };
  const derivedTopology = {
    derivedVersion: 1,
    catalogRevision,
    mapId: STARTER_MAP[0],
    mapAssetId: STARTER_MAP[0],
    topologyDigest,
    builtAt: "1970-01-01T00:00:00.000Z",
    segments: [],
    junctions: [],
    factIndex: {
      locationsByType: {},
      locationsBySubtype: {},
      locationsByTag: {},
      locationsByAffordance: {},
      locationsByFact: {},
      unindexedFactKeys: [],
      segmentsByLaneCount: {},
      segmentsBySpeedLimitKph: {},
      junctionsByControl: {},
      junctionsByArmCount: {},
      segmentByLaneRef: {},
    },
    stats: {
      segmentCount: 0,
      junctionCount: 0,
      conflictPairCount: 0,
      conflictPairsByRelation: {},
      junctionsByControl: {},
      totalSegmentLengthM: 0,
    },
  };
  const roadDigest = sha256(roadGlb);
  const roadwayConsistency = {
    format: "simforge.roadway-consistency.v1",
    sourceXodrSha256: xodrSha256,
    stats: { candidatePairCount: 0, inferredIntervalCount: 0, issueCount: 0 },
    intervals: [],
    issues: [],
    mapId: STARTER_MAP[0],
    validatorVersion: "simforge-starter-map/1",
    sourceDigests: {
      xodrSha256,
      topologySha256: topologyDigest,
      sourceRoadGeometrySha256: roadDigest,
      finalRoadSha256: roadDigest,
      roadAuditSha256: sha256("starter-map-road-audit-unavailable"),
    },
    verdict: "review",
    visualEvidence: { status: "unavailable", reason: "compact starter geometry" },
    runtimeEvidence: { status: "not-probed" },
  };
  const locationsBytes = gzipJson(locations);
  const derivedTopologyBytes = gzipJson(derivedTopology);
  const receipt = {
    contractVersion: "uniscenario.map-intel-build/v1",
    builder: { package: "@simforge-oss/maps", version: "starter-map/1" },
    mapId: STARTER_MAP[0],
    catalogRevision,
    sourceHashes: { xodr: xodrSha256, topology: topologyDigest },
    outputs: {
      locations: sha256(locationsBytes),
      topology: sha256(derivedTopologyBytes),
    },
  };

  await Promise.all([
    writeFile(resolve(mapRoot, "map.xodr"), XODR),
    writeFile(resolve(mapRoot, "topology-index.json.gz"), topologyBytes),
    writeFile(resolve(mapRoot, "lane-polygons.geojson.gz"), emptyGeoJsonBytes),
    writeFile(resolve(mapRoot, "signals.geojson.gz"), emptyGeoJsonBytes),
    writeFile(resolve(mapRoot, "map.geojson.gz"), gzipJson(mapGeoJson)),
    writeFile(resolve(mapRoot, "3d/manifest.json"), `${JSON.stringify(manifest)}\n`),
    writeFile(resolve(mapRoot, "derived/topology-derived.json.gz"), derivedTopologyBytes),
    writeFile(resolve(mapRoot, "derived/locations.json.gz"), locationsBytes),
    writeFile(resolve(mapRoot, "derived/roadway-consistency.json.gz"), gzipJson(roadwayConsistency)),
    writeFile(resolve(mapRoot, "derived/map-intel-build-receipt.json"), `${JSON.stringify(receipt)}\n`),
  ]);
  await writeFile(markerPath, `${JSON.stringify({ version: STARTER_MAP_VERSION })}\n`);
}
