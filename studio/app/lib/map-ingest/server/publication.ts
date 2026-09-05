import { createHash } from "node:crypto";
import { withTransaction } from "@/app/lib/db/data-api";
import type { PublishedMapSummary } from "@/app/lib/map-ingest/contracts";
import {
  BROWSER_ASSET_SET_CONTRACT,
  type NativeMapAssetSetPlan,
  type UploadedMapClosurePlan,
} from "./closure";

const COORDINATE_SYSTEM_ID = "uniscenario.scene-y-up-x-east-z-south/v1";
const COORDINATE_SYSTEM_SHA256 = createHash("sha256").update(JSON.stringify({
  id: COORDINATE_SYSTEM_ID,
  scene: {
    handedness: "right",
    up: "+y",
    east: "+x",
    north: "-z",
    heading: "ccw-about-y",
  },
})).digest("hex");
const MAP_THUMBNAIL_ARTIFACT_KIND = "map-thumbnail-v2";
const SHA256 = /^[a-f0-9]{64}$/;

export type PublishedMapThumbnail = {
  bucket: string;
  key: string;
  sha256: string;
  byteLength: number;
  mediaType: "image/webp";
  recipe: string;
  sourceBucket: string;
  sourceKey: string;
};

export type PublishedMapIntel = {
  contractVersion: string;
  builder: { package: string; version: string };
  mapId: string;
  catalogRevision: string;
  sourceHashes: Record<string, unknown>;
  outputs: Record<string, unknown>;
  receiptSha256: string;
  locationCount: number;
  laneCount: number;
  junctionCount: number;
  roadwayConsistency: {
    format: string;
    validatorVersion: string;
    verdict: string;
    stats: Record<string, unknown>;
    artifactSha256: string;
    sourceDigests: {
      xodrSha256: string;
      topologySha256: string;
      sourceRoadGeometrySha256: string;
      finalRoadSha256: string;
      roadAuditSha256: string;
    };
  };
};

export type PublishUploadedMapVersionInput = {
  /**
   * The draft these artifacts came from. It becomes their producer identity:
   * `simforge.artifacts` requires every row to name either an immutable
   * revision or an operational producer job, and a published map has neither a
   * revision nor any of the compile/validate/render/postprocess jobs, so
   * `20260819110000_map_publication_artifact_producer.sql` adds a
   * `map_publication` family that resolves against `simforge.map_upload_drafts`
   * — and this is the id it resolves by.
   */
  draftId: string;
  plan: UploadedMapClosurePlan;
  workspaceId: string;
  sourceMapId: string;
  sourceMapAssetId: string;
  assetCatalogVersionId: string;
  derivativeReleaseId: string;
  label: string;
  locality: string;
  carlaMapName: string | null;
  provenance: Record<string, unknown>;
  thumbnail: PublishedMapThumbnail;
  mapIntel: PublishedMapIntel;
  triangleCount: number;
  registryReleaseDigest?: string;
  nativePlan?: NativeMapAssetSetPlan;
};

const MAP_UPLOAD_PRODUCER_FAMILY = "map_publication";

/**
 * Provenance every artifact this publication inserts must carry.
 *
 * `uniscenario_artifacts_producer_closure_check` accepts a row only with a
 * revision id or one of four operational job families plus a non-empty job id,
 * and `uniscenario_artifacts_provenance_object_check` requires the JSONB to
 * agree with those columns field for field.
 */
function producerProvenance(draftId: string) {
  // The producer id is the draft id itself, because
  // uniscenario_artifacts_producer_resolvable resolves `map_publication` against
  // simforge.map_upload_drafts by exact id and workspace.
  const producerJobId = draftId;
  // Keys are the SQL parameter names, not camelCase: these objects are spread
  // straight into the Data API binding, which resolves `:producer_job_family`
  // by exact key and fails the statement when it cannot find one.
  return {
    producer_job_family: MAP_UPLOAD_PRODUCER_FAMILY,
    producer_job_id: producerJobId,
    provenance: {
      contract: "uniscenario.artifact-provenance/v1",
      producerJobFamily: MAP_UPLOAD_PRODUCER_FAMILY,
      producerJobId,
    },
  };
}

type IdRow = { id: string };
type ClosureCountRow = { object_count: number | string; byte_length: number | string };

function thumbnailArtifactId(workspaceId: string, digest: string) {
  return `usart_${createHash("sha256")
    .update(`${workspaceId}\0${MAP_THUMBNAIL_ARTIFACT_KIND}\0${digest}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function assertPublicationInput(input: PublishUploadedMapVersionInput) {
  const { plan } = input;
  if (
    plan.contractVersion !== BROWSER_ASSET_SET_CONTRACT ||
    !SHA256.test(plan.closureSha256) ||
    plan.objectCount !== plan.members.length ||
    plan.workspaceId !== input.workspaceId ||
    plan.sourceMapId !== input.sourceMapId ||
    plan.derivativeReleaseId !== input.derivativeReleaseId
  ) {
    throw new Error("invalid_browser_asset_set");
  }
  if (!input.sourceMapAssetId || !input.assetCatalogVersionId) {
    throw new Error("sourceMapAssetId and assetCatalogVersionId are required");
  }
  // Blank here would insert artifacts whose producer job id is empty, which the
  // artifacts table rejects at the end of a long transaction rather than now.
  if (!input.draftId.trim()) throw new Error("draftId is required");
  if (
    plan.members.some((member) =>
      !SHA256.test(member.sha256) ||
      !Number.isSafeInteger(member.byteLength) ||
      member.byteLength < 0 ||
      !member.bucket ||
      !member.key ||
      !member.blobId,
    )
  ) {
    throw new Error("invalid_browser_asset_members");
  }
  if (
    (input.registryReleaseDigest === undefined) !== (input.nativePlan === undefined) ||
    (input.nativePlan && (
      input.nativePlan.mapVersionId !== plan.mapVersionId ||
      input.nativePlan.workspaceId !== input.workspaceId ||
      input.nativePlan.registryReleaseDigest !== input.registryReleaseDigest
    ))
  ) {
    throw new Error("invalid_native_map_asset_set");
  }
}

export async function publishUploadedMapVersion(
  input: PublishUploadedMapVersionInput,
): Promise<PublishedMapSummary> {
  assertPublicationInput(input);
  const { plan } = input;
  const producer = producerProvenance(input.draftId);

  return withTransaction(async (tx) => {
    const source = await tx.queryOne<IdRow>(
      `SELECT id FROM public.map_assets WHERE id = :source_map_asset_id LIMIT 1`,
      { source_map_asset_id: input.sourceMapAssetId },
    );
    if (!source) throw new Error(`source_map_asset_not_found:${input.sourceMapAssetId}`);

    const catalog = await tx.queryOne<IdRow>(
      `SELECT id FROM simforge.asset_catalog_versions
       WHERE id = :asset_catalog_version_id AND status = 'active'
         AND (workspace_id IS NULL OR workspace_id = :workspace_id) LIMIT 1`,
      {
        asset_catalog_version_id: input.assetCatalogVersionId,
        workspace_id: input.workspaceId,
      },
    );
    if (!catalog) {
      throw new Error(`asset_catalog_binding_not_found:${input.assetCatalogVersionId}`);
    }

    const proposedThumbnailId = thumbnailArtifactId(input.workspaceId, input.thumbnail.sha256);
    await tx.execute(
      `INSERT INTO simforge.artifacts (
         id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
         sha256, byte_length, artifact_state, metadata, verified_at,
         producer_job_family, producer_job_id, provenance
       ) VALUES (
         :id, :workspace_id, :artifact_kind, :media_type, :storage_bucket, :storage_key,
         :sha256, :byte_length, 'available', CAST(:metadata AS jsonb), NOW(),
         :producer_job_family, :producer_job_id, CAST(:provenance AS jsonb)
       ) ON CONFLICT DO NOTHING`,
      {
        id: proposedThumbnailId,
        workspace_id: input.workspaceId,
        artifact_kind: MAP_THUMBNAIL_ARTIFACT_KIND,
        media_type: input.thumbnail.mediaType,
        storage_bucket: input.thumbnail.bucket,
        storage_key: input.thumbnail.key,
        sha256: input.thumbnail.sha256,
        byte_length: input.thumbnail.byteLength,
        metadata: {
          contractVersion: input.thumbnail.recipe,
          sourceMapAssetId: input.sourceMapAssetId,
          source: { bucket: input.thumbnail.sourceBucket, key: input.thumbnail.sourceKey },
        },
        ...producer,
      },
    );
    const thumbnailArtifact = await tx.queryOne<IdRow>(
      `SELECT id
       FROM simforge.artifacts
       WHERE workspace_id = :workspace_id
         AND artifact_kind = :artifact_kind
         AND sha256 = :sha256
         AND byte_length = :byte_length
         AND media_type = :media_type
         AND artifact_state = 'available'
         AND deleted_at IS NULL
       LIMIT 1`,
      {
        workspace_id: input.workspaceId,
        artifact_kind: MAP_THUMBNAIL_ARTIFACT_KIND,
        sha256: input.thumbnail.sha256,
        byte_length: input.thumbnail.byteLength,
        media_type: input.thumbnail.mediaType,
      },
    );
    if (!thumbnailArtifact) {
      throw new Error(`map_thumbnail_artifact_identity_conflict:${plan.mapVersionId}`);
    }

    const artifactByPath = new Map<string, string>();
    for (const member of plan.members) {
      if (!member.artifactKind || !member.artifactId) continue;
      await tx.execute(
        `INSERT INTO simforge.artifacts (
           id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
           sha256, byte_length, artifact_state, metadata, verified_at,
           producer_job_family, producer_job_id, provenance
         ) VALUES (
           :id, :workspace_id, :artifact_kind, :media_type, :storage_bucket, :storage_key,
           :sha256, :byte_length, 'available', CAST(:metadata AS jsonb), NOW(),
           :producer_job_family, :producer_job_id, CAST(:provenance AS jsonb)
         ) ON CONFLICT DO NOTHING`,
        {
          id: member.artifactId,
          workspace_id: input.workspaceId,
          artifact_kind: member.artifactKind,
          media_type: member.mediaType,
          storage_bucket: member.bucket,
          storage_key: member.key,
          sha256: member.sha256,
          byte_length: member.byteLength,
          metadata: {
            mapVersionId: plan.mapVersionId,
            sourceMapAssetId: input.sourceMapAssetId,
            relativePath: member.relativePath,
          },
          ...producer,
        },
      );
      // `simforge.artifacts` declares UNIQUE (workspace_id, sha256,
      // artifact_kind): within a workspace the bytes are the identity, and the
      // stored bucket/key is simply where a copy of them lives. So the insert
      // above may legitimately have done nothing because an earlier publish
      // already registered these exact bytes under this kind — possibly at a
      // different content-addressed location. Re-select on the unique key and
      // reuse that row; matching on bucket/key instead would report a conflict
      // for bytes the workspace already owns.
      const exact = await tx.queryRows<IdRow>(
        `SELECT id FROM simforge.artifacts
         WHERE workspace_id = :workspace_id AND artifact_kind = :artifact_kind
           AND sha256 = :sha256 AND byte_length = :byte_length AND artifact_state = 'available'`,
        {
          workspace_id: input.workspaceId,
          artifact_kind: member.artifactKind,
          storage_bucket: member.bucket,
          storage_key: member.key,
          sha256: member.sha256,
          byte_length: member.byteLength,
        },
      );
      const identity = exact.length === 1 ? exact[0] : undefined;
      if (!identity) throw new Error(`artifact_identity_conflict:${member.relativePath}`);
      artifactByPath.set(member.relativePath, identity.id);
    }

    const digest = (relativePath: string) =>
      plan.members.find((member) => member.relativePath === relativePath)?.sha256 ?? null;
    const requiredArtifact = (relativePath: string) => {
      const artifactId = artifactByPath.get(relativePath);
      if (!artifactId) throw new Error(`artifact_identity_conflict:${relativePath}`);
      return artifactId;
    };
    const descriptor = {
      contractVersion: "uniscenario.map-version-descriptor/v2",
      logicalMapId: input.mapIntel.mapId,
      sourceMapId: input.sourceMapId,
      carlaMapName: input.carlaMapName,
      derivativeReleaseId: input.derivativeReleaseId,
      browserClosureSha256: plan.closureSha256,
      ...(input.registryReleaseDigest
        ? { registryReleaseDigest: input.registryReleaseDigest }
        : {}),
      sumoRequired: false,
      artifactDigests: {
        xodrSha256: digest("map.xodr"),
        topologySha256: digest("topology-index.json.gz"),
        derivedTopologySha256: digest("derived/topology-derived.json.gz"),
        locationsSha256: digest("derived/locations.json.gz"),
        signalsSha256: digest("signals.geojson.gz"),
        lanePolygonsSha256: digest("lane-polygons.geojson.gz"),
        roadwayConsistencySha256: digest("derived/roadway-consistency.json.gz"),
        staticSemanticsSha256: digest("3d/semantics.json"),
      },
      provenance: input.provenance,
      mapIntel: {
        contractVersion: input.mapIntel.contractVersion,
        builder: input.mapIntel.builder,
        mapId: input.mapIntel.mapId,
        catalogRevision: input.mapIntel.catalogRevision,
        sourceHashes: input.mapIntel.sourceHashes,
        outputs: input.mapIntel.outputs,
        receiptSha256: input.mapIntel.receiptSha256,
        // Recorded so a later republication of the same map — an optimization,
        // which re-derives nothing — can carry these forward instead of running
        // map-intel again purely to restate numbers that cannot have moved.
        laneCount: input.mapIntel.laneCount,
        junctionCount: input.mapIntel.junctionCount,
        locationCount: input.mapIntel.locationCount,
        triangleCount: input.triangleCount,
      },
      roadwayConsistency: {
        format: input.mapIntel.roadwayConsistency.format,
        validatorVersion: input.mapIntel.roadwayConsistency.validatorVersion,
        verdict: input.mapIntel.roadwayConsistency.verdict,
        stats: input.mapIntel.roadwayConsistency.stats,
        artifactSha256: input.mapIntel.roadwayConsistency.artifactSha256,
        sourceDigests: input.mapIntel.roadwayConsistency.sourceDigests,
      },
    };

    await tx.execute(
      `INSERT INTO simforge.map_versions (
         id, workspace_id, source_map_id, source_map_asset_id, derivative_release_id,
         label, locality, browser_manifest_url, topology_artifact_url,
         xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256,
         descriptor, topology_artifact_id, derived_topology_artifact_id, locations_artifact_id,
         signals_artifact_id, browser_manifest_artifact_id, thumbnail_artifact_id,
         asset_catalog_version_id, sumo_network_sha256, compiler_bundle_version
       ) VALUES (
         :id, :workspace_id, :source_map_id, :source_map_asset_id, :derivative_release_id,
         :label, :locality, :browser_manifest_url, :topology_artifact_url,
         :xodr_artifact_id, :xodr_sha256, :coordinate_system_id, :coordinate_system_sha256,
         CAST(:descriptor AS jsonb), :topology_artifact_id, :derived_topology_artifact_id, :locations_artifact_id,
         :signals_artifact_id, :browser_manifest_artifact_id, :thumbnail_artifact_id,
         :asset_catalog_version_id, :sumo_network_sha256, 'uniscenario.map-compiler-bundle/v1'
       ) ON CONFLICT DO NOTHING`,
      {
        id: plan.mapVersionId,
        workspace_id: input.workspaceId,
        source_map_id: input.sourceMapId,
        source_map_asset_id: input.sourceMapAssetId,
        derivative_release_id: input.derivativeReleaseId,
        label: input.label,
        locality: input.locality,
        browser_manifest_url: `uniscenario-browser:${plan.id}/3d/manifest.json`,
        topology_artifact_url: `uniscenario-browser:${plan.id}/topology-index.json.gz`,
        xodr_artifact_id: requiredArtifact("map.xodr"),
        xodr_sha256: digest("map.xodr"),
        coordinate_system_id: COORDINATE_SYSTEM_ID,
        coordinate_system_sha256: COORDINATE_SYSTEM_SHA256,
        descriptor,
        topology_artifact_id: requiredArtifact("topology-index.json.gz"),
        derived_topology_artifact_id: requiredArtifact("derived/topology-derived.json.gz"),
        locations_artifact_id: requiredArtifact("derived/locations.json.gz"),
        signals_artifact_id: requiredArtifact("signals.geojson.gz"),
        browser_manifest_artifact_id: requiredArtifact("3d/manifest.json"),
        thumbnail_artifact_id: thumbnailArtifact.id,
        asset_catalog_version_id: input.assetCatalogVersionId,
        sumo_network_sha256: plan.sumoNetworkSha256,
      },
    );
    const exactMap = await tx.queryRows<IdRow>(
      `SELECT id FROM simforge.map_versions
       WHERE id = :id AND workspace_id = :workspace_id
         AND source_map_id = :source_map_id AND source_map_asset_id = :source_map_asset_id
         AND derivative_release_id = :derivative_release_id AND xodr_sha256 = :xodr_sha256
         AND coordinate_system_sha256 = :coordinate_system_sha256
         AND asset_catalog_version_id = :asset_catalog_version_id
         AND descriptor->>'browserClosureSha256' = :closure_sha256
         AND (:registry_release_digest IS NULL
           OR descriptor->>'registryReleaseDigest' = :registry_release_digest)`,
      {
        id: plan.mapVersionId,
        workspace_id: input.workspaceId,
        source_map_id: input.sourceMapId,
        source_map_asset_id: input.sourceMapAssetId,
        derivative_release_id: input.derivativeReleaseId,
        xodr_sha256: digest("map.xodr"),
        coordinate_system_sha256: COORDINATE_SYSTEM_SHA256,
        registry_release_digest: input.registryReleaseDigest ?? null,
        asset_catalog_version_id: input.assetCatalogVersionId,
        closure_sha256: plan.closureSha256,
      },
    );
    if (exactMap.length !== 1) throw new Error("map_version_identity_conflict");

    const thumbnailBound = await tx.queryRows<IdRow>(
      `UPDATE simforge.map_versions
       SET thumbnail_artifact_id = :thumbnail_artifact_id
       WHERE id = :map_version_id AND workspace_id = :workspace_id
         AND source_map_asset_id = :source_map_asset_id
       RETURNING id`,
      {
        thumbnail_artifact_id: thumbnailArtifact.id,
        map_version_id: plan.mapVersionId,
        workspace_id: input.workspaceId,
        source_map_asset_id: input.sourceMapAssetId,
      },
    );
    if (thumbnailBound.length !== 1) throw new Error("map_thumbnail_binding_failed");

    await tx.batchExecute(
      `INSERT INTO simforge.browser_asset_blobs (
         id, storage_bucket, storage_key, object_version_id, sha256, byte_length,
         media_type, verification_state, verified_at
       ) VALUES (
         :id, :bucket, :storage_key, :object_version_id, :sha256, :byte_length,
         :media_type, 'verified', NOW()
       ) ON CONFLICT (id) DO UPDATE SET
         verification_state = 'verified', verified_at = NOW()
       WHERE browser_asset_blobs.storage_bucket = EXCLUDED.storage_bucket
         AND browser_asset_blobs.storage_key = EXCLUDED.storage_key
         AND browser_asset_blobs.object_version_id IS NOT DISTINCT FROM EXCLUDED.object_version_id
         AND browser_asset_blobs.sha256 = EXCLUDED.sha256
         AND browser_asset_blobs.byte_length = EXCLUDED.byte_length
         AND browser_asset_blobs.media_type = EXCLUDED.media_type`,
      plan.members.map((member) => ({
        id: member.blobId,
        bucket: member.bucket,
        storage_key: member.key,
        object_version_id: member.objectVersionId,
        sha256: member.sha256,
        byte_length: member.byteLength,
        media_type: member.mediaType,
      })),
    );

    await tx.execute(
      `INSERT INTO simforge.browser_asset_sets (
         id, workspace_id, map_version_id, contract_version, closure_sha256,
         object_count, byte_length, asset_set_state, verified_at
       ) VALUES (
         :id, :workspace_id, :map_version_id, :contract_version, :closure_sha256,
         :object_count, :byte_length, 'available', NOW()
       ) ON CONFLICT (workspace_id, map_version_id, closure_sha256) DO NOTHING`,
      {
        id: plan.id,
        workspace_id: input.workspaceId,
        map_version_id: plan.mapVersionId,
        contract_version: plan.contractVersion,
        closure_sha256: plan.closureSha256,
        object_count: plan.objectCount,
        byte_length: plan.byteLength,
      },
    );
    await tx.batchExecute(
      `INSERT INTO simforge.browser_asset_members (asset_set_id, relative_path, blob_id, role, required)
       VALUES (:asset_set_id, :relative_path, :blob_id, :role, :required)
       ON CONFLICT (asset_set_id, relative_path) DO NOTHING`,
      plan.members.map((member) => ({
        asset_set_id: plan.id,
        relative_path: member.relativePath,
        blob_id: member.blobId,
        role: member.role,
        required: member.required,
      })),
    );

    const counts = await tx.queryOne<ClosureCountRow>(
      `SELECT COUNT(*)::int AS object_count, COALESCE(SUM(b.byte_length), 0)::bigint AS byte_length
       FROM simforge.browser_asset_members m
       JOIN simforge.browser_asset_blobs b ON b.id = m.blob_id AND b.verification_state = 'verified'
       WHERE m.asset_set_id = :asset_set_id`,
      { asset_set_id: plan.id },
    );
    if (
      Number(counts?.object_count) !== plan.objectCount ||
      Number(counts?.byte_length) !== plan.byteLength
    ) {
      throw new Error("browser_asset_set_closure_mismatch");
    }

    if (input.nativePlan) {
      const nativePlan = input.nativePlan;
      await tx.batchExecute(
        `INSERT INTO simforge.native_map_asset_blobs (
           id, storage_bucket, storage_key, object_version_id, sha256, byte_length,
           media_type, verification_state, verified_at
         ) VALUES (
           :id, :bucket, :storage_key, :object_version_id, :sha256, :byte_length,
           :media_type, 'verified', NOW()
         ) ON CONFLICT (id) DO UPDATE SET
           verification_state = 'verified', verified_at = NOW()
         WHERE native_map_asset_blobs.storage_bucket = EXCLUDED.storage_bucket
           AND native_map_asset_blobs.storage_key = EXCLUDED.storage_key
           AND native_map_asset_blobs.object_version_id IS NOT DISTINCT FROM EXCLUDED.object_version_id
           AND native_map_asset_blobs.sha256 = EXCLUDED.sha256
           AND native_map_asset_blobs.byte_length = EXCLUDED.byte_length
           AND native_map_asset_blobs.media_type = EXCLUDED.media_type`,
        nativePlan.members.map((member) => ({
          id: member.blobId,
          bucket: member.bucket,
          storage_key: member.key,
          object_version_id: member.objectVersionId,
          sha256: member.sha256,
          byte_length: member.byteLength,
          media_type: member.mediaType,
        })),
      );
      await tx.execute(
        `INSERT INTO simforge.native_map_asset_sets (
           id, workspace_id, map_version_id, contract_version, closure_sha256,
           registry_release_digest, canonical_digest, object_count, byte_length,
           asset_set_state
         ) VALUES (
           :id, :workspace_id, :map_version_id, :contract_version, :closure_sha256,
           :registry_release_digest, :canonical_digest, :object_count, :byte_length,
           'building'
         ) ON CONFLICT (workspace_id, map_version_id, registry_release_digest) DO NOTHING`,
        {
          id: nativePlan.id,
          workspace_id: nativePlan.workspaceId,
          map_version_id: nativePlan.mapVersionId,
          contract_version: nativePlan.contractVersion,
          closure_sha256: nativePlan.closureSha256,
          registry_release_digest: nativePlan.registryReleaseDigest,
          canonical_digest: nativePlan.canonicalDigest,
          object_count: nativePlan.objectCount,
          byte_length: nativePlan.byteLength,
        },
      );
      await tx.batchExecute(
        `INSERT INTO simforge.native_map_asset_members (
           asset_set_id, relative_path, blob_id, role, required
         ) VALUES (
           :asset_set_id, :relative_path, :blob_id, :role, :required
         ) ON CONFLICT (asset_set_id, relative_path) DO NOTHING`,
        nativePlan.members.map((member) => ({
          asset_set_id: nativePlan.id,
          relative_path: member.relativePath,
          blob_id: member.blobId,
          role: member.role,
          required: member.required,
        })),
      );
      const nativeCounts = await tx.queryOne<ClosureCountRow>(
        `SELECT COUNT(*)::int AS object_count,
           COALESCE(SUM(b.byte_length), 0)::bigint AS byte_length
         FROM simforge.native_map_asset_members m
         JOIN simforge.native_map_asset_blobs b
           ON b.id = m.blob_id AND b.verification_state = 'verified'
         WHERE m.asset_set_id = :asset_set_id`,
        { asset_set_id: nativePlan.id },
      );
      if (
        Number(nativeCounts?.object_count) !== nativePlan.objectCount ||
        Number(nativeCounts?.byte_length) !== nativePlan.byteLength
      ) {
        throw new Error("native_map_asset_set_closure_mismatch");
      }
      const nativeBound = await tx.queryRows<IdRow>(
        `UPDATE simforge.map_versions SET native_map_asset_set_id = :asset_set_id
         WHERE id = :map_version_id AND workspace_id = :workspace_id
           AND (native_map_asset_set_id IS NULL OR native_map_asset_set_id = :asset_set_id)
         RETURNING id`,
        {
          asset_set_id: nativePlan.id,
          map_version_id: nativePlan.mapVersionId,
          workspace_id: nativePlan.workspaceId,
        },
      );
      if (nativeBound.length !== 1) {
        throw new Error("map_version_already_bound_to_different_native_closure");
      }
      const nativeAvailable = await tx.queryRows<IdRow>(
        `UPDATE simforge.native_map_asset_sets
         SET asset_set_state = 'available', verified_at = NOW()
         WHERE id = :asset_set_id AND workspace_id = :workspace_id
           AND map_version_id = :map_version_id
           AND closure_sha256 = :closure_sha256
           AND registry_release_digest = :registry_release_digest
           AND canonical_digest = :canonical_digest
         RETURNING id`,
        {
          asset_set_id: nativePlan.id,
          workspace_id: nativePlan.workspaceId,
          map_version_id: nativePlan.mapVersionId,
          closure_sha256: nativePlan.closureSha256,
          registry_release_digest: nativePlan.registryReleaseDigest,
          canonical_digest: nativePlan.canonicalDigest,
        },
      );
      if (nativeAvailable.length !== 1) throw new Error("native_map_asset_set_identity_conflict");
    }

    const bound = await tx.queryRows<IdRow>(
      `UPDATE simforge.map_versions SET browser_asset_set_id = :asset_set_id
       WHERE id = :map_version_id AND workspace_id = :workspace_id
         AND (browser_asset_set_id IS NULL OR browser_asset_set_id = :asset_set_id)
       RETURNING id`,
      {
        asset_set_id: plan.id,
        map_version_id: plan.mapVersionId,
        workspace_id: input.workspaceId,
      },
    );
    if (bound.length !== 1) {
      throw new Error("map_version_already_bound_to_different_closure");
    }

    return {
      mapVersionId: plan.mapVersionId,
      label: input.label,
      locality: input.locality,
      sourceMapId: input.sourceMapId,
      closureSha256: plan.closureSha256,
      objectCount: plan.objectCount,
      byteLength: plan.byteLength,
      browserOnly: input.carlaMapName === null,
      generated: {
        laneCount: input.mapIntel.laneCount,
        junctionCount: input.mapIntel.junctionCount,
        locationCount: input.mapIntel.locationCount,
        triangleCount: input.triangleCount,
        roadwayConsistencyVerdict: input.mapIntel.roadwayConsistency.verdict,
      },
    };
  });
}
