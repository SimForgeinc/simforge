import { createDatasetExportJobV2 } from "@/app/lib/db/dataset-export-v2-store";

/**
 * Canonical service boundary for the existing dataset export executor.
 *
 * The executor keeps its physical tables during the storage migration, but
 * product callers expose it only as `artifact_postprocess`. Pipeline code does
 * not depend on that temporary table or its historical family name.
 */
export async function createCanonicalDatasetExportJob(
  input: Parameters<typeof createDatasetExportJobV2>[0],
) {
  return createDatasetExportJobV2(input);
}
