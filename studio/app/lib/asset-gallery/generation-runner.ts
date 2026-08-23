import { createHash } from "node:crypto";
import { GALLERY_MAX_GLB_BYTES } from "./contracts";
import { GALLERY_MAX_REFERENCE_IMAGE_BYTES } from "./generation-contracts";
import { readGlbMetadata, referenceThumbnailToWebp } from "./glb-metadata";
import {
  claimGalleryGenerationImport,
  loadGalleryGenerationRecord,
  markGalleryGenerationFailed,
  markGalleryGenerationProgress,
  publishGeneratedGalleryAsset,
} from "./generation-store";
import {
  generatedGalleryObjectKeys,
  uploadGeneratedGalleryObjects,
} from "./generation-storage";
import {
  downloadMeshyArtifact,
  fetchMeshyTask,
  MeshyArtifactTooLargeError,
  MeshyUnavailableError,
} from "../meshy/client";
import type { MeshyTask } from "../meshy/client";

const IMPORT_LEASE_SECONDS = 60;

function providerFailureCode(error: string | null): "moderation_rejected" | "provider_failed" {
  return error && /moderation|content\s*(?:policy|screen)|safety|unsafe/i.test(error)
    ? "moderation_rejected"
    : "provider_failed";
}

/**
 * Move one provider-backed generation as far forward as this invocation safely can.
 *
 * Polling requests are only a source of execution time, not ownership. The database
 * import lease is the authority, so overlapping tabs can never publish twice.
 */
export async function advanceGalleryGeneration(generationId: string): Promise<void> {
  const generation = await loadGalleryGenerationRecord(generationId);
  if (
    !generation ||
    (generation.state !== "generating" && generation.state !== "importing") ||
    !generation.providerTaskId
  ) {
    return;
  }

  let task: MeshyTask;
  try {
    task = await fetchMeshyTask(generation.providerTaskId);
  } catch (error) {
    if (error instanceof MeshyUnavailableError) return;
    await markGalleryGenerationFailed(generationId, "provider_failed", String(error));
    return;
  }

  if (task.status === "PENDING" || task.status === "IN_PROGRESS") {
    await markGalleryGenerationProgress(generationId, task.progress, task.thumbnailUrl);
    return;
  }
  if (task.status === "FAILED" || task.status === "CANCELED") {
    await markGalleryGenerationFailed(
      generationId,
      providerFailureCode(task.error),
      task.error,
    );
    return;
  }
  if (!task.glbUrl || !task.thumbnailUrl) {
    await markGalleryGenerationFailed(
      generationId,
      "provider_failed",
      "Meshy reported success without complete artifact URLs",
    );
    return;
  }

  if (!(await claimGalleryGenerationImport(generationId, IMPORT_LEASE_SECONDS))) return;

  let glb: Uint8Array;
  try {
    glb = await downloadMeshyArtifact(task.glbUrl, GALLERY_MAX_GLB_BYTES);
  } catch (error) {
    if (error instanceof MeshyArtifactTooLargeError) {
      await markGalleryGenerationFailed(generationId, "model_too_large", error.message);
      return;
    }
    // Provider artifact URLs are refreshed by fetching the task again. A transient
    // download outage therefore releases naturally with the lease instead of
    // destroying a generation whose model has already succeeded.
    if (error instanceof MeshyUnavailableError) return;
    await markGalleryGenerationFailed(generationId, "provider_failed", String(error));
    return;
  }

  let thumbnailSource: Uint8Array;
  try {
    thumbnailSource = await downloadMeshyArtifact(
      task.thumbnailUrl,
      GALLERY_MAX_REFERENCE_IMAGE_BYTES,
    );
  } catch (error) {
    if (error instanceof MeshyUnavailableError) return;
    await markGalleryGenerationFailed(
      generationId,
      "import_failed",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  let metadata;
  let thumbnail: Uint8Array;
  try {
    metadata = readGlbMetadata(glb);
    thumbnail = await referenceThumbnailToWebp(thumbnailSource);
  } catch (error) {
    await markGalleryGenerationFailed(
      generationId,
      "import_failed",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const modelSha256 = createHash("sha256").update(glb).digest("hex");
  const thumbnailSha256 = createHash("sha256").update(thumbnail).digest("hex");
  const { modelKey, thumbnailKey } = generatedGalleryObjectKeys(generationId, {
    modelSha256,
    thumbnailSha256,
  });

  try {
    await uploadGeneratedGalleryObjects({
      model: { key: modelKey, bytes: glb },
      thumbnail: { key: thumbnailKey, bytes: thumbnail },
    });
    await publishGeneratedGalleryAsset({
      generationId,
      metadata,
      glb: { key: modelKey, sha256: modelSha256, byteLength: glb.byteLength },
      thumbnail: {
        key: thumbnailKey,
        sha256: thumbnailSha256,
        byteLength: thumbnail.byteLength,
      },
    });
  } catch (error) {
    await markGalleryGenerationFailed(
      generationId,
      "import_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
