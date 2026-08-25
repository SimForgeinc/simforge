import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { MapCoordinateRefSchema, MapImageryTilesetSchema } from "@simforge/studio-shared";
import type { MapAsset, MapAssetArtifact, MapAssetArtifactType, MapPlaceContext } from "@simforge/studio-shared";
import { z } from "zod";
import { MapAssetIdParams, UpdateMapAssetResponse } from "@/app/lib/api-schemas";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import {
  deleteMapAssetById,
  getMapAssetByIdFromDb,
  upsertMapAsset,
} from "@/app/lib/db/map-asset-store";
import { getMapAssetById } from "@/app/lib/map-assets";
import {
  FLYBY_PREVIEW_ARTIFACT_TYPE,
  flybyPreviewKeyForOriginalKey,
} from "@/app/lib/maps/flyby-preview";
import {
  directUploadRequiredPayload,
  shouldRejectDirectMultipartUpload,
} from "@/app/lib/serverless-upload-guard";
void MapAssetIdParams;
void UpdateMapAssetResponse;

import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import { putS3Object } from "@/app/lib/s3/s3-put-object";
import { listS3Keys, deleteS3Keys } from "@/app/lib/s3/s3-delete";

const BUCKET = S3_BUCKET;

function artifactTypeFromExtension(filename: string): MapAssetArtifactType {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (ext === "mp4") return "mp4";
  if (ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp") return "image";
  return "image";
}

function formatTimestamp(d: Date): string {
  const y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}${M}${D}-${h}${m}${s}`;
}

async function uploadToS3(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  await putS3Object(BUCKET, key, buffer, contentType);
  return `s3://${BUCKET}/${key}`;
}

type Params = { params: Promise<{ mapAssetId: string }> };

/**
 * Update a map asset
 * @description Updates tags and/or appends new media artifacts (mp4, image). Metadata is persisted in Aurora.
 * @pathParams MapAssetIdParams
 * @contentType application/json or multipart/form-data
 * @response 200:UpdateMapAssetResponse
 * @responseSet common
 * @add 404
 * @tag Map assets
 * @openapi
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const auth = await requireRouteSession(request);
    if (!auth.ok) return auth.response;

    const { mapAssetId } = await params;

    const existing = await getMapAssetById(mapAssetId);

    if (!existing) {
      return NextResponse.json({ error: "Map asset not found" }, { status: 404 });
    }
    let updatedTags = existing.tags;
    let updatedArtifacts: MapAssetArtifact[] = existing.artifacts ?? [];
    let updatedPlaceContext = existing.place_context;
    let updatedMapCoordinateRef = existing.map_coordinate_ref;
    let updatedCarlaMapName = existing.carla_map_name;
    let updatedImageryTilesets = existing.imagery_tilesets;
    let placeContextUpdated = false;
    let mapCoordinateRefUpdated = false;
    let carlaMapNameUpdated = false;
    let imageryTilesetsUpdated = false;

    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      // JSON body: tags, deleteArtifactUris, newArtifacts (from presigned upload flow; no file bytes)
      const body = await request.json();
      const deleteUrisSet = body.deleteArtifactUris
        ? new Set<string>(body.deleteArtifactUris as string[])
        : new Set<string>();
      updatedArtifacts = (existing.artifacts ?? []).filter((a) => !deleteUrisSet.has(a.uri));

      if (body.tags != null) {
        const tags = body.tags as string[];
        updatedTags = Array.isArray(tags) && tags.length > 0 ? tags : undefined;
      }

      const newArtifactsRaw = body.newArtifacts as Array<{ key: string; artifact_type: MapAssetArtifactType; sha256: string; label?: string; size_bytes?: number }> | undefined;
      if (Array.isArray(newArtifactsRaw) && newArtifactsRaw.length > 0) {
        const appended: MapAssetArtifact[] = newArtifactsRaw.map((a) => {
          const uri = `s3://${BUCKET}/${a.key}`;
          const artifact: MapAssetArtifact = { artifact_type: a.artifact_type, uri, sha256: a.sha256 };
          if (a.label?.trim()) artifact.label = a.label.trim();
          if (a.size_bytes != null) artifact.size_bytes = a.size_bytes;
          return artifact;
        });
        updatedArtifacts = [...updatedArtifacts, ...appended];
      }

      // Optional place_context override: accepts { city, state, country, country_code } or null (to clear).
      if ("placeContext" in body) {
        const pc = body.placeContext as MapPlaceContext | null | undefined;
        updatedPlaceContext = pc ?? undefined;
        placeContextUpdated = true;
      }

      if ("mapCoordinateRef" in body) {
        const parsed = body.mapCoordinateRef == null
          ? { success: true as const, data: undefined }
          : MapCoordinateRefSchema.safeParse(body.mapCoordinateRef);
        if (!parsed.success) {
          return NextResponse.json({ error: "Invalid mapCoordinateRef payload" }, { status: 400 });
        }
        updatedMapCoordinateRef = parsed.data;
        mapCoordinateRefUpdated = true;
      }

      if ("carlaMapName" in body) {
        const raw = body.carlaMapName;
        if (raw != null && typeof raw !== "string") {
          return NextResponse.json({ error: "carlaMapName must be a string or null" }, { status: 400 });
        }
        updatedCarlaMapName = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
        carlaMapNameUpdated = true;
      }

      if ("imageryTilesets" in body) {
        const parsed = body.imageryTilesets == null
          ? { success: true as const, data: undefined }
          : z.array(MapImageryTilesetSchema).safeParse(body.imageryTilesets);
        if (!parsed.success) {
          return NextResponse.json(
            { error: "imageryTilesets must be an array of { tileset_id, layer_id } or null" },
            { status: 400 },
          );
        }
        // Drop rows missing either id and trim; empty list clears imagery.
        const cleaned = (parsed.data ?? [])
          .map((t) => ({ tileset_id: t.tileset_id.trim(), layer_id: t.layer_id.trim() }))
          .filter((t) => t.tileset_id.length > 0 && t.layer_id.length > 0);
        updatedImageryTilesets = cleaned.length > 0 ? cleaned : undefined;
        imageryTilesetsUpdated = true;
      }
    } else {
      // FormData (legacy; subject to body size limit)
      if (shouldRejectDirectMultipartUpload()) {
        return NextResponse.json(
          directUploadRequiredPayload("map_asset_media"),
          { status: 409 },
        );
      }
      const formData = await request.formData();
      const tagsRaw = formData.get("tags") as string | null;
      const labelsRaw = formData.get("labels") as string | null;
      const deleteArtifactUrisRaw = formData.get("deleteArtifactUris") as string | null;
      const mediaFiles = formData.getAll("mediaFiles") as File[];

      const deleteUrisSet = deleteArtifactUrisRaw
        ? new Set<string>(JSON.parse(deleteArtifactUrisRaw) as string[])
        : new Set<string>();
      updatedArtifacts = (existing.artifacts ?? []).filter((a) => !deleteUrisSet.has(a.uri));

      if (tagsRaw !== null) {
        const tags: string[] = JSON.parse(tagsRaw);
        updatedTags = tags.length > 0 ? tags : undefined;
      }

      if (mediaFiles.length > 0) {
        const labels: string[] = labelsRaw ? JSON.parse(labelsRaw) : [];
        const timestamp = formatTimestamp(new Date());
        const newArtifacts: MapAssetArtifact[] = [];

        for (let i = 0; i < mediaFiles.length; i++) {
          const file = mediaFiles[i];
          if (!(file instanceof File) || file.size === 0) continue;

          const buffer = Buffer.from(await file.arrayBuffer());
          const sha256 = createHash("sha256").update(buffer).digest("hex");
          const artifactType = artifactTypeFromExtension(file.name);
          const ext = file.name.split(".").pop()?.toLowerCase() ?? (artifactType === "mp4" ? "mp4" : "jpg");
          const key = `maps/${mapAssetId}/${mapAssetId}-${artifactType}-${timestamp}-${i}.${ext}`;

          const contentTypeMap: Record<string, string> = {
            mp4: "video/mp4",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            webp: "image/webp",
          };
          const fileContentType = contentTypeMap[ext] ?? file.type ?? "application/octet-stream";
          const uri = await uploadToS3(key, buffer, fileContentType);

          const artifact: MapAssetArtifact = { artifact_type: artifactType, uri, sha256, size_bytes: file.size };
          const label = labels[i]?.trim();
          if (label) artifact.label = label;
          newArtifacts.push(artifact);
        }

        updatedArtifacts = [...updatedArtifacts, ...newArtifacts];
      }
    }

    // Auto-clean generated fly-by previews whose source video is no longer
    // present (the fly-by mp4 was deleted or replaced in this update). Dropping
    // them from the artifact list means the removed-artifact S3 cleanup below
    // also purges the preview object, and upsertMapAsset's reconciliation
    // removes the DB row. New fly-by uploads get a fresh preview from the
    // map-flyby-preview Lambda.
    {
      const keyOf = (uri: string) => uri.replace(/^s3:\/\/[^/]+\//, "");
      const expectedPreviewKeys = new Set(
        updatedArtifacts
          .filter((a) => a.artifact_type === "mp4")
          .map((a) => flybyPreviewKeyForOriginalKey(keyOf(a.uri))),
      );
      updatedArtifacts = updatedArtifacts.filter(
        (a) =>
          a.artifact_type !== FLYBY_PREVIEW_ARTIFACT_TYPE ||
          expectedPreviewKeys.has(keyOf(a.uri)),
      );
    }

    // Determine which artifacts were removed so we can delete from S3.
    const updatedUris = new Set(updatedArtifacts.map((a) => a.uri));
    const removedArtifacts = (existing.artifacts ?? []).filter((a) => !updatedUris.has(a.uri));

    const updatedAsset: MapAsset = {
      ...existing,
      tags: updatedTags,
      artifacts: updatedArtifacts,
      ...(placeContextUpdated ? { place_context: updatedPlaceContext } : {}),
      ...(mapCoordinateRefUpdated ? { map_coordinate_ref: updatedMapCoordinateRef } : {}),
      ...(carlaMapNameUpdated ? { carla_map_name: updatedCarlaMapName } : {}),
      ...(imageryTilesetsUpdated ? { imagery_tilesets: updatedImageryTilesets } : {}),
    };

    await upsertMapAsset(updatedAsset);

    // Delete removed artifacts from S3 (best-effort, after DB commit)
    if (removedArtifacts.length > 0) {
      const s3KeysToDelete = removedArtifacts
        .map((a) => a.uri.replace(/^s3:\/\/[^/]+\//, ""))
        .filter(Boolean);
      if (s3KeysToDelete.length > 0) {
        await deleteS3Keys(s3KeysToDelete).catch((err) => {
          console.error("Failed to delete S3 artifacts (orphaned):", err);
        });
      }

      // If a 3d_manifest artifact was removed, purge the entire 3d/ folder
      // because tile files are not individually tracked as artifact rows.
      // Best-effort: failures must not surface as 500 since the DB is already committed.
      const removed3d = removedArtifacts.some(
        (a) => a.artifact_type === "3d_manifest",
      );
      if (removed3d) {
        try {
          const prefix3d = `maps/${mapAssetId}/3d/`;
          const allKeys3d = await listS3Keys(prefix3d);
          if (allKeys3d.length > 0) {
            await deleteS3Keys(allKeys3d);
          }
        } catch (err) {
          console.error("Failed to delete 3D folder from S3:", err);
        }
      }
    }

    return NextResponse.json({ mapAssetId });
  } catch (e) {
    const err = e as { name?: string };
    if (err?.name === "CredentialsProviderError" || String(e).includes("Could not load credentials")) {
      return NextResponse.json(
        {
          error: "S3 credentials not configured",
          detail: "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and optionally AWS_REGION) in your environment or .env.local.",
        },
        { status: 503 }
      );
    }
    console.error("map-assets PATCH error:", e);
    return NextResponse.json({ error: "Failed to update map asset" }, { status: 500 });
  }
}

/**
 * Permanently delete a map asset: all S3 objects under `maps/{mapAssetId}/`, DB row (stats and artifact rows cascade).
 * Requires JSON body `{ confirmEmail }` matching the signed-in user's email (case-insensitive).
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const confirmEmail =
    typeof body === "object" &&
    body !== null &&
    "confirmEmail" in body &&
    typeof (body as { confirmEmail: unknown }).confirmEmail === "string"
      ? (body as { confirmEmail: string }).confirmEmail
      : "";

  if (!confirmEmail.trim()) {
    return NextResponse.json(
      { error: "confirmEmail is required and must match your signed-in email address." },
      { status: 400 },
    );
  }

  const expectedEmail = auth.session.email?.trim() || null;
  if (!expectedEmail) {
    return NextResponse.json(
      {
        error:
          "Your account has no email address on file. Please update your account settings before deleting maps.",
      },
      { status: 400 },
    );
  }

  if (confirmEmail.trim().toLowerCase() !== expectedEmail.toLowerCase()) {
    return NextResponse.json(
      { error: "Confirmation does not match your signed-in email address." },
      { status: 403 },
    );
  }

  const { mapAssetId } = await params;
  const existing = await getMapAssetByIdFromDb(mapAssetId);
  if (!existing) {
    return NextResponse.json({ error: "Map asset not found" }, { status: 404 });
  }

  try {
    const prefix = `maps/${mapAssetId}/`;
    const keys = await listS3Keys(prefix);
    await deleteS3Keys(keys);
    await deleteMapAssetById(mapAssetId);
    return NextResponse.json({
      ok: true,
      mapAssetId,
      deletedS3Objects: keys.length,
    });
  } catch (e) {
    const err = e as { name?: string };
    if (err?.name === "CredentialsProviderError" || String(e).includes("Could not load credentials")) {
      return NextResponse.json(
        {
          error: "S3 credentials not configured",
          detail:
            "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and optionally AWS_REGION) in your environment or .env.local.",
        },
        { status: 503 },
      );
    }
    console.error("map-assets DELETE error:", e);
    return NextResponse.json({ error: "Failed to delete map asset" }, { status: 500 });
  }
}
