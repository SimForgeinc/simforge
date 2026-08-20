/**
 * `MapContext` — the seam between the map-free document layer and `map-intel`.
 *
 * Tier-1 validation splits cleanly in two. Most of it is pure document
 * structure (references resolve, one axis has one owner, `set` keys exist) and
 * needs nothing but the template. The rest asks questions only a map can
 * answer: is there a lane where this role wants to stand, is there 220 m of
 * road ahead of it, is that lane change legal, does that signal exist.
 *
 * Rather than depend on `map-intel` — which would invert the build order and
 * drag a lane graph into a package whose whole point is portability — this
 * module declares the *interface* those questions are asked through. `map-intel`
 * implements it later against the real derived topology; tests implement it in
 * fifty lines (`fake-map-context.ts`). If the interface turns out to be wrong,
 * it is wrong here, in one file, before anyone has built against it.
 *
 * ## Frame coordinates, not map coordinates
 *
 * Every query is in **AnchorFrame** coordinates — `(k, s)` — because that is the
 * only coordinate system a template speaks. Translating frame coordinates to
 * `rsl` (road/section/lane) is the implementer's job and is exactly the
 * knowledge that must not leak into this package: the moment a validator here
 * knows a road id, templates stop being portable.
 */

import type { SignalApproach } from '../schema/v2/interactions.js';

/**
 * Opaque lane handle in the implementer's own coordinates.
 *
 * Deliberately a branded string rather than a structured `{roadId, section,
 * laneId}`: this package must never construct one, only pass it back to the
 * `MapContext` that produced it.
 */
export type LaneRsl = string & { readonly __brand: 'LaneRsl' };

/** Lane surface classes, matching the OpenDRIVE lane types that matter here. */
export type LaneType =
  | 'driving'
  | 'shoulder'
  | 'sidewalk'
  | 'biking'
  | 'parking'
  | 'median'
  | 'restricted'
  | 'crosswalk'
  | 'other';

/** What the validator needs to know about a lane. */
export interface LaneFacts {
  rsl: LaneRsl;
  type: LaneType;
  /** Signed same-direction index in the AnchorFrame; 0 is the reference lane. */
  k: number;
  /** Lane width at the queried `s`, metres. */
  widthM: number;
  /** Posted limit, kph; `null` when the map does not say. */
  speedLimitKph: number | null;
  /** True for lanes inside a junction (no lane changes, different rules). */
  isJunctionInternal: boolean;
}

/** Whether a lane change is legal at a point, per the lane markings. */
export interface LaneChangePermissions {
  left: boolean;
  right: boolean;
}

/** A junction movement: enter from an approach, leave in a direction. */
export interface GateFacts {
  /** Stable id of the gate in the implementer's index. */
  gateId: string;
  /** Arc length of the conflict point with the reference path, frame metres. */
  conflictS: number | null;
  /** Angle at which the movements cross, degrees. `null` when they do not cross. */
  crossingAngleDeg: number | null;
  /** Length of the connecting lane through the junction, metres. */
  lengthM: number;
}

/** A traffic signal head. */
export interface SignalFacts {
  handle: string;
  /** Phases this signal's program actually contains. */
  phases: readonly string[];
}

/** A matched site feature (junction, crossing, parking zone, …). */
export interface FeatureFacts {
  /** The template feature id this site feature is bound to. */
  featureId: string;
  kind: string;
  /** Position along the reference path, frame metres. */
  atM: number;
  /** Extent along the reference path where meaningful. */
  lengthM: number | null;
  /** Characteristic size, metres — the value `junction.sizeM` reads. */
  sizeM: number | null;
}

/**
 * Everything the map-dependent tier-1 checks may ask.
 *
 * All queries are total: an implementation returns `undefined` for "no such
 * thing here" rather than throwing, because "no such thing here" is precisely
 * the answer most of these checks are looking for.
 */
export interface MapContext {
  readonly mapId: string;
  /**
   * Digest of the map topology this context was built from. Stamped into
   * validation output so a stale report is detectable rather than trusted.
   */
  readonly topologyDigest: string;

  /** The lane at frame position `(k, s)`, if one exists there. */
  laneAt(k: number, s: number): LaneFacts | undefined;
  /** Facts for a lane handle. */
  lane(rsl: LaneRsl): LaneFacts | undefined;
  /** Physically contiguous successors of a lane, in the direction of travel. */
  successors(rsl: LaneRsl): readonly LaneRsl[];
  /** Lane-marking permissions at frame position `(k, s)`. */
  laneChangePermissions(k: number, s: number): LaneChangePermissions;
  /** The movement through `featureId` entering from `from` and leaving via `turn`. */
  gate(featureId: string, from: string, turn: string): GateFacts | undefined;
  /** A signal by map handle, or by feature + approach. */
  signal(ref: { handle: string } | { featureId: string; approach: SignalApproach }): SignalFacts | undefined;
  /** A site feature bound to a template feature id. */
  feature(featureId: string): FeatureFacts | undefined;
  /**
   * Drivable distance ahead of `(k, s)` following physically contiguous
   * successors — the whole-clip runway check, not the labelled window.
   */
  forwardRunwayM(k: number, s: number): number;
  /** Drivable distance behind `(k, s)`; the warm-up run-up. */
  upstreamRunwayM(k: number, s: number): number;
}
