import { createHash } from "node:crypto";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";
import type { MapUploadTarget } from "@/app/lib/map-ingest/contracts";
import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import {
  checksumBoundPutRequiredHeaders,
  getPresignedPutUrl,
  headS3Object,
} from "@/app/lib/s3/s3-presign";
import { putS3Object } from "@/app/lib/s3/s3-put-object";
import { verifyUploadedObject } from "@/app/lib/asset-gallery/storage";
import type { UploadedObjectVerification } from "@/app/lib/asset-gallery/storage";

export type MapUploadMember = {
  path: string;
  contentType: string;
  sha256: string;
  byteLength: number;
};

export type MapClosureMember = {
  relativePath: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
  bytes: Buffer;
};

export function mapClosureKey(sha256: string): string {
  return `uniscenario/browser-blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export function mapUploadKey(sha256: string): string {
  return `map-uploads/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

async function presignMapUpload(member: MapUploadMember): Promise<MapUploadTarget> {
  const key = mapUploadKey(member.sha256);
  const headers = checksumBoundPutRequiredHeaders(member.contentType, member.sha256);
  try {
    const object = await headS3Object(key, S3_BUCKET);
    const expectedChecksum = Buffer.from(member.sha256, "hex").toString("base64");
    if (
      object.contentLength === member.byteLength &&
      object.checksumSha256 === expectedChecksum
    ) {
      return { path: member.path, url: null, headers: { ...headers } };
    }
  } catch {
    // A missing content-addressed object is the normal first-upload path.
  }

  const url = await getPresignedPutUrl(
    key,
    member.contentType,
    S3_BUCKET,
    undefined,
    member.sha256,
  );
  return { path: member.path, url, headers: { ...headers } };
}

export async function presignMapUploads(
  members: readonly MapUploadMember[],
): Promise<MapUploadTarget[]> {
  return Promise.all(members.map((member) => presignMapUpload(member)));
}

function artifactBucket(): string {
  return process.env.UNISCENARIO_ARTIFACT_BUCKET?.trim() || "local-artifacts";
}

/**
 * Presign an upload straight into the immutable artifact bucket.
 *
 * A deferred optimization submits variant bytes it computed locally, and those
 * belong in the closure's own bucket rather than the `map-uploads/` staging area
 * a browser writes to — the operator is producing published artifacts, not
 * staging a draft.
 */
async function presignMapClosureUpload(member: MapUploadMember): Promise<MapUploadTarget> {
  const bucket = artifactBucket();
  const key = mapClosureKey(member.sha256);
  const headers = checksumBoundPutRequiredHeaders(member.contentType, member.sha256);
  try {
    const object = await headS3Object(key, bucket);
    const expectedChecksum = Buffer.from(member.sha256, "hex").toString("base64");
    if (object.contentLength === member.byteLength && object.checksumSha256 === expectedChecksum) {
      return { path: member.path, url: null, headers: { ...headers } };
    }
  } catch {
    // A missing content-addressed object is the normal first-upload path.
  }
  const url = await getPresignedPutUrl(key, member.contentType, bucket, undefined, member.sha256);
  return { path: member.path, url, headers: { ...headers } };
}

export async function presignMapClosureUploads(
  members: readonly MapUploadMember[],
): Promise<MapUploadTarget[]> {
  return Promise.all(members.map((member) => presignMapClosureUpload(member)));
}

/** Read a published closure member's bytes, verifying the digest on the way out. */
export async function readMapClosureMember(sha256: string): Promise<Buffer> {
  const bytes = Buffer.from(
    await getS3ObjectBytes(artifactBucket(), mapClosureKey(sha256)),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error(`map closure member ${sha256} checksum changed while reading`);
  }
  return bytes;
}

/** Confirm a closure member's exact bytes are stored in the artifact bucket. */
export function verifyMapClosureMember(
  sha256: string,
  byteLength: number,
): Promise<UploadedObjectVerification> {
  return verifyUploadedObject({
    bucket: artifactBucket(),
    key: mapClosureKey(sha256),
    sha256,
    byteLength,
  });
}

export function verifyMapUpload(
  sha256: string,
  byteLength: number,
): Promise<UploadedObjectVerification> {
  return verifyUploadedObject({
    bucket: S3_BUCKET,
    key: mapUploadKey(sha256),
    sha256,
    byteLength,
  });
}

export async function readMapUpload(sha256: string): Promise<Buffer> {
  const bytes = Buffer.from(await getS3ObjectBytes(S3_BUCKET, mapUploadKey(sha256)));
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error(`map upload ${sha256} checksum changed while reading`);
  }
  return bytes;
}

export async function storeMapClosureMember(member: MapClosureMember): Promise<void> {
  const bucket = artifactBucket();
  const key = mapClosureKey(member.sha256);
  const expectedChecksum = Buffer.from(member.sha256, "hex").toString("base64");
  try {
    const existing = await headS3Object(key, bucket);
    if (
      existing.contentLength !== member.byteLength ||
      existing.checksumSha256 !== expectedChecksum
    ) {
      throw new Error(`immutable map closure object mismatch at ${key}`);
    }
    return;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("immutable map closure object mismatch")) {
      throw error;
    }
  }

  await putS3Object(bucket, key, member.bytes, member.mediaType);

  const stored = await headS3Object(key, bucket);
  if (
    stored.contentLength !== member.byteLength ||
    stored.checksumSha256 !== expectedChecksum
  ) {
    throw new Error(`immutable map closure object mismatch at ${key}`);
  }
}
