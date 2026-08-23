export type DirectUploadKind = "map_asset_media" | "scenario_import";

export function shouldRejectDirectMultipartUpload(): boolean {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

export function directUploadRequiredPayload(uploadKind: DirectUploadKind) {
  return {
    error: "Direct multipart uploads are not supported by this deployment.",
    code: "direct_upload_required",
    uploadKind,
    detail:
      "Use the direct-to-S3 multipart upload flow for this deployment.",
  };
}
