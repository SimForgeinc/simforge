/**
 * Contracts for the async map-enrichment job system. A single Lambda worker consumes
 * SQS messages typed by `EnrichmentJobType`; progress is tracked in the
 * `map_asset_enrichment_jobs` table (migration 0058) and surfaced to the UI
 * via the `/enrichment/status` polling endpoint.
 *
 * The enum is intentionally kept as an enum (even though there is only one
 * value today) so that reintroducing a lighter-weight job type — e.g. a
 * standalone street-name resolver against the cached snapshot — is a code
 * change without a schema migration. The dev Aurora DB enum still contains
 * `street_name_resolution` from migration 0058; it is harmless while no
 * consumer issues messages of that type.
 */
import { z } from "zod";

/**
 * `third_party_enrichment` is the full, DuckDB + Overture pipeline. It
 * persists the canonical 3rd-party snapshot (POIs, named road segments,
 * attribution) and runs inline street-name resolution on the candidate
 * locations before marking the job succeeded.
 */
export const EnrichmentJobTypeSchema = z.enum(["third_party_enrichment"]);
export type EnrichmentJobType = z.infer<typeof EnrichmentJobTypeSchema>;

/**
 * Lifecycle states for an enrichment job row. `pending` is written by the
 * API route at enqueue time; the Lambda transitions through `running` to a
 * terminal state (`succeeded` / `failed` / `timeout`).
 */
export const EnrichmentJobStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "timeout",
]);
export type EnrichmentJobStatus = z.infer<typeof EnrichmentJobStatusSchema>;

/**
 * One row of `map_asset_enrichment_jobs`, projected for client consumption.
 * `result_json` carries success metadata (feature counts, resolved / total,
 * timing) — schema-free since it evolves faster than the API contract.
 */
export const EnrichmentJobSchema = z.object({
  id: z.string(),
  map_asset_id: z.string(),
  job_type: EnrichmentJobTypeSchema,
  status: EnrichmentJobStatusSchema,
  provider_release: z.string().nullable(),
  requested_by: z.string().nullable(),
  sqs_message_id: z.string().nullable(),
  enqueued_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  error_message: z.string().nullable(),
  attempt_count: z.number().int(),
  result_json: z.record(z.unknown()).nullable(),
});
export type EnrichmentJob = z.infer<typeof EnrichmentJobSchema>;

/**
 * The JSON payload Next.js writes into the SQS MessageBody when enqueuing a
 * job. The Lambda parses this directly.
 */
export interface EnrichmentJobQueueMessage {
  job_id: string;
  map_asset_id: string;
  job_type: EnrichmentJobType;
  provider_release?: string;
}
