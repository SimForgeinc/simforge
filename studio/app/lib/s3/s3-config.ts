/**
 * Logical bucket retained in database coordinates for the filesystem store.
 * This module is imported by client components, so it must stay free of
 * Node-only imports; the filesystem layout lives in `../db/config`.
 */
export const LOCAL_ARTIFACT_BUCKET = "local-artifacts";
export const S3_BUCKET = LOCAL_ARTIFACT_BUCKET;
export const S3_BUCKET_PUBLIC = LOCAL_ARTIFACT_BUCKET;
export const S3_REGION = "local";

// ---------------------------------------------------------------------------
// Dataset S3 path builders
// ---------------------------------------------------------------------------

/** Raw simulation frames for a dataset variation. */
export function datasetRawPath(datasetId: string, variationId: string): string {
  return `datasets/${datasetId}/variations/${variationId}/raw/`;
}

/** Cosmos-transferred frames for a dataset variation. */
export function datasetTransferredPath(datasetId: string, variationId: string): string {
  return `datasets/${datasetId}/variations/${variationId}/transferred/`;
}

/** Ground-truth annotations for a dataset variation. */
export function datasetAnnotationsPath(datasetId: string, variationId: string): string {
  return `datasets/${datasetId}/variations/${variationId}/annotations/`;
}

/** Packaged export archive for a dataset in a given format. */
export function datasetExportPath(datasetId: string, format: string): string {
  return `datasets/${datasetId}/exports/${format}/`;
}

/** Derived export bundle path for a specific export job. */
export function datasetDerivedExportPath(
  datasetId: string,
  exportId: string,
  format: string,
): string {
  return `datasets/${datasetId}/derived/${format}/${exportId}/`;
}
