import type {
  CandidateLocation,
  MapAssetEnrichmentSnapshot,
  MapOverlayLayer,
  MapOverlayLayerId,
  MapSearchIndex,
  MapSearchIndexObject,
} from "@simcloud/shared";
import aliasSpec from "./map-search-aliases.json";
import {
  objectFamilyForCandidateKind,
  type SearchObjectFamily,
} from "./classification-thresholds";
import {
  asFeatureCollection,
  featureMapId,
  FEATURE_ADDRESS_KEYS,
  FEATURE_AMENITY_KEYS,
  FEATURE_NAME_KEYS,
  JUNCTION_ID_KEYS,
  JUNCTION_NAME_KEYS,
  CONNECTING_ROADS_KEYS,
  LANE_LENGTH_KEYS,
  overlayFeatureIdString,
  propNumber,
  propString,
  ROAD_ID_KEYS,
  ROAD_NAME_KEYS,
  type GeoJSONFeature,
  type GeoJSONFeatureCollection,
} from "./geojson-props";
import { humanizeTag } from "@/app/lib/scenario-intelligence-ui";
import { isPedestrianSpawnCandidate } from "@simcloud/shared";

export type { SearchObjectFamily };

export type SearchSourceKind =
  | "candidate_location"
  | "road_network_junction"
  | "road_network_street"
  | "overlay_poi";

export interface MapSearchDocumentGeometryRef {
  kind: "candidate" | "geojson_feature" | "overlay_feature" | "road_aggregate";
  candidateId?: string;
  geojsonFeatureId?: number;
  geojsonFeatureIds?: number[];
  overlayLayerId?: MapOverlayLayerId;
  overlayFeatureId?: string;
}

export interface MapSearchDocument {
  id: string;
  sourceKind: SearchSourceKind;
  objectFamily: SearchObjectFamily;
  subtype: string;
  /**
   * Raw object kind — `CandidateLocation.kind` on the legacy path,
   * `MapSearchIndexObject.kind` on the sidecar path. Carries the stable
   * identity attribute used by semantic groups that match on kind rather
   * than extractor-specific tags (e.g. `street_parking` resolves every
   * kind=street_parking candidate regardless of which detector tagged it).
   */
  kind?: string;
  label: string;
  description: string;
  /** Pre-normalized text blob used as the scoring/filtering haystack. */
  searchText: string;
  exactMapAttributes: string[];
  relatedObjects: string[];
  scenarioTags: string[];
  /** Baseline confidence in the 0–1 range used to seed scoring. */
  candidateConfidence: number;
  rank?: number;
  /** CandidateLocation.id — set only when this document is backed by a candidate. */
  candidateId?: string;
  /**
   * Typed detector facts (numbers/booleans) for ranking — see
   * `MapSearchDocumentFacts`. Present on candidate-backed documents; absent on
   * pure-geometry docs (raw GeoJSON junctions/streets with no candidate).
   */
  facts?: MapSearchDocumentFacts;
  geometryReference: MapSearchDocumentGeometryRef;
}

export interface MapSearchInputs {
  candidates: CandidateLocation[];
  roadNetwork?: object | null;
  enrichment?: MapAssetEnrichmentSnapshot | null;
}

// ---------------------------------------------------------------------------
// Shared normalization helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Typed projection of `map-search-aliases.json`
// ---------------------------------------------------------------------------
//
// Every table the corpus reads from the alias JSON is declared here once, so
// new callers pick up type-checked shapes and a single file describes the
// full metadata schema — no hunting through code for "which tag produces
// which badge". Adding a new table means extending this type + the JSON.

interface RoadSegmentSubtypeRule {
  tag: string;
  subtype: string;
}

type TagMatchKind = "exact" | "substring";

interface TagFactRule {
  match: TagMatchKind;
  tag: string;
  facts: string[];
}

interface OverlayLayerMeta {
  subtype: string;
  family_terms: string[];
}

type AliasSpecShape = {
  numeric_normalization?: Record<string, string>;
  street_suffix_normalization?: Record<string, string>;
  candidate_subtypes?: Record<string, string>;
  sidecar_subtypes?: Record<string, string>;
  road_segment_subtype_by_tag?: RoadSegmentSubtypeRule[];
  road_segment_badges_by_tag?: Record<string, string[]>;
  left_turn_phrases_by_tag?: Record<string, string[]>;
  tag_facts?: TagFactRule[];
  tag_facts_exceptions?: Record<string, string[]>;
  kind_facts?: Record<string, string[]>;
  fact_related_objects?: Record<string, string>;
  fact_value_badges?: Record<string, Record<string, string[]>>;
  fact_value_badges_by_kind?: Record<string, Record<string, Record<string, string[]>>>;
  fact_true_badges?: Record<string, string[]>;
  overlay_layer_metadata?: Partial<Record<MapOverlayLayerId, OverlayLayerMeta>>;
};

const ALIAS_SPEC = aliasSpec as AliasSpecShape;

// Pre-tokenizer word → digit map. Keeping it in JSON lets alias tooling (and
// any future non-TS consumer) read one list; this const is the typed view.
const NUMERIC_WORDS: Record<string, string> = ALIAS_SPEC.numeric_normalization ?? {};

// USPS street-suffix abbreviations → canonical long form. Applied on both
// indexed text and parsed query tokens so "600 clipper dr" and "600 clipper
// drive" converge to the same canonical "600 clipper drive". Always rewrite
// to the long form so legitimate building names containing the long form
// (e.g. "Stanford Drive Building") still match short queries unchanged.
const STREET_SUFFIX_WORDS: Record<string, string> =
  ALIAS_SPEC.street_suffix_normalization ?? {};

/** CandidateLocation.kind → display subtype (legacy corpus). */
const CANDIDATE_SUBTYPES: Record<string, string> = ALIAS_SPEC.candidate_subtypes ?? {};

/**
 * MapSearchIndexObject.kind → display subtype (sidecar corpus). The sidecar
 * enum is a superset of CandidateLocationKind (adds `street`, `street_segment`,
 * `road_segment_feature`) so it keeps its own table.
 */
const SIDECAR_SUBTYPES: Record<string, string> = ALIAS_SPEC.sidecar_subtypes ?? {};

/** Priority-ordered tag → subtype rules for road_segment candidates. First match wins. */
const ROAD_SEGMENT_SUBTYPE_RULES: RoadSegmentSubtypeRule[] =
  ALIAS_SPEC.road_segment_subtype_by_tag ?? [];

/** Tag → extra badges for sidecar road_segment_feature objects. */
const ROAD_SEGMENT_BADGES_BY_TAG: Record<string, string[]> =
  ALIAS_SPEC.road_segment_badges_by_tag ?? {};

/** Protected / unprotected left-turn tag → search phrase list. */
const LEFT_TURN_PHRASES_BY_TAG: Record<string, string[]> =
  ALIAS_SPEC.left_turn_phrases_by_tag ?? {};

/** Tag → fact rules. `exact` matches the literal tag; `substring` matches any tag containing the value. */
const TAG_FACT_RULES: TagFactRule[] = ALIAS_SPEC.tag_facts ?? [];

/** Exceptions to `substring` rules — tags listed here skip the substring rule of the same key. */
const TAG_FACT_EXCEPTIONS: Record<string, string[]> = ALIAS_SPEC.tag_facts_exceptions ?? {};

/** CandidateLocation.kind → implicit facts added regardless of tag content. */
const KIND_FACTS: Record<string, string[]> = ALIAS_SPEC.kind_facts ?? {};

/** Fact string → related-object label (what shows up in `relatedObjects` when that fact appears). */
const FACT_RELATED_OBJECTS: Record<string, string> = ALIAS_SPEC.fact_related_objects ?? {};

/** Sidecar fact key + string value → badge strings. Covers enum remaps like control_type=traffic_light → "signalized". */
const FACT_VALUE_BADGES: Record<string, Record<string, string[]>> =
  ALIAS_SPEC.fact_value_badges ?? {};

/**
 * Per-object-kind override for `fact_value_badges`. Used when the same fact
 * key carries different semantics on different object kinds — e.g. POI
 * `size_class` is parking-lot-specific while junction `size_class` describes
 * intersection footprint area. The kind-keyed entry takes precedence; if a
 * given kind has no override for a key, the global `fact_value_badges` entry
 * is used.
 */
const FACT_VALUE_BADGES_BY_KIND: Record<string, Record<string, Record<string, string[]>>> =
  ALIAS_SPEC.fact_value_badges_by_kind ?? {};

/** Sidecar fact key → badge strings emitted when the value is literally `true`. */
const FACT_TRUE_BADGES: Record<string, string[]> = ALIAS_SPEC.fact_true_badges ?? {};

/** overlay layer_id → display metadata (subtype + family terms folded into searchText). */
const OVERLAY_LAYER_METADATA: Partial<Record<MapOverlayLayerId, OverlayLayerMeta>> =
  ALIAS_SPEC.overlay_layer_metadata ?? {};

export function normalizeForSearch(value: string): string {
  let normalized = value.trim().toLowerCase();
  for (const [word, replacement] of Object.entries(NUMERIC_WORDS)) {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, "g"), replacement);
  }
  for (const [abbrev, longForm] of Object.entries(STREET_SUFFIX_WORDS)) {
    normalized = normalized.replace(new RegExp(`\\b${abbrev}\\b\\.?`, "g"), longForm);
  }
  return normalized.replace(/\s+/g, " ");
}

function buildSearchText(parts: Array<string | null | undefined>): string {
  return normalizeForSearch(parts.filter((p): p is string => Boolean(p)).join(" "));
}

// ---------------------------------------------------------------------------
// Candidate-location normalization (unchanged fact extraction)
// ---------------------------------------------------------------------------

/**
 * Pick a user-facing subtype for a road-segment candidate based on which tag
 * the road-detector emitted. Rules come from `road_segment_subtype_by_tag`
 * in the alias JSON, priority-ordered (first match wins — most distinctive
 * tags go first). Returns null when nothing matched; the caller then falls
 * back to the baseline subtype.
 */
function roadSegmentSubtype(candidate: CandidateLocation): string | null {
  const tagSet = new Set(candidate.tags);
  for (const rule of ROAD_SEGMENT_SUBTYPE_RULES) {
    if (tagSet.has(rule.tag)) return rule.subtype;
  }
  return null;
}

function subtypeForCandidate(candidate: CandidateLocation): string {
  // road_segment overrides with a tag-specific subtype ("Steep road",
  // "Bike merge corridor", …) when the detector flagged one. Otherwise the
  // JSON-sourced map gives the generic kind label.
  if (candidate.kind === "road_segment") {
    return roadSegmentSubtype(candidate) ?? CANDIDATE_SUBTYPES[candidate.kind] ?? "Map object";
  }
  return CANDIDATE_SUBTYPES[candidate.kind] ?? "Map object";
}

/**
 * Walk the JSON-driven `tag_facts` table and emit every fact whose rule
 * matches one of the candidate's tags. `exact` rules require an equality
 * match; `substring` rules fire on `tag.includes(...)` unless the tag is
 * listed in `tag_facts_exceptions` for that key (e.g. "PARKING" as a
 * substring rule adds "curb parking", but not for PARKING_LOT_*_ACCESS
 * which already match more specific exact rules). The exceptions table
 * is what keeps the substring fallback from double-tagging.
 */
function factsForTags(tags: readonly string[]): string[] {
  const tagSet = new Set(tags);
  const out = new Set<string>();
  for (const rule of TAG_FACT_RULES) {
    const exceptions = TAG_FACT_EXCEPTIONS[rule.tag] ?? [];
    if (rule.match === "exact") {
      if (!tagSet.has(rule.tag)) continue;
    } else {
      let hit = false;
      for (const tag of tags) {
        if (!tag.includes(rule.tag)) continue;
        if (exceptions.includes(tag)) continue;
        hit = true;
        break;
      }
      if (!hit) continue;
    }
    for (const fact of rule.facts) out.add(fact);
  }
  return [...out];
}

/**
 * Typed, machine-readable subset of a candidate's detector facts, surfaced on
 * `MapSearchDocument.facts` so a consumer can rank on the NUMBERS (not just the
 * humanized strings in `searchText`). This is the shared seam that lets the
 * map-search panel and the deterministic `findCollisionSites` site enumerator
 * read the same source: keyword search uses `searchText`; fit-ranking reads
 * these. Additive — `searchText` still carries the humanized facts.
 *
 * Fields are the detector evidence primitives most useful for collision-site
 * fit (junction shape + pedestrian-spawn affordance); occlusion fields ride
 * along for later families. snake_case primitives → camelCase here.
 */
export interface MapSearchDocumentFacts {
  approachCount?: number;
  gateCount?: number;
  internalLaneCount?: number;
  polygonAreaSqm?: number;
  hasSignal?: boolean;
  hasStopSign?: boolean;
  isAllWayStop?: boolean;
  isTIntersection?: boolean;
  isComplex?: boolean;
  pedestrianSpawn?: boolean;
  occlusionSubtype?: string;
  severity?: "low" | "medium" | "high";
}

function numberFact(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolFact(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Merge every detector's primitives into one lookup (later evidence wins). */
function mergedPrimitives(candidate: CandidateLocation): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const entry of candidate.evidence) {
    Object.assign(merged, entry.primitives as Record<string, unknown>);
  }
  return merged;
}

/**
 * Build the typed facts from a candidate's raw detector primitives. Used by both
 * corpus paths (sidecar objects are candidate-backed too), so the typed numbers
 * are identical regardless of how the document was assembled.
 */
export function documentFactsFromCandidate(
  candidate: CandidateLocation,
): MapSearchDocumentFacts {
  const p = mergedPrimitives(candidate);
  const facts: MapSearchDocumentFacts = {};
  const approachCount = numberFact(p.approach_count);
  if (approachCount !== undefined) facts.approachCount = approachCount;
  const gateCount = numberFact(p.gate_count);
  if (gateCount !== undefined) facts.gateCount = gateCount;
  const internalLaneCount = numberFact(p.internal_lane_count);
  if (internalLaneCount !== undefined) facts.internalLaneCount = internalLaneCount;
  const polygonAreaSqm = numberFact(p.polygon_area_sqm);
  if (polygonAreaSqm !== undefined) facts.polygonAreaSqm = polygonAreaSqm;
  const hasSignal = boolFact(p.has_signal);
  if (hasSignal !== undefined) facts.hasSignal = hasSignal;
  const hasStopSign = boolFact(p.has_stop_sign);
  if (hasStopSign !== undefined) facts.hasStopSign = hasStopSign;
  const isAllWayStop = boolFact(p.is_all_way_stop);
  if (isAllWayStop !== undefined) facts.isAllWayStop = isAllWayStop;
  const isTIntersection = boolFact(p.is_t_intersection);
  if (isTIntersection !== undefined) facts.isTIntersection = isTIntersection;
  const isComplex = boolFact(p.is_complex);
  if (isComplex !== undefined) facts.isComplex = isComplex;
  if (typeof p.occlusion_subtype === "string") {
    facts.occlusionSubtype = p.occlusion_subtype;
  }
  if (p.severity === "low" || p.severity === "medium" || p.severity === "high") {
    facts.severity = p.severity;
  }
  if (isPedestrianSpawnCandidate(candidate)) facts.pedestrianSpawn = true;
  return facts;
}

/**
 * Fallback typed facts for a sidecar object with no backing candidate (rare —
 * e.g. a road-network junction object on a partially-backfilled map). Derives
 * from the sidecar's own curated junction/POI facts, which are thinner than raw
 * candidate evidence (no gate_count / area) but enough for coarse ranking.
 */
function documentFactsFromIndexObject(
  obj: MapSearchIndexObject,
): MapSearchDocumentFacts {
  const f = obj.facts as Record<string, unknown>;
  const facts: MapSearchDocumentFacts = {};
  const approachCount = numberFact(f.approach_count);
  if (approachCount !== undefined) facts.approachCount = approachCount;
  const hasSignal = boolFact(f.has_signal) ?? boolFact(f.is_signalized);
  if (hasSignal !== undefined) facts.hasSignal = hasSignal;
  const hasStopSign = boolFact(f.has_stop_sign);
  if (hasStopSign !== undefined) facts.hasStopSign = hasStopSign;
  const isAllWayStop = boolFact(f.is_all_way_stop);
  if (isAllWayStop !== undefined) facts.isAllWayStop = isAllWayStop;
  const isTIntersection = boolFact(f.is_t_intersection);
  if (isTIntersection !== undefined) facts.isTIntersection = isTIntersection;
  if (typeof f.occlusion_subtype === "string") facts.occlusionSubtype = f.occlusion_subtype;
  if (f.severity === "low" || f.severity === "medium" || f.severity === "high") {
    facts.severity = f.severity;
  }
  if (boolFact(f.pedestrian_spawn)) facts.pedestrianSpawn = true;
  return facts;
}

export function collectCandidatePrimitiveFacts(candidate: CandidateLocation): string[] {
  const primitives = candidate.evidence.flatMap((entry) => {
    const raw = entry.primitives as Record<string, unknown>;
    return Object.entries(raw);
  });

  const facts = new Set<string>();
  for (const [key, value] of primitives) {
    if (key === "has_signal" && value === true) facts.add("signalized");
    if (key === "has_stop_sign" && value === true) facts.add("stop-sign-controlled");
    if (key === "approach_count" && typeof value === "number") {
      facts.add(`${value}-leg`);
      if (value >= 5) facts.add("multi-leg");
      if (value === 4) facts.add("4-way");
      if (value === 3) facts.add("3-leg");
    }
    if (key === "is_t_intersection" && value === true) facts.add("T-intersection");
    if (key === "is_all_way_stop" && value === true) facts.add("all-way stop");
    if (key === "is_complex" && value === true) facts.add("complex geometry");
  }

  // leftTurnPhrasesForTags returns human-readable phrases for protected /
  // unprotected left-turn tags; adding them up front (not in the per-tag
  // loop below) avoids a plain `tag.includes("PROTECTED_LEFT")` bug that
  // falsely labels TURN_UNPROTECTED_LEFT as "protected left".
  for (const phrase of leftTurnPhrasesForTags(candidate.tags)) facts.add(phrase);
  for (const fact of factsForTags(candidate.tags)) facts.add(fact);

  for (const [key, value] of primitives) {
    if (key === "access_point_count" && typeof value === "number" && value > 0) {
      facts.add(`${value} access point${value === 1 ? "" : "s"}`);
    }
    if (key === "space_count" && typeof value === "number" && value > 0 && candidate.kind === "parking_lot") {
      facts.add(`${value} parking space${value === 1 ? "" : "s"}`);
    }
    if (key === "grade_pct" && typeof value === "number" && value > 4) {
      facts.add(`${value.toFixed(0)}% grade`);
    }
  }

  for (const fact of KIND_FACTS[candidate.kind] ?? []) facts.add(fact);

  // Mirror the sidecar's `pedestrian_spawn` fact for the legacy corpus
  // path. Same canonical signal (`isPedestrianSpawnCandidate`) used in
  // both places — the legacy path emits the humanized "pedestrian spawn"
  // badge so un-backfilled maps still surface the affordance to the
  // LLM via `semantic: ["pedestrian_spawn"]` (which resolves to the
  // same badge through `fact_true_badges`).
  if (isPedestrianSpawnCandidate(candidate)) facts.add("pedestrian spawn");

  return [...facts];
}

function candidateRelatedObjects(candidate: CandidateLocation, facts: string[]): string[] {
  const related = new Set<string>();
  if (candidate.label.includes("@")) {
    for (const part of candidate.label.split("@").map((entry) => entry.trim()).filter(Boolean)) {
      related.add(part);
    }
  }
  for (const fact of facts) {
    const label = FACT_RELATED_OBJECTS[fact];
    if (label) related.add(label);
  }
  return [...related].slice(0, 3);
}

function candidateToDocument(candidate: CandidateLocation): MapSearchDocument {
  const facts = collectCandidatePrimitiveFacts(candidate);
  const description = candidate.description ?? candidate.reason ?? candidate.label;
  const related = candidateRelatedObjects(candidate, facts);

  return {
    id: candidate.id,
    sourceKind: "candidate_location",
    objectFamily: objectFamilyForCandidateKind(candidate.kind),
    subtype: subtypeForCandidate(candidate),
    kind: candidate.kind,
    label: candidate.label,
    description,
    searchText: buildSearchText([
      candidate.kind,
      candidate.source,
      candidate.label,
      candidate.description,
      candidate.reason,
      ...candidate.tags,
      ...candidate.evidence.map((entry) => entry.explanation),
      ...facts,
    ]),
    exactMapAttributes: facts,
    relatedObjects: related,
    scenarioTags: candidate.tags.map(humanizeTag).slice(0, 3),
    candidateConfidence: candidate.confidence,
    rank: candidate.rank,
    candidateId: candidate.id,
    facts: documentFactsFromCandidate(candidate),
    geometryReference: { kind: "candidate", candidateId: candidate.id },
  };
}

// ---------------------------------------------------------------------------
// Road-network GeoJSON normalization (junctions + streets)
// ---------------------------------------------------------------------------

function junctionFeatureToDocument(
  feature: GeoJSONFeature,
  coveredLabels: Set<string>,
): MapSearchDocument | null {
  const props = feature.properties ?? {};
  const junctionId = propString(props, JUNCTION_ID_KEYS);
  const name = propString(props, JUNCTION_NAME_KEYS);
  const connectingRoads = propString(props, CONNECTING_ROADS_KEYS);
  const featureMap = featureMapId(feature);

  const label = name ?? (junctionId ? `Junction ${junctionId}` : `Junction ${featureMap ?? ""}`.trim());
  if (!label) return null;
  if (coveredLabels.has(normalizeForSearch(label))) return null;

  const facts: string[] = [];
  const related: string[] = [];
  if (connectingRoads) {
    for (const road of connectingRoads.split(/[,;]/).map((s) => s.trim()).filter(Boolean).slice(0, 3)) {
      related.push(road);
    }
  }

  const docId = junctionId ? `junction:${junctionId}` : `junction:feat:${featureMap ?? label}`;
  return {
    id: docId,
    sourceKind: "road_network_junction",
    objectFamily: "junction",
    subtype: "Road junction",
    label,
    description: connectingRoads
      ? `Road junction connecting ${connectingRoads}`
      : "Road junction from map geometry",
    searchText: buildSearchText([
      "junction",
      "intersection",
      "road junction",
      label,
      junctionId,
      connectingRoads,
    ]),
    exactMapAttributes: facts,
    relatedObjects: related,
    scenarioTags: [],
    candidateConfidence: 0.5,
    geometryReference: {
      kind: "geojson_feature",
      geojsonFeatureId: featureMap,
    },
  };
}

interface StreetAggregate {
  roadKey: string;
  label: string;
  laneCount: number;
  totalLength: number;
  featureIds: number[];
  laneTypes: Set<string>;
}

function aggregateStreetFeatures(fc: GeoJSONFeatureCollection): StreetAggregate[] {
  const byRoad = new Map<string, StreetAggregate>();
  for (const feature of fc.features ?? []) {
    const props = feature.properties ?? {};
    if (props.Type !== "Lane" && props.type !== "Lane") continue;
    const laneType = String(props.LaneType ?? props.lane_type ?? "").toLowerCase();
    // Only driving lanes aggregate into the user-facing "street" result. Sidewalks,
    // bike lanes, parking lanes remain searchable via candidate locations.
    if (laneType && laneType !== "driving") continue;

    const roadId = propString(props, ROAD_ID_KEYS);
    const roadName = propString(props, ROAD_NAME_KEYS);
    const key = roadId ?? roadName;
    if (!key) continue;

    let agg = byRoad.get(key);
    if (!agg) {
      agg = {
        roadKey: key,
        label: roadName ?? `Road ${roadId}`,
        laneCount: 0,
        totalLength: 0,
        featureIds: [],
        laneTypes: new Set(),
      };
      byRoad.set(key, agg);
    }
    agg.laneCount += 1;
    const length = propNumber(props, LANE_LENGTH_KEYS);
    if (length) agg.totalLength += length;
    const mapId = featureMapId(feature);
    if (typeof mapId === "number") agg.featureIds.push(mapId);
    if (laneType) agg.laneTypes.add(laneType);
    // Prefer a human-readable RoadName over "Road <id>" if we see one later.
    if (roadName && agg.label.startsWith("Road ")) agg.label = roadName;
  }
  return [...byRoad.values()];
}

function streetAggregateToDocument(
  agg: StreetAggregate,
  coveredLabels: Set<string>,
): MapSearchDocument | null {
  if (coveredLabels.has(normalizeForSearch(agg.label))) return null;

  const facts = new Set<string>();
  if (agg.laneCount === 1) facts.add("single-lane");
  if (agg.laneCount >= 4) facts.add("multi-lane");
  if (agg.totalLength > 0) facts.add(`${Math.round(agg.totalLength)}m long`);
  const factList = [...facts];

  return {
    id: `street:${agg.roadKey}`,
    sourceKind: "road_network_street",
    objectFamily: "street",
    subtype: "Street segment",
    label: agg.label,
    description: `Street with ${agg.laneCount} driving lane${agg.laneCount === 1 ? "" : "s"}`,
    searchText: buildSearchText([
      "street",
      "road",
      "lane",
      "corridor",
      agg.label,
      agg.roadKey,
      ...factList,
    ]),
    exactMapAttributes: factList,
    relatedObjects: [],
    scenarioTags: [],
    candidateConfidence: 0.4,
    geometryReference: {
      kind: "road_aggregate",
      geojsonFeatureIds: agg.featureIds,
    },
  };
}

function roadNetworkToDocuments(
  roadNetwork: object | null | undefined,
  coveredLabels: Set<string>,
): MapSearchDocument[] {
  const fc = asFeatureCollection(roadNetwork);
  if (!fc) return [];

  const docs: MapSearchDocument[] = [];

  for (const feature of fc.features ?? []) {
    const type = feature.properties?.Type ?? feature.properties?.type;
    if (type === "Junction") {
      const doc = junctionFeatureToDocument(feature, coveredLabels);
      if (doc) docs.push(doc);
    }
  }

  for (const agg of aggregateStreetFeatures(fc)) {
    const doc = streetAggregateToDocument(agg, coveredLabels);
    if (doc) docs.push(doc);
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Overlay POI normalization
// ---------------------------------------------------------------------------
//
// Per-layer subtype + family_terms come from `overlay_layer_metadata` in the
// alias JSON — see that table for the full set. Adding a new overlay layer
// means adding one entry there, not editing this file.

function overlayFeatureToDocument(
  layer: MapOverlayLayer,
  feature: GeoJSONFeature,
  featureId: string,
): MapSearchDocument | null {
  const meta = OVERLAY_LAYER_METADATA[layer.layer_id];
  if (!meta) return null;
  const props = feature.properties ?? {};
  const label = propString(props, FEATURE_NAME_KEYS) ?? layer.label;
  const address = propString(props, FEATURE_ADDRESS_KEYS);
  const amenity = propString(props, FEATURE_AMENITY_KEYS);

  const facts: string[] = [];
  if (amenity) facts.push(amenity);

  const related: string[] = [];
  if (address) related.push(address);

  return {
    id: `poi:${layer.layer_id}:${featureId}`,
    sourceKind: "overlay_poi",
    objectFamily: "poi",
    subtype: meta.subtype,
    label,
    description: address ? `${meta.subtype} at ${address}` : meta.subtype,
    searchText: buildSearchText([
      ...meta.family_terms,
      label,
      amenity,
      address,
    ]),
    exactMapAttributes: facts,
    relatedObjects: related,
    scenarioTags: [],
    candidateConfidence: 0.45,
    geometryReference: {
      kind: "overlay_feature",
      overlayLayerId: layer.layer_id,
      overlayFeatureId: featureId,
    },
  };
}

function enrichmentToPoiDocuments(
  enrichment: MapAssetEnrichmentSnapshot | null | undefined,
): MapSearchDocument[] {
  if (!enrichment) return [];
  // Feature ids claimed by a single-feature candidate — those surface in
  // search via the candidate-backed doc with the original Overture name, so
  // skip the duplicate overlay_poi doc. Multi-feature *clusters* (e.g. five
  // bus stops collapsed into "Bus stop corridor (5 features)") carry a
  // generic label, so per-feature search recall must come from the
  // overlay_poi docs below — they don't claim anything.
  const claimed = new Set<string>();
  for (const candidate of enrichment.candidate_locations ?? []) {
    const evidence = candidate.evidence ?? [];
    const featureCount = evidence.reduce((n, ref) => n + (ref.feature_ids?.length ?? 0), 0);
    if (featureCount !== 1) continue;
    for (const ref of evidence) {
      for (const fid of ref.feature_ids ?? []) {
        claimed.add(`${ref.layer_id}:${fid}`);
      }
    }
  }

  const docs: MapSearchDocument[] = [];
  for (const layer of enrichment.overlay_payload?.layers ?? []) {
    const fc = asFeatureCollection(layer.data);
    if (!fc) continue;
    for (const feature of fc.features ?? []) {
      const fid = overlayFeatureIdString(feature);
      if (!fid) continue;
      if (claimed.has(`${layer.layer_id}:${fid}`)) continue;
      const doc = overlayFeatureToDocument(layer, feature, fid);
      if (doc) docs.push(doc);
    }
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Unified corpus builder
// ---------------------------------------------------------------------------

export function buildSearchDocuments(inputs: MapSearchInputs): MapSearchDocument[] {
  const candidateDocs = inputs.candidates.map(candidateToDocument);

  // Labels already covered by candidates — used to suppress duplicate raw junction
  // and street docs that re-surface the same place.
  const coveredLabels = new Set<string>();
  for (const doc of candidateDocs) {
    coveredLabels.add(normalizeForSearch(doc.label));
  }

  const roadDocs = roadNetworkToDocuments(inputs.roadNetwork, coveredLabels);
  const poiDocs = enrichmentToPoiDocuments(inputs.enrichment);

  return [...candidateDocs, ...roadDocs, ...poiDocs];
}

// ---------------------------------------------------------------------------
// Sidecar-backed corpus (Phase A)
// ---------------------------------------------------------------------------
//
// When a `search_index.json` sidecar is present, it is the authoritative
// source for what objects exist on the map. Each canonical object in the
// sidecar becomes exactly one search doc. Candidate-backed objects also pick
// up the candidate's scenario tags, reason, and description to keep tag- and
// reason-based queries working (e.g. `INTERSECTION_SIGNALIZED`, "steep grade").

function objectFamilyForSidecarKind(
  kind: MapSearchIndexObject["kind"],
): SearchObjectFamily {
  if (kind === "junction") return "junction";
  // road_segment_feature objects anchor to a length of road, not a
  // destination — they belong in the street family for filter + icon
  // purposes, even though the sidecar catalogs them separately.
  if (kind === "street" || kind === "street_segment" || kind === "road_segment_feature") return "street";
  if (kind === "address") return "address";
  return "poi";
}

function sidecarSubtype(
  obj: MapSearchIndexObject,
  candidate?: CandidateLocation,
): string {
  // road_segment_feature — pick a specific subtype from the candidate's
  // scenario tags ("Shared bike corridor", "Bike merge corridor", "Steep
  // road", …) so the icon + label line up with the road feature's actual
  // character. Other kinds read straight from the JSON-sourced map.
  if (obj.kind === "road_segment_feature") {
    return (candidate ? roadSegmentSubtype(candidate) : null) ?? SIDECAR_SUBTYPES[obj.kind] ?? "Map object";
  }
  return SIDECAR_SUBTYPES[obj.kind] ?? "Map object";
}

/**
 * Extra search badges for road_segment_feature POIs derived from candidate
 * scenario tags. Differentiates shared-roadway bike lanes, intersection
 * mixing zones, and protected lanes from the generic "bike lane" emitted
 * by `factsToBadges` on `bike_lane_present=true`.
 *
 * Mappings come from `road_segment_badges_by_tag` in the alias JSON. The
 * one rule that can't fit a flat table lives here: BIKE_LANE_STANDARD's
 * "dedicated bike lane" badge is suppressed when a more-specific variant
 * (shared-roadway or intersection mixing zone) is also on the candidate,
 * so the same road doesn't render as both "dedicated" and "shared".
 */
function roadSegmentExtraBadges(tags: readonly string[]): string[] {
  const tagSet = new Set(tags);
  const suppressed = new Set<string>();
  if (tagSet.has("BIKE_INTERSECTION_MIXING_ZONE") || tagSet.has("BIKE_LANE_SHARED_ROADWAY")) {
    suppressed.add("BIKE_LANE_STANDARD");
  }
  const out: string[] = [];
  for (const tag of tags) {
    if (suppressed.has(tag)) continue;
    const badges = ROAD_SEGMENT_BADGES_BY_TAG[tag];
    if (badges) out.push(...badges);
  }
  return out;
}

/**
 * Human-readable phrases for protected / unprotected left-turn tags. Folded
 * into both the badge list and the searchText blob so queries like
 * "permissive left", "unprotected left turn", or "left across traffic"
 * resolve to the right candidates whether the doc came from the sidecar
 * or the legacy candidate-only corpus. Mappings come from
 * `left_turn_phrases_by_tag` in the alias JSON.
 */
function leftTurnPhrasesForTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const phrases = LEFT_TURN_PHRASES_BY_TAG[tag];
    if (phrases) out.push(...phrases);
  }
  return out;
}

/**
 * Emit human-readable fact strings from a sidecar object's `facts` block.
 * Keeps searchText rich ("4-way", "signalized", "steep grade", etc.) without
 * requiring callers to maintain a parallel enum mapping.
 *
 * Two JSON tables drive the flat cases:
 *   - `fact_value_badges[key][value]` — enum remaps (e.g. control_type =
 *     "traffic_light" → "signalized").
 *   - `fact_true_badges[key]` — badges emitted when the boolean is true.
 *
 * Everything else stays inline because the logic doesn't fit a flat table:
 * numeric formatting (grade_pct, length_m, space_count), synonym expansion
 * (leg_label "4-way" also adds "4-leg"), passthrough (poi_type).
 */
function factsToBadges(facts: Record<string, unknown>, kind?: string): string[] {
  const out = new Set<string>();
  const kindOverrides = kind ? FACT_VALUE_BADGES_BY_KIND[kind] : undefined;
  for (const [key, value] of Object.entries(facts ?? {})) {
    if (value == null || value === false) continue;

    // Enum remaps first — covers control_type, grade_class, speed_class,
    // size_class, lane_count_class, curvature_class, complexity_class.
    // The kind-specific override is consulted first so junction size_class
    // doesn't get rendered as "small parking lot".
    if (typeof value === "string") {
      const enumBadges =
        kindOverrides?.[key]?.[value] ?? FACT_VALUE_BADGES[key]?.[value];
      if (enumBadges) {
        for (const badge of enumBadges) out.add(badge);
      }
    }

    // Boolean-true badges — covers has_signal, has_stop_sign, is_*,
    // bike_lane_present, parking_present, sidewalk_present, crest_present.
    if (value === true) {
      const trueBadges = FACT_TRUE_BADGES[key];
      if (trueBadges) {
        for (const badge of trueBadges) out.add(badge);
      }
    }

    // Keys with logic beyond a flat lookup.
    switch (key) {
      case "leg_label":
        if (typeof value === "string") {
          out.add(value);
          if (value === "4-way") out.add("4-leg");
          if (value === "3-leg") out.add("3-leg");
          if (value === "multi-leg") out.add("multi-leg");
        }
        break;
      case "approach_count":
        if (typeof value === "number") {
          out.add(`${value}-leg`);
          if (value === 4) out.add("4-way");
        }
        break;
      case "poi_type":
        if (typeof value === "string") out.add(value.replace(/_/g, " "));
        break;
      case "grade_pct":
        // Show the exact grade number whenever it would classify as
        // moderate or steep (>= GRADE_CLASS_FLAT_MAX_PCT). Complements the
        // grade_class badge — users see both "steep grade" and "8% grade".
        if (typeof value === "number" && value >= 2) {
          out.add(`${Math.round(value)}% grade`);
        }
        break;
      case "space_count":
        if (typeof value === "number" && value > 0) {
          out.add(`${value} space${value === 1 ? "" : "s"}`);
        }
        break;
      case "overture_speed_limit_mph":
        // Posted limit (Overture) as exact-value terms only — deliberately no
        // bucketing into fast/slow classes: the source isn't guaranteed
        // correct, so the raw value speaks for itself and `speed_class`
        // (XODR design speed) keeps owning high-/low-speed semantics.
        if (typeof value === "number" && value > 0) {
          out.add(`${value} mph`);
          out.add(`posted ${value} mph`);
          out.add(`${value} mph zone`);
        }
        break;
      case "length_m":
        if (typeof value === "number" && value > 0) {
          out.add(`${Math.round(value)}m long`);
        }
        break;
      default:
        break;
    }
  }
  return [...out];
}

function sidecarObjectToDocument(
  obj: MapSearchIndexObject,
  candidate: CandidateLocation | undefined,
): MapSearchDocument {
  const baseFacts = factsToBadges(obj.facts as Record<string, unknown>, obj.kind);
  const subtype = sidecarSubtype(obj, candidate);
  // For road_segment_feature POIs, replace the generic "bike lane" fact
  // with a more specific one from the candidate tags ("shared bike lane",
  // "bike mixing zone", "protected bike lane", or "dedicated bike lane").
  // This is done at doc-build time so it picks up correctly even when the
  // sidecar was written by an older build that didn't classify bike-lane
  // kinds — no rebuild required.
  // Dedup at assembly: `factsToBadges` is internally deduped, but the tag-
  // derived helpers below can repeat phrases the sidecar facts already
  // emitted (e.g. `unprotected_left_candidate=true` and a
  // `TURN_UNPROTECTED_LEFT` tag both produce "unprotected left"), and the
  // helpers themselves can repeat across multiple input tags.
  const facts = (() => {
    if (obj.kind !== "road_segment_feature" || !candidate) {
      // Left-turn phrases live on the candidate's tags, not the sidecar
      // facts — fold them in so junction results get the "unprotected
      // left" / "protected left" badge and searchText tokens too.
      const leftTurnExtras = candidate ? leftTurnPhrasesForTags(candidate.tags) : [];
      return leftTurnExtras.length > 0
        ? [...new Set([...baseFacts, ...leftTurnExtras])]
        : baseFacts;
    }
    const extras = roadSegmentExtraBadges(candidate.tags);
    if (extras.length === 0) return baseFacts;
    const withoutGeneric = baseFacts.filter((f) => f !== "bike lane");
    return [...new Set([...withoutGeneric, ...extras])];
  })();
  const scenarioTags = obj.scenario_tags ?? candidate?.tags ?? [];

  // `connected_road_names` is set on junctions (which already carry the road
  // name in obj.name via the resolver) AND on branded POIs whose names we
  // intentionally don't override (hotels, restaurants, bus stops, etc. — see
  // `build-search-index.ts`). For both we surface the roads as related refs
  // and fold them into searchText so queries like "hotel on Clipper Drive"
  // still match. `factsToBadges` ignores array-valued facts so we have to
  // route this through `searchText` explicitly.
  const connectedRoads =
    (obj.facts as { connected_road_names?: string[] }).connected_road_names ?? [];
  const related: string[] = connectedRoads.slice(0, 3);

  const description =
    candidate?.description ??
    candidate?.reason ??
    `${subtype}${facts.length > 0 ? ` — ${facts.slice(0, 3).join(", ")}` : ""}`;

  const searchText = buildSearchText([
    obj.kind.replace(/_/g, " "),
    subtype,
    obj.name,
    candidate?.label,
    candidate?.description,
    candidate?.reason,
    ...(candidate?.tags ?? []),
    ...(candidate?.evidence?.map((e) => e.explanation) ?? []),
    ...facts,
    ...connectedRoads,
  ]);

  const baseConfidence = obj.kind === "junction" ? 0.65 : obj.kind === "street" ? 0.55 : 0.55;
  const confidence = candidate?.confidence ?? baseConfidence;

  // Geometry reference must match what `place-highlight.ts` expects:
  //   - `candidate`       → single candidate_id
  //   - `geojson_feature` → a single `geojsonFeatureId`
  //   - `road_aggregate`  → many `geojsonFeatureIds`
  // Candidate-backed docs use the candidate path; street and street_segment
  // docs aggregate lanes; everything else falls back to the first feature_ref.
  const featureIds =
    obj.feature_refs
      ?.map((ref) => ref.geojson_feature_id)
      .filter((v): v is number => typeof v === "number") ?? [];
  const geometryReference: MapSearchDocumentGeometryRef =
    candidate != null
      ? { kind: "candidate", candidateId: candidate.id }
      : obj.kind === "street" || obj.kind === "street_segment"
        ? { kind: "road_aggregate", geojsonFeatureIds: featureIds }
        : obj.kind === "address"
          // Address objects don't have a road-network feature_ref — they live
          // in the snapshot's `addresses` overlay layer instead. The sidecar
          // object id is `address:<row_id>`; the overlay feature id is the
          // bare row id (set by mapAssetAddressRowId in the address extractor).
          // Returning `geojson_feature` with no id would trip the
          // "no highlightable geometry" hard filter in runMapSearch and drop
          // every address document before scoring.
          ? {
              kind: "overlay_feature",
              overlayLayerId: "addresses",
              overlayFeatureId: obj.id.replace(/^address:/, ""),
            }
          : { kind: "geojson_feature", geojsonFeatureId: featureIds[0] };

  return {
    id: obj.id,
    sourceKind: candidate ? "candidate_location" : "road_network_junction",
    objectFamily: objectFamilyForSidecarKind(obj.kind),
    subtype,
    kind: obj.kind,
    label: obj.name,
    description: typeof description === "string" ? description : subtype,
    searchText,
    exactMapAttributes: facts,
    relatedObjects: related,
    scenarioTags: scenarioTags.map(humanizeTag).slice(0, 3),
    candidateConfidence: confidence,
    ...(candidate?.rank != null ? { rank: candidate.rank } : {}),
    ...(candidate ? { candidateId: candidate.id } : {}),
    facts: candidate
      ? documentFactsFromCandidate(candidate)
      : documentFactsFromIndexObject(obj),
    geometryReference,
  };
}

export interface BuildSearchDocumentsFromIndexInput {
  sidecar: MapSearchIndex;
  candidates: CandidateLocation[];
}

export function buildSearchDocumentsFromIndex(
  input: BuildSearchDocumentsFromIndexInput,
): MapSearchDocument[] {
  const candidatesById = new Map(input.candidates.map((c) => [c.id, c]));
  const docs: MapSearchDocument[] = [];
  for (const obj of Object.values(input.sidecar.objects)) {
    const candidate = obj.candidate_id
      ? candidatesById.get(obj.candidate_id)
      : undefined;
    docs.push(sidecarObjectToDocument(obj, candidate));
  }
  return docs;
}
