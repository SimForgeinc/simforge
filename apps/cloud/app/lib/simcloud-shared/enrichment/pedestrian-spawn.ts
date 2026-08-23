/**
 * Canonical signal: "is this candidate a place where pedestrians are
 * naturally present and can be spawned in a scenario?"
 *
 * Single source of truth for the answer. Consumed by:
 *   - the sidecar builder (`build-search-index.ts`), which writes the
 *     boolean onto POI facts so the LLM can target it via the existing
 *     `semantic: ["pedestrian_spawn"]` query
 *   - the legacy corpus builder (`map-search-corpus.ts`), which surfaces
 *     it as a "pedestrian spawn" humanized badge for un-backfilled maps
 *   - the geometry-inspection tool, which surfaces it on the
 *     `GeometryReport` so the scenario builder reads one boolean instead
 *     of running its own substring matcher
 *
 * Keeping this here in `shared/enrichment` rather than in the scenario
 * layer is deliberate: pedestrian-spawn eligibility is a *property of
 * the map location*, not of any one scenario family. The spatial layer
 * owns the labeling; scenarios consume it.
 *
 * NOT covered here: junction- and street-kind candidates. Those receive
 * `pedestrian_spawn` via graph-adjacency derivations in the sidecar
 * builder (a junction is a pedestrian spawn iff it touches a sidewalk-
 * bearing street or carries a crosswalk POI). The function below
 * returns the value for the candidate's *inherent* kind only.
 */
import type { CandidateLocation, CandidateLocationKind } from "../map-candidate-location";

/**
 * Candidate kinds whose mere presence implies pedestrian spawn
 * eligibility. Every kind here passes one of three tests:
 *   - it IS pedestrian infrastructure (crosswalks)
 *   - it is a place pedestrians wait, board, or congregate
 *     (transit / boarding zones, school / hospital / commercial
 *     frontages and approaches)
 *   - it is a place vehicles park and people walk to/from
 *     (parking lot / cluster / street parking)
 *
 * NOT included: `junction`, `road_segment`, `street_parking`'s
 * mid-block-only variant (handled by adjacency), `av_collision_point`
 * (depends on the specific collision), `occlusion` (depends on
 * subtype — see `PEDESTRIAN_SPAWN_OCCLUSION_SUBTYPES`).
 */
export const PEDESTRIAN_SPAWN_KINDS: ReadonlySet<CandidateLocationKind> = new Set([
  "crosswalk_zone",
  "sidewalk_segment",
  "bus_stop_corridor",
  "transit_stop_corridor",
  "school_frontage",
  "hospital_approach",
  "retail_frontage",
  "restaurant_frontage",
  "hotel_approach",
  "airport_approach",
  "shopping_mall_approach",
  "gas_station_approach",
  "parking_lot",
  "parking_cluster",
  "street_parking",
]);

/**
 * Occlusion subtypes that carry implicit pedestrian-spawn semantics —
 * each anchors to a place where pedestrians cross or congregate. The
 * detector outputs a `"Pedestrian At …"` scenarioTag for these but the
 * subtype check here is the authoritative signal (tags are humanized
 * downstream and shouldn't be relied on for routing).
 *
 * Vehicle-visibility-only occlusion subtypes (`CURVE_OCCLUSION`,
 * `CREST_OCCLUSION`, `NARROW_BUILDING_CORRIDOR`) are intentionally
 * omitted — they describe sightline geometry, not pedestrian density.
 */
export const PEDESTRIAN_SPAWN_OCCLUSION_SUBTYPES: ReadonlySet<string> = new Set([
  "BUS_STOP_OCCLUSION",
  "COMMERCIAL_DELIVERY_OCCLUSION",
  "PARKING_NEAR_CONFLICT_POINT",
]);

/**
 * Returns true when the candidate is inherently a pedestrian spawn
 * point given its kind. For occlusion candidates, also consults the
 * `occlusion_subtype` evidence primitive.
 *
 * Junctions and streets are intentionally NOT decided here; their
 * pedestrian-spawn flag comes from adjacency derivations in the
 * sidecar build (sidewalk-present streets, anchored crosswalk POIs).
 */
export function isPedestrianSpawnCandidate(candidate: CandidateLocation): boolean {
  if (PEDESTRIAN_SPAWN_KINDS.has(candidate.kind)) return true;
  if (candidate.kind === "occlusion") {
    for (const ev of candidate.evidence) {
      const subtype = ev.primitives.occlusion_subtype;
      if (typeof subtype === "string" && PEDESTRIAN_SPAWN_OCCLUSION_SUBTYPES.has(subtype)) {
        return true;
      }
    }
  }
  return false;
}
