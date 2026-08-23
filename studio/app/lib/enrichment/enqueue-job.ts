import "server-only";

import type { EnrichmentJob, EnrichmentJobType } from "@simcloud/shared";

export interface EnqueueEnrichmentJobInput {
  mapAssetId: string;
  jobType: EnrichmentJobType;
  providerRelease?: string;
  requestedBy?: string;
}

export interface EnqueueEnrichmentJobResult {
  job: EnrichmentJob | { id: string; job_type: EnrichmentJobType; status: "pending" };
  reused: boolean;
}

export async function enqueueEnrichmentJob(
  _input: EnqueueEnrichmentJobInput,
): Promise<EnqueueEnrichmentJobResult> {
  throw new Error("Map enrichment workers are unavailable in the local cloud app.");
}
