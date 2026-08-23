import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_ORGANIZATION_ID,
  LOCAL_USER_ID,
  LOCAL_WORKSPACE_ID,
} from "../app/lib/auth/session";
import { queryRows, withTransaction } from "../app/lib/db/data-api";
import { LOCAL_ARTIFACT_BUCKET } from "../app/lib/db/config";
import { registerLocalFile, writeLocalObject, type LocalObjectMetadata } from "../app/lib/s3/s3-object";
import { migrate } from "./migrate";

const MAPS = [
  ["yale-street", "Yale Street", "New Haven, Connecticut"],
  ["belmont-research-center", "Belmont Research Center", "Belmont, California"],
  ["el-camino-road", "El Camino Road", "California"],
  ["easterbrook-discovery-school", "Easterbrook Discovery School", "San Jose, California"],
  ["richmond-field-station", "Richmond Field Station", "Richmond, California"],
] as const;
const CORE_PATHS = [
  "map.xodr",
  "map.geojson.gz",
  "topology-index.json.gz",
  "signals.geojson.gz",
  "lane-polygons.geojson.gz",
  "derived/topology-derived.json.gz",
  "derived/locations.json.gz",
  "derived/signals.json.gz",
  "3d/manifest.json",
] as const;
const REQUIRED_PATHS = new Set([
  "map.xodr",
  "topology-index.json.gz",
  "signals.geojson.gz",
  "lane-polygons.geojson.gz",
  "derived/topology-derived.json.gz",
  "derived/locations.json.gz",
  "3d/manifest.json",
]);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot =
  process.env.UNISCENARIOS_DEV_ASSETS?.trim() || "/home/path/UniScenarios/dev-assets";

type SeedFile = {
  relativePath: string;
  sourcePath: string;
  storageKey: string;
  metadata: LocalObjectMetadata;
  mediaType: string;
  blobId: string;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function mediaType(path: string): string {
  if (path.endsWith(".geojson.gz")) return "application/geo+json";
  if (path.endsWith(".json.gz")) return "application/json";
  switch (extname(path).toLowerCase()) {
    case ".json": return "application/json";
    case ".xodr": return "application/xml";
    case ".glb": return "model/gltf-binary";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

function memberRole(path: string): "manifest" | "environment" | "geometry" | "texture" | "metadata" | "runtime" {
  if (path === "3d/manifest.json") return "manifest";
  if (/\.(png|jpe?g|webp)$/i.test(path)) return "texture";
  if (/\.(glb|gltf|xodr)$/i.test(path)) return "geometry";
  if (path.startsWith("3d/env/")) return "environment";
  if (path.includes("sumo/")) return "runtime";
  return "metadata";
}

function collectManifestFiles(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    if (/\.(?:glb|gltf|png|jpe?g|webp|json)$/i.test(value) && !value.includes("..")) {
      output.add(`3d/${value.replace(/^\/+/, "")}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectManifestFiles(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectManifestFiles(item, output);
  }
}

async function existingSeedPaths(mapRoot: string): Promise<string[]> {
  const paths = new Set<string>(CORE_PATHS);
  const manifest = JSON.parse(await readFile(resolve(mapRoot, "3d/manifest.json"), "utf8")) as unknown;
  collectManifestFiles(manifest, paths);
  const existing: string[] = [];
  for (const path of paths) {
    try {
      await access(resolve(mapRoot, path));
      existing.push(path);
    } catch {
      if (REQUIRED_PATHS.has(path)) throw new Error(`Required browser asset is missing: ${path}`);
    }
  }
  return existing.sort();
}

async function registerMapFiles(slug: string): Promise<SeedFile[]> {
  const mapRoot = resolve(assetsRoot, slug);
  const files: SeedFile[] = [];
  for (const relativePath of await existingSeedPaths(mapRoot)) {
    const sourcePath = resolve(mapRoot, relativePath);
    const storageKey = `maps/${slug}/${relativePath}`;
    const type = mediaType(relativePath);
    const metadata = await registerLocalFile(LOCAL_ARTIFACT_BUCKET, storageKey, sourcePath, type);
    files.push({
      relativePath,
      sourcePath,
      storageKey,
      metadata,
      mediaType: type,
      blobId: `blob_${sha256(`${metadata.checksumSha256Hex}:${type}`).slice(0, 32)}`,
    });
  }
  return files;
}

async function seedIdentity(): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
       VALUES (:id, :name, :email, TRUE, 'owner') ON CONFLICT (id) DO NOTHING`,
      { id: LOCAL_USER_ID, name: "Local Owner", email: "owner@local.uniscenarios" },
    );
    await tx.execute(
      `INSERT INTO public.ba_organization (id, name, slug)
       VALUES (:id, 'Local Workspace', 'local') ON CONFLICT (id) DO NOTHING`,
      { id: LOCAL_ORGANIZATION_ID },
    );
    await tx.execute(
      `INSERT INTO public.ba_member (id, "organizationId", "userId", role)
       VALUES (:id, :organization_id, :user_id, 'owner') ON CONFLICT (id) DO NOTHING`,
      {
        id: "00000000-0000-4000-8000-000000000005",
        organization_id: LOCAL_ORGANIZATION_ID,
        user_id: LOCAL_USER_ID,
      },
    );
    await tx.execute(
      `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
       VALUES (:id, 'personal', 'local', 'Local Workspace', :user_id, :organization_id)
       ON CONFLICT (id) DO NOTHING`,
      { id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID, organization_id: LOCAL_ORGANIZATION_ID },
    );
  });
}

function artifactParams(
  id: string,
  kind: string,
  file: SeedFile | { storageKey: string; metadata: LocalObjectMetadata; mediaType: string },
  producerId: string,
) {
  return {
    id,
    workspace_id: LOCAL_WORKSPACE_ID,
    artifact_kind: kind,
    media_type: file.mediaType,
    bucket: LOCAL_ARTIFACT_BUCKET,
    key: file.storageKey,
    sha256: file.metadata.checksumSha256Hex,
    byte_length: file.metadata.sizeBytes,
    user_id: LOCAL_USER_ID,
    producer_id: producerId,
    provenance: {
      contract: "uniscenario.artifact-provenance/v1",
      producerJobFamily: "map_publication",
      producerJobId: producerId,
    },
  };
}

export async function seed(): Promise<void> {
  await migrate();
  await seedIdentity();
  const registered = new Map<string, SeedFile[]>();
  for (const [slug] of MAPS) {
    const files = await registerMapFiles(slug);
    registered.set(slug, files);
    console.log(`registered ${slug}: ${files.length} browser assets`);
  }

  const catalogBody = Buffer.from(JSON.stringify({
    contract: "uniscenario.asset-catalog/v1",
    pipelineVersion: "local-seed/v1",
    assets: [],
  }));
  const catalogStorageKey = "catalogs/local-seed-v1.json";
  const catalogMetadata = await writeLocalObject(
    LOCAL_ARTIFACT_BUCKET,
    catalogStorageKey,
    catalogBody,
    "application/json",
  );
  const catalogArtifactId = "artifact_local_catalog_v1";
  const catalogVersionId = "catalog_local_v1";

  await withTransaction(async (tx) => {
    for (const [index, [slug, label, locality]] of MAPS.entries()) {
      const files = registered.get(slug)!;
      const xodr = files.find((file) => file.relativePath === "map.xodr")!;
      const draftId = `usmapdraft_${sha256(`local:${slug}`).slice(0, 32)}`;
      await tx.execute(
        `INSERT INTO public.map_assets (id, name, description, crs, tags, carla_map_name, ue5_carla_map_name)
         VALUES (:id, :name, :description, 'EPSG:4326', :tags, :carla_name, :carla_name)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
        {
          id: slug,
          name: label,
          description: `${label} local development map`,
          tags: ["local", "seeded"],
          carla_name: slug.replaceAll("-", "_"),
        },
      );
      await tx.execute(
        `INSERT INTO uniscenario.map_upload_drafts (
           id, workspace_id, created_by_user_id, label, locality, carla_map_name,
           source_map_id, xodr_sha256, xodr_byte_length, thumbnail_sha256,
           thumbnail_byte_length, layers, preflight, draft_state
         ) VALUES (
           :id, :workspace_id, :user_id, :label, :locality, :carla_name,
           :source_map_id, :sha256, :byte_length, :sha256, :byte_length,
           :layers, :preflight, 'published'
         ) ON CONFLICT (id) DO NOTHING`,
        {
          id: draftId,
          workspace_id: LOCAL_WORKSPACE_ID,
          user_id: LOCAL_USER_ID,
          label,
          locality,
          carla_name: slug.replaceAll("-", "_"),
          source_map_id: `local:${slug}`,
          sha256: xodr.metadata.checksumSha256Hex,
          byte_length: xodr.metadata.sizeBytes,
          layers: [],
          preflight: { source: "local-seed", index },
        },
      );
    }

    const firstDraftId = `usmapdraft_${sha256(`local:${MAPS[0][0]}`).slice(0, 32)}`;
    await tx.execute(
      `INSERT INTO uniscenario.artifacts (
         id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
         sha256, byte_length, artifact_state, created_by_user_id, verified_at,
         verification_method, verification_sha256, producer_job_family, producer_job_id, provenance
       ) VALUES (
         :id, :workspace_id, :artifact_kind, :media_type, :bucket, :key,
         :sha256, :byte_length, 'available', :user_id, NOW(),
         'stream_sha256', :sha256, 'map_publication', :producer_id, :provenance
       ) ON CONFLICT (id) DO NOTHING`,
      artifactParams(catalogArtifactId, "asset-catalog-manifest-v1", {
        storageKey: catalogStorageKey,
        metadata: catalogMetadata,
        mediaType: "application/json",
      }, firstDraftId),
    );
    await tx.execute(
      `INSERT INTO uniscenario.asset_catalog_versions (
         id, workspace_id, manifest_artifact_id, manifest_sha256, source_inventory_sha256,
         pipeline_version, toolchain, provenance, status
       ) VALUES (
         :id, :workspace_id, :artifact_id, :sha256, :sha256,
         'local-seed/v1', :toolchain, :provenance, 'active'
       ) ON CONFLICT (id) DO NOTHING`,
      {
        id: catalogVersionId,
        workspace_id: LOCAL_WORKSPACE_ID,
        artifact_id: catalogArtifactId,
        sha256: catalogMetadata.checksumSha256Hex,
        toolchain: { source: "local" },
        provenance: { source: "UniScenarios/dev-assets" },
      },
    );

    for (const [slug, label, locality] of MAPS) {
      const files = registered.get(slug)!;
      const byPath = new Map(files.map((file) => [file.relativePath, file]));
      const xodr = byPath.get("map.xodr")!;
      const draftId = `usmapdraft_${sha256(`local:${slug}`).slice(0, 32)}`;
      const mapVersionId = `mapv_${sha256(`local:${slug}:v1`).slice(0, 32)}`;
      const assetSetId = `bas_${sha256(`local:${slug}:assets:v1`).slice(0, 32)}`;
      const artifactByPath: Record<string, string> = {};
      for (const path of REQUIRED_PATHS) {
        const file = byPath.get(path)!;
        const artifactId = `artifact_${sha256(`${slug}:${path}`).slice(0, 32)}`;
        artifactByPath[path] = artifactId;
        await tx.execute(
          `INSERT INTO uniscenario.artifacts (
             id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
             sha256, byte_length, artifact_state, created_by_user_id, verified_at,
             verification_method, verification_sha256, producer_job_family, producer_job_id, provenance
           ) VALUES (
             :id, :workspace_id, :artifact_kind, :media_type, :bucket, :key,
             :sha256, :byte_length, 'available', :user_id, NOW(),
             'stream_sha256', :sha256, 'map_publication', :producer_id, :provenance
           ) ON CONFLICT (id) DO NOTHING`,
          artifactParams(artifactId, `map-${path.replaceAll("/", "-")}`, file, draftId),
        );
      }
      await tx.execute(
        `INSERT INTO uniscenario.map_versions (
           id, workspace_id, source_map_id, source_map_asset_id, derivative_release_id,
           label, locality, browser_manifest_url, topology_artifact_url,
           xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256,
           descriptor, created_by_user_id, topology_artifact_id, derived_topology_artifact_id,
           locations_artifact_id, signals_artifact_id, browser_manifest_artifact_id,
           asset_catalog_version_id, compiler_bundle_version
         ) VALUES (
           :id, :workspace_id, :source_map_id, :source_map_asset_id, 'local-v1',
           :label, :locality, :manifest_url, :topology_url,
           :xodr_artifact_id, :xodr_sha256, 'EPSG:4326', :coordinate_sha256,
           :descriptor, :user_id, :topology_artifact_id, :derived_artifact_id,
           :locations_artifact_id, :signals_artifact_id, :manifest_artifact_id,
           :catalog_version_id, 'local-seed/v1'
         ) ON CONFLICT (id) DO NOTHING`,
        {
          id: mapVersionId,
          workspace_id: LOCAL_WORKSPACE_ID,
          source_map_id: slug,
          source_map_asset_id: slug,
          label,
          locality,
          manifest_url: `/api/uniscenario/maps/${mapVersionId}/browser-assets/3d/manifest.json`,
          topology_url: `/api/uniscenario/maps/${mapVersionId}/browser-assets/topology-index.json.gz`,
          xodr_artifact_id: artifactByPath["map.xodr"]!,
          xodr_sha256: xodr.metadata.checksumSha256Hex,
          coordinate_sha256: sha256("EPSG:4326"),
          descriptor: { source: "local-seed", slug },
          user_id: LOCAL_USER_ID,
          topology_artifact_id: artifactByPath["topology-index.json.gz"]!,
          derived_artifact_id: artifactByPath["derived/topology-derived.json.gz"]!,
          locations_artifact_id: artifactByPath["derived/locations.json.gz"]!,
          signals_artifact_id: artifactByPath["signals.geojson.gz"]!,
          manifest_artifact_id: artifactByPath["3d/manifest.json"]!,
          catalog_version_id: catalogVersionId,
        },
      );
      const closureSha256 = sha256(files.map((file) => `${file.relativePath}:${file.metadata.checksumSha256Hex}`).join("\n"));
      await tx.execute(
        `INSERT INTO uniscenario.browser_asset_sets (
           id, workspace_id, map_version_id, closure_sha256, object_count,
           byte_length, asset_set_state, verified_at
         ) VALUES (
           :id, :workspace_id, :map_version_id, :closure_sha256, :object_count,
           :byte_length, 'available', NOW()
         ) ON CONFLICT (id) DO NOTHING`,
        {
          id: assetSetId,
          workspace_id: LOCAL_WORKSPACE_ID,
          map_version_id: mapVersionId,
          closure_sha256: closureSha256,
          object_count: files.length,
          byte_length: files.reduce((sum, file) => sum + file.metadata.sizeBytes, 0),
        },
      );
      await tx.batchExecute(
        `INSERT INTO uniscenario.browser_asset_blobs (
           id, storage_bucket, storage_key, sha256, byte_length, media_type,
           verification_state, verified_at
         ) VALUES (
           :id, :bucket, :key, :sha256, :byte_length, :media_type, 'verified', NOW()
         ) ON CONFLICT (id) DO NOTHING`,
        files.map((file) => ({
          id: file.blobId,
          bucket: LOCAL_ARTIFACT_BUCKET,
          key: file.storageKey,
          sha256: file.metadata.checksumSha256Hex,
          byte_length: file.metadata.sizeBytes,
          media_type: file.mediaType,
        })),
      );
      await tx.batchExecute(
        `INSERT INTO uniscenario.browser_asset_members (
           asset_set_id, relative_path, blob_id, role, required
         ) VALUES (:asset_set_id, :relative_path, :blob_id, :role, :required)
         ON CONFLICT (asset_set_id, relative_path) DO NOTHING`,
        files.map((file) => ({
          asset_set_id: assetSetId,
          relative_path: file.relativePath,
          blob_id: file.blobId,
          role: memberRole(file.relativePath),
          required: REQUIRED_PATHS.has(file.relativePath),
        })),
      );
      await tx.execute(
        "UPDATE uniscenario.map_versions SET browser_asset_set_id = :asset_set_id WHERE id = :id",
        { asset_set_id: assetSetId, id: mapVersionId },
      );
      await tx.execute(
        "UPDATE uniscenario.map_upload_drafts SET map_version_id = :map_version_id WHERE id = :id",
        { map_version_id: mapVersionId, id: draftId },
      );
    }
  });

  const maps = await queryRows<{ id: string; label: string }>(
    "SELECT id, label FROM uniscenario.map_versions WHERE retired_at IS NULL ORDER BY label",
  );
  console.log(`seed complete: ${maps.length} map_versions`);
  for (const map of maps) console.log(`  ${map.id} ${map.label}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await seed();
}
