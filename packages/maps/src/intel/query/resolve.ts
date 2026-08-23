/**
 * `resolveReference` — free text → ranked handles.
 *
 * This closes the "the intersection by the school" loop: a model writes prose,
 * gets back handles, and then queries and authors using only handles. No LLM is
 * involved in the resolution itself — it is token overlap plus bigram-dice
 * fuzziness plus a small table of type keywords, which is deterministic,
 * explainable, and fast enough to run per keystroke.
 *
 * Deliberately *not* clever: there is no spatial reasoning here ("north of the
 * park"). Prose spatial predicates are exactly what the structured query layer
 * exists to replace.
 */

import type { LocationCatalog, LocationType, StudioLocation } from '../types/location.js';
import type { Handle, LocationId } from '../types/ids.js';
import { idIndex } from './find.js';
import { compareStrings } from '../build/compare.js';

/** One ranked candidate. */
export interface ResolvedReference {
  id: LocationId;
  handle: Handle;
  name: string;
  type: LocationType;
  /** 0..1. */
  score: number;
  /** Why it ranked, most significant first. */
  reasons: string[];
}

/** Options for {@link resolveReference}. */
export interface ResolveOptions {
  /** Default 8. */
  limit?: number;
  /** Restrict to these types. */
  types?: readonly LocationType[];
  /** Drop candidates below this score. Default 0.12. */
  minScore?: number;
}

/** Words that imply a type, and the type they imply. */
const TYPE_KEYWORDS: ReadonlyArray<readonly [RegExp, LocationType, number]> = [
  [/\b(intersection|junction|crossroads?)\b/, 'junction', 0.35],
  [/\b(left turn|right turn|turn|movement|through)\b/, 'junction_movement', 0.25],
  [/\b(crosswalk|crossing|zebra)\b/, 'crosswalk', 0.35],
  [/\b(school zone|school)\b/, 'school_zone', 0.3],
  [/\b(parking (space|bay|stall))\b/, 'parking_space', 0.35],
  [/\b(parking lot|car park)\b/, 'parking_area', 0.35],
  [/\b(street parking|parked cars?)\b/, 'parking_lane', 0.3],
  [/\b(bus stop|transit stop)\b/, 'bus_stop', 0.4],
  [/\b(sidewalk|pavement|footpath)\b/, 'sidewalk', 0.3],
  [/\b(midblock|mid-block|straightaway|stretch of road|block)\b/, 'midblock_segment', 0.3],
  [/\b(occlusion|blind|obscured|hidden)\b/, 'occlusion_zone', 0.35],
  [/\b(work zone|construction|roadworks?)\b/, 'work_zone_suitable', 0.4],
  [/\b(entrance|doorway|address|building)\b/, 'building_entrance', 0.3],
  [/\b(corridor|road|street|avenue|boulevard)\b/, 'driving_corridor', 0.12],
];

/** Rank catalog records against a free-text description. */
export function resolveReference(
  catalog: LocationCatalog,
  text: string,
  options: ResolveOptions = {},
): ResolvedReference[] {
  const limit = options.limit ?? 8;
  const minScore = options.minScore ?? 0.12;
  const query = text.trim().toLowerCase();
  if (query.length === 0) return [];

  // Exact id/handle wins outright — models should be able to round-trip.
  const direct = idIndex(catalog).get(text.trim());
  if (direct) {
    return [
      {
        id: direct.id,
        handle: direct.handle,
        name: direct.name,
        type: direct.type,
        score: 1,
        reasons: ['exact id or handle match'],
      },
    ];
  }

  const queryTokens = tokenise(query);
  const typeHints = TYPE_KEYWORDS.filter(([re]) => re.test(query));

  const out: ResolvedReference[] = [];
  for (const loc of catalog.locations) {
    if (options.types && !options.types.includes(loc.type)) continue;
    const scored = scoreLocation(loc, query, queryTokens, typeHints);
    if (scored.score < minScore) continue;
    out.push({
      id: loc.id,
      handle: loc.handle,
      name: loc.name,
      type: loc.type,
      score: Math.round(scored.score * 1000) / 1000,
      reasons: scored.reasons,
    });
  }

  out.sort((a, b) => b.score - a.score || compareStrings(a.handle as string, b.handle as string));
  return out.slice(0, limit);
}

function scoreLocation(
  loc: StudioLocation,
  query: string,
  queryTokens: readonly string[],
  typeHints: ReadonlyArray<readonly [RegExp, LocationType, number]>,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const haystackName = `${loc.name} ${loc.handle}`.toLowerCase();
  const nameTokens = tokenise(haystackName);
  const overlap = queryTokens.filter((t) => nameTokens.includes(t));
  if (overlap.length > 0) {
    const share = overlap.length / queryTokens.length;
    score += 0.55 * share;
    reasons.push(`name/handle shares ${overlap.join(', ')}`);
  }

  const fuzzy = diceCoefficient(query, haystackName);
  if (fuzzy > 0.25) {
    score += 0.2 * fuzzy;
    reasons.push(`fuzzy name similarity ${fuzzy.toFixed(2)}`);
  }

  // Road names carried in facts are the most common way people refer to places.
  const roadFacts = ['road_name', 'street_name', 'connected_road_names', 'resolved_name'];
  for (const key of roadFacts) {
    const value = loc.facts[key];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? (value as readonly string[]) : [String(value)];
    for (const v of values) {
      const tokens = tokenise(v.toLowerCase());
      const hit = queryTokens.filter((t) => tokens.includes(t));
      if (hit.length === 0) continue;
      score += 0.3 * (hit.length / Math.max(1, tokens.length));
      reasons.push(`${key} matches ${hit.join(', ')}`);
      break;
    }
  }

  for (const [, type, weight] of typeHints) {
    if (loc.type === type) {
      score += weight;
      reasons.push(`type keyword implies ${type}`);
    }
  }

  for (const tag of loc.tags) {
    const words = tag.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const hit = queryTokens.filter((t) => words.includes(t));
    if (hit.length > 0) {
      score += 0.12;
      reasons.push(`tag ${tag}`);
      break;
    }
  }

  // A record you cannot place is a worse answer than one you can.
  if (!loc.anchor.road) score *= 0.8;

  return { score: Math.min(1, score), reasons };
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'at', 'by', 'on', 'in', 'of', 'near', 'to', 'with', 'and', 'is', 'that', 'this',
]);

function tokenise(text: string): string[] {
  return text
    .split(/[^a-z0-9]+/i)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Sørensen–Dice over character bigrams. */
export function diceCoefficient(a: string, b: string): number {
  const bigrams = (s: string): string[] => {
    const out: string[] = [];
    const clean = s.replace(/\s+/g, ' ');
    for (let i = 0; i + 1 < clean.length; i++) out.push(clean.slice(i, i + 2));
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.length === 0 || B.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const g of A) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of B) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hits += 1;
      pool.set(g, n - 1);
    }
  }
  return (2 * hits) / (A.length + B.length);
}
