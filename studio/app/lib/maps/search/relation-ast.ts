import aliasSpec from "./map-search-aliases.json";
import { normalizeForSearch, type SearchObjectFamily } from "./map-search-corpus";
import { escapeRegExp, matchesTerm, SEARCH_STOPWORDS } from "./search-constants";

/**
 * Relation-aware AST for map search queries.
 *
 * Isomorphic (client + server). Extends the existing phrase-precedence
 * tokenization in map-search.ts with a single-scan pass that also picks up
 * relation operators ("near", "adjacent to", "within 100m"). When a relation
 * span is found, tokens on either side are attributed to the subject and
 * object halves; otherwise the whole query becomes a subject with no relation
 * and the result degrades to the legacy text search unchanged.
 */

export type RelationOp =
  | "near"
  | "adjacent_to"
  | "within"
  | "leads_to"
  | "connected_to"
  | "upstream_of"
  | "downstream_of";

/** Operator classes — `spatial` resolves via RTree; `topology` via graph BFS. */
export type RelationOpKind = "spatial" | "topology";

const TOPOLOGY_OPS: ReadonlySet<RelationOp> = new Set([
  "leads_to",
  "connected_to",
  "upstream_of",
  "downstream_of",
]);

export function relationOpKind(op: RelationOp): RelationOpKind {
  return TOPOLOGY_OPS.has(op) ? "topology" : "spatial";
}

export interface SemanticGroupMatch {
  id: string;
  label: string;
  searchTerms: string[];
  /**
   * Authoritative anchors copied from map-search-aliases.json. When any
   * is present, the executor treats them as the sole match signals (OR
   * semantics) — see `docMatchesSemanticGroup` in map-search.ts for the
   * full semantics. Left undefined when the group has no anchor and
   * searchTerms carry the match.
   *
   * `candidateExactAttributes` differs from the others: it requires an
   * exact (whole-string) match against `doc.exactMapAttributes`, not a
   * word-bounded substring inside `doc.searchText`. Use it when the
   * search_term is a generic word that would otherwise false-match
   * compound phrases (e.g. "uncontrolled" inside "uncontrolled left turn").
   */
  candidateTagTerms?: string[];
  candidateKinds?: string[];
  candidateExactAttributes?: string[];
}

export interface ObjectIntent {
  /**
   * Exact map-element anchor. When set, this side resolves to *only* the
   * document whose `id` equals this value — families / semantic / freeText
   * are ignored entirely. Use it once an exact feature has been identified
   * (a user-confirmed candidate, a prior search_map result, or
   * inspect_location_geometry) so spatial queries stop guessing from
   * ambiguous strings like street names.
   */
  featureId?: string;
  families: SearchObjectFamily[];
  semantic: SemanticGroupMatch[];
  freeText: string[];
}

export interface RelationClause {
  op: RelationOp;
  /**
   * Explicit distance (meters) parsed from the query or provided by a
   * structured call. For `within` this is required; for `near`/`adjacent_to`
   * it overrides the default threshold.
   */
  distance_m?: number;
  object: ObjectIntent;
}

export interface ParseHint {
  code:
    | "subject_empty"
    | "object_empty"
    | "within_missing_distance"
    | "unknown_operator"
    | "direction_unavailable";
  message: string;
}

export interface ParsedMapSearchAst {
  query: string;
  subject: ObjectIntent;
  relation?: RelationClause;
  hints: ParseHint[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Alias loading
// ─────────────────────────────────────────────────────────────────────────────

interface AliasSpec {
  numeric_normalization: Record<string, string>;
  object_families: Record<SearchObjectFamily, { label: string; aliases: string[] }>;
  semantic_terms: Array<{
    id: string;
    label: string;
    aliases: string[];
    search_terms: string[];
    candidate_tags?: string[];
    candidate_kinds?: string[];
    exact_attributes?: string[];
  }>;
  relation_terms?: Array<{
    id: string;
    op: RelationOp;
    label: string;
    aliases: string[];
    expects_distance?: boolean;
  }>;
}

const SPEC = aliasSpec as AliasSpec;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
//
// escapeRegExp + matchesTerm imported from ./search-constants — single source
// of truth shared with map-search.ts and relation-executor.ts. `findAllSpans`
// stays local because it's the only consumer of span-based matching (used to
// locate the relation operator's position in the query for text slicing).

/**
 * Word-boundary-aware substring finder. Returns all non-overlapping spans of
 * `term` in `text` where the term is not wedged inside a larger word.
 */
function findAllSpans(text: string, term: string): Array<{ start: number; end: number }> {
  if (!term) return [];
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(`(^|\\b)${escapeRegExp(term)}(\\b|$)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // m.index is the start of the match including the leading boundary anchor.
    // Re-compute the span covering only the term itself so slicing is stable.
    const leadingBoundaryLen = m[1] ? m[1].length : 0;
    const start = m.index + leadingBoundaryLen;
    spans.push({ start, end: start + term.length });
    if (re.lastIndex === m.index) re.lastIndex += 1; // guard against zero-width loops
  }
  return spans;
}

// ─────────────────────────────────────────────────────────────────────────────
// Relation span detection
// ─────────────────────────────────────────────────────────────────────────────

interface RelationSpanMatch {
  op: RelationOp;
  alias: string;
  start: number;
  end: number;
  /** True if the operator alias grammatically expects a distance (e.g. `within`). */
  expectsDistance: boolean;
}

function findRelationSpans(normalized: string): RelationSpanMatch[] {
  const out: RelationSpanMatch[] = [];
  for (const term of SPEC.relation_terms ?? []) {
    for (const rawAlias of term.aliases) {
      const alias = normalizeForSearch(rawAlias);
      for (const span of findAllSpans(normalized, alias)) {
        out.push({
          op: term.op,
          alias,
          start: span.start,
          end: span.end,
          expectsDistance: term.expects_distance === true,
        });
      }
    }
  }
  return out;
}

/**
 * Pick the "dominant" relation span. Longest-match-wins; ties broken by the
 * earliest start so "within" beats "in" and the first of two equal-length
 * matches is the anchor. Returns `null` if no relation was found.
 */
function pickDominantRelationSpan(spans: RelationSpanMatch[]): RelationSpanMatch | null {
  if (spans.length === 0) return null;
  return spans.slice().sort((a, b) => {
    const lenDiff = b.alias.length - a.alias.length;
    if (lenDiff !== 0) return lenDiff;
    return a.start - b.start;
  })[0]!;
}

/**
 * Parse a trailing distance clause like "100m", "50 meters", "75 m" starting
 * at the character after the operator alias. Returns the distance in meters
 * plus the character offset where the clause ends (so it can be excised from
 * the object half of the query), or null if no distance is present.
 */
function parseDistanceAfter(
  normalized: string,
  startIndex: number,
): { distance_m: number; consumedUntil: number } | null {
  const tail = normalized.slice(startIndex);
  const re = /^\s*(\d+(?:\.\d+)?)\s*(m|meters?|metres?)?\b/;
  const m = re.exec(tail);
  if (!m) return null;
  const value = Number.parseFloat(m[1]!);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { distance_m: value, consumedUntil: startIndex + m[0].length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Object-intent parsing for a single half of the query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stopwords that add no signal on their own. Relation operators ("near",
 * "around", "by") are consumed by the relation scanner before object-intent
 * parsing runs, so seeing them again here is a no-op — using the shared
 * SEARCH_STOPWORDS set is still safe.
 */
const INTENT_STOPWORDS = SEARCH_STOPWORDS;

interface SemanticAliasMatch {
  groupId: string;
  label: string;
  searchTerms: string[];
  candidateTagTerms?: string[];
  candidateKinds?: string[];
  candidateExactAttributes?: string[];
  alias: string;
}

function parseObjectIntent(text: string): ObjectIntent {
  const normalized = normalizeForSearch(text).trim();
  if (!normalized) {
    return { families: [], semantic: [], freeText: [] };
  }

  const families: SearchObjectFamily[] = [];
  const familySet = new Set<SearchObjectFamily>();
  const consumed = new Set<string>();

  // Collect every (group, alias) match first so phrase-level overlap with
  // family aliases can be resolved (e.g. "road" inside "steep road"). This
  // mirrors the precedence logic that already lived in map-search.ts#parseQuery.
  const groupMatches: SemanticAliasMatch[] = [];
  for (const semanticTerm of SPEC.semantic_terms) {
    const aliases = semanticTerm.aliases.map(normalizeForSearch);
    const searchTerms = semanticTerm.search_terms.map(normalizeForSearch);
    const candidateTagTerms = semanticTerm.candidate_tags?.map(normalizeForSearch);
    const candidateKinds = semanticTerm.candidate_kinds?.map((kind) => kind.toLowerCase());
    const candidateExactAttributes = semanticTerm.exact_attributes?.map(normalizeForSearch);
    for (const alias of aliases) {
      if (matchesTerm(normalized, alias)) {
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
  const looksLikeStreetAddress = /^\d+\s/.test(normalized);
  const numericSemanticMatched = groupMatches.some((gm) => /^\d+\s/.test(gm.alias));
  const treatAsAddress = looksLikeStreetAddress && !numericSemanticMatched;

  if (treatAsAddress) {
    families.push("address");
    familySet.add("address");
    // Drop semantic matches the user did not actually ask for — these were
    // suffix-word collisions (e.g. `arterial_road` via "avenue") that would
    // otherwise hard-filter address documents out via `docMatchesSemanticGroup`.
    groupMatches.length = 0;
  } else {
    for (const [family, spec] of Object.entries(SPEC.object_families) as Array<
      [SearchObjectFamily, { label: string; aliases: string[] }]
    >) {
      const aliases = spec.aliases.map(normalizeForSearch);
      for (const term of aliases) {
        if (!matchesTerm(normalized, term)) continue;
        // Skip a family alias whose match is entirely contained in a longer
        // semantic alias — keeps "steep road" from spuriously adding family:street.
        const spannedByLongerSemantic = groupMatches.some(
          (gm) => gm.alias.length > term.length && gm.alias.includes(term),
        );
        if (spannedByLongerSemantic) continue;
        if (!familySet.has(family)) {
          families.push(family);
          familySet.add(family);
        }
        consumed.add(term);
      }
    }
  }

  // Resolve semantic-group overlaps (e.g. "bike_merge" wins over "conflict"
  // when the alias literally contains the shorter one's alias).
  const effectiveMatches = groupMatches.filter((m) => {
    return !groupMatches.some(
      (other) =>
        other.groupId !== m.groupId &&
        other.alias.length > m.alias.length &&
        other.alias.includes(m.alias),
    );
  });

  const semanticById = new Map<string, SemanticGroupMatch>();
  for (const m of effectiveMatches) {
    semanticById.set(m.groupId, {
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

  const freeText = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !INTENT_STOPWORDS.has(token))
    .filter((token) => {
      for (const term of consumed) {
        const normalizedTerm = normalizeForSearch(term);
        if (
          token === normalizedTerm ||
          token.includes(normalizedTerm) ||
          normalizedTerm.includes(token)
        ) {
          return false;
        }
      }
      return true;
    });

  return { families, semantic: [...semanticById.values()], freeText };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a free-text query into a relation-aware AST. When no relation operator
 * is present, `relation` is undefined and the caller should delegate to the
 * legacy text-only ranking. When present, the subject and object halves are
 * populated independently so the relation executor can retrieve each side.
 */
export function parseMapSearchToAst(query: string): ParsedMapSearchAst {
  const normalized = normalizeForSearch(query);
  const hints: ParseHint[] = [];

  const dominant = pickDominantRelationSpan(findRelationSpans(normalized));
  if (!dominant) {
    return {
      query,
      subject: parseObjectIntent(normalized),
      hints,
    };
  }

  let rightStart = dominant.end;
  let distance_m: number | undefined;

  if (dominant.expectsDistance) {
    const parsedDistance = parseDistanceAfter(normalized, rightStart);
    if (parsedDistance) {
      distance_m = parsedDistance.distance_m;
      rightStart = parsedDistance.consumedUntil;
    } else {
      hints.push({
        code: "within_missing_distance",
        message: `"${dominant.alias}" expects a distance (e.g. "within 100m"). Falling back to text search.`,
      });
      // Drop the relation entirely — we can't run a meaningful `within` query.
      return {
        query,
        subject: parseObjectIntent(normalized),
        hints,
      };
    }
  }

  const leftText = normalized.slice(0, dominant.start);
  const rightText = normalized.slice(rightStart);

  const subject = parseObjectIntent(leftText);
  const object = parseObjectIntent(rightText);

  const subjectEmpty =
    subject.families.length === 0 &&
    subject.semantic.length === 0 &&
    subject.freeText.length === 0;
  const objectEmpty =
    object.families.length === 0 &&
    object.semantic.length === 0 &&
    object.freeText.length === 0;

  if (subjectEmpty || objectEmpty) {
    if (subjectEmpty) {
      hints.push({
        code: "subject_empty",
        message: `"${dominant.alias}" with no subject on the left. Running a plain-text search over the remainder.`,
      });
    }
    if (objectEmpty) {
      hints.push({
        code: "object_empty",
        message: `"${dominant.alias}" with no object on the right. Stripping the operator and running a plain-text search.`,
      });
    }
    // Fall back: run a plain text search over the whole query minus the operator.
    const stripped = `${leftText} ${rightText}`.trim();
    return {
      query,
      subject: parseObjectIntent(stripped),
      hints,
    };
  }

  // Directional topology ops (`leads_to`, `upstream_of`, `downstream_of`) carry
  // traffic-flow semantics in the language but the current sidecar stores
  // every edge as `direction: "both"` (no lane-aware flow data yet). The
  // graph index's forward/reverse indices therefore converge on the same set,
  // making these ops effectively equivalent to `connected_to`. Flag that
  // clearly so users typing "A before B" aren't surprised by an undirected
  // result. Remove this hint once directional edges land.
  if (
    dominant.op === "leads_to" ||
    dominant.op === "upstream_of" ||
    dominant.op === "downstream_of"
  ) {
    hints.push({
      code: "direction_unavailable",
      message: `"${dominant.alias}" implies traffic-flow direction, but the map graph is currently undirected — results include every reachable neighbor regardless of flow (equivalent to "connected to").`,
    });
  }

  return {
    query,
    subject,
    relation: {
      op: dominant.op,
      distance_m,
      object,
    },
    hints,
  };
}

/**
 * True if an object intent contributes any positive signal — at least one
 * family, one semantic group, or one free-text token. Used by callers that
 * want to short-circuit when a structured query arrives with an empty subject.
 */
export function isObjectIntentEmpty(intent: ObjectIntent): boolean {
  return (
    !intent.featureId &&
    intent.families.length === 0 &&
    intent.semantic.length === 0 &&
    intent.freeText.length === 0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured-input AST builder
// ─────────────────────────────────────────────────────────────────────────────
//
// Companion entry point to `parseMapSearchToAst`. Where the parser tokenizes
// a free-text query and infers families / semantic groups / relation spans,
// this builder accepts a pre-decomposed structured shape — usually emitted
// by the LLM tier that has already done the natural-language understanding.
// The output AST is identical in shape and feeds the same executor, so
// downstream code (relation executor, text-only ranker, chip builder)
// doesn't care which entry point produced it.
//
// Semantic ids are looked up against `map-search-aliases.json`; unknown ids
// are silently dropped with a hint so the caller can surface the issue
// without aborting the search. Free-text tokens are normalized but not
// further parsed — the caller has already decided what's a subject and
// what's a residual phrase.
//
// Multi-subject AND/OR semantics are out of scope here; the structured
// shape mirrors the current single-intent model so it can be extended
// later without rewriting any consumer.

export interface StructuredObjectIntent {
  /**
   * Exact map-element id (e.g. 'junction:1045' or a candidateId). When set,
   * the query is pinned to exactly that feature and families / semantic /
   * freeText on this side are ignored. Prefer this over street-name
   * freeText whenever an exact feature has already been identified.
   */
  featureId?: string;
  /** Object families ('junction' | 'street' | 'poi'). */
  families?: SearchObjectFamily[];
  /**
   * Semantic group ids from `map-search-aliases.json#semantic_terms[].id`
   * (e.g. 'parking_lot', 'school', 'signalized', 'four_way'). Members of
   * one intent are AND'd against the corpus — every group must match.
   */
  semantic?: string[];
  /**
   * Residual free-text tokens to fold into match scoring. Normalized
   * (lowercased, numeric word folding) but not further parsed.
   */
  freeText?: string[];
}

export interface StructuredRelationClause {
  op: RelationOp;
  /** Required for `within`; optional override for other ops. */
  distance_m?: number;
  object: StructuredObjectIntent;
}

export interface StructuredSearchInput {
  subject: StructuredObjectIntent;
  relation?: StructuredRelationClause;
}

/**
 * Build a `SemanticGroupMatch` (the executor-facing shape) from a semantic
 * id by looking up the aliases JSON. Returns null when the id isn't known.
 */
function lookupSemanticGroupById(id: string): SemanticGroupMatch | null {
  const term = SPEC.semantic_terms.find((t) => t.id === id);
  if (!term) return null;
  return {
    id: term.id,
    label: term.label,
    searchTerms: term.search_terms.map(normalizeForSearch),
    ...(term.candidate_tags
      ? { candidateTagTerms: term.candidate_tags.map(normalizeForSearch) }
      : {}),
    ...(term.candidate_kinds
      ? { candidateKinds: term.candidate_kinds.map((k) => k.toLowerCase()) }
      : {}),
    ...(term.exact_attributes
      ? { candidateExactAttributes: term.exact_attributes.map(normalizeForSearch) }
      : {}),
  };
}

function buildIntent(
  input: StructuredObjectIntent,
  hints: ParseHint[],
  side: "subject" | "object",
): ObjectIntent {
  const semantic: SemanticGroupMatch[] = [];
  const seenIds = new Set<string>();
  for (const id of input.semantic ?? []) {
    if (seenIds.has(id)) continue;
    const match = lookupSemanticGroupById(id);
    if (!match) {
      hints.push({
        code: "unknown_operator",
        message: `Unknown semantic id '${id}' on ${side}; ignored.`,
      });
      continue;
    }
    seenIds.add(id);
    semantic.push(match);
  }
  const freeText = (input.freeText ?? [])
    .map((t) => normalizeForSearch(t))
    .filter((t) => t.length > 0);
  const featureId = input.featureId?.trim();
  return {
    ...(featureId ? { featureId } : {}),
    families: [...(input.families ?? [])],
    semantic,
    freeText,
  };
}

/**
 * Build a `ParsedMapSearchAst` from a structured input shape. Symmetric to
 * `parseMapSearchToAst` but skips tokenization — the caller has already
 * decomposed the user's intent into subject + relation + object. The
 * returned AST is dispatched to the same executor downstream.
 *
 * `originalQuery` is an optional prose form of the structured input,
 * passed by the natural-language wrapper (`searchMapLocations` →
 * `searchMapLocationsStructured`) so:
 *   (a) the result's `query` field surfaces what the user typed instead
 *       of the stringified structured form, and
 *   (b) the legacy text-search fallback (no-relation queries) tokenizes
 *       the original prose, preserving pre-refactor ranking behavior.
 * Direct structured callers omit it; the deterministic stringification
 * is used as the AST's `query` instead.
 */
export function buildAstFromStructured(
  input: StructuredSearchInput,
  originalQuery?: string,
): ParsedMapSearchAst {
  const hints: ParseHint[] = [];
  const subject = buildIntent(input.subject, hints, "subject");

  let relation: RelationClause | undefined;
  if (input.relation) {
    if (input.relation.op === "within" && input.relation.distance_m == null) {
      hints.push({
        code: "within_missing_distance",
        message: `'within' requires distance_m; structured relation dropped.`,
      });
    } else {
      relation = {
        op: input.relation.op,
        ...(input.relation.distance_m != null
          ? { distance_m: input.relation.distance_m }
          : {}),
        object: buildIntent(input.relation.object, hints, "object"),
      };
    }
  }

  return {
    query: originalQuery ?? stringifyStructuredInput(input),
    subject,
    relation,
    hints,
  };
}

/**
 * Adapter that turns a free-text query into a `StructuredSearchInput`.
 * The natural-language layer's only responsibility — once a query is
 * parsed to structured, every downstream concern (corpus loading, AST
 * construction, executor dispatch, legacy text fallback) lives in the
 * structured path. Improvements to either layer are independent: a
 * smarter parser doesn't touch the executor, and a new executor feature
 * doesn't require parser changes (only an aliases.json update if the
 * feature surfaces a new semantic id the user might type).
 *
 * Internally delegates to `parseMapSearchToAst` and projects the AST's
 * `SemanticGroupMatch` shape down to bare semantic ids — the executor
 * re-resolves them via `buildAstFromStructured` so we don't carry two
 * representations of the same lookup.
 */
export function parseMapSearchToStructured(query: string): {
  structured: StructuredSearchInput;
  parserHints: ParseHint[];
} {
  const ast = parseMapSearchToAst(query);
  const subject: StructuredObjectIntent = {
    families: [...ast.subject.families],
    semantic: ast.subject.semantic.map((s) => s.id),
    freeText: [...ast.subject.freeText],
  };
  let relation: StructuredRelationClause | undefined;
  if (ast.relation) {
    relation = {
      op: ast.relation.op,
      ...(ast.relation.distance_m != null
        ? { distance_m: ast.relation.distance_m }
        : {}),
      object: {
        families: [...ast.relation.object.families],
        semantic: ast.relation.object.semantic.map((s) => s.id),
        freeText: [...ast.relation.object.freeText],
      },
    };
  }
  return {
    structured: relation ? { subject, relation } : { subject },
    parserHints: ast.hints,
  };
}

/**
 * Compose a human-readable query string from a structured input. Used as
 * `ast.query` so chips / hint messages / logs read the same way they would
 * for a free-text query like 'parking lot near a school'.
 */
function stringifyStructuredInput(input: StructuredSearchInput): string {
  const left = stringifyIntent(input.subject);
  if (!input.relation) return left || "[empty]";
  const op = input.relation.op.replace(/_/g, " ");
  const distance =
    input.relation.distance_m != null ? ` ${input.relation.distance_m}m of` : "";
  const right = stringifyIntent(input.relation.object);
  return `${left} ${op}${distance} ${right}`.trim();
}

function stringifyIntent(input: StructuredObjectIntent): string {
  const parts: string[] = [];
  if (input.featureId?.trim()) parts.push(input.featureId.trim());
  for (const family of input.families ?? []) parts.push(family);
  for (const id of input.semantic ?? []) parts.push(id.replace(/_/g, " "));
  for (const tok of input.freeText ?? []) parts.push(tok);
  return parts.join(" ");
}
