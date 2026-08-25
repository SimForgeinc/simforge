import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import sharp from "sharp";

import { LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import { execute } from "@/app/lib/db/data-api";
import { LOCAL_ARTIFACT_BUCKET } from "@/app/lib/db/config";
import { upsertMapAsset } from "@/app/lib/db/map-asset-store";
import { extractCoordinateRefFromXodr } from "@/app/lib/maps/metadata/xodr";
import { registerLocalFile, writeLocalObject, type LocalObjectMetadata } from "@/app/lib/s3/s3-object";
import { buildDerivedArtifacts, MAP_INTEL_BUILDER_VERSION } from "./derived";
import { planUploadedMapClosure, type UploadedMapClosureMemberInput } from "./closure";
import { publishUploadedMapVersion, type PublishedMapIntel } from "./publication";
import { publishedMapReleaseId } from "./release-id";

export type DevAssetMap = readonly [slug: string, label: string, locality: string];

type GeoJson = { features?: Array<{ geometry?: { coordinates?: unknown } }> };
type Topology = Parameters<typeof buildDerivedArtifacts>[0]["topologyIndex"];
type Manifest = {
  scene?: { totalTriangles?: number };
};
type Receipt = {
  contractVersion?: string;
  builder?: { package?: string; version?: string };
  mapId?: string;
  catalogRevision?: string;
  sourceHashes?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};
type RoadwayReport = {
  format: string;
  validatorVersion: string;
  verdict: string;
  stats: Record<string, unknown>;
  sourceDigests: PublishedMapIntel["roadwayConsistency"]["sourceDigests"];
};

type StoredMember = UploadedMapClosureMemberInput & {
  metadata: LocalObjectMetadata;
  sourcePath?: string;
};

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function mediaType(path: string): string {
  if (path.endsWith(".geojson.gz") || path.endsWith(".json.gz") || path.endsWith(".xml.gz")) {
    return "application/gzip";
  }
  switch (extname(path).toLowerCase()) {
    case ".json": return "application/json";
    case ".geojson": return "application/geo+json";
    case ".xml": return "application/xml";
    case ".xodr": return "application/xml";
    case ".glb": return "model/gltf-binary";
    case ".gltf": return "model/gltf+json";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".ktx2": return "image/ktx2";
    case ".bin": return "application/octet-stream";
    default: return "application/octet-stream";
  }
}

async function stableFiles(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = directory ? posix.join(directory, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await stableFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function coordinatePairs(value: unknown, output: Array<[number, number]>, limit = Number.POSITIVE_INFINITY): void {
  if (output.length >= limit || !Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    if (Number.isFinite(value[0]) && Number.isFinite(value[1])) output.push([value[0], value[1]]);
    return;
  }
  for (const child of value) coordinatePairs(child, output, limit);
}

function geoBounds(geojson: GeoJson): { minX: number; minY: number; maxX: number; maxY: number } {
  const points: Array<[number, number]> = [];
  for (const feature of geojson.features ?? []) coordinatePairs(feature.geometry?.coordinates, points);
  if (points.length === 0) throw new Error("road-network GeoJSON contains no coordinates");
  return points.reduce(
    (bounds, [x, y]) => ({
      minX: Math.min(bounds.minX, x), minY: Math.min(bounds.minY, y),
      maxX: Math.max(bounds.maxX, x), maxY: Math.max(bounds.maxY, y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

async function renderRoadThumbnail(label: string, geojson: GeoJson): Promise<Buffer> {
  const width = 640;
  const height = 360;
  const margin = 24;
  const bounds = geoBounds(geojson);
  const spanX = Math.max(bounds.maxX - bounds.minX, Number.EPSILON);
  const spanY = Math.max(bounds.maxY - bounds.minY, Number.EPSILON);
  const scale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const paths: string[] = [];
  let renderedPoints = 0;
  for (const feature of geojson.features ?? []) {
    if (renderedPoints >= 24_000) break;
    const points: Array<[number, number]> = [];
    coordinatePairs(feature.geometry?.coordinates, points, 500);
    if (points.length < 2) continue;
    const d = points.map(([x, y], index) => {
      const px = offsetX + (x - bounds.minX) * scale;
      const py = height - (offsetY + (y - bounds.minY) * scale);
      return `${index === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`;
    }).join(" ");
    paths.push(`<path d="${d}"/>`);
    renderedPoints += points.length;
  }
  const safeLabel = label.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]!);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#17212b"/><stop offset="1" stop-color="#071014"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <g fill="none" stroke="#43d7b5" stroke-opacity=".7" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${paths.join("")}</g>
    <rect x="18" y="306" width="${Math.min(360, 34 + safeLabel.length * 10)}" height="36" rx="8" fill="#071014" fill-opacity=".82"/>
    <text x="32" y="330" fill="#f4f7f8" font-family="sans-serif" font-size="18" font-weight="600">${safeLabel}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 88 }).toBuffer();
}

function jsonFromGzip<T>(bytes: Buffer): T {
  return JSON.parse(gunzipSync(bytes).toString("utf8")) as T;
}

function roadGlbPath(paths: string[]): string {
  const path = paths.find((candidate) => /\/tiles\/road\.glb$/i.test(candidate));
  if (!path) throw new Error("published dev asset has no roads-only road.glb for consistency derivation");
  return path;
}

async function storeSourceMember(
  mapRoot: string,
  slug: string,
  relativePath: string,
): Promise<StoredMember> {
  const sourcePath = resolve(mapRoot, relativePath);
  const key = `maps/${slug}/${relativePath}`;
  const metadata = await registerLocalFile(
    LOCAL_ARTIFACT_BUCKET,
    key,
    sourcePath,
    mediaType(relativePath),
  );
  return {
    relativePath,
    sha256: metadata.checksumSha256Hex,
    byteLength: metadata.sizeBytes,
    mediaType: mediaType(relativePath),
    bucket: LOCAL_ARTIFACT_BUCKET,
    key,
    metadata,
    sourcePath,
  };
}

async function storeGeneratedMember(relativePath: string, bytes: Buffer): Promise<StoredMember> {
  const digest = sha256(bytes);
  const key = `map-closure/${digest}`;
  const metadata = await writeLocalObject(LOCAL_ARTIFACT_BUCKET, key, bytes, mediaType(relativePath));
  return {
    relativePath,
    sha256: digest,
    byteLength: bytes.byteLength,
    mediaType: mediaType(relativePath),
    bucket: LOCAL_ARTIFACT_BUCKET,
    key,
    metadata,
  };
}

export async function publishDevAssetMap({
  map,
  assetsRoot,
  assetCatalogVersionId,
  activeReleaseId,
}: {
  map: DevAssetMap;
  assetsRoot: string;
  assetCatalogVersionId: string;
  activeReleaseId: string;
}) {
  const [slug, label, locality] = map;
  const mapRoot = resolve(assetsRoot, slug);
  const paths = await stableFiles(mapRoot);
  const members: StoredMember[] = [];
  for (const path of paths) members.push(await storeSourceMember(mapRoot, slug, path));
  const byPath = new Map(members.map((member) => [member.relativePath, member]));
  const requireMember = (path: string) => {
    const member = byPath.get(path);
    if (!member) throw new Error(`${slug} publication input missing ${path}`);
    return member;
  };

  // Dev-assets retain the timestamped source publication id they were built
  // under. This local publication binds the same immutable network bytes to
  // the stable map asset slug, so its sidecar must carry that published source
  // identity just like the synchronous ingest pipeline's generated outputs.
  const sumoManifestPath = "derived/sumo/sumo-network-manifest.json";
  const sourceSumoManifest = JSON.parse(
    await readFile(requireMember(sumoManifestPath).sourcePath!, "utf8"),
  ) as Record<string, unknown>;
  const sumoManifestMember = await storeGeneratedMember(
    sumoManifestPath,
    Buffer.from(`${JSON.stringify({ ...sourceSumoManifest, sourceMapId: slug })}\n`),
  );
  const sumoManifestIndex = members.findIndex(
    (member) => member.relativePath === sumoManifestPath,
  );
  members[sumoManifestIndex] = sumoManifestMember;
  byPath.set(sumoManifestPath, sumoManifestMember);

  const xodrBytes = await readFile(requireMember("map.xodr").sourcePath!);
  const xodrText = xodrBytes.toString("utf8");
  const manifestBytes = await readFile(requireMember("3d/manifest.json").sourcePath!);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  const topologyBytes = await readFile(requireMember("topology-index.json.gz").sourcePath!);
  const topology = jsonFromGzip<Topology>(topologyBytes);
  const lanePolygons = jsonFromGzip<NonNullable<Parameters<typeof buildDerivedArtifacts>[0]["lanePolygonsJson"]>>(
    await readFile(requireMember("lane-polygons.geojson.gz").sourcePath!),
  );
  const signals = jsonFromGzip<NonNullable<Parameters<typeof buildDerivedArtifacts>[0]["signalsJson"]>>(
    await readFile(requireMember("signals.geojson.gz").sourcePath!),
  );
  const roadway = buildDerivedArtifacts({
    mapId: slug,
    xodrText,
    xodrSha256: requireMember("map.xodr").sha256,
    topologyIndex: topology,
    topologyBytes,
    lanePolygonsJson: lanePolygons,
    signalsJson: signals,
    manifest: manifest as Parameters<typeof buildDerivedArtifacts>[0]["manifest"],
    roadGlbBytes: await readFile(resolve(mapRoot, roadGlbPath(paths))),
  }).roadwayConsistency.bytes;
  if (!byPath.has("derived/roadway-consistency.json.gz")) {
    const member = await storeGeneratedMember("derived/roadway-consistency.json.gz", roadway);
    members.push(member);
    byPath.set(member.relativePath, member);
  }

  const roadGeoJsonCompressed = await readFile(requireMember("map.geojson.gz").sourcePath!);
  const roadGeoJsonBytes = gunzipSync(roadGeoJsonCompressed);
  const roadGeoJson = JSON.parse(roadGeoJsonBytes.toString("utf8")) as GeoJson;
  const thumbnailBytes = await renderRoadThumbnail(label, roadGeoJson);
  const thumbnailKey = `maps/${slug}/thumbnail.webp`;
  const thumbnailMetadata = await writeLocalObject(
    LOCAL_ARTIFACT_BUCKET, thumbnailKey, thumbnailBytes, "image/webp",
  );
  const geojsonKey = `maps/${slug}/map.geojson`;
  const geojsonMetadata = await writeLocalObject(
    LOCAL_ARTIFACT_BUCKET, geojsonKey, roadGeoJsonBytes, "application/geo+json",
  );

  const sourceMapId = slug;
  const draftId = `usmapdraft_${sha256(`dev-assets:${slug}`).slice(0, 32)}`;
  await upsertMapAsset({
    map_asset_id: sourceMapId,
    name: label,
    carla_map_name: slug.replaceAll("-", "_"),
    ue5_carla_map_name: slug.replaceAll("-", "_"),
    description: `${label} local development map`,
    crs: "OpenDRIVE",
    bbox: { min_lat: 0, min_lng: 0, max_lat: 0, max_lng: 0 },
    center: { lat: 0, lng: 0 },
    created_at: new Date(0).toISOString(),
    tags: ["local", "seeded"],
    map_coordinate_ref: extractCoordinateRefFromXodr(xodrText),
    map_source: { tool: "SimForge dev-assets publication" },
    place_context: { city: locality, geocoder: "manual" },
    artifacts: [
      {
        artifact_type: "xodr", uri: `s3://${LOCAL_ARTIFACT_BUCKET}/${requireMember("map.xodr").key}`,
        sha256: requireMember("map.xodr").sha256, size_bytes: xodrBytes.byteLength,
        created_at: new Date(0).toISOString(),
      },
      {
        artifact_type: "geojson", uri: `s3://${LOCAL_ARTIFACT_BUCKET}/${geojsonKey}`,
        sha256: geojsonMetadata.checksumSha256Hex, size_bytes: geojsonMetadata.sizeBytes,
        created_at: new Date(0).toISOString(),
      },
      {
        artifact_type: "thumbnail", uri: `s3://${LOCAL_ARTIFACT_BUCKET}/${thumbnailKey}`,
        sha256: thumbnailMetadata.checksumSha256Hex, size_bytes: thumbnailMetadata.sizeBytes,
        created_at: new Date(0).toISOString(),
      },
    ],
  });
  await execute(
    `INSERT INTO simforge.map_upload_drafts (
       id, workspace_id, created_by_user_id, label, locality, carla_map_name,
       source_map_id, xodr_sha256, xodr_byte_length, thumbnail_sha256,
       thumbnail_byte_length, layers, preflight, draft_state
     ) VALUES (
       :id, :workspace_id, :user_id, :label, :locality, :carla_map_name,
       :source_map_id, :xodr_sha256, :xodr_byte_length, :thumbnail_sha256,
       :thumbnail_byte_length, CAST(:layers AS jsonb), CAST(:preflight AS jsonb), 'publishing'
     ) ON CONFLICT (id) DO NOTHING`,
    {
      id: draftId,
      workspace_id: LOCAL_WORKSPACE_ID,
      user_id: LOCAL_USER_ID,
      label,
      locality,
      carla_map_name: slug.replaceAll("-", "_"),
      source_map_id: sourceMapId,
      xodr_sha256: requireMember("map.xodr").sha256,
      xodr_byte_length: xodrBytes.byteLength,
      thumbnail_sha256: thumbnailMetadata.checksumSha256Hex,
      thumbnail_byte_length: thumbnailMetadata.sizeBytes,
      layers: [],
      preflight: { source: "dev-assets", fullPublishedClosure: true },
    },
  );

  const releaseId = publishedMapReleaseId({
    activeReleaseId,
    members,
  });
  const plan = planUploadedMapClosure({
    workspaceId: LOCAL_WORKSPACE_ID,
    sourceMapId,
    derivativeReleaseId: releaseId,
    manifest,
    members,
  });
  const receiptBytes = await readFile(requireMember("derived/map-intel-build-receipt.json").sourcePath!);
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as Receipt;
  const locations = jsonFromGzip<{ locations?: unknown[] }>(
    await readFile(requireMember("derived/locations.json.gz").sourcePath!),
  );
  const roadwayReport = jsonFromGzip<RoadwayReport>(roadway);
  const result = await publishUploadedMapVersion({
    draftId,
    plan,
    workspaceId: LOCAL_WORKSPACE_ID,
    sourceMapId,
    sourceMapAssetId: sourceMapId,
    assetCatalogVersionId,
    derivativeReleaseId: releaseId,
    label,
    locality,
    carlaMapName: slug.replaceAll("-", "_"),
    provenance: { kind: "dev-assets-publication", source: mapRoot },
    thumbnail: {
      bucket: LOCAL_ARTIFACT_BUCKET,
      key: thumbnailKey,
      sha256: thumbnailMetadata.checksumSha256Hex,
      byteLength: thumbnailMetadata.sizeBytes,
      mediaType: "image/webp",
      recipe: "uniscenario.road-network-thumbnail/v1",
      sourceBucket: LOCAL_ARTIFACT_BUCKET,
      sourceKey: geojsonKey,
    },
    mapIntel: {
      contractVersion: receipt.contractVersion ?? "uniscenario.map-intel-build/v1",
      builder: {
        package: receipt.builder?.package ?? "@simforge/maps",
        version: receipt.builder?.version ?? MAP_INTEL_BUILDER_VERSION,
      },
      mapId: receipt.mapId ?? slug,
      catalogRevision: receipt.catalogRevision ?? sha256(receiptBytes),
      sourceHashes: receipt.sourceHashes ?? {},
      outputs: receipt.outputs ?? {},
      receiptSha256: sha256(receiptBytes),
      locationCount: locations.locations?.length ?? 0,
      laneCount: topology.stats.lanes,
      junctionCount: topology.stats.junctions,
      roadwayConsistency: {
        format: roadwayReport.format,
        validatorVersion: roadwayReport.validatorVersion,
        verdict: roadwayReport.verdict,
        stats: roadwayReport.stats,
        artifactSha256: requireMember("derived/roadway-consistency.json.gz").sha256,
        sourceDigests: roadwayReport.sourceDigests,
      },
    },
    triangleCount: manifest.scene?.totalTriangles ?? 0,
  });
  await execute(
    `UPDATE simforge.map_upload_drafts
     SET draft_state = 'published', map_version_id = :map_version_id, updated_at = NOW()
     WHERE id = :id`,
    { id: draftId, map_version_id: result.mapVersionId },
  );
  return {
    ...result,
    sumoNetworkSha256: plan.sumoNetworkSha256,
    thumbnailBytes: thumbnailMetadata.sizeBytes,
  };
}
