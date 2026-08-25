/**
 * Deferred optimization of an already-published map version.
 *
 * The expensive texture work (`gltf-transform uastc`, which shells out to the
 * digest-pinned native KTX binary) cannot run in a route, so an operator runs it
 * locally and submits the resulting closure here. This module owns the rules that
 * make such a submission safe.
 *
 * The shape of an optimize pass, and why it is a new version rather than an edit:
 * a published closure is immutable — its digest is what the editor caches by, and
 * `browser_asset_set_id` binds once. `simforge.map_versions` is unique on
 * `(workspace_id, source_map_asset_id, derivative_release_id)` precisely so an
 * optimized rebuild can be published *alongside* the original instead of
 * repointing it, and the editor's descriptor query already prefers the newest
 * publication per source map. Scenarios are unaffected because
 * `simforge.documents.map_version_id` pins the exact version they were
 * authored against.
 *
 * An optimize pass may only add or replace files under `3d/variants/`. It must
 * not touch the road network, the city manifest or the derived artifacts, because
 * it does not re-derive them — the new version carries the source version's
 * descriptor forward verbatim.
 */
import { z } from "zod";

import { queryOne, queryRows } from "@/app/lib/db/data-api";

import type { PublishedMapIntel } from "./publication";

const CarriedDescriptorSchema = z.object({
  mapIntel: z.object({
    contractVersion: z.string().min(1),
    builder: z.object({ package: z.string().min(1), version: z.string().min(1) }),
    mapId: z.string().min(1),
    catalogRevision: z.string().min(1),
    sourceHashes: z.record(z.string(), z.string()),
    outputs: z.record(z.string(), z.unknown()),
    receiptSha256: z.string().regex(/^[0-9a-f]{64}$/),
    laneCount: z.number().int().nonnegative(),
    junctionCount: z.number().int().nonnegative(),
    locationCount: z.number().int().nonnegative(),
    triangleCount: z.number().int().nonnegative(),
  }),
  roadwayConsistency: z.object({
    format: z.string().min(1),
    validatorVersion: z.string().min(1),
    verdict: z.string().min(1),
    stats: z.record(z.string(), z.unknown()),
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sourceDigests: z.object({
      xodrSha256: z.string().regex(/^[0-9a-f]{64}$/),
      topologySha256: z.string().regex(/^[0-9a-f]{64}$/),
      sourceRoadGeometrySha256: z.string().regex(/^[0-9a-f]{64}$/),
      finalRoadSha256: z.string().regex(/^[0-9a-f]{64}$/),
      roadAuditSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  }),
});

/** Only the identity fields matter here; the server assigns storage locations. */
export type SubmittedClosureMember = {
  relativePath: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
};

/** Paths an optimize pass is allowed to introduce or replace. */
const OPTIMIZABLE_PREFIX = "3d/variants/";

export type OptimizationSourceMember = {
  relativePath: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  required: boolean;
};

export type OptimizationSource = {
  mapVersionId: string;
  workspaceId: string;
  sourceMapId: string;
  sourceMapAssetId: string;
  label: string;
  locality: string;
  carlaMapName: string | null;
  assetCatalogVersionId: string;
  descriptor: Record<string, unknown>;
  closureSha256: string;
  members: OptimizationSourceMember[];
  /** The draft whose publication produced this version; the artifact producer. */
  draftId: string;
  thumbnail: {
    bucket: string;
    key: string;
    sha256: string;
    byteLength: number;
    mediaType: string;
  };
};

type SourceRow = {
  id: string;
  workspace_id: string;
  source_map_id: string;
  source_map_asset_id: string | null;
  label: string;
  locality: string;
  asset_catalog_version_id: string;
  descriptor: string;
  closure_sha256: string;
  draft_id: string | null;
  carla_map_name: string | null;
  thumbnail_bucket: string | null;
  thumbnail_key: string | null;
  thumbnail_sha256: string | null;
  thumbnail_byte_length: number | null;
  thumbnail_media_type: string | null;
};

type MemberRow = {
  relative_path: string;
  sha256: string;
  byte_length: number;
  media_type: string;
  required: boolean;
};

export class OptimizationSourceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OptimizationSourceError";
    this.status = status;
  }
}

export async function loadOptimizationSource(
  mapVersionId: string,
  workspaceId: string,
): Promise<OptimizationSource> {
  const row = await queryOne<SourceRow>(
    `SELECT mv.id, mv.workspace_id, mv.source_map_id, mv.source_map_asset_id, mv.label,
            mv.locality, mv.asset_catalog_version_id, mv.descriptor::text AS descriptor,
            bs.closure_sha256, d.id AS draft_id, ma.carla_map_name,
            thumb.storage_bucket AS thumbnail_bucket, thumb.storage_key AS thumbnail_key,
            thumb.sha256 AS thumbnail_sha256, thumb.byte_length AS thumbnail_byte_length,
            thumb.media_type AS thumbnail_media_type
       FROM simforge.map_versions mv
       JOIN simforge.browser_asset_sets bs
         ON bs.id = mv.browser_asset_set_id AND bs.asset_set_state = 'available'
       LEFT JOIN simforge.map_upload_drafts d
         ON d.map_version_id = mv.id AND d.workspace_id = mv.workspace_id
       LEFT JOIN public.map_assets ma ON ma.id = mv.source_map_asset_id
       LEFT JOIN simforge.artifacts thumb ON thumb.id = mv.thumbnail_artifact_id
      WHERE mv.id = :map_version_id AND mv.workspace_id = :workspace_id
        AND mv.retired_at IS NULL
      LIMIT 1`,
    { map_version_id: mapVersionId, workspace_id: workspaceId },
  );
  if (!row) throw new OptimizationSourceError(`map version ${mapVersionId} is not available`, 404);
  if (!row.source_map_asset_id) {
    throw new OptimizationSourceError(`map version ${mapVersionId} has no source map asset`, 409);
  }
  if (!row.draft_id) {
    // Every artifact needs a `map_publication` producer that resolves against
    // simforge.map_upload_drafts. A version published by the operator seed
    // script has no draft, so it cannot be optimized through this route until
    // that path gets a producer of its own.
    throw new OptimizationSourceError(
      `map version ${mapVersionId} was not published from an upload, so it has no producer to attribute an optimization to`,
      409,
    );
  }
  if (!row.thumbnail_bucket || !row.thumbnail_key || !row.thumbnail_sha256
    || row.thumbnail_byte_length === null || !row.thumbnail_media_type) {
    throw new OptimizationSourceError(`map version ${mapVersionId} has no bound thumbnail`, 409);
  }

  const members = await queryRows<MemberRow>(
    `SELECT bm.relative_path, bb.sha256, bb.byte_length, bb.media_type, bm.required
       FROM simforge.browser_asset_members bm
       JOIN simforge.browser_asset_sets bs ON bs.id = bm.asset_set_id
       JOIN simforge.browser_asset_blobs bb ON bb.id = bm.blob_id
      WHERE bs.map_version_id = :map_version_id AND bs.asset_set_state = 'available'
        AND bb.verification_state = 'verified'
      ORDER BY bm.relative_path`,
    { map_version_id: mapVersionId },
  );
  if (members.length === 0) {
    throw new OptimizationSourceError(`map version ${mapVersionId} has no verified closure members`, 409);
  }

  const descriptor: unknown = JSON.parse(row.descriptor);
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new OptimizationSourceError(`map version ${mapVersionId} has a malformed descriptor`, 409);
  }

  return {
    mapVersionId: row.id,
    workspaceId: row.workspace_id,
    sourceMapId: row.source_map_id,
    sourceMapAssetId: row.source_map_asset_id,
    label: row.label,
    locality: row.locality,
    carlaMapName: row.carla_map_name,
    assetCatalogVersionId: row.asset_catalog_version_id,
    descriptor: { ...descriptor },
    closureSha256: row.closure_sha256,
    draftId: row.draft_id,
    thumbnail: {
      bucket: row.thumbnail_bucket,
      key: row.thumbnail_key,
      sha256: row.thumbnail_sha256,
      byteLength: Number(row.thumbnail_byte_length),
      mediaType: row.thumbnail_media_type,
    },
    members: members.map((member) => ({
      relativePath: member.relative_path,
      sha256: member.sha256,
      byteLength: Number(member.byte_length),
      mediaType: member.media_type,
      required: member.required,
    })),
  };
}

export type OptimizationDelta = {
  added: string[];
  replaced: string[];
  unchanged: string[];
};

/**
 * Prove the submitted closure is the source closure plus variant work.
 *
 * Anything outside `3d/variants/` must be present with the identical digest.
 * Dropping or rewriting the road network, the manifest or a derived artifact
 * would silently produce a map whose descriptor — carried forward unchanged —
 * describes bytes that are no longer there.
 */
export function diffOptimizedClosure(
  source: readonly OptimizationSourceMember[],
  submitted: readonly SubmittedClosureMember[],
): OptimizationDelta {
  const sourceByPath = new Map(source.map((member) => [member.relativePath, member]));
  const submittedByPath = new Map(submitted.map((member) => [member.relativePath, member]));

  for (const member of source) {
    if (member.relativePath.startsWith(OPTIMIZABLE_PREFIX)) continue;
    const match = submittedByPath.get(member.relativePath);
    if (!match) {
      throw new OptimizationSourceError(
        `optimized closure drops ${member.relativePath}, which an optimization may not change`,
        422,
      );
    }
    if (match.sha256 !== member.sha256 || match.byteLength !== member.byteLength) {
      throw new OptimizationSourceError(
        `optimized closure changes ${member.relativePath}, which an optimization may not change`,
        422,
      );
    }
  }

  const added: string[] = [];
  const replaced: string[] = [];
  const unchanged: string[] = [];
  for (const member of submitted) {
    const existing = sourceByPath.get(member.relativePath);
    if (!existing) {
      if (!member.relativePath.startsWith(OPTIMIZABLE_PREFIX)) {
        throw new OptimizationSourceError(
          `optimized closure adds ${member.relativePath} outside ${OPTIMIZABLE_PREFIX}`,
          422,
        );
      }
      added.push(member.relativePath);
    } else if (existing.sha256 !== member.sha256) {
      replaced.push(member.relativePath);
    } else {
      unchanged.push(member.relativePath);
    }
  }
  if (added.length === 0 && replaced.length === 0) {
    throw new OptimizationSourceError("optimized closure is identical to the published one", 409);
  }
  return {
    added: added.sort(),
    replaced: replaced.sort(),
    unchanged: unchanged.sort(),
  };
}

/**
 * The new version's descriptor is the source's, with only the closure digest and
 * the optimization provenance moved on. An optimize pass re-derives nothing, so
 * copying the map-intel receipt, the roadway-consistency verdict and every
 * artifact digest verbatim is the honest record of what happened.
 */
export function carryDescriptorForward({
  descriptor,
  closureSha256,
  releaseSuffix,
  sourceMapVersionId,
}: {
  descriptor: Record<string, unknown>;
  closureSha256: string;
  releaseSuffix: string;
  sourceMapVersionId: string;
}): Record<string, unknown> {
  return {
    ...descriptor,
    browserClosureSha256: closureSha256,
    optimization: {
      contractVersion: "uniscenario.map-optimization/v1",
      releaseSuffix,
      optimizedFromMapVersionId: sourceMapVersionId,
    },
  };
}

/**
 * Recover the publish inputs an optimization must restate from the source
 * version's descriptor.
 *
 * An optimization re-derives nothing, so these values must come from the record
 * of the publication that did derive them. They are validated rather than
 * assumed: a descriptor written before these fields existed would otherwise
 * publish a version claiming zero lanes.
 */
export function carriedPublishInputs(descriptor: Record<string, unknown>): {
  mapIntel: PublishedMapIntel;
  triangleCount: number;
} {
  const parsed = CarriedDescriptorSchema.safeParse(descriptor);
  if (!parsed.success) {
    throw new OptimizationSourceError(
      "source map version predates optimization support: its descriptor has no recorded map-intel counts, "
        + "so republish it from the Assets page before optimizing",
      409,
    );
  }
  const { mapIntel, roadwayConsistency } = parsed.data;
  return {
    triangleCount: mapIntel.triangleCount,
    mapIntel: {
      contractVersion: mapIntel.contractVersion,
      builder: mapIntel.builder,
      mapId: mapIntel.mapId,
      catalogRevision: mapIntel.catalogRevision,
      sourceHashes: mapIntel.sourceHashes,
      outputs: mapIntel.outputs,
      receiptSha256: mapIntel.receiptSha256,
      laneCount: mapIntel.laneCount,
      junctionCount: mapIntel.junctionCount,
      locationCount: mapIntel.locationCount,
      roadwayConsistency,
    },
  };
}
