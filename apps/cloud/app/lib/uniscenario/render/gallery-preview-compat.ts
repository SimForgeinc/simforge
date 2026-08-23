/**
 * Read-only shape for historical gallery rows. New UniScenarios render output
 * uses the artifact DTOs in this directory; this type does not admit jobs.
 */
export type HistoricalGalleryPreview = {
  schema: "simforge.render.gallery_preview.v1";
  selectorVersion: "simforge.render.gallery_preview.v1";
  jobId: string;
  videoArtifactId: string | null;
  posterArtifactId: string | null;
  videoMediaPath: string | null;
  posterMediaPath: string | null;
  label: string | null;
  kind:
    | "trailing_rgb"
    | "primary_rgb"
    | "rgb"
    | "rgb_bboxed"
    | "rgb_annotated"
    | "lidar_bev"
    | "depth"
    | "semantic_segmentation"
    | "edge"
    | "trajectory_overlay"
    | "legacy_recording"
    | "fallback_video"
    | "none";
  selectionReason: string;
  outputModality: string;
  sensorCategory: string;
  sizeBytes: number | null;
  noPreviewReason: string | null;
};
