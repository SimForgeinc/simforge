/**
 * Deterministic collision-site enumeration (stage-1 Phase 1).
 *
 * `findCollisionSites` is an ENUMERATOR, not a picker: given a family and a map,
 * it returns every viable collision site ranked by fit (not proximity), with a
 * viability floor and a top-N cap. The conversational flow takes the top match;
 * the dataset flow takes the top-N — which is the whole point per the project
 * direction: generate a LARGER, better-sited set so collisions are likely in
 * aggregate, and label the rest by observed outcome (Phase 3).
 *
 * The Phase 0 contact baseline (33% on proximity-only selection) is what this
 * replaces: ranking by comfortable run-up + crossing geometry prefers a clean
 * site over the merely nearest one. This module wires the existing per-family
 * planners/selectors into the shared fit scorer (`site-fit.ts`).
 *
 * This first cut covers `pedestrian_crossing` (the most-ready family); the turn
 * families and the corpus-facts join (junction cleanliness term + constraint
 * filtering) layer on next without changing this contract.
 */
import type { MapTopologyIndex, Vec2 } from "@simforge/studio-shared";
import { selectPedestrianCrossingSite } from "@/app/lib/llm/scenario-generation/planner/pedestrian-crossing-site-selector";
import {
  selectMidblockPedSites,
  isMidblockGateId,
} from "@/app/lib/llm/scenario-generation/planner/midblock-ped-site-selector";
import type { PedCrossingSite } from "@/app/lib/llm/scenario-generation/planner/pedestrian-crossing-site-selector";
import {
  topologyJunctionCentroid,
  planUnprotectedLeftTurnGated,
  planRightTurnHookGated,
} from "@/app/lib/llm/scenario-generation/planner/gated-collision-planner";
import type { PlannedCollision } from "@/app/lib/llm/scenario-generation/collision-route-planner";
import { findBicycleMergeSites } from "@/app/lib/llm/scenario-generation/planner/bicycle-merge-planner";
import {
  selectTurnPedCrosswalkSites,
  type TurnPedCrosswalkSite,
} from "@/app/lib/llm/scenario-generation/planner/turn-ped-crosswalk-planner";
import type {
  ProjectedOccluder,
  ProjectedParkingLot,
} from "@/app/lib/llm/scenario-generation/load-pedestrian-regions";
import {
  resolveCrossingLine,
  type ProjectedCrosswalk,
  type ProjectedSidewalk,
} from "@/app/lib/llm/scenario-generation/planner/pedestrian-crossing-geometry";
import type { MapSearchDocument, MapSearchDocumentFacts } from "@/app/lib/maps/search/map-search";
import {
  scoreCollisionSite,
  selectTopSites,
  DEFAULT_FIT_FLOOR,
  type SiteFitResult,
} from "./site-fit";

type TurnFamily = "unprotected_left_turn" | "right_turn_hook";
type TurnPedCrosswalkFamily = "left_turn_ped_crosswalk" | "right_turn_ped_crosswalk";
type CollisionSiteFamily =
  | "pedestrian_crossing"
  | TurnFamily
  | "bicycle_merge"
  | TurnPedCrosswalkFamily;

/**
 * Junction cleanliness facts for the fit scorer, derived from the topology the
 * planner already holds. Per the fact-quality audit, `approach_count` is the
 * COMPLETE, authoritative signal (XODR road degree) — count distinct approach
 * roads — and complexity derives from it (≥5 legs = complex). This deliberately
 * avoids the partial-coverage / source-divergent detector counts
 * (gate_count / internal_lane_count), which the audit flagged as unreliable to
 * gate on. `hasSignal` is a constraint signal, not a cleanliness one, so it is
 * not used here.
 */
function topologyJunctionFacts(
  topology: MapTopologyIndex,
  junctionId: string | null,
): MapSearchDocumentFacts {
  if (!junctionId) return {};
  const junction = topology.junctions[junctionId];
  if (!junction) return {};
  const roads = new Set<string>();
  for (const rsl of junction.approachLaneRsls) {
    const road = rsl.split(":")[0];
    if (road) roads.add(road);
  }
  if (roads.size === 0) return {};
  const approachCount = roads.size;
  return { approachCount, isComplex: approachCount >= 5 };
}

/**
 * Semantic location constraints (the `ScenarioRequest.locationConstraints`
 * subset the deterministic site search can enforce today). Coordinates never
 * appear here — these are predicates the candidate index can answer.
 */
export interface SiteLocationConstraints {
  /** Require a signalized (true) or unsignalized (false) junction. */
  signalized?: boolean;
  /** Require every tag to appear in the junction's candidate text (AND, case-insensitive). */
  requiredTags?: string[];
  /**
   * Require the site to be within `nearPoiRadiusM` of a pedestrian-origin POI
   * matching ANY of these terms (e.g. "bus stop", "school"). Matched against the
   * candidate POI kinds (bus_stop_corridor, school_frontage, …).
   */
  nearPoi?: string[];
}

/** A kind-tagged POI in runtime meters (from the projected pedestrian regions). */
export interface CollisionSitePoi {
  kind: string;
  point: Vec2;
}

const DEFAULT_NEAR_POI_RADIUS_M = 80;

/**
 * Whether a candidate POI kind satisfies a user term. Normalizes the kind
 * (`bus_stop_corridor` -> "bus stop corridor") and substring-matches the term,
 * plus a few synonyms ("shop"/"store" -> retail, "bus"/"transit" -> stops).
 */
function poiKindMatchesTerm(kind: string, term: string): boolean {
  const k = kind.toLowerCase().replace(/_/g, " ");
  const t = term.toLowerCase().trim();
  if (!t) return false;
  if (k.includes(t)) return true;
  const synonyms: Record<string, string[]> = {
    bus: ["bus stop", "transit stop"],
    transit: ["transit stop", "bus stop"],
    shop: ["retail", "shopping mall"],
    store: ["retail", "shopping mall"],
    mall: ["shopping mall"],
    cafe: ["restaurant"],
    transport: ["bus stop", "transit stop"],
  };
  for (const [key, kinds] of Object.entries(synonyms)) {
    if (t.includes(key) && kinds.some((kk) => k.includes(kk))) return true;
  }
  return false;
}

/**
 * Per-junction corpus facts + a tag haystack, keyed by topology `junctionId` —
 * what the constraint filter joins on. The corpus junction doc ids
 * (`junction:<id>`) match the topology junctionIds 1:1 (verified on Yale: 56/56),
 * so the join is a direct id lookup with no geometry matching.
 */
export type JunctionConstraintIndex = Map<
  string,
  { facts: MapSearchDocumentFacts; haystack: string }
>;

/**
 * Build the junction constraint index from the shared map-search corpus — the
 * single retrieval source both the conversational search and the dataset
 * generator read, so a junction that satisfies "signalized" in one satisfies it
 * in the other. Junction docs only (id `junction:<id>`); the haystack folds the
 * normalized search text, exact attributes and scenario tags.
 */
export function buildJunctionConstraintIndex(
  corpus: ReadonlyArray<MapSearchDocument>,
): JunctionConstraintIndex {
  const index: JunctionConstraintIndex = new Map();
  for (const doc of corpus) {
    if (!doc.id.startsWith("junction:")) continue;
    const junctionId = doc.id.slice("junction:".length);
    const haystack = [doc.searchText, ...(doc.exactMapAttributes ?? []), ...(doc.scenarioTags ?? [])]
      .join(" ")
      .toLowerCase();
    index.set(junctionId, { facts: doc.facts ?? {}, haystack });
  }
  return index;
}

/**
 * Whether a junction satisfies the constraints. A POSITIVE constraint needs
 * evidence: a junction the corpus has no entry for cannot be confirmed, so it is
 * excluded (strict-in-dev — keeps unverifiable sites out of the dataset). With
 * no constraints set, every junction passes (the filter is a no-op).
 */
interface ConstraintContext {
  index: JunctionConstraintIndex | undefined;
  /** The collision locale (runtime meters) for the nearPoi proximity test. */
  referencePoint: Vec2 | null;
  poiIndex: ReadonlyArray<CollisionSitePoi> | undefined;
  nearPoiRadiusM: number;
}

function junctionPassesConstraints(
  junctionId: string | null,
  constraints: SiteLocationConstraints | undefined,
  ctx: ConstraintContext,
): boolean {
  if (!constraints) return true;
  const wantSignal = constraints.signalized;
  const tags = (constraints.requiredTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const nearPoi = (constraints.nearPoi ?? []).map((t) => t.trim()).filter(Boolean);

  // signalized / requiredTags join the corpus index (no-op without it, by contract).
  if ((wantSignal !== undefined || tags.length > 0) && ctx.index) {
    const entry = junctionId ? ctx.index.get(junctionId) : undefined;
    if (!entry) return false; // a positive constraint needs corpus evidence
    if (wantSignal !== undefined && (entry.facts.hasSignal ?? false) !== wantSignal) return false;
    for (const tag of tags) {
      if (!entry.haystack.includes(tag)) return false;
    }
  }

  // nearPoi: the site must be within radius of a POI matching ANY requested term.
  if (nearPoi.length > 0) {
    const point = ctx.referencePoint;
    if (!point || !ctx.poiIndex?.length) return false; // can't confirm -> exclude
    const r2 = ctx.nearPoiRadiusM * ctx.nearPoiRadiusM;
    const near = ctx.poiIndex.some(
      (poi) =>
        nearPoi.some((term) => poiKindMatchesTerm(poi.kind, term)) &&
        (poi.point.x - point.x) ** 2 + (poi.point.y - point.y) ** 2 <= r2,
    );
    if (!near) return false;
  }
  return true;
}

interface RankedCollisionSiteBase {
  /** Stable id for dedup + reproducibility. */
  siteId: string;
  /** World point (runtime meters) where subject and conflict actor are planned to meet. */
  conflictPoint: Vec2;
  /** Deterministic fit score + viability verdict + per-term breakdown. */
  fit: SiteFitResult;
}

/** A viable, fit-ranked pedestrian-crossing site (gate-anchored). */
export interface RankedPedestrianSite extends RankedCollisionSiteBase {
  family: "pedestrian_crossing";
  pedSite: PedCrossingSite;
  /** The roadside occluder matched to this site (D1/D2), if any — drives the
   *  parked-car occluder placement. Null when the site has no nearby occlusion. */
  occluder?: ProjectedOccluder | null;
}

/** A viable, fit-ranked turn-conflict site (junction + the solved plan). Also
 *  carries bicycle_merge sites — same "pre-solved plan" shape, no junction. */
export interface RankedTurnSite extends RankedCollisionSiteBase {
  family: TurnFamily | "bicycle_merge";
  /** Junction id for turn families; the driving-lane rsl for bicycle_merge. */
  junctionId: string;
  plan: PlannedCollision;
  /** Roadside occluder matched to a right-hook conflict (so the cyclist emerges
   *  from behind a parked car). Null when none nearby / non-right-hook family. */
  occluder?: ProjectedOccluder | null;
}

/** A viable, fit-ranked turn-across-crosswalk site (Left/Right gate + the
 *  exit-leg conflict geometry the walker planner needs). */
export interface RankedTurnPedCrosswalkSite extends RankedCollisionSiteBase {
  family: TurnPedCrosswalkFamily;
  /** Junction id for constraint filtering + diversity anchoring. */
  junctionId: string;
  /** The selected gate + exit-leg conflict geometry (fed to the walker planner). */
  turnSite: TurnPedCrosswalkSite;
  /** Roadside occluder matched to the exit-leg conflict point, if any — drives
   *  the parked-car occluder placement, and is what `requireOccluder` filters
   *  on. Populated since 2026-07-29; it was hard-null in v1, which silently
   *  made requireOccluder a no-op for these families. */
  occluder?: ProjectedOccluder | null;
}

/** A viable, fit-ranked collision site ready to hand to a per-family planner. */
export type RankedCollisionSite =
  | RankedPedestrianSite
  | RankedTurnSite
  | RankedTurnPedCrosswalkSite;

export interface FindCollisionSitesArgs {
  family: CollisionSiteFamily;
  topology: MapTopologyIndex;
  /** Subject cruise speed used to size the required run-up and the planner. */
  subjectSpeedKph: number;
  /** NPC/oncoming speed (turn families); defaults to the subject speed. */
  npcSpeedKph?: number;
  /** Minimum approach run-up time for pedestrian_crossing (default 5 s). */
  minTimeS?: number;
  /**
   * Projected pedestrian regions (crosswalks / sidewalks / POIs). When provided
   * for the pedestrian family, each site resolves its real crossing line and is
   * ranked by crossing-geometry quality (perpendicular span, real infrastructure
   * vs road-edge fallback) — the term that otherwise can't discriminate among
   * roomy sites. Without it, perpendicularity defaults to ideal.
   */
  regions?: {
    crosswalks: ProjectedCrosswalk[];
    sidewalks: ProjectedSidewalk[];
    poiPoints: Vec2[];
    /** Roadside parked-vehicle occlusion sites — ped sites near one are ranked
     *  HIGHER (workstream D1) so occluded crossings are preferred. */
    occluders?: ProjectedOccluder[];
    /** Curated combined parking-lot polygons. A turn junction whose centroid falls
     *  inside one is a parking-lot AISLE (not a street intersection) and is
     *  down-ranked, so real street unprotected-lefts dominate the batch. */
    parkingLots?: ProjectedParkingLot[];
    /** RoadRunner ParkingSpace bay centroids (runtime meters) — driveway
     *  classifier evidence: a "driveway" stub whose dead-end feeds bays is a
     *  LOT ENTRANCE (operator: driveways have NO parking spots). */
    parkingSpacePoints?: Vec2[];
  };
  /** Planned arrival time for the turn families (default 6 s). */
  arrivalTimeS?: number;
  /** Composite fit floor; sites below it are not admitted (default 0.45). */
  floor?: number;
  /** Top-N cap after the floor (default: all viable sites). */
  limit?: number;
  /**
   * Semantic location constraints (signalized / required tags). Applied as a
   * pre-filter on candidate junctions BEFORE fit ranking, so the floor + top-N
   * operate on the constrained set. A no-op unless `junctionIndex` is supplied.
   */
  constraints?: SiteLocationConstraints;
  /** Per-junction corpus facts/tags the constraints join on (see `buildJunctionConstraintIndex`). */
  junctionIndex?: JunctionConstraintIndex;
  /** Kind-tagged POIs (runtime meters) for the `nearPoi` constraint. */
  poiIndex?: ReadonlyArray<CollisionSitePoi>;
  /** Radius for `nearPoi` proximity (default 80 m). */
  nearPoiRadiusM?: number;
  /**
   * Turn-across-crosswalk families only (dib 2026-07-24 — "ped collision
   * avoidance at driveway: separate category"). When true, restrict selection to
   * DRIVEWAY-destination sites so a dedicated emit cell yields a consistent
   * driveway-turn set. Forwarded straight to `selectTurnPedCrosswalkSites`;
   * a no-op for every other family. Default/false keeps the mixed set.
   */
  entranceOnly?: boolean;
  /** @deprecated alias of `entranceOnly`. */
  drivewayOnly?: boolean;
}

function mapAnchor(topology: MapTopologyIndex): Vec2 | null {
  // The pedestrian selector returns ALL room-viable sites regardless of anchor
  // (the anchor only drives its internal proximity score, which we discard and
  // replace with fit). Any junction centroid is a fine seed.
  for (const junctionId of Object.keys(topology.junctions)) {
    const centroid = topologyJunctionCentroid(topology, junctionId);
    if (centroid) return centroid.center;
  }
  return null;
}

/**
 * Enumerate viable pedestrian-crossing sites across the map, fit-ranked.
 *
 * Run-up headroom is the dominant ranking term: a site that clears the room
 * guard by a comfortable margin lets the subject reach speed and absorb tracking
 * error before the conflict, which the contact baseline showed matters far more
 * than proximity. Crossing perpendicularity is ~ideal by construction for the
 * pedestrian family (the crossing axis is perpendicular to the subject heading), so
 * it does not discriminate here — junction cleanliness (from the corpus typed
 * facts) is the next term to fold in.
 */
function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Crossing-geometry quality in [0,1] for a pedestrian site, from the resolved
 * curb-to-curb line. A normal 1–2 lane crossing spans ~7–14 m; penalize
 * over-wide / distant-curb crossings (the CG1 "crossed 47 m down the road" /
 * CG2 "over-wide" cases) and demote road-edge fallbacks (no real pedestrian
 * infrastructure at the conflict). This is the per-site discriminator the run-up
 * term lacks — degenerate geometry ranks DOWN instead of floating to the top.
 */
function pedCrossingQuality(
  topology: MapTopologyIndex,
  pedSite: PedCrossingSite,
  regions: NonNullable<FindCollisionSitesArgs["regions"]>,
): number {
  const crossing = resolveCrossingLine({
    topology,
    conflictPoint: pedSite.conflictPoint,
    approachLaneRsl: pedSite.approachLaneRsl,
    crossingAxisRad: pedSite.crossingAxisRad,
    crosswalks: regions.crosswalks,
    sidewalks: regions.sidewalks,
    poiPoints: regions.poiPoints,
  });
  if (!crossing) return 0.6; // degenerate topology -> neutral-ish, not ideal
  const spanM = Math.abs(crossing.spawnOffsetM) + Math.abs(crossing.farOffsetM);
  // span 0–14 m -> 1.0; ramps down to 0 by ~44 m.
  let quality = clamp01(1 - Math.max(0, spanM - 14) / 30);
  if (crossing.source === "road_edge") quality *= 0.7;
  return quality;
}

/** Match radius (m) for associating an occluder with a ped conflict point. The
 *  parking-near-conflict detector already requires proximity to the crosswalk,
 *  so this is a generous catch for the projected cluster centroid. */
/** 30 -> 40 (dib review 2026-07-03: raise the occluded share — occlusions rated
 *  the strongest realism element; candidate scarcity, not the emit count, was
 *  the limiter: saratoga matched only 2 occluded sites of 60 requested). */
const OCCLUDER_MATCH_RADIUS_M = 40;
/** How strongly an occlusion match boosts a ped site's fit (added to fitScore so
 *  occluded sites rank above non-occluded ones — workstream D1). */
const OCCLUSION_FIT_WEIGHT = 0.6;

/** Nearest occluder to `point` within {@link OCCLUDER_MATCH_RADIUS_M}, plus a
 *  proximity-weighted occlusion score in [0,1]. Null when none is near. */
function matchOccluder(
  point: Vec2,
  occluders: ReadonlyArray<ProjectedOccluder> | undefined,
): { occluder: ProjectedOccluder; score: number } | null {
  if (!occluders || occluders.length === 0) return null;
  let best: ProjectedOccluder | null = null;
  let bestDist = Infinity;
  for (const o of occluders) {
    const d = Math.hypot(o.point.x - point.x, o.point.y - point.y);
    if (d < bestDist) {
      bestDist = d;
      best = o;
    }
  }
  if (!best || bestDist > OCCLUDER_MATCH_RADIUS_M) return null;
  const proximity = 1 - bestDist / OCCLUDER_MATCH_RADIUS_M;
  return { occluder: best, score: clamp01(best.confidence * proximity) };
}

/** Synthesized-occluder confidence for mid-block sites with no DB occluder
 *  nearby. The parked body is SPAWNED by us (D2 placement + LOS verify), so the
 *  only uncertainty is placement geometry — below a matched high-confidence DB
 *  cluster, above weak matches. */
const SYNTHESIZED_OCCLUDER_CONFIDENCE = 0.75;
/** Rotate synthesized-occluder subtypes for visual variety (car ↔ large; bus
 *  stays context-gated to real bus stops per the 2026-07-03 occluder classes). */
const SYNTHESIZED_OCCLUDER_SUBTYPES = [
  "PARKING_NEAR_CONFLICT_POINT",
  "COMMERCIAL_DELIVERY_OCCLUSION",
] as const;

function findPedestrianCrossingSites(args: FindCollisionSitesArgs): RankedCollisionSite[] {
  const minTimeS = args.minTimeS ?? 5;
  const anchor = mapAnchor(args.topology);
  if (!anchor) return [];
  const picked = selectPedestrianCrossingSite({
    topology: args.topology,
    anchor,
    subjectSpeedKph: args.subjectSpeedKph,
    minTimeS,
  });
  // Gate-anchored sites + MID-BLOCK stations (dib 2026-07-08: ped collisions
  // "literally anywhere"). Both run through the same constraint filter — a
  // mid-block site correctly fails junction-evidence constraints (signalized/
  // tags) and correctly participates in geometric ones (nearPoi).
  const midblock = selectMidblockPedSites({
    topology: args.topology,
    subjectSpeedKph: args.subjectSpeedKph,
    minTimeS,
  });
  const sites = [...(picked?.sites ?? []), ...midblock].filter((s) =>
    junctionPassesConstraints(
      isMidblockGateId(s.gate.id) ? null : s.gate.junctionId,
      args.constraints,
      {
        index: args.junctionIndex,
        referencePoint: s.conflictPoint,
        poiIndex: args.poiIndex,
        nearPoiRadiusM: args.nearPoiRadiusM ?? DEFAULT_NEAR_POI_RADIUS_M,
      },
    ),
  );
  if (sites.length === 0) return [];

  const requiredRunUpM = (args.subjectSpeedKph * minTimeS) / 3.6;
  const scored = sites.map((pedSite) => {
    const baseFit = scoreCollisionSite({
      signals: {
        runUpM: pedSite.roomM,
        requiredRunUpM,
        // Crossing-geometry quality from the resolved curb-to-curb line when
        // regions are supplied (demotes over-wide / distant / road-edge
        // crossings); ideal by construction otherwise.
        conflictPerpendicularity: args.regions
          ? pedCrossingQuality(args.topology, pedSite, args.regions)
          : 1,
      },
      // Cleanliness from the gate's junction: prefer simple junctions, demote
      // complex multi-leg ones (the audit's complete, authoritative signal).
      facts: topologyJunctionFacts(args.topology, pedSite.gate.junctionId),
      floor: args.floor ?? DEFAULT_FIT_FLOOR,
    });
    // D1: a crossing next to street parking is where a real occluded VRU
    // collision happens (the ops review's "no occlusion -> not viable" gap).
    // Boost occluded sites above non-occluded ones (added AFTER the floor verdict
    // so it ranks, not admits) and carry the matched occluder for D2 placement.
    let matched = matchOccluder(pedSite.conflictPoint, args.regions?.occluders);
    // Mid-block sites SYNTHESIZE their occluder when no DB cluster is nearby —
    // the parked body is ours to spawn (D2 placement derives its position from
    // the walker spawn + subject path; the point below only seeds the record), so
    // occlusion is available anywhere by construction. Subtype rotates
    // deterministically (car ↔ large) for visual variety.
    if (!matched && isMidblockGateId(pedSite.gate.id)) {
      let h = 0;
      for (const ch of pedSite.gate.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      matched = {
        occluder: {
          point: pedSite.conflictPoint,
          confidence: SYNTHESIZED_OCCLUDER_CONFIDENCE,
          subtype: SYNTHESIZED_OCCLUDER_SUBTYPES[h % SYNTHESIZED_OCCLUDER_SUBTYPES.length]!,
        },
        score: SYNTHESIZED_OCCLUDER_CONFIDENCE,
      };
    }
    const fit = matched
      ? { ...baseFit, fitScore: baseFit.fitScore + OCCLUSION_FIT_WEIGHT * matched.score }
      : baseFit;
    return {
      pedSite,
      tieKey: pedSite.gate.id,
      fit,
      occluder: matched?.occluder ?? null,
    };
  });

  const limit = args.limit ?? scored.length;
  return selectTopSites(scored, limit).map((s) => ({
    family: "pedestrian_crossing" as const,
    siteId: `ped:${s.pedSite.gate.id}`,
    conflictPoint: s.pedSite.conflictPoint,
    fit: s.fit,
    pedSite: s.pedSite,
    occluder: s.occluder,
  }));
}

function polylineLengthM(points: ReadonlyArray<{ x: number; y: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

/** Heading (rad) of a polyline's final segment — the actor's direction at the conflict. */
function exitHeading(points: ReadonlyArray<{ x: number; y: number }>): number | null {
  if (points.length < 2) return null;
  const b = points[points.length - 1]!;
  const a = points[points.length - 2]!;
  if (a.x === b.x && a.y === b.y) return null;
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * Crossing perpendicularity in [0,1] for a turn conflict: |sin(Δheading)|
 * between the subject turn path and the conflicting through path at the meeting
 * point. 1 = a clean ~perpendicular T-bone; →0 = an oblique/grazing crossing
 * (a worse, less reliable collision). Unlike the pedestrian family this is a
 * real per-site discriminator.
 */
function turnPerpendicularity(plan: PlannedCollision): number {
  const subjectH = exitHeading([plan.subject.spawnPoint, ...plan.subject.waypoints]);
  const npcH = exitHeading([plan.npc.spawnPoint, ...plan.npc.waypoints]);
  if (subjectH == null || npcH == null) return 0.6; // unknown -> neutral-ish
  return Math.abs(Math.sin(subjectH - npcH));
}

const TURN_SOLVERS: Record<TurnFamily, typeof planUnprotectedLeftTurnGated> = {
  unprotected_left_turn: planUnprotectedLeftTurnGated,
  right_turn_hook: planRightTurnHookGated,
};

/**
 * HARD geometric viability gate for a turn site — applied BEFORE fit ranking so
 * the 1-shot creator never emits a junction that geometrically cannot host a
 * turn collision (the fit score only *ranks*, so a grazing junction with a long
 * run-up could average to "viable" and float into the top-N).
 *
 * The degenerate class is the GRAZING / near-parallel crossing: the subject turn
 * path and the conflicting through path meet at too shallow an angle (|sinΔ|
 * low), so they run alongside instead of T-boning — no reliable contact is
 * possible regardless of timing. On Yale this drops ~20 of ~34 left junctions
 * (perp ≤ 0.41) and keeps the real crossings (perp ≥ 0.56).
 *
 * What this DELIBERATELY does not filter: timing misses. A clean T-bone junction
 * (perp ≈ 1) that misses in CARLA because the turning subject lags its schedule
 * (e.g. left-1340 / 1302) is a TIMING problem, not a bad location — the repair
 * loop re-times the NPC to fix it. Path lengths are not gated either: the gated
 * planner pads subject + NPC to a fixed run-up, so a length gate would be dead (it
 * returns null when a junction can't host the run-up, excluding it upstream).
 */
const MIN_TURN_PERPENDICULARITY = 0.4; // |sin Δheading| — reject crossings shallower than ~24°
// A right hook is INHERENTLY a shallow-angle conflict: the subject turns across a
// near-PARALLEL through-rider (cyclist/vehicle on its right continuing straight),
// and that crossing happens early in the turn where the subject is still ~parallel to
// the rider — so the T-bone perpendicularity gate above rejects essentially every
// real right hook (measured: 150 viable plans → 13 sites, ~91% dropped). The gated
// planner has already verified a STRICT in-junction crossing, so a right hook only
// needs a tiny non-degenerate floor (reject an exactly-parallel grazing alongside).
const MIN_RIGHT_HOOK_PERPENDICULARITY = 0.05;

function turnSiteViable(plan: PlannedCollision, family: TurnFamily): boolean {
  const floor =
    family === "right_turn_hook" ? MIN_RIGHT_HOOK_PERPENDICULARITY : MIN_TURN_PERPENDICULARITY;
  return turnPerpendicularity(plan) >= floor;
}

/**
 * Enumerate viable turn-conflict sites across the map, fit-ranked. The gated
 * solver picks the junction NEAREST its `documentCenter`, so feeding each
 * junction's own centroid enumerates per junction; a non-null plan is a viable
 * site. Fit = run-up headroom + crossing perpendicularity + junction
 * cleanliness.
 */
/** Winding-number/ray-cast point-in-polygon on a runtime-meter ring. */
function pointInPolygon(pt: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const intersects =
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** A turn junction whose centroid falls inside a curated parking-lot polygon is a
 *  parking-lot AISLE crossing, not a street intersection. Its clean ~90° geometry
 *  otherwise floats to the TOP of the fit ranking (2026-07-09: "only parking-lot
 *  lefts survived"). Multiply its fitScore by this so real street lefts outrank it,
 *  while a MINORITY of parking-lot lefts still make the tail (the operator rated one
 *  "ok, 3/5" — keep some, don't exclude). */
const PARKING_LOT_FIT_PENALTY = 0.55;

function findTurnSites(args: FindCollisionSitesArgs, family: TurnFamily): RankedCollisionSite[] {
  const solver = TURN_SOLVERS[family];
  const parkingLots = args.regions?.parkingLots ?? [];
  const subjectSpeedKph = args.subjectSpeedKph;
  const npcSpeedKph = args.npcSpeedKph ?? subjectSpeedKph;
  const arrivalTimeS = args.arrivalTimeS ?? 6;
  const requiredRunUpM = (subjectSpeedKph * arrivalTimeS) / 3.6;

  const scored: Array<{
    junctionId: string;
    plan: PlannedCollision;
    tieKey: string;
    fit: SiteFitResult;
    occluder: ProjectedOccluder | null;
  }> = [];
  for (const junctionId of Object.keys(args.topology.junctions)) {
    const centroid = topologyJunctionCentroid(args.topology, junctionId);
    if (!centroid) continue;
    if (
      !junctionPassesConstraints(junctionId, args.constraints, {
        index: args.junctionIndex,
        referencePoint: centroid.center,
        poiIndex: args.poiIndex,
        nearPoiRadiusM: args.nearPoiRadiusM ?? DEFAULT_NEAR_POI_RADIUS_M,
      })
    )
      continue;
    const plan = solver({
      topology: args.topology,
      documentCenter: centroid.center,
      subjectSpeedKph,
      npcSpeedKph,
      arrivalTimeS,
    });
    if (!plan) continue;
    // Drop grazing / near-parallel junctions that can't T-bone, before they can
    // rank into the top-N (timing misses are left for the repair loop).
    if (!turnSiteViable(plan, family)) continue;
    const runUpM = polylineLengthM([plan.subject.spawnPoint, ...plan.subject.waypoints]);
    const baseFit = scoreCollisionSite({
      signals: { runUpM, requiredRunUpM, conflictPerpendicularity: turnPerpendicularity(plan) },
      facts: topologyJunctionFacts(args.topology, junctionId),
      floor: args.floor ?? DEFAULT_FIT_FLOOR,
    });
    // Right-hook + occlusion (dib): a parked car next to the conflict turns this
    // into the high-value "cyclist emerges from behind a parked car as the subject
    // turns across the bike lane" case. Boost occluded right-hook sites above
    // clear ones (mirrors the pedestrian D1 occlusion ranking) and carry the
    // matched occluder for placement. Left turns keep clear sightlines.
    const matched =
      family === "right_turn_hook"
        ? matchOccluder(plan.conflictPoint, args.regions?.occluders)
        : null;
    const boosted = matched
      ? { ...baseFit, fitScore: baseFit.fitScore + OCCLUSION_FIT_WEIGHT * matched.score }
      : baseFit;
    // Both turn families are viable BY CONSTRUCTION: the gated planner verified a
    // strict in-junction crossing on a DIFFERENT road + travelsWithLane + spawn
    // spread, and turnSiteViable() above already hard-gated grazing/near-parallel
    // geometry. scoreCollisionSite's floor is T-bone-calibrated and additionally
    // acts as an IMPLICIT perpendicularity≈0.73 gate, because its run-up-headroom
    // term (weight 0.4) is structurally ≈0 — the subject path is padded to exactly the
    // required run-up, so runUpM≈requiredRunUpM for every turn site. An unprotected
    // LEFT is a car arcing ACROSS oncoming traffic, so its conflict is inherently
    // OBLIQUE (perp 0.4-0.7) and it failed that hidden floor — which is why only
    // near-90° parking-lot aisle crossings survived (2026-07-09 review: "only
    // parking-lot lefts"). Trust the planner for lefts too: keep the fitScore for
    // RANKING but don't let the perp-heavy floor drop a geometrically-real street
    // left. Quality control moves to the 2D + authoritative-3D behavior gates.
    const viabilityTrusted =
      family === "right_turn_hook" || family === "unprotected_left_turn"
        ? { ...boosted, viable: true }
        : boosted;
    // Down-rank parking-lot aisle junctions (centroid inside a curated lot polygon)
    // so street unprotected-lefts dominate the top-N.
    const inParkingLot =
      parkingLots.length > 0 &&
      parkingLots.some((lot) => pointInPolygon(centroid.center, lot.polygon));
    const fit = inParkingLot
      ? { ...viabilityTrusted, fitScore: viabilityTrusted.fitScore * PARKING_LOT_FIT_PENALTY }
      : viabilityTrusted;
    scored.push({ junctionId, plan, tieKey: junctionId, fit, occluder: matched?.occluder ?? null });
  }

  const limit = args.limit ?? scored.length;
  return selectTopSites(scored, limit).map((s) => ({
    family,
    siteId: `${family === "unprotected_left_turn" ? "left" : "right"}:${s.junctionId}`,
    conflictPoint: s.plan.conflictPoint,
    fit: s.fit,
    junctionId: s.junctionId,
    plan: s.plan,
    occluder: s.occluder,
  }));
}

/**
 * Conflicts staged near the edge of the road network read badly on camera —
 * the subject's approach or run-out visibly leaves the built world ("have the path
 * avoid going to the edge of the map", dib review 2026-07-03: yale-134-33,
 * dirosa-869-31). Gate candidate sites on distance from the drivable-network
 * bounding box; fail open when the gate would starve a small map of sites.
 */
const MAP_EDGE_MARGIN_M = 30;

function drivableBounds(topology: MapTopologyIndex): {
  minX: number; maxX: number; minY: number; maxY: number;
} | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const lane of Object.values(topology.lanes ?? {})) {
    // Normalize before comparing: lane-type casing varies across sources
    // ("Driving" vs "driving"); a case-sensitive miss here would return null
    // bounds and silently fail-open the whole edge gate (PR #309 review).
    if ((lane.laneType ?? "").toLowerCase() !== "driving") continue;
    for (const p of lane.polyline ?? []) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

function dropSitesNearMapEdge(
  sites: RankedCollisionSite[],
  args: FindCollisionSitesArgs,
): RankedCollisionSite[] {
  const bounds = drivableBounds(args.topology);
  if (!bounds || sites.length === 0) return sites;
  const inner = sites.filter((s) => {
    const p = s.conflictPoint;
    return (
      p.x - bounds.minX >= MAP_EDGE_MARGIN_M &&
      bounds.maxX - p.x >= MAP_EDGE_MARGIN_M &&
      p.y - bounds.minY >= MAP_EDGE_MARGIN_M &&
      bounds.maxY - p.y >= MAP_EDGE_MARGIN_M
    );
  });
  // Fail open: a tiny map where the margin would reject most sites keeps them
  // (better an edge-adjacent scene than no scene).
  return inner.length >= Math.max(1, Math.ceil(sites.length * 0.25)) ? inner : sites;
}

export function findCollisionSites(args: FindCollisionSitesArgs): RankedCollisionSite[] {
  switch (args.family) {
    case "pedestrian_crossing":
      return diversifyRankedSites(dropSitesNearMapEdge(findPedestrianCrossingSites(args), args));
    case "unprotected_left_turn":
    case "right_turn_hook":
      return diversifyRankedSites(dropSitesNearMapEdge(findTurnSites(args, args.family), args));
    case "bicycle_merge":
      return diversifyRankedSites(dropSitesNearMapEdge(findBicycleMergeSitesRanked(args), args));
    case "left_turn_ped_crosswalk":
    case "right_turn_ped_crosswalk":
      return diversifyRankedSites(
        dropSitesNearMapEdge(findTurnPedCrosswalkSites(args, args.family), args),
      );
    default:
      return [];
  }
}

/**
 * Crossing-geometry quality in [0,1] for a turn-across-crosswalk site, from the
 * resolved curb-to-curb line on the DESTINATION (exit) leg. Mirrors
 * {@link pedCrossingQuality}: penalize over-wide / distant-curb crossings and
 * demote road-edge fallbacks. The exit lane's rsl stands in as the approach lane
 * for the resolver's road-edge fallback.
 */
function turnPedCrossingQuality(
  topology: MapTopologyIndex,
  site: TurnPedCrosswalkSite,
  regions: NonNullable<FindCollisionSitesArgs["regions"]>,
): number {
  const crossing = resolveCrossingLine({
    topology,
    conflictPoint: site.conflictPoint,
    approachLaneRsl: site.exitLaneRsl,
    crossingAxisRad: site.crossingAxisRad,
    crosswalks: regions.crosswalks,
    sidewalks: regions.sidewalks,
    poiPoints: regions.poiPoints,
  });
  if (!crossing) return 0.6;
  const spanM = Math.abs(crossing.spawnOffsetM) + Math.abs(crossing.farOffsetM);
  let quality = clamp01(1 - Math.max(0, spanM - 14) / 30);
  if (crossing.source === "road_edge") quality *= 0.7;
  return quality;
}

/**
 * Enumerate viable turn-across-crosswalk sites for one turn direction, fit-ranked.
 * The gate-based selector (`selectTurnPedCrosswalkSites`) yields every Left/Right
 * gate with a real destination leg + run-up room; here we join constraints, score
 * (run-up headroom + destination-leg crossing quality + junction cleanliness), and
 * trust viability by construction (a real turn gate + driving exit leg), like the
 * turn families — the 2D + authoritative-3D gates do the quality control.
 */
function findTurnPedCrosswalkSites(
  args: FindCollisionSitesArgs,
  family: TurnPedCrosswalkFamily,
): RankedCollisionSite[] {
  const minTimeS = args.minTimeS ?? 5;
  const turn = family === "left_turn_ped_crosswalk" ? "Left" : "Right";
  const { sites } = selectTurnPedCrosswalkSites({
    topology: args.topology,
    turn,
    subjectSpeedKph: args.subjectSpeedKph,
    minTimeS,
    entranceOnly: args.entranceOnly ?? args.drivewayOnly,
    // Driveway classifier evidence (operator round 2): parking bays/lots veto
    // lot entrances ("driveways have NO parking spots"); Overture service
    // segments carry the semantic label once the enrichment retains subclass.
    drivewaySignals: args.regions
      ? {
          parkingSpacePoints: args.regions.parkingSpacePoints,
          parkingLots: args.regions.parkingLots,
        }
      : undefined,
  });
  const filtered = sites.filter((s) =>
    junctionPassesConstraints(s.junctionId, args.constraints, {
      index: args.junctionIndex,
      referencePoint: s.conflictPoint,
      poiIndex: args.poiIndex,
      nearPoiRadiusM: args.nearPoiRadiusM ?? DEFAULT_NEAR_POI_RADIUS_M,
    }),
  );
  if (filtered.length === 0) return [];

  const requiredRunUpM = (args.subjectSpeedKph * minTimeS) / 3.6;
  const scored = filtered.map((turnSite) => {
    const baseFit = scoreCollisionSite({
      signals: {
        runUpM: turnSite.roomM,
        requiredRunUpM,
        // Perpendicular by construction; when regions are supplied, demote
        // over-wide / road-edge destination-leg crossings.
        conflictPerpendicularity: args.regions
          ? turnPedCrossingQuality(args.topology, turnSite, args.regions)
          : 1,
      },
      facts: topologyJunctionFacts(args.topology, turnSite.junctionId),
      floor: args.floor ?? DEFAULT_FIT_FLOOR,
    });
    // Match a roadside occluder to the EXIT-LEG conflict point, exactly as the
    // straight pedestrian_crossing family does. Without this a turn-ped site
    // was always occluder-less, which made `requireOccluder` a silent no-op for
    // these families and left the Euro NCAP CPTA obstructed variants
    // (CPTAfo / CPTAno) with no way to be generated at all (dib 2026-07-29).
    // Boost occluded sites AFTER the floor verdict so occlusion ranks rather
    // than admits — same ordering, and same weight, as the ped family.
    const matched = matchOccluder(turnSite.conflictPoint, args.regions?.occluders);
    const fit = matched
      ? { ...baseFit, fitScore: baseFit.fitScore + OCCLUSION_FIT_WEIGHT * matched.score }
      : baseFit;
    return {
      turnSite,
      tieKey: turnSite.gate.id,
      // Trust viability by construction (a real Left/Right gate + a driving exit
      // leg + run-up room) — an oblique turn's perp-heavy fit floor would
      // otherwise drop geometrically-real street turns (same trust the turn
      // families apply).
      fit: { ...fit, viable: true },
      occluder: matched?.occluder ?? null,
    };
  });

  const limit = args.limit ?? scored.length;
  return selectTopSites(scored, limit).map((s) => ({
    family,
    siteId: `${family === "left_turn_ped_crosswalk" ? "leftped" : "rightped"}:${s.turnSite.gate.id}`,
    conflictPoint: s.turnSite.conflictPoint,
    fit: s.fit,
    junctionId: s.turnSite.junctionId,
    turnSite: s.turnSite,
    occluder: s.occluder,
  }));
}

/** Min distance between selected conflict points (strict pass). dib review
 *  2026-07-08: every belmont ped scene landed at ONE junction — fitScore alone
 *  ranks the single best corridor's gates back-to-back. */
const DIVERSITY_MIN_SPACING_M = 60;
/** Max sites sharing one anchor (junction for peds/turns, lane for merges). */
const DIVERSITY_PER_ANCHOR_CAP = 2;

function siteAnchorKey(site: RankedCollisionSite): string {
  return site.family === "pedestrian_crossing"
    ? `j:${site.pedSite.gate.junctionId}`
    : `j:${site.junctionId}`;
}

/**
 * Re-order a fit-ranked site list so consumers taking the top-N get SPATIAL
 * SPREAD, not the best corridor densified. Greedy in fit order over relaxing
 * passes — never drops a site, only demotes clustered ones to the tail:
 *   pass 1: spacing >= DIVERSITY_MIN_SPACING_M AND per-anchor cap
 *   pass 2: per-anchor cap only (small map: corridors closer than the floor)
 *   pass 3: everything left, original fit order (old behavior as the tail)
 */
export function diversifyRankedSites(sites: RankedCollisionSite[]): RankedCollisionSite[] {
  const picked: RankedCollisionSite[] = [];
  const pickedIds = new Set<string>();
  const anchorCounts = new Map<string, number>();
  const far = (site: RankedCollisionSite) =>
    picked.every(
      (p) =>
        Math.hypot(
          p.conflictPoint.x - site.conflictPoint.x,
          p.conflictPoint.y - site.conflictPoint.y,
        ) >= DIVERSITY_MIN_SPACING_M,
    );
  const underCap = (site: RankedCollisionSite) =>
    (anchorCounts.get(siteAnchorKey(site)) ?? 0) < DIVERSITY_PER_ANCHOR_CAP;
  const take = (site: RankedCollisionSite) => {
    picked.push(site);
    pickedIds.add(site.siteId);
    const key = siteAnchorKey(site);
    anchorCounts.set(key, (anchorCounts.get(key) ?? 0) + 1);
  };
  for (const site of sites) {
    if (far(site) && underCap(site)) take(site);
  }
  for (const site of sites) {
    if (!pickedIds.has(site.siteId) && underCap(site)) take(site);
  }
  for (const site of sites) {
    if (!pickedIds.has(site.siteId)) take(site);
  }
  return picked;
}

/**
 * Bicycle-merge sites (a cyclist steers out of a parallel bike lane into the
 * subject's lane). The planner enumerates + pre-solves each; here we wrap each in a
 * fit (run-up headroom is the only meaningful term — there's no junction) and
 * apply the top-N cap, matching the turn-site shape so the batch generator
 * consumes it identically.
 */
function findBicycleMergeSitesRanked(args: FindCollisionSitesArgs): RankedCollisionSite[] {
  const subjectSpeedKph = args.subjectSpeedKph;
  const npcSpeedKph = args.npcSpeedKph ?? subjectSpeedKph;
  const arrivalTimeS = args.arrivalTimeS ?? 6;
  const requiredRunUpM = (subjectSpeedKph * arrivalTimeS) / 3.6;
  const merges = findBicycleMergeSites({
    topology: args.topology,
    subjectSpeedKph,
    npcSpeedKph,
    arrivalTimeS,
  });
  const scored = merges.map((m) => ({
    site: m,
    tieKey: m.laneId,
    fit: scoreCollisionSite({
      signals: { runUpM: m.runUpM, requiredRunUpM, conflictPerpendicularity: 1 },
      facts: {} as MapSearchDocumentFacts,
      floor: args.floor ?? DEFAULT_FIT_FLOOR,
    }),
  }));
  const limit = args.limit ?? scored.length;
  return selectTopSites(scored, limit).map((s) => ({
    family: "bicycle_merge" as const,
    siteId: `merge:${s.site.laneId}`,
    conflictPoint: s.site.conflictPoint,
    fit: s.fit,
    junctionId: s.site.laneId,
    plan: s.site.plan,
  }));
}
