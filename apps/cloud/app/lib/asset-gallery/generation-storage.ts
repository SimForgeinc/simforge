import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";
import { putS3Object } from "@/app/lib/s3/s3-put-object";
import type { GalleryReferenceImageMediaType } from "./generation-contracts";
import {
  GALLERY_MAX_REFERENCE_IMAGE_BYTES,
  GALLERY_REFERENCE_IMAGE_EXTENSIONS,
} from "./generation-contracts";
import {
  galleryModelKey,
  galleryThumbnailKey,
  presignGalleryUpload,
  verifyUploadedObject,
} from "./storage";

export function generationReferenceImageKey(
  generationId: string,
  index: number,
  mediaType: GalleryReferenceImageMediaType,
): string {
  return `asset-gallery/generations/${generationId}/ref/${index}.${GALLERY_REFERENCE_IMAGE_EXTENSIONS[mediaType]}`;
}

export async function presignGalleryGenerationReferenceUploads(
  generationId: string,
  images: { mediaType: GalleryReferenceImageMediaType; sha256: string }[],
): Promise<{ url: string; headers: Record<string, string> }[]> {
  return Promise.all(
    images.map(async (image, index) => {
      const target = await presignGalleryUpload(
        generationReferenceImageKey(generationId, index, image.mediaType),
        image.mediaType,
        image.sha256,
      );
      return { url: target.url, headers: { ...target.headers } };
    }),
  );
}

export async function verifyGalleryGenerationReferenceImage(input: {
  bucket: string;
  key: string;
  sha256: string;
  byteLength: number;
}): Promise<boolean> {
  const result = await verifyUploadedObject(input);
  return result.ok;
}

export async function getGalleryGenerationReferenceImage(
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  const bytes = await getS3ObjectBytes(bucket, key);
  if (bytes.byteLength > GALLERY_MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("Gallery generation reference image exceeds the byte limit.");
  }
  return bytes;
}

export function generatedGalleryObjectKeys(
  generationId: string,
  input: { modelSha256: string; thumbnailSha256: string },
): { modelKey: string; thumbnailKey: string } {
  return {
    modelKey: galleryModelKey(generationId, 1, input.modelSha256),
    thumbnailKey: galleryThumbnailKey(generationId, 1, input.thumbnailSha256),
  };
}

export async function uploadGeneratedGalleryObjects(input: {
  model: { key: string; bytes: Uint8Array };
  thumbnail: { key: string; bytes: Uint8Array };
}): Promise<void> {
  await Promise.all([
    putS3Object(S3_BUCKET, input.model.key, input.model.bytes, "model/gltf-binary"),
    putS3Object(S3_BUCKET, input.thumbnail.key, input.thumbnail.bytes, "image/webp"),
  ]);
}
