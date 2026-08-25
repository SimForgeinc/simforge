import { z } from "zod";

/**
 * Parquet contract for normalized real-world accident / near-miss events.
 *
 * Raw records from external providers (Xu et al. CA AV Collision augmented
 * dataset today; NHTSA SGO, FARS, CRSS, etc. in later phases) are normalized
 * into this shape by the accident-ingest-worker and written as one parquet
 * per (dataset, release). The map-third-party-enrichment Lambda reads these
 * parquets with DuckDB httpfs and projects them onto map_candidate_locations.
 *
 * Schema evolution is additive: new optional columns are safe; bumping
 * ACCIDENT_EVENTS_SCHEMA_VERSION signals a breaking change, at which point
 * the projection reader must be updated before it will read new parquets.
 */

export const ACCIDENT_DATASETS = [
  "ca_av_collision",
  "nhtsa_sgo",
  "fars",
  "crss",
  "nyc_mvc",
  "ca_ccrs",
] as const;
export const AccidentDatasetSchema = z.enum(ACCIDENT_DATASETS);
export type AccidentDataset = z.infer<typeof AccidentDatasetSchema>;

export const ACCIDENT_SEVERITIES = [
  "fatal",
  "injury",
  "pdo",
  "near_miss",
  "unknown",
] as const;
export const AccidentSeveritySchema = z.enum(ACCIDENT_SEVERITIES);
export type AccidentSeverity = z.infer<typeof AccidentSeveritySchema>;

export const AccidentEventSchema = z.object({
  dataset: AccidentDatasetSchema,
  release: z.string(),
  source_record_id: z.string(),
  operator: z.string().nullable(),
  event_at: z.string().datetime().nullable(),
  center_lat: z.number(),
  center_lng: z.number(),
  severity: AccidentSeveritySchema.nullable(),
  mode_tags: z.array(z.string()),
  narrative: z.string().nullable(),
  attrs: z.record(z.unknown()),
  source_artifact: z.string(),
});
export type AccidentEvent = z.infer<typeof AccidentEventSchema>;

/** Bump on any breaking change to AccidentEventSchema. */
export const ACCIDENT_EVENTS_SCHEMA_VERSION = 1;
