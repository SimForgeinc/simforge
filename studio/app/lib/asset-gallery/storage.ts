import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import {
  checksumBoundPutRequiredHeaders,
  getPresignedGetUrl,
  getPresignedPutUrl,
  headS3Object,
} from "@/app/lib/s3/s3-presign";

const GLB_CONTENT_TYPE = "model/gltf-binary";
const THUMBNAIL_CONTENT_TYPE = "image/webp";

export function galleryModelKey(assetId: string, version: number, sha256: string): string {
  return `asset-gallery/${assetId}/${version}/model/${sha256}.glb`;
}

export function galleryThumbnailKey(assetId: string, version: number, sha256: string): string {
  return `asset-gallery/${assetId}/${version}/thumb/${sha256}.webp`;
}

export async function presignGalleryUpload(
  key: string,
  contentType: string,
  sha256: string,
): Promise<{ url: string; headers: Readonly<Record<string, string>> }> {
  const headers = checksumBoundPutRequiredHeaders(contentType, sha256);
  const url = await getPresignedPutUrl(key, contentType, S3_BUCKET, undefined, sha256);
  return { url, headers };
}

export async function presignGalleryAssetUploads(input: {
  modelKey: string;
  modelSha256: string;
  thumbnailKey: string;
  thumbnailSha256: string;
}) {
  const [glbUpload, thumbnailUpload] = await Promise.all([
    presignGalleryUpload(input.modelKey, GLB_CONTENT_TYPE, input.modelSha256),
    presignGalleryUpload(input.thumbnailKey, THUMBNAIL_CONTENT_TYPE, input.thumbnailSha256),
  ]);
  return { glbUpload, thumbnailUpload };
}

export function getGalleryModelUrl(key: string): Promise<string> {
  return getPresignedGetUrl(key, S3_BUCKET);
}

export function getGalleryThumbnailUrl(key: string): Promise<string> {
  return getPresignedGetUrl(key, S3_BUCKET);
}

export type UploadedObjectVerification =
  | { ok: true }
  | { ok: false; reason: "missing" | "length_mismatch" | "checksum_mismatch" };

export async function verifyUploadedObject(input: {
  key: string;
  sha256: string;
  byteLength: number;
  bucket?: string;
}): Promise<UploadedObjectVerification> {
  try {
    const object = await headS3Object(input.key, input.bucket ?? S3_BUCKET);
    if (object.contentLength !== input.byteLength) {
      return { ok: false, reason: "length_mismatch" };
    }

    const expectedBase64 = Buffer.from(input.sha256, "hex").toString("base64");
    if (object.checksumSha256 !== expectedBase64) {
      return { ok: false, reason: "checksum_mismatch" };
    }

    return { ok: true };
  } catch {
    return { ok: false, reason: "missing" };
  }
}
