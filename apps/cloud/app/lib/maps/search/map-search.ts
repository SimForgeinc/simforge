import aliasSpec from "./map-search-aliases.json";
import {
  matchesTerm,
  SEARCH_SCORING,
  SEARCH_STOPWORDS,
  TYPE_DEFINING_SEMANTIC_IDS,
} from "./search-constants";
import {
  buildSearchDocuments,
  normalizeForSearch,
  type MapSearchDocument,
  type MapSearchDocumentFacts,
  type MapSearchDocumentGeometryRef,
  type MapSearchInputs,
  type SearchObjectFamily,
} from "./map-search-corpus";

export type {
  SearchObjectFamily,
  MapSearchDocument,
  MapSearchDocumentFacts,
  MapSearchDocumentGeometryRef,
  MapSearchInputs,
};

export interface SearchFilterChip {
  id: string;
  label: string;
  /**
   * Visual kind. `subject` chips describe the primary object the user is
   * looking for; `relation` chips carry a spatial predicate + its target
   * ("near bus stop") and render as a single visually-joined pill.
   */
  kind?: "subject" | "relation";
  /** Present on `relation` chips. Display text for the operator ("near", "within 50 m"). */
  operatorLabel?: string;
  /** Present on `relation` chips. Display text for the target object ("bus stop"). */
  objectLabel?: string;
}

/**
 * Extra metadata attached to a subject result when a relation operator
 * matched. Populated by the relation executor for `near` / `within` /
 * `adjacent_to` queries — otherwise absent.
 */
export interface RelatedObjectRef {
  /** Canonical object id of the matched neighbor (e.g. `poi:school_frontage:...`). */
  objectId: string;
  /** Relation operator that produced this match. */
  relation:
    | "near"
    | "adjacent_to"
    | "within"
    | "leads_to"
    | "connected_to"
    | "upstream_of"
    | "downstream_of";
  /** Distance (meters) from subject centroid to neighbor centroid, if known. */
  distance_m?: number;
  /** Display fields copied from the matched neighbor's document, for UI badges. */
  title?: string;
  subtype?: string;
  objectFamily?: SearchObjectFamily;
  /**
   * Geometry pointer for the matched neighbor. Lets the UI resolve a subtle
   * "related" highlight (feature-state, overlay ring, or candidate polygon)
   * alongside the primary subject highlight when a spatial result is focused.
   */
  geometryReference?: MapSearchDocumentGeometryRef;
  /**
   * WGS84 centroid of the neighbor ([lng, lat]), copied from the sidecar. In
   * the API response so LLM agents can use the coordinate directly — without
   * also having to fetch the sidecar to dereference `objectId`.
   */
  centroid?: [number, number];
  /**
   * Reconstructed graph route from subject → neighbor for topology relations
   * (`leads_to` and friends). Populated only on graph-backed matches. Each
   * step carries an objectId, the kind, the neighbor's centroid, and the
   * accumulated traversal distance from the subject — agents can feed the
   * centroid sequence to the simulator as waypoints, and the UI can show
   * the route to explain why a multi-hop neighbor matched.
   */
  path?: TopologyPathStep[];
  /**
   * True when the reconstructed path exceeded `MAX_TOPOLOGY_PATH_NODES` and
   * was clipped to a head + tail slice. Hint for the UI/agent that some
   * intermediate hops are missing from `path`.
   */
  pathTruncated?: boolean;
}

export interface TopologyPathStep {
  objectId: string;
  /** Cumulative graph-traversal distance (m) from the subject to this step. */
  cumulativeM: number;
  /** Display label copied from the sidecar object. */
  title?: string;
  /** Object kind (e.g. `junction`, `street`, `bus_stop`) — drives UI iconography. */
  kind?: string;
  /** WGS84 centroid ([lng, lat]) — usable directly as a simulator waypoint. */
  centroid?: [number, number];
}

export interface MapSearchResult {
  id: string;
  candidateId: string;
  objectFamily: SearchObjectFamily;
  subtype: string;
  title: string;
  description: string;
  exactMapAttributes: string[];
  relatedObjects: string[];
  /** Populated only for relation queries; empty/absent on plain text search. */
  relatedObjectRefs?: RelatedObjectRef[];
  scenarioTags: string[];
  candidateConfidence: number;
  matchReasons: string[];
  /** Pointer to the underlying place so handlers can highlight / zoom / focus without re-resolving. */
  geometryReference?: MapSearchDocumentGeometryRef;
  /**
   * WGS84 centroid of this result ([lng, lat]), copied from the sidecar. In
   * the API response so LLM agents can place scenarios at the subject without
   * a second round trip to resolve geometry.
   */
  centroid?: [number, number];
}

export interface MapSearchParseHint {
  code: string;
  message: string;
}

export interface ParsedMapSearch {
  query: string;
  chips: SearchFilterChip[];
  results: MapSearchResult[];
  /** Leftover tokens after family + semantic aliases consume their matches.
   *  Surfaced for the in-panel debug view. */
  freeText: string[];
  /**
   * Signals from the query parser when an input couldn't be resolved as typed
   * (e.g. `within` with no distance, a relation with an empty right side).
   * Empty on well-formed queries.
   */
  parseHints?: MapSearchParseHint[];
}

export interface MapSearchSuggestion {
  id: string;
  label: string;
  applyValue: string;
}

type ParsedSearchFilters = {
  objectFamilies: Set<SearchObjectFamily>;
  semanticGroups: Array<{
    id: string;
    label: string;
    searchTerms: string[];
    /** Normalised tag tokens (e.g. "turn_unprotected_left"). When set, the filter uses these INSTEAD OF searchTerms. */
    candidateTagTerms?: string[];
    /**
     * Raw object kinds (e.g. "street_parking"). When set, a doc satisfies the
     * group if `doc.kind` is in this list. Combined with `candidateTagTerms`
     * via OR — either matching is enough. Preferred over `candidateTagTerms`
     * when a semantic category corresponds directly to an object kind rather
     * than to a raw tag, since kinds are stable across extractor versions.
     */
    candidateKinds?: string[];
    /**
     * Whole-string match anchor against `doc.exactMapAttributes` (after
     * `normalizeForSearch`). Stricter than `searchTerms`, which word-bound
     * matches against `searchText` and so picks up generic words inside
     * larger compound badges (e.g. "uncontrolled" inside "uncontrolled left
     * turn"). Combined with the other anchors via OR.
     */
    candidateExactAttributes?: string[];
  }>;
  freeText: string[];
};

const SEARCH_ALIASES = aliasSpec as {
  numeric_normalization: Record<string, string>;
  object_families: Record<SearchObjectFamily, { label: string; aliases: string[] }>;
  /**
   * A semantic group optionally carries authoritative anchors that replace
   * the free-text `search_terms` fallback:
   *   • `candidate_tags` — matches when the doc's raw tag set contains one of
   *     these (e.g. `TURN_UNPROTECTED_LEFT` → the "unprotected left" group).
   *   • `candidate_kinds` — matches when `doc.kind` is in the list (e.g.
   *     `street_parking` → every kind=street_parking candidate regardless of
   *     which extractor emitted its raw tags). Preferred when a category maps
   *     to an object kind rather than an extractor-specific tag.
   * When either field is set, matching is authoritative: `search_terms` is
   * ignored, and a doc satisfies the group iff at least one anchor matches.
   * Without these anchors the matcher falls back to word-bounded substring
   * matching against `search_terms` — this is what lets free-text in
   * explanations (e.g. "No protected left-turn control" in an unprotected
   * junction's reason) leak, so anchor any group that needs precision.
   */
  semantic_terms: Array<{
    id: string;
    label: string;
    aliases: string[];
    search_terms: string[];
    candidate_tags?: string[];
    candidate_kinds?: string[];
    /**
     * Whole-string match anchor against `doc.exactMapAttributes`. Stricter
     * than `search_terms` (which word-bound matches against `searchText` and
     * thus picks up "uncontrolled" inside "uncontrolled left turn"). Use
     * when the search_term is a generic word that appears as a sub-phrase
     * of unrelated badges — anchor on the standalone attribute instead.
     */
    exact_attributes?: string[];
  }>;
};

const SEARCH_SUGGESTION_TERMS = (() => {
  const terms = new Map<string, number>();

  for (const spec of Object.values(SEARCH_ALIASES.object_families)) {
    terms.set(normalizeForSearch(spec.label), 1);
    for (const alias of spec.aliases) terms.set(normalizeForSearch(alias), 1);
  }

  for (const semanticTerm of SEARCH_ALIASES.semantic_terms) {
    terms.set(normalizeForSearch(semanticTerm.label), 0);
    for (const alias of semanticTerm.aliases) terms.set(normalizeForSearch(alias), 0);
    for (const searchTerm of semanticTerm.search_terms) terms.set(normalizeForSearch(searchTerm), 0);
  }

  return [...terms.entries()]
    .filter(([term]) => Boolean(term))
    .map(([term, sourceRank]) => ({ term, sourceRank }))
    .sort((left, right) => left.sourceRank - right.sourceRank || left.term.localeCompare(right.term));
})();

// escapeRegExp / matchesTerm imported from ./search-constants — see that
// module for the single-source-of-truth definition.

function parseQuery(query: string): ParsedSearchFilters {
  const rawLowered = normalizeForSearch(query);

  // Extract quoted phrases before any other parsing. A quoted phrase is the
  // user opting out of our tokenizer: we treat it as a single free-text term
  // (matched literally) and remove it from the alias-matching pass so
  // incidental words inside the quotes don't produce spurious chips.
  const quotedPhrases: string[] = [];
  const lowered = rawLowered.replace(/"([^"]+)"|'([^']+)'/g, (_m, dq, sq) => {
    const phrase = (dq ?? sq ?? "").trim().replace(/\s+/g, " ");
    if (phrase) quotedPhrases.push(phrase);
    return " ";
  });

  const objectFamilies = new Set<SearchObjectFamily>();
  const semanticGroups = new Map<
    string,
    {
      id: string;
      label: string;
      searchTerms: string[];
      candidateTagTerms?: string[];
      candidateKinds?: string[];
      candidateExactAttributes?: string[];
    }
  >();
  const consumed = new Set<string>();

  // Collect every (group, alias) match first so we can detect phrase-level
  // overlap with family aliases (e.g. "road" inside "steep road"). Without
  // this, "steep road" adds family:street via the word "road" on top of the
  // intended semantic:grade match, which then strict-filters out non-street
  // results. The same rule already resolves overlaps between semantic groups
  // (e.g. `bike_merge` winning "bike conflict corridor" over plain `conflict`).
  type GroupMatch = {
    groupId: string;
    label: string;
    searchTerms: string[];
    candidateTagTerms?: string[];
    candidateKinds?: string[];
    candidateExactAttributes?: string[];
    alias: string;
  };
  const groupMatches: GroupMatch[] = [];
  for (const semanticTerm of SEARCH_ALIASES.semantic_terms) {
    const aliases = semanticTerm.aliases.map(normalizeForSearch);
    const searchTerms = semanticTerm.search_terms.map(normalizeForSearch);
    const candidateTagTerms = semanticTerm.candidate_tags?.map(normalizeForSearch);
    const candidateKinds = semanticTerm.candidate_kinds?.map((kind) => kind.toLowerCase());
    const candidateExactAttributes = semanticTerm.exact_attributes?.map(normalizeForSearch);
    for (const alias of aliases) {
      if (matchesTerm(lowered, alias)) {
        groupMatches.push({
          groupId: semanticTerm.id,
          label: semanticTerm.label,
          searchTerms,
          candidateTagTerms,
          candidateKinds,
          candidateExactAttributes,
          alias,
        });
      }
    }
  }

  // Address-query heuristic: a leading number FOLLOWED BY WHITESPACE signals
  // a postal-address lookup ("600 Clipper Drive", "1500 Page Mill Rd"). When
  // we treat a query as an address we pin the family to `address` and drop
  // any semantic-term matches — street-suffix words like "drive"/"avenue"/
  // "boulevard" otherwise pull in sibling chips (`street` family / arterial_road
  // semantic) that then hard-filter every address document out at the tail.
  //
  // Two carve-outs to avoid regressing existing numeric intents:
  //   1. The whitespace requirement (`^\d+\s`) excludes hyphenated facets
  //      like "4-way junctions" / "3-leg intersection" (no space after digit).
  //   2. If a semantic alias that itself starts with `<digits><space>` matched
  //      (e.g. "3 way", "4 way stop", "3 road junction"), the user's intent
  //      was the semantic, not an address — leave the semantic path intact.
  //
  // Suffix abbreviations are normalized to long form in `normalizeForSearch`,
  // so "dr"/"drive" both reach this point identically.
  const looksLikeStreetAddress = /^\d+\s/.test(lowered);
  const numericSemanticMatched = groupMatches.some((gm) => /^\d+\s/.test(gm.alias));
  const treatAsAddress = looksLikeStreetAddress && !numericSemanticMatched;

  if (treatAsAddress) {
    objectFamilies.add("address");
    // Drop semantic matches the user did not actually ask for — these were
    // suffix-word collisions (e.g. `arterial_road` via "avenue") that would
    // otherwise hard-filter address documents out via `docMatchesSemanticGroup`.
    groupMatches.length = 0;
  } else {
    for (const [family, spec] of Object.entries(SEARCH_ALIASES.object_families) as Array<
      [SearchObjectFamily, { label: string; aliases: string[] }]
    >) {
      const aliases = spec.aliases.map(normalizeForSearch);
      for (const term of aliases) {
        if (!matchesTerm(lowered, term)) continue;
        // Phrase-precedence: skip a family alias whose match is entirely
        // contained in a longer semantic alias that also matched. This keeps
        // "steep road" / "steep street" / "pedestrian crossing" from adding
        // a spurious family chip when the user's intent is the semantic group.
        const spannedByLongerSemantic = groupMatches.some(
          (gm) => gm.alias.length > term.length && gm.alias.includes(term),
        );
        if (spannedByLongerSemantic) continue;
        objectFamilies.add(family);
        consumed.add(term);
      }
    }
  }

  const effectiveMatches = groupMatches.filter((m) => {
    return !groupMatches.some(
      (other) =>
        other.groupId !== m.groupId &&
        other.alias.length > m.alias.length &&
        other.alias.includes(m.alias),
    );
  });
  for (const m of effectiveMatches) {
    semanticGroups.set(m.groupId, {
      id: m.groupId,
      label: m.label,
      searchTerms: m.searchTerms,
      ...(m.candidateTagTerms ? { candidateTagTerms: m.candidateTagTerms } : {}),
      ...(m.candidateKinds ? { candidateKinds: m.candidateKinds } : {}),
      ...(m.candidateExactAttributes
        ? { candidateExactAttributes: m.candidateExactAttributes }
        : {}),
    });
    consumed.add(m.alias);
  }

  const singleWordFreeText = lowered
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !SEARCH_STOPWORDS.has(token))
    .filter(
      (token) =>
        ![...consumed].some((term) => {
          const normalizedTerm = normalizeForSearch(term);
          return token === normalizedTerm || token.includes(normalizedTerm) || normalizedTerm.includes(token);
        }),
    );

  // Merge quoted phrases in front of single-word tokens. Dedupe against each
  // other and against single words that are already subsumed by a phrase
  // (e.g. typing `"el camino real" real` should not add "real" a second time).
  const freeText: string[] = [];
  const seen = new Set<string>();
  for (const phrase of quotedPhrases) {
    if (seen.has(phrase)) continue;
    freeText.push(phrase);
    seen.add(phrase);
  }
  for (const token of singleWordFreeText) {
    if (seen.has(token)) continue;
    const subsumed = quotedPhrases.some((phrase) =>
      phrase.split(" ").includes(token),
    );
    if (subsumed) continue;
    freeText.push(token);
    seen.add(token);
  }

  return { objectFamilies, semanticGroups: [...semanticGroups.values()], freeText };
}

function buildChips(parsed: ParsedSearchFilters): SearchFilterChip[] {
  const chips: SearchFilterChip[] = [];
  for (const family of parsed.objectFamilies) {
    chips.push({
      id: `family:${family}`,
      label: SEARCH_ALIASES.object_families[family].label,
    });
  }
  for (const semanticGroup of parsed.semanticGroups) {
    chips.push({ id: `semantic:${semanticGroup.id}`, label: semanticGroup.label });
  }
  return chips;
}

/**
 * Semantic chip ids that name a specific object type, not an attribute. When
 * the query pairs a family word with one of these (e.g. "bus stop near
 * intersection"), the user's primary intent is the POI type and the family
 * word is just context — drop the strict filter so the POI can surface.
 * Attribute-style semantics ("signalized", "uncontrolled", "grade") keep the
 * filter strict so e.g. "signalized junction" returns only junctions.
 */
// TYPE_DEFINING_SEMANTIC_IDS imported from ./search-constants — single
// source of truth shared with the relation executor.

function shouldHardFilterObjectFamilies(parsed: ParsedSearchFilters): boolean {
  if (parsed.objectFamilies.size === 0) return false;
  // Query is purely a family word ("junctions"): strict filter.
  if (parsed.semanticGroups.length === 0 && parsed.freeText.length === 0) return true;
  // A type-defining semantic chip means the primary intent is that POI type,
  // not the family word — keep filter advisory so the POI can surface.
  if (parsed.semanticGroups.some((g) => TYPE_DEFINING_SEMANTIC_IDS.has(g.id))) {
    return false;
  }
  // Attribute-style semantics only ("signalized junction"): strict filter so
  // the family word anchors the result set.
  return true;
}

/**
 * Tests whether a document satisfies a semantic group's intent.
 *
 * When the group declares `candidateTagTerms`, `candidateKinds`, or
 * `candidateExactAttributes`, those are authoritative (OR semantics — any
 * matching is enough). Free-text in explanations / descriptions is not
 * allowed to trump the anchored match — this keeps e.g. "No protected
 * left-turn control" in an unprotected junction's reason from false-matching
 * the `protected_left` group.
 *
 * `candidateExactAttributes` requires a whole-string equality match against
 * `doc.exactMapAttributes` (after `normalizeForSearch`). Use it for generic
 * words that would otherwise false-match compound badges — e.g.
 * "uncontrolled" inside the badge "uncontrolled left turn", which marks a
 * permissive turn at a signalized/stop-controlled junction, not an
 * uncontrolled junction.
 *
 * Without any anchor, the matcher falls back to word-bounded substring
 * matching against the group's `searchTerms`.
 */
function docMatchesSemanticGroup(
  doc: MapSearchDocument,
  group: ParsedSearchFilters["semanticGroups"][number],
): boolean {
  const hasKindAnchor = group.candidateKinds != null && group.candidateKinds.length > 0;
  const hasTagAnchor = group.candidateTagTerms != null && group.candidateTagTerms.length > 0;
  const hasExactAttrAnchor =
    group.candidateExactAttributes != null && group.candidateExactAttributes.length > 0;
  if (hasKindAnchor || hasTagAnchor || hasExactAttrAnchor) {
    if (
      hasKindAnchor &&
      doc.kind != null &&
      group.candidateKinds!.includes(doc.kind.toLowerCase())
    ) {
      return true;
    }
    if (
      hasTagAnchor &&
      group.candidateTagTerms!.some((term) => matchesTerm(doc.searchText, term))
    ) {
      return true;
    }
    if (hasExactAttrAnchor) {
      const normalizedAttrs = doc.exactMapAttributes.map(normalizeForSearch);
      if (
        group.candidateExactAttributes!.some((attr) => normalizedAttrs.includes(attr))
      ) {
        return true;
      }
    }
    return false;
  }
  return group.searchTerms.some((term) => matchesTerm(doc.searchText, term));
}

function scoreDocument(doc: MapSearchDocument, parsed: ParsedSearchFilters): number {
  let score = doc.candidateConfidence * SEARCH_SCORING.confidenceBase;

  if (parsed.objectFamilies.size > 0 && parsed.objectFamilies.has(doc.objectFamily)) {
    score += SEARCH_SCORING.familyMatchBonus;
  }

  for (const semanticGroup of parsed.semanticGroups) {
    if (docMatchesSemanticGroup(doc, semanticGroup)) score += SEARCH_SCORING.semanticGroupBonus;
  }

  for (const term of parsed.freeText) {
    if (matchesTerm(doc.searchText, term)) score += SEARCH_SCORING.freeTextBonus;
  }

  if (doc.rank != null) score += Math.max(0, SEARCH_SCORING.rankCeiling - doc.rank);

  return score;
}

function documentToResult(doc: MapSearchDocument, queryTerms: string[]): MapSearchResult {
  const lowerFacts = doc.exactMapAttributes.map(normalizeForSearch);
  const matchedFacts = queryTerms.filter((term) => lowerFacts.some((fact) => matchesTerm(fact, term)));
  const matchedScenarioTags = doc.scenarioTags.filter((tag) =>
    queryTerms.some((term) => matchesTerm(normalizeForSearch(tag), term)),
  );

  const matchReasons = [
    ...new Set([
      ...matchedFacts,
      ...matchedScenarioTags,
      ...(queryTerms.length === 0 ? [] : ["matches query text"]),
    ]),
  ];

  return {
    id: doc.id,
    candidateId: doc.candidateId ?? doc.id,
    objectFamily: doc.objectFamily,
    subtype: doc.subtype,
    title: doc.label,
    description: doc.description,
    exactMapAttributes: doc.exactMapAttributes,
    relatedObjects: doc.relatedObjects,
    scenarioTags: doc.scenarioTags,
    candidateConfidence: doc.candidateConfidence,
    matchReasons,
    geometryReference: doc.geometryReference,
  };
}

/**
 * Merge an already-typed query prefix with a suggestion term, stripping any
 * trailing tokens of the prefix that are also leading tokens of the term.
 *
 * This avoids duplicate fragments when the user is partway through typing
 * the term itself. For example, a query `"3 w"` picking the term `"3-way"`
 * should apply as `"3-way"`, not `"3 3-way"` — the `"3"` at the end of the
 * prefix is already the first token of `"3-way"`. Multi-word queries whose
 * earlier tokens don't overlap with the term are preserved unchanged
 * (`"signalized 3"` + `"3-way"` → `"signalized 3-way"`).
 *
 * Tokenization splits the term on both spaces and hyphens so variants like
 * `"3-way"` and `"3 way"` behave identically for overlap detection.
 */
function combineQueryPrefixWithTerm(queryPrefix: string, term: string): string {
  const trimmedPrefix = queryPrefix.trim();
  if (!trimmedPrefix) return term;
  // Whitespace-split view preserves hyphens within each token so we can
  // reconstruct the retained prefix with its original punctuation.
  const originalPrefixTokens = trimmedPrefix.split(/\s+/).filter(Boolean);
  // Normalized view treats hyphens like whitespace, so a prefix ending in
  // "t-intersection" matches a term starting with "t intersection".
  const normalizedPrefixTokens = trimmedPrefix.split(/[\s-]+/).filter(Boolean);
  const termTokens = term.split(/[\s-]+/).filter(Boolean);
  let overlapCount = 0;
  const maxOverlap = Math.min(normalizedPrefixTokens.length, termTokens.length);
  for (let k = maxOverlap; k >= 1; k--) {
    const prefSuffix = normalizedPrefixTokens.slice(normalizedPrefixTokens.length - k).join(" ");
    const termPrefix = termTokens.slice(0, k).join(" ");
    if (prefSuffix === termPrefix) {
      overlapCount = k;
      break;
    }
  }
  // Map the normalized overlap count back to whole original tokens to drop.
  // Only drop an original token when all of its hyphen-split pieces are
  // covered by the overlap — a partial match leaves the original token in
  // place so we don't lose characters from the retained prefix.
  let normalizedAccum = 0;
  let dropFromRight = 0;
  for (let i = originalPrefixTokens.length - 1; i >= 0 && normalizedAccum < overlapCount; i--) {
    const subTokenCount = originalPrefixTokens[i]!.split(/-+/).filter(Boolean).length;
    if (normalizedAccum + subTokenCount > overlapCount) break;
    normalizedAccum += subTokenCount;
    dropFromRight += 1;
  }
  const keptTokens = originalPrefixTokens.slice(0, originalPrefixTokens.length - dropFromRight);
  return keptTokens.length > 0 ? `${keptTokens.join(" ")} ${term}` : term;
}

export function getMapSearchSuggestions(query: string, limit = 6): MapSearchSuggestion[] {
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return [];

  const lastWhitespaceIndex = normalizedQuery.lastIndexOf(" ");
  const queryPrefix = lastWhitespaceIndex >= 0 ? normalizedQuery.slice(0, lastWhitespaceIndex + 1) : "";
  const trailingFragment = lastWhitespaceIndex >= 0 ? normalizedQuery.slice(lastWhitespaceIndex + 1) : normalizedQuery;

  const scored = SEARCH_SUGGESTION_TERMS.flatMap(({ term, sourceRank }) => {
    if (term === normalizedQuery) return [];

    if (term.startsWith(normalizedQuery)) {
      return [{ score: sourceRank, suggestion: { id: `full:${term}`, label: term, applyValue: term } }];
    }

    if (trailingFragment && term.startsWith(trailingFragment)) {
      const applyValue = normalizeForSearch(combineQueryPrefixWithTerm(queryPrefix, term));
      if (applyValue !== normalizedQuery) {
        return [{ score: sourceRank + 1, suggestion: { id: `suffix:${applyValue}`, label: term, applyValue } }];
      }
    }

    if (term.includes(normalizedQuery)) {
      return [{ score: sourceRank + 2, suggestion: { id: `contains:${term}`, label: term, applyValue: term } }];
    }

    if (trailingFragment && term.includes(trailingFragment)) {
      const applyValue = normalizeForSearch(combineQueryPrefixWithTerm(queryPrefix, term));
      if (applyValue !== normalizedQuery) {
        return [{ score: sourceRank + 3, suggestion: { id: `contains-suffix:${applyValue}`, label: term, applyValue } }];
      }
    }

    return [];
  });

  const deduped = new Map<string, { score: number; suggestion: MapSearchSuggestion }>();
  for (const entry of scored) {
    const existing = deduped.get(entry.suggestion.applyValue);
    if (!existing || entry.score < existing.score) {
      deduped.set(entry.suggestion.applyValue, entry);
    }
  }

  return [...deduped.values()]
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.suggestion.label.length - right.suggestion.label.length ||
        left.suggestion.label.localeCompare(right.suggestion.label),
    )
    .slice(0, limit)
    .map((entry) => entry.suggestion);
}

/**
 * Run a search over an in-memory corpus.
 *
 * The `inputs` form rebuilds the document corpus on every call — used by the
 * client fast path where inputs are already in memory.
 *
 * The `{ documents }` form skips corpus construction, letting the server-side
 * service cache a prebuilt corpus across queries for a given map asset.
 */
export function runMapSearch(
  inputsOrDocuments: MapSearchInputs | { documents: MapSearchDocument[] },
  query: string,
  limit = 50,
): ParsedMapSearch {
  const parsed = parseQuery(query);
  const chips = buildChips(parsed);
  const queryTerms = [
    ...parsed.semanticGroups.flatMap((group) => group.searchTerms),
    ...parsed.freeText,
  ];

  const documents =
    "documents" in inputsOrDocuments
      ? inputsOrDocuments.documents
      : buildSearchDocuments(inputsOrDocuments);

  const filtered = documents.filter((doc) => {
    // Drop results with no highlightable geometry — a geojson_feature ref
    // with a missing id sends the UI's "Highlight in Twin" button to a
    // dead link. The document may still exist in the sidecar to serve as
    // an anchor target for nearby POIs; we just don't surface it as a
    // result of its own.
    if (
      doc.geometryReference.kind === "geojson_feature" &&
      doc.geometryReference.geojsonFeatureId == null
    ) {
      return false;
    }

    if (shouldHardFilterObjectFamilies(parsed) && !parsed.objectFamilies.has(doc.objectFamily)) {
      return false;
    }

    if (queryTerms.length === 0) return true;

    return (
      parsed.semanticGroups.every((group) => docMatchesSemanticGroup(doc, group)) &&
      parsed.freeText.every((term) => matchesTerm(doc.searchText, term))
    );
  });

  const results = filtered
    .sort((left, right) => scoreDocument(right, parsed) - scoreDocument(left, parsed))
    .slice(0, limit)
    .map((doc) => documentToResult(doc, queryTerms));

  return {
    query,
    chips,
    results,
    freeText: parsed.freeText,
  };
}
