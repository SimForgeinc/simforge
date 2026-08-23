/**
 * The intermediate record every derivation emits.
 *
 * A draft is a {@link StudioLocation} minus its `handle`: handles cannot be
 * assigned until *every* location on the map exists, because uniqueness is the
 * whole point of the disambiguation ladder. Keeping that as a distinct type
 * means "a location without a handle" is unrepresentable in the built catalog.
 */

import type { LocationId } from '../types/ids.js';
import type {
  Affordance,
  AnchorQuality,
  FactValue,
  LocationAnchor,
  LocationExtent,
  LocationType,
  ProvenanceEntry,
} from '../types/location.js';

/** Inputs to the naming / disambiguation ladder. */
export interface NamingHints {
  /**
   * Preferred slug stems, most specific first. The first that yields a unique
   * handle wins; the ladder then adds qualifiers.
   */
  stems: string[];
  /** Road names associated with the location, for cross-street disambiguation. */
  roadNames: string[];
}

/** A location before handle assignment. */
export interface LocationDraft {
  id: LocationId;
  name: string;
  type: LocationType;
  subtype?: string;
  tags: string[];
  anchor: LocationAnchor;
  extent?: LocationExtent;
  affordances: Affordance[];
  facts: Record<string, FactValue>;
  provenance: ProvenanceEntry[];
  quality: { anchor: AnchorQuality; confidence: number };
  naming: NamingHints;
  /** Search-index object id, when this draft was adopted rather than derived. */
  sourceObjectId?: string;
  /** Content identity key, retained for debugging id churn. */
  identityKey: string;
}
