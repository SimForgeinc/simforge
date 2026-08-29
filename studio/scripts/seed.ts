import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
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
} from "../app/lib/map-ingest/server/dev-asset-publication";
import { registerLocalFile, writeLocalObject } from "../app/lib/s3/s3-object";
import { SUMO_RUNTIME_VERSION } from "../app/lib/scenario/sumo-runtime";
import { migrate } from "./migrate";
import { ensureStarterMapAssets, STARTER_MAP } from "./starter-map";

const FULL_DEV_MAPS: readonly DevAssetMap[] = [
  ["belmont-office-park-belmont-ca", "Belmont Office Park", "Belmont, California"],
  ["di-rosa-sf", "Di Rosa", "San Francisco, California"],
  ["el-camino-rd-palo-alto-ca", "El Camino Road", "Palo Alto, California"],
  ["page-mill-rd-palo-alto-ca", "Page Mill Road", "Palo Alto, California"],
  ["richmond-field-station-richmond-ca", "Richmond Field Station", "Richmond, California"],
  ["san-ramon-phase-1-p1", "San Ramon Phase 1 P1", "San Ramon, California"],
  ["san-ramon-phase-1-p2", "San Ramon Phase 1 P2", "San Ramon, California"],
  ["san-ramon-phase-2", "San Ramon Phase 2", "San Ramon, California"],
  ["saratoga-school-area", "Saratoga School Area", "Saratoga, California"],
  ["yale-st-palo-alto-ca", "Yale Street", "Palo Alto, California"],
];
const configuredAssetsRoot =
  process.env.SCEN_DEV_ASSETS?.trim() || "/home/path/simforge-assets/map-bundles";
const fullAssetsAvailable = existsSync(resolve(configuredAssetsRoot, FULL_DEV_MAPS[0]![0]));
const assetsRoot = fullAssetsAvailable
  ? configuredAssetsRoot
  : resolve(LOCAL_CLOUD_ROOT, "starter-map-assets");
const MAPS: readonly DevAssetMap[] = fullAssetsAvailable ? FULL_DEV_MAPS : [STARTER_MAP];
const catalogArtifactId = "artifact_local_catalog_v2";
const catalogVersionId = "catalog_local_v2";
const editorReleaseId = "editor_release_local_dev_assets_v2";
const catalogDraftId = "usmapdraft_00000000000000000000000000000000";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

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
        provenance: { source: assetsRoot },
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
          source: assetsRoot,
        },
      },
    );
  });
}

async function seedSumoRuntime(): Promise<void> {
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
  if (!fullAssetsAvailable) {
    await ensureStarterMapAssets(assetsRoot);
    console.log(
      `development map bundles were not found at ${configuredAssetsRoot}; generated the bundled Starter Road`,
    );
  }
  await migrate();
  await seedIdentity();
  await seedPublicationBinding();
  await seedSumoRuntime();
  let skipped = 0;
  for (const map of MAPS) {
    // A dev checkout rarely holds the whole corpus. Skip absent bundles loudly
    // rather than aborting the boot: one missing map must not deny the operator
    // every other map, and a silent skip would look like a publish bug.
    if (!existsSync(resolve(assetsRoot, map[0]))) {
      console.warn(`skipped ${map[0]}: no bundle at ${resolve(assetsRoot, map[0])}`);
      skipped += 1;
      continue;
    }
    try {
      const result = await publishDevAssetMap({
        map,
        assetsRoot,
        assetCatalogVersionId: catalogVersionId,
        activeReleaseId: editorReleaseId,
      });
      console.log(
        `published ${map[0]}: ${result.objectCount} members, ${result.byteLength} bytes, `
        + `SUMO ${result.sumoNetworkSha256 ? "ready" : "unavailable"}, thumbnail ${result.thumbnailBytes} bytes`,
      );
    } catch (error) {
      // An incomplete bundle is normal in a dev checkout: map pipelines rewrite
      // these directories in place, so members appear and vanish mid-session.
      // Report it and keep whatever is already published rather than failing the
      // whole boot, which would take the studio down for one bad map.
      skipped += 1;
      console.warn(`skipped ${map[0]}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (skipped > 0) console.warn(`${skipped}/${MAPS.length} dev asset maps skipped; set SCEN_DEV_ASSETS to a fuller corpus`);
  const maps = await queryRows<{ id: string; label: string }>(
    "SELECT id, label FROM simforge.map_versions WHERE retired_at IS NULL ORDER BY label",
  );
  console.log(`seed complete: ${maps.length} map_versions`);
  for (const map of maps) console.log(`  ${map.id} ${map.label}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await seed();
}
