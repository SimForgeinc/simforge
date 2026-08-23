/**
 * Fly-by preview artifact helpers.
 *
 * A fly-by video is uploaded as an `mp4` artifact under
 * `maps/{mapAssetId}/{name}.mp4`. The map-flyby-preview Lambda (S3-triggered)
 * transcodes a low-res, short, muted clip and stores it as an `mp4_preview`
 * artifact under `maps/{mapAssetId}/previews/{name}.preview.mp4`.
 *
 * The key derivation here MUST stay byte-for-byte identical to the copy in
 * `infra/lambdas/map-flyby-preview/src/keys.ts`, because the web edit flow uses
 * it to map a deleted fly-by video back to the preview it should clean up, and
 * the Lambda uses it to decide where to write.
 */

/** Artifact type for the auto-generated low-res fly-by preview clip. */
export const FLYBY_PREVIEW_ARTIFACT_TYPE = "mp4_preview" as const;

/** S3 key prefix segment that holds generated previews under a map's folder. */
export const FLYBY_PREVIEW_DIR_SEGMENT = "previews";

/**
 * Derive the preview S3 key for an original fly-by `mp4` key.
 * `maps/{id}/{name}.mp4` -> `maps/{id}/previews/{name}.preview.mp4`.
 */
export function flybyPreviewKeyForOriginalKey(originalKey: string): string {
  const lastSlash = originalKey.lastIndexOf("/");
  const dir = lastSlash >= 0 ? originalKey.slice(0, lastSlash) : "";
  const file = lastSlash >= 0 ? originalKey.slice(lastSlash + 1) : originalKey;
  const base = file.replace(/\.mp4$/i, "");
  const prefix = dir ? `${dir}/` : "";
  return `${prefix}${FLYBY_PREVIEW_DIR_SEGMENT}/${base}.preview.mp4`;
}

/** True when an S3 key is a generated fly-by preview (so the Lambda skips it). */
export function isFlybyPreviewKey(key: string): boolean {
  return key.includes(`/${FLYBY_PREVIEW_DIR_SEGMENT}/`) && /\.preview\.mp4$/i.test(key);
}
