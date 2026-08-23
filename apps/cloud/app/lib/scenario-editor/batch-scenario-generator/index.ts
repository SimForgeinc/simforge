import type { AppContext } from "@/app/lib/db/app-context";
import {
  createDatasetScenario,
  listVariationsForDataset,
} from "@/app/lib/db/scenario-query-store";
import { readSemanticRoadSegmentsByMapName } from "@/app/lib/maps/topology/server/semantic-road-network";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import type { ParkingLaneRef } from "@/app/lib/maps/topology/parking-lanes";
import { parkingLanesFromTopology } from "@/app/lib/maps/topology/parking-lanes";
import { getMapTopologyIndex } from "@/app/lib/maps/topology/server/topology-index-service";
import { resolveMapAssetReference } from "../scenario-api-store";
import { loadMotorwayFootprintForMap } from "./road-class-gate";
import type {
  BatchParkedDensity,
  BatchScenarioStrategy,
  BatchTrafficProfile,
  BatchTrafficSource,
  Candidate,
} from "./types";
import type { SumoAmbientEmitInput } from "./emit";
import {
  MAP_AMBIENT_CAP,
  SEMANTIC_NETWORK_READ_TIMEOUT_MS,
  congestedEgoSpeedKph,
} from "./constants";
import { isDrivableSegment, segmentLengthMeters, segmentRsl } from "./graph";
import {
  centerlinePointAtFraction,
  hashSeed,
  laneKeepRunwayMeters,
  measureEmittedRouteCorridor,
  routeFollowRunwayMeters,
  seededRandom,
  speedLimitInBand,
  survivalRunwayBestBranchMeters,
  survivalRunwayMeters,
  worldAnchorAtFraction,
  buildForwardRouteThroughSuccessors,
  upstreamSpawnForApproach,
} from "./routing";
import { drawBatchEnvironmentPreset, variationForScenario } from "./variation";
import {
  candidatesForStrategy,
  stopAnchorableJunctionEntryCandidates,
} from "./candidates";
import { stopVariantFallbackOrder } from "./placement-stop";
import {
  assessEgoRouteOverrun,
  drawPlacementForBucket,
  placeVariationOnCandidate,
  placementAnchorKey,
} from "./placement";
import { type MapExtent, resolveMapExtent } from "./extent";
import { fetchMapRenderExtent } from "./extent-source";
import {
  buildBatchTrafficActors,
  buildHeavyTrafficFillActors,
  buildParkedActors,
  buildStopLeadActor,
  clampHeavyTrafficTargetCount,
} from "./actors";
import { applyGeneratedDraft, instructionsForStrategy, plannedEgoCorridor } from "./emit";
import { attributeControl, fetchMapSignals, type MapSignals } from "./signals-source";
import { isHighwayStrategy, isStopJunctionStrategy, stopJunctionControl } from "./types";

// Re-export the public type/const surface so existing importers keep using the
// same `batch-scenario-generator` path after the modular split.
export {
  BATCH_SCENARIO_STRATEGIES,
  BATCH_SCENARIO_DEFAULT_STRATEGIES,
  BATCH_HIGHWAY_SCENARIO_STRATEGIES,
  BATCH_TRAFFIC_PROFILES,
  BATCH_TRAFFIC_SOURCES,
  BATCH_PARKED_DENSITIES,
} from "./types";
export type {
  BatchScenarioStrategy,
  BatchTrafficProfile,
  BatchTrafficSource,
  BatchParkedDensity,
} from "./types";
export type { SumoAmbientEmitInput } from "./emit";
// `ParkingLaneRef` + the topology extractor live in the shared maps module so
// the collision scene-population layer reuses them. Re-exported here for the
// existing batchGenerateScenarios `parkingLanes` callers.
export type { ParkingLaneRef };
export { clampHeavyTrafficTargetCount } from "./actors";

export type BatchGenerateScenarioRequest = {
  count: number;
  mapNames: string[];
  strategies: BatchScenarioStrategy[];
  alpamayoCapture: boolean;
  trafficEnabled: boolean;
  /** "normal" (default) keeps the existing near-field-ring-only behavior
   * byte-identical; "heavy" additionally lane-fills the subject's surroundings
   * with jam traffic (see buildHeavyTrafficFillActors). */
  trafficProfile?: BatchTrafficProfile;
  /** Where the mid/far-field ambient comes from: "procedural" (default, the
   * geometric fill) or "sumo" (a warmed offline SUMO window). Opt-in — it sits
   * ALONGSIDE trafficProfile rather than replacing it, and "procedural" stays
   * byte-identical to the pre-SUMO generator. */
  trafficSource?: BatchTrafficSource;
  /** Supplies the SUMO window per (map, scene). Required when
   * trafficSource === "sumo". The caller reads the window out of the movie and
   * hands it in, so the generator itself stays pure. Returning null for a map
   * makes that map fall back to the procedural fill. */
  sumoAmbientForScene?: (input: {
    mapName: string;
    seed: number;
    datasetId: string;
    /** Placed subject spawn (runtime XY) — lets the supplier pick the movie
     * window whose traffic is AROUND the subject (the flow is corridor-wide but
     * only spawns inside the streamed bubble survive; a window whose mass
     * sits elsewhere on the map yields a starved scene). */
    subjectSpawn?: { x: number; y: number };
    /** Planned subject trajectory (scene-time samples) — lets the supplier score
     * windows by TIME-SYNCED camera value (the subject outruns congested flow, so
     * spawn-relative scores are stale by mid-clip). */
    subjectCorridor?: Array<{ t: number; x: number; y: number }>;
  }) => SumoAmbientEmitInput | null;
  /** heavy profile only: total vehicles per scenario (subject + near-field ring
   * + fill), clamped to [50, 400]; default 250. */
  heavyTrafficTargetCount?: number;
  /** Hard ceiling on the PROCEDURAL fill population, bypassing the [50,400]
   * target floor. Exists for count-matched A/B controls (match the fill to a
   * capped SUMO arm) and for spawn-budget experiments; unset keeps production
   * behavior. Combines with the per-map ambient cap by minimum. */
  ambientCap?: number;
  /** Mix large vehicles (city bus + articulated semi-trailer + box truck) into
   * the background lane fill (medium/heavy profiles only). Default false keeps
   * the fill all passenger cars and byte-identical. Long bodies (~12-16m) may
   * fail the tightest spawns — they're kept off the subject's own corridor, given
   * extra headway, and the worker tolerates individual spawn failures. */
  heavyVehiclesEnabled?: boolean;
  /** Mix cyclists into the background lane fill (medium/heavy profiles only).
   * Default false. Off the subject's corridor, capped at bike speed. */
  bikesEnabled?: boolean;
  /** Street-parking density. "none" (default) places no parked cars and keeps
   * the scene byte-identical. light/moderate/heavy line the curb lanes around
   * the subject with static parked vehicles (see buildParkedActors). */
  parkedDensity?: BatchParkedDensity;
  /** Optional per-scenario annotation merged verbatim into each created
   * scenario's variationParams under `sceneAnnotation` (e.g. nav prompt, road
   * type, traffic/parking density). Free-form metadata for downstream training
   * / export consumers; the dashboard batch UI leaves it unset. */
  sceneAnnotation?: Record<string, unknown> | null;
  /** Annotated Parking lanes (from the map topology index) used to place street
   * parking when parkedDensity != "none". The slimmed runtime bundle omits
   * parking lanes, so the caller supplies them per map. Absent → no parked cars
   * even when parkedDensity is set. */
  parkingLanes?: ReadonlyArray<ParkingLaneRef>;
  /** Added to every scenario's seed. Lets a caller redraw the same
   * (map, strategy) bucket with a different placement when a single-count draw
   * skips (insufficient runway) or lands an undesired spot — without polluting
   * the dataset (skips create nothing). Default 0 keeps placement byte-identical. */
  seedOffset?: number;
  /** Overrides the drawn subject cruise speed (km/h) for every scenario. Lowering it
   * shrinks the forward-runway demand (runway ≈ speed × ~13s), which is what
   * lets lane_keep / lane_change fit short urban blocks (e.g. Yale, whose
   * longest lane_keep runway is ~80m — impossible at 28+ km/h but fine at
   * ~18 km/h). Omit to keep the drawn per-strategy speed. */
  subjectSpeedKphOverride?: number;
  /** Keep the subject AT subjectSpeedKphOverride under medium/heavy profiles instead of
   * applying the congestion factor (congestedEgoSpeedKph). For SPEED-LABELED
   * cells where the speed IS the scenario — the freeway 100/88/85 rows, whose
   * override also forces placement onto freeway-length runways — a congested
   * subject both breaks the label and re-opens placement on geometry that cannot
   * host the named speed (PR-538 review P1-2). Ambient density is unaffected.
   * Default false: ordinary medium/heavy cells keep the congested subject
   * (dib 2026-07-27: an subject racing its own flow reads wrong). */
  subjectSpeedPinned?: boolean;
  /** Per-lane speed limit (km/h) keyed by rsl ("road:section:lane"), from the
   * topology index (the runtime bundle omits it). Lets the candidate filter
   * pick the right road class. The caller supplies it per map. */
  laneSpeedLimitByRsl?: Record<string, number>;
  /** Restrict subject-spawn candidates to lanes whose speed limit is in this band
   * (km/h) — target highway/arterial vs urban/residential. A candidate with no
   * known speed limit is kept (not filtered out). */
  minSpeedLimitKph?: number;
  maxSpeedLimitKph?: number;
  /** Spawn anchors ("road:section:lane") that prior draws already used. The
   * draw treats them as already-used so it SPREADS placements across the map
   * (prefers a fresh segment; falls back to the least-used when the viable pool
   * is exhausted) instead of re-picking the same 1-2 longest segments. The
   * multi-count path dedups internally; a per-scene caller (count:1 in a loop)
   * accumulates the chosen anchors and feeds them back here. Default [] =
   * byte-identical to the undeduped draw. See operator-review issue #1. */
  excludeSpawnRsls?: ReadonlyArray<string>;
  /** Overrides the datasetId that seeds the RNG hash (placement, variation,
   * traffic, parking) WITHOUT changing where the scenario is persisted. Lets a
   * replay harness reproduce a previously-flagged scene byte-for-byte (same
   * draw) while writing the regenerated draft to a throwaway scratch dataset —
   * so the fix can be A/B'd on the EXACT flagged set. The placement is a pure
   * function of (seedDatasetId, mapName, strategy, seed) + the request opts +
   * excludeSpawnRsls, so recording those four keys + opts at emit time makes any
   * scene exactly reproducible. Default = `datasetId` (no behaviour change). */
  seedDatasetId?: string;
};

export type BatchGenerateScenarioResult = {
  requested: number;
  created: Array<{
    id: string;
    displayName: string;
    mapName: string;
    strategy: BatchScenarioStrategy;
  }>;
  skipped: Array<{ mapName: string; strategy: BatchScenarioStrategy; reason: string }>;
  /** Highway waves are explicit opt-ins: a requested highway strategy with no
   * geometric candidates on ANY requested map fails the whole request (the
   * batch API route returns 400) instead of silently generating an urban-only
   * wave. Present and non-empty only in that failure case. */
  unplaceableHighwayStrategies?: Array<{
    strategy: BatchScenarioStrategy;
    mapNames: string[];
  }>;
};

async function readRuntimeSegmentsForMap(mapName: string): Promise<RuntimeRoadSegment[] | null> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), SEMANTIC_NETWORK_READ_TIMEOUT_MS);
  });
  const read = readSemanticRoadSegmentsByMapName(mapName).catch(() => null);
  return await Promise.race([read, timeout]);
}

export async function batchGenerateScenarios(
  context: AppContext,
  datasetId: string,
  request: BatchGenerateScenarioRequest,
): Promise<BatchGenerateScenarioResult> {
  const perMapCandidates = new Map<string, Candidate[]>();
  const segmentsByMap = new Map<string, ReadonlyMap<string, RuntimeRoadSegment>>();
  // Per-map usable extent for the map-edge placement guard (measured 0.10
  // footprint when the bundle over-covers it, else the bundle bbox).
  const extentByMap = new Map<string, MapExtent | null>();
  // Per-map signals overlay (stop/yield/light + crosswalks) for the stop-junction
  // control ATTRIBUTION: junction-approach candidates are tagged by the control the
  // signals.geojson shows on the approach road, so families land at the right junctions
  // and are labeled from map data (not the worker's runtime detection).
  const signalsByMap = new Map<string, MapSignals | null>();
  const skipped: BatchGenerateScenarioResult["skipped"] = [];
  const trafficProfile: BatchTrafficProfile = request.trafficProfile ?? "normal";
  const trafficSource: BatchTrafficSource = request.trafficSource ?? "procedural";
  const heavyTrafficTargetCount = clampHeavyTrafficTargetCount(
    request.heavyTrafficTargetCount,
  );
  const parkedDensity: BatchParkedDensity = request.parkedDensity ?? "none";
  const heavyVehiclesEnabled = request.heavyVehiclesEnabled === true;
  const bikesEnabled = request.bikesEnabled === true;
  const sceneAnnotation = request.sceneAnnotation ?? null;
  // An explicit `parkingLanes` (the emit harness supplies one) is applied to
  // every map. Otherwise, when parking is requested, load each map's parking
  // lanes from the TOPOLOGY index — the slimmed runtime bundle drops them, so
  // without this `parkedDensity` is recorded but `buildParkedActors` places
  // nothing (scenarios mislabeled as parked with an empty curb; PR #290 P2 / §I).
  const explicitParkingLanes: ReadonlyArray<ParkingLaneRef> = request.parkingLanes ?? [];
  const parkingLanesByMap = new Map<string, ReadonlyArray<ParkingLaneRef>>();
  if (parkedDensity !== "none" && explicitParkingLanes.length === 0) {
    await Promise.all(
      request.mapNames.map(async (mapName) => {
        try {
          const ref = await resolveMapAssetReference(mapName);
          const lanes = ref.mapAssetId
            ? parkingLanesFromTopology(
                await getMapTopologyIndex(ref.mapAssetId, "carla_ue5"),
              )
            : [];
          parkingLanesByMap.set(mapName, lanes);
        } catch (err) {
          // Topology may not be built for a map — degrade to no parking for that
          // map rather than failing the whole batch (mirrors topoForMap).
          console.warn(
            `[batch-gen] no parking topology for ${mapName}: ${(err as Error).message}`,
          );
          parkingLanesByMap.set(mapName, []);
        }
      }),
    );
  }

  // Only the stop-junction families consult the signals overlay; skip the per-map
  // S3 fetch entirely otherwise.
  const needSignals = request.strategies.some(isStopJunctionStrategy);
  const mapSegments = await Promise.all(
    request.mapNames.map(async (mapName) => ({
      mapName,
      segments: await readRuntimeSegmentsForMap(mapName),
      // Source of truth for the map-edge guard: the measured 0.10 render extent
      // from the map-asset render_extent artifact. Null → fall back to the
      // interim const / bundle bbox in resolveMapExtent.
      renderExtent: await fetchMapRenderExtent(mapName),
      signals: needSignals ? await fetchMapSignals(mapName) : null,
    })),
  );

  // Ramp families (highway_entry/exit) need the map's motorway footprint from
  // the stored search-index (road-class gate, dib 2026-07-17). Loaded once per
  // map, only when a ramp strategy is requested; null => those families admit
  // nothing (fail-closed).
  const wantsRampFamilies = request.strategies.some(
    (s) => s === "highway_entry" || s === "highway_exit",
  );

  for (const { mapName, segments, renderExtent, signals } of mapSegments) {
    if (segments) {
      segmentsByMap.set(mapName, new Map(segments.map((seg) => [segmentRsl(seg), seg])));
      extentByMap.set(mapName, resolveMapExtent(mapName, segments, renderExtent));
      signalsByMap.set(mapName, signals);
    }
    if (!segments) {
      for (const strategy of request.strategies) {
        skipped.push({
          mapName,
          strategy,
          reason: "Runtime map bundle is unavailable or its read timed out for this map.",
        });
      }
      continue;
    }
    const motorwayFootprint = wantsRampFamilies
      ? await loadMotorwayFootprintForMap(mapName).catch(() => null)
      : null;
    for (const strategy of request.strategies) {
      let candidates = candidatesForStrategy(segments, strategy, { motorwayFootprint })
        // Optional road-class filter: keep candidates whose lane speed limit is
        // in the requested band (unknown speed limit → kept).
        .filter((candidate) =>
          speedLimitInBand(
            request.laneSpeedLimitByRsl?.[segmentRsl(candidate.segment)],
            request.minSpeedLimitKph,
            request.maxSpeedLimitKph,
          ),
        )
        // Longer start segments host far more viable placements on these
        // junction-dense maps; kept length-sorted so the resample's early
        // attempts hit high-yield segments first, but the draw itself is now
        // UNIFORM (issue #1) — no length bias — and dedups across the dataset.
        // The `rsl` tiebreaker is REQUIRED for determinism: equal-length segments
        // would otherwise keep their input order (the map's `values()` iteration
        // order, which is not stable across runs), so the seeded draw would land on
        // a different segment each emit — same seed, different scene. Sorting ties by
        // rsl makes the candidate list a pure function of the map data.
        .sort(
          (a, b) =>
            segmentLengthMeters(b.segment) - segmentLengthMeters(a.segment) ||
            (segmentRsl(a.segment) < segmentRsl(b.segment)
              ? -1
              : segmentRsl(a.segment) > segmentRsl(b.segment)
                ? 1
                : 0),
        );
      // Stop-junction families: keep only junction approaches whose signals.geojson
      // control matches the requested family (attributed by approach road_id). This is
      // the data-driven targeting that replaces relying on the worker's runtime detection
      // (which has no yield concept). `stop_at_uncontrolled` keeps only approaches with NO
      // control; a specific-control family with no signals overlay fails CLOSED (drop all,
      // so a scene is never mislabeled as controlled).
      if (isStopJunctionStrategy(strategy)) {
        const signals = signalsByMap.get(mapName) ?? null;
        const want = stopJunctionControl(strategy);
        if (want === "uncontrolled") {
          candidates = candidates.filter(
            (c) => attributeControl(signals, c.segment.road_id) === "uncontrolled",
          );
        } else if (signals && want) {
          candidates = candidates.filter(
            (c) => attributeControl(signals, c.segment.road_id) === want,
          );
        } else if (want) {
          candidates = [];
        }
      }
      if (candidates.length === 0) {
        // Say WHY. "No valid runtime topology candidates" over a map that clearly
        // HAS road segments means the segments were read but every one was
        // classified undrivable — which is a data/contract bug (e.g. the lane_type
        // casing mismatch that zeroed every map), not an empty map. Distinguishing
        // "read 0 segments" from "read N, none usable" is the difference between a
        // one-minute diagnosis and an hour of it.
        const drivable = segments.filter(isDrivableSegment).length;
        skipped.push({
          mapName,
          strategy,
          reason:
            request.minSpeedLimitKph != null || request.maxSpeedLimitKph != null
              ? "No candidate lanes in the requested speed-limit band."
              : drivable === 0
                ? `No DRIVABLE lanes among ${segments.length} segments (lane_type values: ${[
                    ...new Set(segments.map((s) => String(s.lane_type ?? "null"))),
                  ]
                    .slice(0, 6)
                    .join("/")}) — the road network read fine, so this is a lane_type/contract mismatch, not an empty map.`
                : `No ${strategy} candidates among ${drivable} drivable lanes (${segments.length} segments).`,
        });
        continue;
      }
      perMapCandidates.set(`${mapName}:${strategy}`, candidates);
    }
  }

  // Highway waves are explicit opt-ins: a requested highway strategy with no
  // geometric candidates on ANY requested map fails the whole request (the
  // route returns 400) instead of silently generating an urban-only wave.
  // Ported from the monolith generator during the wave-2a consolidation.
  const unplaceableHighwayStrategies = request.strategies
    .filter((strategy) => isHighwayStrategy(strategy))
    .filter((strategy) =>
      request.mapNames.every((mapName) => !perMapCandidates.has(`${mapName}:${strategy}`)),
    )
    .map((strategy) => ({ strategy, mapNames: [...request.mapNames] }));
  if (unplaceableHighwayStrategies.length > 0) {
    return {
      requested: request.count,
      created: [],
      skipped,
      unplaceableHighwayStrategies,
    };
  }

  const created: BatchGenerateScenarioResult["created"] = [];
  const selectable = request.mapNames.flatMap((mapName) =>
    request.strategies.flatMap((strategy) => {
      const candidates = perMapCandidates.get(`${mapName}:${strategy}`);
      if (!candidates) return [];
      return [
        {
          mapName,
          strategy,
          candidates,
          // Line-anchored stop variants (junction_proceed / queue_at_junction)
          // draw from these (filter preserves the length-sorted order for the
          // resample's high-yield-first attempts; the draw is uniform).
          junctionEntryCandidates:
            strategy === "stop"
              ? stopAnchorableJunctionEntryCandidates(
                  segmentsByMap.get(mapName) ?? new Map(),
                  candidates,
                )
              : [],
        },
      ];
    }),
  );
  if (selectable.length === 0) {
    return { requested: request.count, created, skipped };
  }

  const existingScenarioCount = (await listVariationsForDataset(
    context.workspaceId,
    datasetId,
  )).length;

  // The RNG hash is seeded from `seedDatasetId` (defaults to the persistence
  // `datasetId`). A replay harness pins this to a flagged scene's ORIGINAL
  // datasetId to reproduce its exact draw while persisting to a scratch dataset.
  const seedDatasetId = request.seedDatasetId ?? datasetId;

  // Spawn-anchor usage for spatial spreading (issue #1). Seed from the caller's
  // already-used anchors (a count:1-in-a-loop emitter feeds back prior spawns)
  // so the draw avoids re-picking them; then track this call's own placements.
  const usedAnchors = new Map<string, number>();
  for (const rsl of request.excludeSpawnRsls ?? []) {
    for (const mapName of request.mapNames) {
      usedAnchors.set(`${mapName}|${rsl}`, (usedAnchors.get(`${mapName}|${rsl}`) ?? 0) + 1);
    }
  }

  for (let index = 0; index < request.count; index += 1) {
    const bucket = selectable[index % selectable.length];
    if (!bucket) break;
    const seed = existingScenarioCount + index + 1 + (request.seedOffset ?? 0);
    const random = seededRandom(hashSeed([seedDatasetId, bucket.mapName, bucket.strategy, seed]));
    const byRsl = segmentsByMap.get(bucket.mapName);
    if (!byRsl) continue;
    // Per-map ambient cap: on dead-end-heavy maps (Munich) mass ambient fill crashes
    // CARLA on successor-less roads, so clamp the effective profile + target regardless
    // of the requested density (Munich yield RCA, dib 2026-07-20). No-op on other maps.
    const mapAmbientCap = MAP_AMBIENT_CAP[bucket.mapName];
    const ambientCap =
      request.ambientCap != null
        ? Math.min(request.ambientCap, mapAmbientCap ?? Infinity)
        : mapAmbientCap;
    // Only the PER-MAP cap downgrades heavy->medium (its reason is CARLA
    // crash-avoidance on dead-end-heavy maps). A request-level cap must NOT
    // change the profile: an A/B control capped for count-matching has to keep
    // the jam-spacing character its cell is labelled with.
    const effectiveTrafficProfile: BatchTrafficProfile =
      mapAmbientCap != null && trafficProfile === "heavy" ? "medium" : trafficProfile;
    const effectiveHeavyTrafficTargetCount =
      ambientCap != null
        ? Math.min(heavyTrafficTargetCount, ambientCap)
        : heavyTrafficTargetCount;
    const drawnVariation = variationForScenario(bucket.strategy, seed, bucket.mapName, seedDatasetId);
    // An subject-speed override lowers the forward-runway demand so straight-line
    // maneuvers fit short urban blocks. Applied before placement so the runway
    // gate uses the real (lower) speed.
    // Dense traffic slows the SUBJECT too (dib 2026-07-14). Free-flow speed into a
    // crawling queue = rear-end or violent brake, which was the largest source of
    // unintended contact in dense scenes. An explicit subjectSpeedKphOverride is the
    // template author's intent and still wins. `freeFlowSpeedKph` is preserved so
    // ambient traffic scales congestion off the road's real speed, not the subject's
    // already-slowed one. Applied before placement so the runway/curve gates use
    // the real (lower) speed.
    // Speed override FIRST, congestion factor SECOND (dib 2026-07-27: the old
    // order let subjectSpeedKphOverride clobber the heavy-profile slowdown, so the
    // highway-heavy subject "raced through stopped traffic" at its full override
    // speed). Medium now congests the subject too — an subject that outruns its own
    // flow forever reads wrong even when nothing collides.
    const overriddenVariation =
      request.subjectSpeedKphOverride != null && Number.isFinite(request.subjectSpeedKphOverride)
        ? { ...drawnVariation, speedKph: Math.max(1, request.subjectSpeedKphOverride) }
        : drawnVariation;
    // congestedEgoSpeedKph is the single source of the profile factors (also
    // asserted over the corpus by test/unit/lib/nominal-subject-speed.test.ts).
    // subjectSpeedPinned keeps a speed-labeled cell's subject at its authored override
    // while ambient density stays congested; freeFlowSpeedKph is still stamped
    // so ambient scales off the road's real speed either way.
    const baseVariation =
      request.trafficProfile === "heavy" || request.trafficProfile === "medium"
        ? {
            ...overriddenVariation,
            freeFlowSpeedKph: overriddenVariation.speedKph,
            speedKph: congestedEgoSpeedKph(
              request.trafficProfile,
              overriddenVariation.speedKph,
              request.subjectSpeedPinned === true,
            ),
          }
        : overriddenVariation;
    // Per-draw placement-gate reject tally (e.g. route_runway_overrun — the
    // dead-end overrun guard) so a skipped bucket says WHY its draws failed
    // instead of only the generic runway message.
    const gateRejects = new Map<string, number>();
    const drawnPlacement = drawPlacementForBucket({
      segments: byRsl,
      strategy: bucket.strategy,
      candidates: bucket.candidates,
      junctionEntryCandidates: bucket.junctionEntryCandidates,
      baseVariation,
      random,
      onStopReject: (reason) =>
        gateRejects.set(reason, (gateRejects.get(reason) ?? 0) + 1),
      mapName: bucket.mapName,
      usedAnchors,
      extent: extentByMap.get(bucket.mapName) ?? null,
    });
    const candidate = drawnPlacement?.candidate ?? null;
    const placed = drawnPlacement?.placed ?? null;
    if (placed) {
      const key = placementAnchorKey(bucket.mapName, placed);
      usedAnchors.set(key, (usedAnchors.get(key) ?? 0) + 1);
    }
    if (!candidate || !placed) {
      const rejectSummary =
        gateRejects.size > 0
          ? ` Gate rejects: ${[...gateRejects.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => `${reason} x${count}`)
              .join(", ")}.`
          : "";
      skipped.push({
        mapName: bucket.mapName,
        strategy: bucket.strategy,
        reason:
          "Insufficient drivable runway: no candidate lane hosts this maneuver " +
          `inside the label window at ${baseVariation.speedKph} km/h.` +
          rejectSummary,
      });
      continue;
    }
    const displayName = `Batch ${bucket.strategy.replaceAll("_", " ")} ${String(seed).padStart(4, "0")}`;
    // Resolve this scene's SUMO window (if any) BEFORE the spec is stamped, so
    // the movie + window it came from are recorded as provenance. A null return
    // for a map falls back to the procedural fill rather than failing the batch.
    const subjectSpawnPoint = centerlinePointAtFraction(
      placed.spawnSegment,
      placed.variation.spawnFraction,
    );
    const plannedCorridor = subjectSpawnPoint
      ? plannedEgoCorridor(
          { x: subjectSpawnPoint.x, y: subjectSpawnPoint.y },
          placed.spawnSegment,
          placed.variation,
          20,
        )
      : [];
    const sumoAmbient =
      trafficSource === "sumo"
        ? (request.sumoAmbientForScene?.({
            mapName: bucket.mapName,
            seed,
            datasetId: seedDatasetId,
            ...(subjectSpawnPoint ? { subjectSpawn: { x: subjectSpawnPoint.x, y: subjectSpawnPoint.y } } : {}),
            ...(plannedCorridor.length > 1 ? { subjectCorridor: plannedCorridor } : {}),
          }) ?? null)
        : null;
    // Seeded daylight weather (dedicated "weather" rng stream; also baked into
    // the draft renderConfig for the render path to pick up). Seeded from
    // seedDatasetId — NOT the persistence datasetId the monolith used — so a
    // replay harness reproduces a flagged scene's weather along with its draw.
    const environmentPreset = drawBatchEnvironmentPreset(
      bucket.strategy,
      seed,
      bucket.mapName,
      seedDatasetId,
    );
    const scenario = await createDatasetScenario(context, datasetId, {
      mapName: bucket.mapName,
      displayName,
      variationParams: {
        generator: "simforge.batch_normal_driving.v1",
        seed,
        strategy: bucket.strategy,
        mapName: bucket.mapName,
        candidateRoadId: String(candidate.segment.road_id),
        candidateSectionId: candidate.segment.section_id ?? null,
        candidateLaneId: candidate.segment.lane_id ?? null,
        candidateHasKnownSuccessor: candidate.hasKnownDrivableSuccessor,
        spawnRoadId: String(placed.spawnSegment.road_id),
        spawnSectionId: placed.spawnSegment.section_id ?? null,
        spawnLaneId: placed.spawnSegment.lane_id ?? null,
        spawnFraction: placed.variation.spawnFraction,
        speedKph: placed.variation.speedKph,
        instructionDelaySeconds: placed.variation.instructionDelaySeconds,
        approachTimeSeconds: placed.variation.approachTimeSeconds,
        alpamayoCapture: request.alpamayoCapture,
        trafficEnabled: request.trafficEnabled,
        // Stop scenarios record their causal variant + the DECLARED cause/boundary
        // (intent), so the stop_outcome metric can gate on what the scene was
        // created for (expected_cause) and the timeline/CoC can name it. Other
        // families keep byte-identical variationParams.
        ...(bucket.strategy === "stop" && placed.stopPlan
          ? {
              stopVariant: placed.stopPlan.variant,
              stopCause:
                placed.stopPlan.variant === "vru_yield"
                  ? "vru"
                  : placed.stopPlan.variant === "stop_sign"
                    ? "stop_sign"
                    : placed.stopPlan.variant === "lead_brake"
                      ? "lead_vehicle"
                      : placed.stopPlan.variant === "junction_proceed"
                        ? "traffic_light"
                        : "lead_vehicle",
              stopPattern:
                placed.stopPlan.subjectResume || placed.stopPlan.lead?.resume || placed.stopPlan.vru
                  ? "resume"
                  : "hold",
              stopRestGapMeters: placed.variation.stopRestGapMeters ?? null,
            }
          : {}),
        // Ramp scenarios (highway_exit / highway_entry) record their resolved
        // gore/merge chain endpoints + speed split so the annotation/CoT layer
        // can name the ramp; other families keep byte-identical params.
        ...(placed.highwayRoute
          ? {
              highwayChainFirstRsl: segmentRsl(placed.highwayRoute.chain[0]!),
              highwayChainLastRsl: segmentRsl(
                placed.highwayRoute.chain[placed.highwayRoute.chain.length - 1]!,
              ),
              highwayPreSpeedKph: placed.highwayRoute.preSpeedKph,
              highwayPostSpeedKph: placed.highwayRoute.postSpeedKph,
            }
          : {}),
        // Seeded daylight weather (also baked into the draft renderConfig).
        environmentPreset,
        // Fill-profile params recorded only when active (medium/heavy) so
        // "normal" scenarios keep byte-identical variationParams.
        ...(effectiveTrafficProfile !== "normal"
          ? {
              trafficProfile: effectiveTrafficProfile,
              heavyTrafficTargetCount: effectiveHeavyTrafficTargetCount,
            }
          : {}),
        // SUMO ambient provenance, recorded only when SUMO actually supplied
        // this scene's traffic. (movieId, windowT0S) is what makes the ambient
        // reproducible: the window is re-READ from the stored reel, never
        // re-simulated — SUMO's save-state does not restore car-following
        // internals, so re-simulation diverges.
        ...(sumoAmbient
          ? {
              trafficSource: "sumo",
              sumoMovieId: sumoAmbient.movieId,
              sumoWindowT0S: sumoAmbient.windowT0S,
            }
          : {}),
        // Heavy-vehicle / bike mix recorded only when enabled so default
        // scenarios keep byte-identical variationParams.
        ...(heavyVehiclesEnabled ? { heavyVehiclesEnabled: true } : {}),
        ...(bikesEnabled ? { bikesEnabled: true } : {}),
        // Parking density recorded only when active so non-parking scenarios
        // keep byte-identical variationParams.
        ...(parkedDensity !== "none" ? { parkedDensity } : {}),
        // Free-form per-scene annotation recorded verbatim when present.
        ...(sceneAnnotation ? { sceneAnnotation } : {}),
      },
      draftTransform: (draft) =>
        applyGeneratedDraft({
          draft,
          candidate,
          seed,
          variation: placed.variation,
          spawnSegment: placed.spawnSegment,
          stopPlan: placed.stopPlan,
          highwayRoute: placed.highwayRoute,
          alpamayoCapture: request.alpamayoCapture,
          trafficEnabled: request.trafficEnabled,
          trafficProfile: effectiveTrafficProfile,
          trafficSource,
          ...(sumoAmbient ? { sumoAmbient } : {}),
          heavyTrafficTargetCount: effectiveHeavyTrafficTargetCount,
          ambientCap,
          heavyVehiclesEnabled,
          bikesEnabled,
          parkedDensity,
          parkingLanes: parkingLanesByMap.get(bucket.mapName) ?? explicitParkingLanes,
          segments: byRsl,
          datasetId: seedDatasetId,
          environmentPreset,
        }),
    });
    created.push({
      id: scenario.id,
      displayName,
      mapName: bucket.mapName,
      strategy: bucket.strategy,
    });
  }

  return { requested: request.count, created, skipped };
}

export const __batchScenarioGeneratorTestHooks = {
  readRuntimeSegmentsForMap,
  assessEgoRouteOverrun,
  candidatesForStrategy,
  variationForScenario,
  instructionsForStrategy,
  segmentLengthMeters,
  laneKeepRunwayMeters,
  measureEmittedRouteCorridor,
  routeFollowRunwayMeters,
  survivalRunwayMeters,
  survivalRunwayBestBranchMeters,
  buildForwardRouteThroughSuccessors,
  upstreamSpawnForApproach,
  placeVariationOnCandidate,
  drawPlacementForBucket,
  placementAnchorKey,
  centerlinePointAtFraction,
  worldAnchorAtFraction,
  stopAnchorableJunctionEntryCandidates,
  stopVariantFallbackOrder,
  buildStopLeadActor,
  buildBatchTrafficActors,
  buildHeavyTrafficFillActors,
  buildParkedActors,
  clampHeavyTrafficTargetCount,
  hashSeed,
  seededRandom,
};
