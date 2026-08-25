import { z } from "zod";

/**
 * Stored media-type emission remains legacy to preserve artifact metadata and
 * canonical-document digests. Flip only with the coordinated document cutover.
 */
export const EMIT_CANONICAL_STORED_MEDIA_TYPES = false;

function emittedMediaType(canonical: string, legacy: string): string {
  return EMIT_CANONICAL_STORED_MEDIA_TYPES ? canonical : legacy;
}
type CanonicalSchemaId<Legacy extends `uniscenario.${string}`> =
  Legacy extends `uniscenario.${infer Suffix}` ? `simforge.${Suffix}` : never;

export function acceptedStoredSchemaId<const Legacy extends `uniscenario.${string}`>(
  legacy: Legacy,
) {
  const canonical = legacy.replace(/^uniscenario\./, "simforge.") as CanonicalSchemaId<Legacy>;
  return z.union([z.literal(canonical), z.literal(legacy)]);
}

export function isAcceptedStoredSchemaId(
  value: string,
  legacy: `uniscenario.${string}`,
): boolean {
  return value === legacy || value === legacy.replace(/^uniscenario\./, "simforge.");
}


export const MATERIALIZED_TRAFFIC_MEDIA_TYPE = emittedMediaType(
  "application/vnd.simforge.materialized-traffic+json",
  "application/vnd.uniscenarios.materialized-traffic+json",
);
export const PLAYBACK_MEDIA_TYPE = emittedMediaType(
  "application/vnd.simforge.playback+json",
  "application/vnd.uniscenarios.playback+json",
);
export const COMPRESSED_PLAYBACK_MEDIA_TYPE = emittedMediaType(
  "application/vnd.simforge.playback+json+gzip",
  "application/vnd.simforge.uniscenario-playback+json+gzip",
);

const ACCEPTED_MEDIA_TYPES: Record<string, true> = {
  "application/vnd.simforge.materialized-traffic+json": true,
  "application/vnd.uniscenarios.materialized-traffic+json": true,
  "application/vnd.simforge.playback+json": true,
  "application/vnd.uniscenarios.playback+json": true,
  "application/vnd.simforge.playback+json+gzip": true,
  "application/vnd.simforge.uniscenario-playback+json+gzip": true,
};

export function isAcceptedStoredMediaType(value: string): boolean {
  return ACCEPTED_MEDIA_TYPES[value] === true;
}
