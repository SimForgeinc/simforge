/**
 * Branded identifier types.
 *
 * The single most expensive failure mode observed in the prior system was two
 * map representations distinguished only by documentation: a *display* string
 * ("Oxford Avenue @ West El Camino Real") sitting in a field that the placement
 * code later read as a road reference. Branding makes that a compile error.
 *
 * The rule this module enforces:
 *
 * - **Display strings are plain `string`.** `StudioLocation.name`,
 *   `describeLocation()` output, road names in facts — all unbranded.
 * - **Placement anchors are branded.** {@link LaneRef} (`road:section:lane`),
 *   {@link JunctionId}, {@link GateId}.
 * - **Catalog references are branded.** {@link LocationId}, {@link Handle}.
 *
 * Because every brand is a distinct nominal type, a `string` never flows into a
 * placement position without an explicit, validating cast (`asLaneRef(...)`),
 * and a {@link Handle} never flows into a {@link LaneRef} position at all.
 */

declare const BRAND: unique symbol;

/** Nominal wrapper around a primitive. */
export type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/** Short map identifier, e.g. `yale-street`. */
export type MapId = Brand<string, 'MapId'>;

/** Content-derived catalog identity, `loc_<24 hex>`. Never positional. */
export type LocationId = Brand<string, 'LocationId'>;

/** Unique, typeable, LLM-friendly reference, e.g. `junction/yale-st-at-college-ave`. */
export type Handle = Brand<string, 'Handle'>;

/** OpenDRIVE lane reference `road:section:lane` — a *placement* anchor. */
export type LaneRef = Brand<string, 'LaneRef'>;

/** OpenDRIVE junction id as it appears in the topology index. */
export type JunctionId = Brand<string, 'JunctionId'>;

/** Topology-index gate id, e.g. `115:0:4-1`. */
export type GateId = Brand<string, 'GateId'>;

/** Derived-topology segment id, `seg_<16 hex>`. */
export type SegmentId = Brand<string, 'SegmentId'>;

const LOCATION_ID_RE = /^loc_[0-9a-f]{24}$/;
const HANDLE_RE = /^[a-z0-9_]+\/[a-z0-9][a-z0-9-]*$/;
const LANE_REF_RE = /^-?\d+:\d+:-?\d+$/;
const SEGMENT_ID_RE = /^seg_[0-9a-f]{16}$/;

function must(ok: boolean, kind: string, value: string): void {
  if (!ok) throw new TypeError(`${kind}: malformed value ${JSON.stringify(value)}`);
}

/** Assert-and-brand a map id. */
export function asMapId(value: string): MapId {
  must(/^[a-z0-9][a-z0-9-]*$/.test(value), 'MapId', value);
  return value as MapId;
}

/** Assert-and-brand a catalog id. */
export function asLocationId(value: string): LocationId {
  must(LOCATION_ID_RE.test(value), 'LocationId', value);
  return value as LocationId;
}

/** Assert-and-brand a handle. */
export function asHandle(value: string): Handle {
  must(HANDLE_RE.test(value), 'Handle', value);
  return value as Handle;
}

/** Assert-and-brand a lane reference (`road:section:lane`). */
export function asLaneRef(value: string): LaneRef {
  must(LANE_REF_RE.test(value), 'LaneRef', value);
  return value as LaneRef;
}

/** Brand a junction id (any non-empty token; xodr ids are free-form). */
export function asJunctionId(value: string): JunctionId {
  must(value.length > 0, 'JunctionId', value);
  return value as JunctionId;
}

/** Brand a gate id. */
export function asGateId(value: string): GateId {
  must(value.length > 0, 'GateId', value);
  return value as GateId;
}

/** Assert-and-brand a segment id. */
export function asSegmentId(value: string): SegmentId {
  must(SEGMENT_ID_RE.test(value), 'SegmentId', value);
  return value as SegmentId;
}

/** True when the string is shaped like a {@link LocationId}. */
export function isLocationId(value: string): boolean {
  return LOCATION_ID_RE.test(value);
}

/** True when the string is shaped like a {@link Handle}. */
export function isHandle(value: string): boolean {
  return HANDLE_RE.test(value);
}

/** True when the string is shaped like a {@link LaneRef}. */
export function isLaneRef(value: string): boolean {
  return LANE_REF_RE.test(value);
}

/** Decomposed {@link LaneRef}. */
export interface LaneRefParts {
  roadId: number;
  section: number;
  laneId: number;
}

/** Split a {@link LaneRef} into its three integer components. */
export function parseLaneRef(ref: LaneRef): LaneRefParts {
  const [r, s, l] = (ref as string).split(':');
  return { roadId: Number(r), section: Number(s), laneId: Number(l) };
}

/** Rebuild a {@link LaneRef} from components. */
export function formatLaneRef(parts: LaneRefParts): LaneRef {
  return `${parts.roadId}:${parts.section}:${parts.laneId}` as LaneRef;
}
