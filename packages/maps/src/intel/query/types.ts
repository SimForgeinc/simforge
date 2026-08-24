/**
 * The query vocabulary.
 *
 * Deliberately structured-only: there is no free-text spatial field anywhere in
 * this shape. Free text goes through {@link resolveReference}, which returns
 * handles; the model then queries with those. Letting a model write spatial
 * predicates in prose is how you get confidently wrong placements.
 */

import type { Affordance, AnchorQuality, FactValue, LocationType, StudioLocation } from '../types/location.js';

/**
 * A set-valued filter. A bare value or array means "any of"; the object form
 * adds `allOf` and `noneOf`.
 */
export type SetFilter<T extends string> =
  | T
  | readonly T[]
  | { anyOf?: readonly T[]; allOf?: readonly T[]; noneOf?: readonly T[] };

/** Comparison operators available on facts. */
export const FACT_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists', 'missing'] as const;

/** A member of {@link FACT_OPS}. */
export type FactOp = (typeof FACT_OPS)[number];

/** One fact predicate. */
export interface FactFilter {
  key: string;
  op: FactOp;
  value?: FactValue;
}

/** `anyOf`/`allOf`/`noneOf` over fact predicates — the missing piece in the prior tool surface. */
export type FactFilterGroup =
  | readonly FactFilter[]
  | { anyOf?: readonly FactFilter[]; allOf?: readonly FactFilter[]; noneOf?: readonly FactFilter[] };

/** Proximity constraint, expressed against another catalog record. */
export interface NearFilter {
  /** A {@link import('../types/ids.js').LocationId} or {@link import('../types/ids.js').Handle}. */
  id: string;
  withinM: number;
}

/** The full query. */
export interface FindLocationsQuery {
  type?: SetFilter<LocationType>;
  subtype?: SetFilter<string>;
  tags?: SetFilter<string>;
  affordances?: SetFilter<Affordance>;
  facts?: FactFilterGroup;
  near?: NearFilter;
  anchorQuality?: SetFilter<AnchorQuality>;
  /** Only return records that are actually placeable. */
  requireRoadAnchor?: boolean;
  /** Default 25, hard cap {@link MAX_RESULT_LIMIT}. */
  limit?: number;
  /** Drop results within this many metres of an already-selected result. */
  diversityRadiusM?: number;
  sort?: 'relevance' | 'distance' | 'handle';
}

/** Hard cap on results per call. */
export const MAX_RESULT_LIMIT = 200;

/** Default result cap. */
export const DEFAULT_RESULT_LIMIT = 25;

/** One hit. The subject's own record is returned inline — never just an id. */
export interface LocationMatch {
  location: StudioLocation;
  score: number;
  /** Present when the query had a `near` clause. */
  distanceM?: number;
  /** Human-readable justification per satisfied clause. */
  matchedReasons: string[];
}

/** Structured query error — machine-repairable, as unattended loops require. */
export class MapIntelQueryError extends Error {
  readonly code: string;
  readonly path: string;
  readonly reason: string;
  /** Closed vocabulary for the offending field, when there is one. */
  readonly allowed?: readonly string[];

  constructor(code: string, path: string, reason: string, allowed?: readonly string[]) {
    super(`${code} at ${path}: ${reason}`);
    this.name = 'MapIntelQueryError';
    this.code = code;
    this.path = path;
    this.reason = reason;
    this.allowed = allowed;
  }

  /** JSON form for CLI/tool transport. */
  toJSON(): { code: string; path: string; reason: string; allowed?: readonly string[] } {
    return { code: this.code, path: this.path, reason: this.reason, ...(this.allowed ? { allowed: this.allowed } : {}) };
  }
}
