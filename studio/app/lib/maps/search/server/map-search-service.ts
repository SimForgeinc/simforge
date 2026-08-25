/**
 * Server-side map search service.
 *
 * Loads the `search_index.json` sidecar (authoritative in Phase A) plus
 * candidates for a given mapAssetId, builds the search corpus, and runs
 * queries. Intended to be called from API routes, server actions, and
 * automation scripts.
 *
 * The client-side in-memory fast path is retired — queries only flow through
 * this service. Corpus construction happens here (with an LRU cache keyed by
 * sidecar sha256) and never on the client.
 *
 * Fallback: if a map does not yet have a sidecar (pre-backfill), the service
 * falls back to the legacy candidate + raw-GeoJSON corpus so existing search
 * UIs don't break while the admin backfill runs. This fallback is logged and
 * should be removed once all maps carry `search_index` artifacts.
 */

import type {
  CandidateLocation,
  MapAssetEnrichmentSnapshot,
  MapSearchIndex,
} from "@simforge/studio-shared";
import { MapSearchIndexSchema } from "@simforge/studio-shared";
import aliasSpec from "@/app/lib/maps/search/map-search-aliases.json";
import { getCandidateLocationsByMapAssetId } from "@/app/lib/db/map-candidate-location-store";
import { getMapAssetEnrichmentById } from "@/app/lib/db/map-asset-enrichment-store";
import { getMapArtifactRevision } from "@/app/lib/db/map-asset-store";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";
import {
  buildSearchDocuments,
  buildSearchDocumentsFromIndex,
  type MapSearchDocument,
} from "@/app/lib/maps/search/map-search-corpus";
import {
  getMapSearchSuggestions,
  runMapSearch,
  type MapSearchParseHint,
  type MapSearchSuggestion,
  type ParsedMapSearch,
} from "@/app/lib/maps/search/map-search";
import {
  buildAstFromStructured,
  parseMapSearchToStructured,
  type ParsedMapSearchAst,
  type StructuredSearchInput,
} from "@/app/lib/maps/search/relation-ast";
import { executeRelation } from "@/app/lib/maps/search/server/relation-executor";
import { SEARCH_LIMITS } from "@/app/lib/maps/search/search-constants";
import {
  buildSpatialIndex,
  type SpatialIndex,
} from "@/app/lib/maps/search/server/spatial-index";
import {
  buildGraphIndex,
  type GraphIndex,
} from "@/app/lib/maps/search/server/graph-index";

const FAMILY_CHIP_LABEL: Record<string, string> =
  (aliasSpec as { family_chip_label?: Record<string, string> }).family_chip_label ?? {};

const OPERATOR_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(
    (aliasSpec as {
      operators?: Record<string, { label: string }>;
    }).operators ?? {},
  ).map(([op, spec]) => [op, spec.label]),
);

async function loadGeoJsonBody(bucket: string, key: string): Promise<object | null> {
  try {
    const text = await getS3ObjectUtf8(bucket, key);
    if (!text) return null;
    return JSON.parse(text) as object;
  } catch (err) {
    console.warn(`[map-search-service] GeoJSON fetch failed for ${bucket}/${key}:`, err);
    return null;
  }
}

async function loadSearchIndex(
  bucket: string,
  key: string,
): Promise<MapSearchIndex | null> {
  try {
    const text = await getS3ObjectUtf8(bucket, key);
    if (!text) return null;
    const parsed = JSON.parse(text) as unknown;
    return MapSearchIndexSchema.parse(parsed);
  } catch (err) {
    console.warn(`[map-search-service] search_index fetch/parse failed for ${bucket}/${key}:`, err);
    return null;
  }
}

function maxCandidateUpdatedAt(candidates: CandidateLocation[]): string | null {
  let max: string | null = null;
  for (const c of candidates) {
    if (c.updated_at && (max === null || c.updated_at > max)) max = c.updated_at;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Corpus cache
// ---------------------------------------------------------------------------
//
// Cache the built corpus per map asset, keyed by every revision signal that
// can change the documents: enrichment.computed_at, candidate count, the max
// candidate updated_at (catches in-place edits that keep the row count
// stable), and the GeoJSON artifact sha256 (catches S3 replacements).
//
// On cache hit we skip both document construction *and* the S3 GeoJSON
// download, since the revision signals are all derivable from cheap DB
// lookups.

type CacheEntry = {
  corpus: MapSearchDocument[];
  /** Present when the corpus was built from a sidecar — enables relation queries. */
  sidecar: MapSearchIndex | null;
  /** Built lazily alongside the corpus when a sidecar is available. */
  spatialIndex: SpatialIndex | null;
  /** Topology graph built from sidecar edges — powers Phase C operators. */
  graphIndex: GraphIndex | null;
  touchedAt: number;
};

const corpusCache = new Map<string, CacheEntry>();

function buildCacheKey(parts: {
  mapAssetId: string;
  searchIndexSha256: string | null;
  enrichmentComputedAt: string | null;
  candidateCount: number;
  maxCandidateUpdatedAt: string | null;
  geojsonSha256: string | null;
}): string {
  return [
    parts.mapAssetId,
    parts.searchIndexSha256 ?? "none",
    parts.enrichmentComputedAt ?? "none",
    String(parts.candidateCount),
    parts.maxCandidateUpdatedAt ?? "none",
    parts.geojsonSha256 ?? "none",
  ].join("::");
}

function touchCacheEntry(key: string, entry: CacheEntry): void {
  entry.touchedAt = Date.now();
  corpusCache.delete(key);
  corpusCache.set(key, entry);
  if (corpusCache.size > SEARCH_LIMITS.corpusCacheEntries) {
    const oldest = corpusCache.keys().next().value;
    if (oldest) corpusCache.delete(oldest);
  }
}

/** Test-only: drop cached corpora so service tests don't leak across runs. */
export function clearMapSearchCorpusCache(): void {
  corpusCache.clear();
}

// ---------------------------------------------------------------------------
// Resolve → cache → build
// ---------------------------------------------------------------------------

interface ResolvedInputs {
  candidates: CandidateLocation[];
  enrichment: MapAssetEnrichmentSnapshot | null;
  geojsonRevision: { bucket: string; key: string; sha256: string | null } | null;
  searchIndexRevision: { bucket: string; key: string; sha256: string | null } | null;
}

async function loadResolvedInputs(mapAssetId: string): Promise<ResolvedInputs> {
  const [candidates, enrichment, geojsonRevision, searchIndexRevision] = await Promise.all([
    getCandidateLocationsByMapAssetId(mapAssetId),
    getMapAssetEnrichmentById(mapAssetId),
    getMapArtifactRevision(mapAssetId, "geojson"),
    getMapArtifactRevision(mapAssetId, "search_index"),
  ]);
  return { candidates, enrichment, geojsonRevision, searchIndexRevision };
}

async function getOrBuildCorpus(
  mapAssetId: string,
  inputs: ResolvedInputs,
): Promise<CacheEntry> {
  const key = buildCacheKey({
    mapAssetId,
    searchIndexSha256: inputs.searchIndexRevision?.sha256 ?? null,
    enrichmentComputedAt: inputs.enrichment?.computed_at ?? null,
    candidateCount: inputs.candidates.length,
    maxCandidateUpdatedAt: maxCandidateUpdatedAt(inputs.candidates),
    geojsonSha256: inputs.geojsonRevision?.sha256 ?? null,
  });

  const cached = corpusCache.get(key);
  if (cached) {
    touchCacheEntry(key, cached);
    return cached;
  }

  // Sidecar-first: when a `search_index.json` is registered, it is the
  // authoritative source of canonical objects. Candidates are joined in by
  // `candidate_id` for supplemental scenario tags and descriptions. The
  // spatial index is built once alongside the corpus so relation queries
  // don't pay rebuild cost per call.
  let corpus: MapSearchDocument[];
  let sidecar: MapSearchIndex | null = null;
  let spatialIndex: SpatialIndex | null = null;
  let graphIndex: GraphIndex | null = null;
  if (inputs.searchIndexRevision) {
    sidecar = await loadSearchIndex(
      inputs.searchIndexRevision.bucket,
      inputs.searchIndexRevision.key,
    );
    if (sidecar) {
      corpus = buildSearchDocumentsFromIndex({
        sidecar,
        candidates: inputs.candidates,
      });
      spatialIndex = buildSpatialIndex(sidecar);
      graphIndex = buildGraphIndex(sidecar);
      console.log(
        `[map-search-service] indexes built map=${mapAssetId} ` +
          `corpus=${corpus.length} ` +
          `spatial=${spatialIndex.ids.length} ` +
          `graph=${graphIndex.size} ` +
          `edges=${sidecar.graph.edges?.length ?? 0}`,
      );
    } else {
      console.warn(
        `[map-search-service] search_index artifact present but unreadable for ${mapAssetId}; falling back to legacy corpus`,
      );
      corpus = await buildLegacyCorpus(inputs);
    }
  } else {
    console.warn(
      `[map-search-service] no search_index sidecar for ${mapAssetId}; using legacy corpus (run the admin backfill to convert)`,
    );
    corpus = await buildLegacyCorpus(inputs);
  }

  const entry: CacheEntry = {
    corpus,
    sidecar,
    spatialIndex,
    graphIndex,
    touchedAt: Date.now(),
  };
  touchCacheEntry(key, entry);
  return entry;
}

/**
 * Legacy corpus path — kept only for maps that have not yet been backfilled
 * with a `search_index` artifact. Remove once the admin backfill script has
 * run against every map in every environment.
 */
async function buildLegacyCorpus(
  inputs: ResolvedInputs,
): Promise<MapSearchDocument[]> {
  const roadNetwork = inputs.geojsonRevision
    ? await loadGeoJsonBody(inputs.geojsonRevision.bucket, inputs.geojsonRevision.key)
    : null;
  return buildSearchDocuments({
    candidates: inputs.candidates,
    roadNetwork,
    enrichment: inputs.enrichment,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SearchMapLocationsArgs {
  mapAssetId: string;
  query: string;
  limit?: number;
}

export interface SearchMapLocationsResult extends ParsedMapSearch {
  mapAssetId: string;
  totalDocuments: number;
}

/**
 * Resolve and (re)use the cached search corpus for a map. Exposed so callers
 * outside the keyword-search path (e.g. the LLM-driven candidate selector)
 * can read the same documents the search panel ranks against, without paying
 * a second S3 fetch. Returns null when the map has no resolvable inputs.
 */
export async function loadMapSearchCorpus(
  mapAssetId: string,
): Promise<{
  documents: MapSearchDocument[];
  totalDocuments: number;
} | null> {
  const inputs = await loadResolvedInputs(mapAssetId);
  const entry = await getOrBuildCorpus(mapAssetId, inputs);
  return {
    documents: entry.corpus,
    totalDocuments: entry.corpus.length,
  };
}

/**
 * Run a search against a specific map asset. Loads candidates, enrichment,
 * and road-network GeoJSON from their authoritative sources (DB + S3), builds
 * (or reuses) the cached corpus, and returns the same `ParsedMapSearch` shape
 * the client has always used, plus a few server-only fields.
 *
 * Relation branch: when the query contains a proximity operator (`near`,
 * `within`, `adjacent_to`) AND the map has a sidecar-backed corpus, the
 * relation executor replaces the legacy text ranker. Without a sidecar, the
 * relation degrades to plain text search with a parseHint.
 */
/**
 * Natural-language entry point. Now a thin adapter: parse the prose into
 * a `StructuredSearchInput` via the NL parser, then delegate to the
 * canonical `searchMapLocationsStructured` for corpus loading, AST
 * construction, and executor dispatch.
 *
 * Architectural intent: the structured path is the single source of
 * truth for executor behavior. The natural-language path is a parser
 * layer on top — improvements to the parser (synonym handling, polite-
 * framing, fuzzy matching) don't touch the executor; new executor
 * features (compound boolean subjects, attribute filters, etc.) extend
 * the structured path and the NL adapter inherits them automatically as
 * soon as the parser knows how to express them.
 */
export async function searchMapLocations(
  args: SearchMapLocationsArgs,
): Promise<SearchMapLocationsResult> {
  const { mapAssetId, query, limit } = args;
  const { structured, parserHints } = parseMapSearchToStructured(query);
  const result = await searchMapLocationsStructured({
    mapAssetId,
    structured,
    limit,
    // Pass the user's prose through so:
    //  (a) the result's `query` field reads as what the user typed (not
    //      the deterministic stringification of the structured form), and
    //  (b) the legacy text ranker on the no-relation fallback tokenizes
    //      the original prose, preserving pre-refactor ranking. Direct
    //      structured callers omit this and the stringified form is used.
    originalQuery: query,
  });
  if (parserHints.length === 0) return result;
  // Surface the NL parser's hints (subject_empty, object_empty,
  // direction_unavailable, etc.) ahead of any structured-path hints. Both
  // are typed as `MapSearchParseHint`-compatible, so flat-merge is safe.
  const nlHints: MapSearchParseHint[] = parserHints.map((h) => ({
    code: h.code,
    message: h.message,
  }));
  return {
    ...result,
    parseHints: [...nlHints, ...(result.parseHints ?? [])],
  };
}

export interface SearchMapLocationsStructuredArgs {
  mapAssetId: string;
  /**
   * Pre-decomposed structured query — caller has already resolved the
   * subject/relation/object slots, typically via the LLM tier. Bypasses
   * tokenization and feeds the AST builder directly. See
   * `StructuredSearchInput` for the shape and `map-search-aliases.json` for
   * the catalog of valid `semantic` ids.
   */
  structured: StructuredSearchInput;
  limit?: number;
  /**
   * Internal: when this entry is reached via the natural-language wrapper
   * (`searchMapLocations`), the original query string is passed here so
   * the AST's `query` field and the legacy text-ranker tokenization stay
   * bit-equivalent to the pre-refactor behavior. Direct structured
   * callers (LLM tier, future REST consumers) omit this and the
   * deterministic stringification of `structured` is used instead.
   */
  originalQuery?: string;
}

/**
 * Canonical structured-search entry point. Owns corpus loading, AST
 * construction, and executor dispatch — all executor-side functionality
 * lives here so improvements (new operators, compound subjects, etc.)
 * land in one place. The natural-language wrapper (`searchMapLocations`)
 * delegates here after parsing prose into a `StructuredSearchInput`.
 *
 * Dispatch:
 *   - When `structured.relation` is set AND the map has a sidecar +
 *     spatial index, run the relation executor (RTree / graph BFS).
 *   - Otherwise fall back to the legacy text ranker over the structured
 *     query's prose form (or the original NL query when invoked through
 *     the wrapper).
 */
export async function searchMapLocationsStructured(
  args: SearchMapLocationsStructuredArgs,
): Promise<SearchMapLocationsResult> {
  const { mapAssetId, structured, limit, originalQuery } = args;
  const inputs = await loadResolvedInputs(mapAssetId);
  const entry = await getOrBuildCorpus(mapAssetId, inputs);
  const { corpus, sidecar, spatialIndex, graphIndex } = entry;

  const ast = buildAstFromStructured(structured, originalQuery);
  const astHints: MapSearchParseHint[] = ast.hints.map((h) => ({
    code: h.code,
    message: h.message,
  }));

  if (ast.relation && sidecar && spatialIndex) {
    const relationResults = executeRelation({
      ast: { ...ast, relation: ast.relation },
      sidecar,
      documents: corpus,
      spatialIndex,
      graphIndex,
      limit,
    });
    const chips = buildRelationChips(ast);
    return {
      query: ast.query,
      chips,
      results: relationResults,
      freeText: [...ast.subject.freeText, ...ast.relation.object.freeText],
      parseHints: astHints.length > 0 ? astHints : undefined,
      mapAssetId,
      totalDocuments: corpus.length,
    };
  }

  const extraHints: MapSearchParseHint[] = [];
  if (ast.relation && (!sidecar || !spatialIndex)) {
    extraHints.push({
      code: "relation_unavailable_no_sidecar",
      message:
        "Proximity queries need a built search index for this map. Running a plain text search instead.",
    });
  }
  const parsed = runMapSearch({ documents: corpus }, ast.query, limit);
  const mergedHints = [...astHints, ...extraHints];
  return {
    ...parsed,
    parseHints: mergedHints.length > 0 ? mergedHints : undefined,
    mapAssetId,
    totalDocuments: corpus.length,
  };
}

function buildRelationChips(ast: ParsedMapSearchAst): SearchFilterChipLike[] {
  const chips: SearchFilterChipLike[] = [];
  for (const family of ast.subject.families) {
    chips.push({
      id: `family:${family}`,
      label: formatFamilyLabel(family),
      kind: "subject",
    });
  }
  for (const group of ast.subject.semantic) {
    chips.push({ id: `semantic:${group.id}`, label: group.label, kind: "subject" });
  }
  if (ast.relation) {
    // Collapse the whole right side into a single "relation + object" chip so
    // the UI can render it as one visual pill: "[near · bus stop]". Gives the
    // user a direct read on which part of their query is the spatial target.
    const opWord = OPERATOR_LABEL[ast.relation.op] ?? ast.relation.op;
    const distance =
      ast.relation.distance_m != null ? ` ${ast.relation.distance_m} m` : "";
    const operatorLabel = `${opWord}${distance}`;
    const objectParts: string[] = [];
    for (const family of ast.relation.object.families) {
      objectParts.push(formatFamilyLabel(family));
    }
    for (const group of ast.relation.object.semantic) {
      objectParts.push(group.label);
    }
    for (const token of ast.relation.object.freeText) objectParts.push(token);
    const objectLabel = objectParts.join(" ").trim() || "target";
    chips.push({
      id: `relation:${ast.relation.op}`,
      label: `${operatorLabel} ${objectLabel}`,
      kind: "relation",
      operatorLabel,
      objectLabel,
    });
  }
  return chips;
}

function formatFamilyLabel(family: string): string {
  // Singular chip labels (Junction / Street / POI) live in the JSON under
  // family_chip_label so they stay lockstep with the plural family labels
  // in object_families.
  return FAMILY_CHIP_LABEL[family] ?? family;
}

type SearchFilterChipLike = {
  id: string;
  label: string;
  kind?: "subject" | "relation";
  operatorLabel?: string;
  objectLabel?: string;
};

export interface SuggestMapSearchArgs {
  mapAssetId?: string;
  query: string;
  limit?: number;
}

/**
 * Suggestion terms are drawn from the static alias vocabulary, not from a
 * map-asset-specific corpus, so no I/O is required. The `mapAssetId` arg is
 * accepted for future per-map suggestion sources (e.g. street names from the
 * road network) without changing the call-site signature.
 */
export function suggestMapSearch(args: SuggestMapSearchArgs): MapSearchSuggestion[] {
  return getMapSearchSuggestions(args.query, args.limit);
}
