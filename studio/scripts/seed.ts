import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOCAL_ORGANIZATION_ID,
  LOCAL_USER_ID,
  LOCAL_WORKSPACE_ID,
} from "../app/lib/auth/session";
import { queryRows, withTransaction } from "../app/lib/db/data-api";
import { LOCAL_ARTIFACT_BUCKET, LOCAL_CLOUD_ROOT } from "../app/lib/db/config";
import {
  publishDevAssetMap,
  type DevAssetMap,
  type MapInstallationReceipt,
  type RegistryMapInstallation,
} from "../app/lib/map-ingest/server/dev-asset-publication";
import { registerLocalFile, writeLocalObject } from "../app/lib/s3/s3-object";
import { SUMO_RUNTIME_VERSION } from "../app/lib/scenario/sumo-runtime";
import { migrate } from "./migrate";
import { ensureStarterMapAssets, STARTER_MAP } from "./starter-map";

const dataHome = process.env.XDG_DATA_HOME?.trim() || resolve(homedir(), ".local/share");
const mapsCacheRoot =
  process.env.SIMFORGE_MAPS_CACHE_ROOT?.trim() || resolve(dataHome, "simforge/maps");
const semanticProfilesRoot = resolve(mapsCacheRoot, "dev-assets");
const webProfilesRoot = resolve(mapsCacheRoot, "map-bundles");
const nativeProfilesRoot = resolve(mapsCacheRoot, ".corpus");
const starterAssetsRoot = resolve(LOCAL_CLOUD_ROOT, "starter-map-assets");
const catalogArtifactId = "artifact_local_catalog_v2";
const catalogVersionId = "catalog_local_v2";
const editorReleaseId = "editor_release_local_dev_assets_v2";
const catalogDraftId = "usmapdraft_00000000000000000000000000000000";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const SHA256 = /^[a-f0-9]{64}$/;
const MAP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertSafeMemberPath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new Error(`unsafe installation member path: ${path}`);
  }
}

async function readProfileReceipt(
  root: string,
  name: string,
  profile: MapInstallationReceipt["profile"],
): Promise<MapInstallationReceipt> {
  const receipt = JSON.parse(
    await readFile(resolve(root, ".map-release.json"), "utf8"),
  ) as MapInstallationReceipt;
  if (
    receipt.schema !== "simforge.map-installation.v1" ||
    receipt.name !== name ||
    receipt.profile !== profile ||
    !/^v[1-9][0-9]*$/.test(receipt.version) ||
    !SHA256.test(receipt.releaseDigest) ||
    !SHA256.test(receipt.canonicalDigest) ||
    (receipt.webDigest !== undefined && !SHA256.test(receipt.webDigest)) ||
    !receipt.members ||
    typeof receipt.members !== "object" ||
    Array.isArray(receipt.members)
  ) {
    throw new Error(`invalid ${profile} installation receipt`);
  }
  for (const [relativePath, member] of Object.entries(receipt.members)) {
    assertSafeMemberPath(relativePath);
    if (
      !member ||
      !SHA256.test(member.sha256) ||
      !Number.isSafeInteger(member.bytes) ||
      member.bytes < 0
    ) {
      throw new Error(`invalid ${profile} receipt member: ${relativePath}`);
    }
    const memberStat = await stat(resolve(root, relativePath));
    if (!memberStat.isFile() || memberStat.size !== member.bytes) {
      throw new Error(`incomplete ${profile} receipt member: ${relativePath}`);
    }
  }
  return receipt;
}

function mapLabel(name: string): string {
  return name.split("-").map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join(" ");
}

async function discoverRegistryMaps(): Promise<Array<{
  map: DevAssetMap;
  installation: RegistryMapInstallation;
}>> {
  let names: string[];
  try {
    names = (await readdir(webProfilesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && MAP_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const installed: Array<{ map: DevAssetMap; installation: RegistryMapInstallation }> = [];
  for (const name of names) {
    const semanticRoot = resolve(semanticProfilesRoot, name);
    const webRoot = resolve(webProfilesRoot, name);
    const nativeRoot = resolve(nativeProfilesRoot, name);
    try {
      const [semanticReceipt, webReceipt, nativeReceipt] = await Promise.all([
        readProfileReceipt(semanticRoot, name, "semantic"),
        readProfileReceipt(webRoot, name, "web"),
        readProfileReceipt(nativeRoot, name, "native"),
      ]);
      if (
        semanticReceipt.version !== webReceipt.version ||
        nativeReceipt.version !== webReceipt.version ||
        semanticReceipt.releaseDigest !== webReceipt.releaseDigest ||
        nativeReceipt.releaseDigest !== webReceipt.releaseDigest ||
        semanticReceipt.canonicalDigest !== webReceipt.canonicalDigest ||
        nativeReceipt.canonicalDigest !== webReceipt.canonicalDigest ||
        !webReceipt.webDigest ||
        (semanticReceipt.webDigest !== undefined &&
          semanticReceipt.webDigest !== webReceipt.webDigest) ||
        (nativeReceipt.webDigest !== undefined &&
          nativeReceipt.webDigest !== webReceipt.webDigest) ||
        ![
          "map.xodr",
          "map.geojson.gz",
          "topology-index.json.gz",
          "lane-polygons.geojson.gz",
          "signals.geojson.gz",
          "derived/topology-derived.json.gz",
          "derived/locations.json.gz",
          "derived/roadway-consistency.json.gz",
          "derived/map-intel-build-receipt.json",
          "derived/source-capabilities.json.gz",
          "derived/thumbnail.webp",
        ].every((path) => semanticReceipt.members[path]) ||
        !webReceipt.members["3d/manifest.json"] ||
        !nativeReceipt.members["master.gltf"]
      ) {
        throw new Error("installation profiles do not identify one complete release");
      }
      installed.push({
        map: [name, mapLabel(name), "Installed map"],
        installation: {
          semanticRoot,
          webRoot,
          nativeRoot,
          semanticReceipt,
          webReceipt,
          nativeReceipt,
        },
      });
    } catch (error) {
      console.warn(`ignored incomplete installed map ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }
  return installed;
}

async function seedIdentity(): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
       VALUES (:id, :name, :email, TRUE, 'owner') ON CONFLICT (id) DO NOTHING`,
      { id: LOCAL_USER_ID, name: "Local Owner", email: "owner@local.simforge" },
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

async function seedPublicationBinding(): Promise<void> {
  const catalogBody = Buffer.from(JSON.stringify({
    contract: "uniscenario.asset-catalog/v1",
    pipelineVersion: "dev-assets-publication/v2",
    assets: [],
  }));
  const catalogStorageKey = "catalogs/dev-assets-publication-v2.json";
  const catalogMetadata = await writeLocalObject(
    LOCAL_ARTIFACT_BUCKET,
    catalogStorageKey,
    catalogBody,
    "application/json",
  );
  const releaseManifestSha256 = sha256(`dev-assets-publication\0${catalogMetadata.checksumSha256Hex}`);
  await withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO simforge.map_upload_drafts (
         id, workspace_id, created_by_user_id, label, locality, source_map_id,
         xodr_sha256, xodr_byte_length, thumbnail_sha256, thumbnail_byte_length,
         layers, preflight, draft_state
       ) VALUES (
         :id, :workspace_id, :user_id, 'Local asset catalog', 'Local', 'local-catalog',
         :sha256, 1, :sha256, 1, '[]'::jsonb, '{}'::jsonb, 'published'
       ) ON CONFLICT (id) DO NOTHING`,
      {
        id: catalogDraftId,
        workspace_id: LOCAL_WORKSPACE_ID,
        user_id: LOCAL_USER_ID,
        sha256: sha256(""),
      },
    );
    await tx.execute(
      `INSERT INTO simforge.artifacts (
         id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
         sha256, byte_length, artifact_state, created_by_user_id, verified_at,
         verification_method, verification_sha256, producer_job_family, producer_job_id, provenance
       ) VALUES (
         :id, :workspace_id, 'asset-catalog-manifest-v1', 'application/json', :bucket, :key,
         :sha256, :byte_length, 'available', :user_id, NOW(),
         'stream_sha256', :sha256, 'map_publication', :producer_id, CAST(:provenance AS jsonb)
       ) ON CONFLICT (id) DO NOTHING`,
      {
        id: catalogArtifactId,
        workspace_id: LOCAL_WORKSPACE_ID,
        bucket: LOCAL_ARTIFACT_BUCKET,
        key: catalogStorageKey,
        sha256: catalogMetadata.checksumSha256Hex,
        byte_length: catalogMetadata.sizeBytes,
        user_id: LOCAL_USER_ID,
        producer_id: catalogDraftId,
        provenance: {
          contract: "uniscenario.artifact-provenance/v1",
          producerJobFamily: "map_publication",
          producerJobId: catalogDraftId,
        },
      },
    );
    await tx.execute(
      `INSERT INTO simforge.asset_catalog_versions (
         id, workspace_id, manifest_artifact_id, manifest_sha256, source_inventory_sha256,
         pipeline_version, toolchain, provenance, status
       ) VALUES (
         :id, :workspace_id, :artifact_id, :sha256, :sha256,
         'dev-assets-publication/v2', CAST(:toolchain AS jsonb), CAST(:provenance AS jsonb), 'active'
       ) ON CONFLICT (id) DO NOTHING`,
      {
        id: catalogVersionId,
        workspace_id: LOCAL_WORKSPACE_ID,
        artifact_id: catalogArtifactId,
        sha256: catalogMetadata.checksumSha256Hex,
        toolchain: { source: "local" },
        provenance: { source: mapsCacheRoot },
      },
    );
    await tx.execute(
      `INSERT INTO simforge.editor_asset_releases (
         id, workspace_id, manifest_sha256, source_inventory_sha256,
         asset_catalog_version_id, source_environment, manifest, release_state, activated_at
       ) VALUES (
         :id, :workspace_id, :manifest_sha256, :source_inventory_sha256,
         :catalog_version_id, 'dev', CAST(:manifest AS jsonb), 'active', NOW()
       ) ON CONFLICT (id) DO NOTHING`,
      {
        id: editorReleaseId,
        workspace_id: LOCAL_WORKSPACE_ID,
        manifest_sha256: releaseManifestSha256,
        source_inventory_sha256: catalogMetadata.checksumSha256Hex,
        catalog_version_id: catalogVersionId,
        manifest: {
          contractVersion: "simforge.editor-assets-release/v1",
          manifestSha256: releaseManifestSha256,
          source: mapsCacheRoot,
        },
      },
    );
  });
}

async function seedSumoRuntime(assetsRoot: string): Promise<void> {
  const runtimeRoot = resolve(assetsRoot, "sumo-runtime");
  const runtimeFiles = [
    ["sumo.mjs", "text/javascript"],
    ["sumo.wasm", "application/wasm"],
    ["runtime-manifest.json", "application/json"],
    ["THIRD_PARTY_NOTICES.md", "text/markdown"],
  ] as const;
  if (!runtimeFiles.every(([fileName]) => existsSync(resolve(runtimeRoot, fileName)))) {
    console.log("SUMO browser runtime unavailable; Studio will use native deterministic traffic");
    return;
  }
  for (const [fileName, contentType] of runtimeFiles) {
    await registerLocalFile(
      LOCAL_ARTIFACT_BUCKET,
      `uniscenario/sumo-runtime/${SUMO_RUNTIME_VERSION}/${fileName}`,
      resolve(runtimeRoot, fileName),
      contentType,
    );
  }
  console.log(`registered SUMO browser runtime ${SUMO_RUNTIME_VERSION}`);
}

export async function seed(): Promise<void> {
  const installedMaps = await discoverRegistryMaps();
  if (installedMaps.length === 0) {
    await ensureStarterMapAssets(starterAssetsRoot);
    console.log(
      `no complete installed registry maps were found at ${mapsCacheRoot}; generated the bundled Starter Road`,
    );
  }
  await migrate();
  await seedIdentity();
  await seedPublicationBinding();
  await seedSumoRuntime(
    installedMaps.length > 0 ? semanticProfilesRoot : starterAssetsRoot,
  );
  let skipped = 0;
  const publications = installedMaps.length > 0
    ? installedMaps
    : [{ map: STARTER_MAP, assetsRoot: starterAssetsRoot }];
  for (const publication of publications) {
    try {
      const result = await publishDevAssetMap({
        map: publication.map,
        ...("installation" in publication
          ? { installation: publication.installation }
          : { assetsRoot: publication.assetsRoot }),
        assetCatalogVersionId: catalogVersionId,
        activeReleaseId: editorReleaseId,
      });
      console.log(
        `published ${publication.map[0]}: ${result.objectCount} browser members, `
        + `${result.byteLength} bytes, SUMO ${result.sumoNetworkSha256 ? "ready" : "unavailable"}, `
        + `thumbnail ${result.thumbnailBytes} bytes`,
      );
    } catch (error) {
      skipped += 1;
      console.warn(`skipped ${publication.map[0]}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }
  if (skipped > 0) {
    console.warn(`${skipped}/${publications.length} installed maps skipped`);
  }
  const maps = await queryRows<{ id: string; label: string }>(
    "SELECT id, label FROM simforge.map_versions WHERE retired_at IS NULL ORDER BY label",
  );
  console.log(`seed complete: ${maps.length} map_versions`);
  for (const map of maps) console.log(`  ${map.id} ${map.label}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await seed();
}
