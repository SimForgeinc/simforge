/**
 * `batchGenerateCollisionScenarios` — the server-side bridge that turns a
 * structured collision `ScenarioRequest` into persisted dataset scenario rows,
 * mirroring `batchGenerateScenarios` (normal driving) but for the deterministic
 * collision families.
 *
 *   per map:  load topology + corpus + pedestrian regions + runtime segments
 *     ──▶  generateCollisionScenarioBatch (the pure, fit-ranked, gated service)
 *     ──▶  createDatasetScenario (one row per validated draft)
 *
 * The pure generator (`@/app/lib/llm/scenario-generation/batch-collision-generator`)
 * holds all the geometry/timing logic and is unit-tested in isolation; this
 * module is only I/O: map loading, persistence, and provenance. Persisted rows
 * carry `variation_params.generator = "simforge.batch_collision.v1"` so they are
 * distinguishable from manual + normal-driving scenarios, and the draft's
 * `validationIntent` is stamped so the validation tiers judge each render
 * against its intended outcome + conflict time.
 */
import type { AppContext } from "@/app/lib/db/app-context";
import {
  TIMED_INSTRUCTION_PRIMITIVE_FOR_JUNCTION_DIRECTION,
  authoredJunctionTurn,
  type RuntimeScenarioEditorActor,
} from "@simforge/studio-shared";
import { createDatasetScenario } from "@/app/lib/db/scenario-query-store";
import { resolveScenarioMapReference } from "@/app/lib/scenario-editor/scenario-api-store";
import { getMapTopologyIndex } from "@/app/lib/maps/topology/server/topology-index-service";
import { loadMapSearchCorpus } from "@/app/lib/maps/search/server/map-search-service";
import { loadProjectedPedestrianRegions } from "@/app/lib/llm/scenario-generation/load-pedestrian-regions";
import { readSemanticRoadSegmentsByMapAssetId } from "@/app/lib/maps/topology/server/semantic-road-network";
import { compileTimedInstructions } from "@/app/lib/scenario-editor/timed-instructions";
import { buildJunctionConstraintIndex } from "@/app/lib/llm/scenario-generation/site-search/find-collision-sites";
import {
  buildLaneDirectionIndex,
  wrongWayVerdictForPath,
  type LaneDirectionIndex,
} from "@/app/lib/scenario-editor/batch-scenario-generator/path-direction-check";
import {
  generateCollisionScenarioBatch,
  type GeneratedScenario,
} from "@/app/lib/llm/scenario-generation/batch-collision-generator";
import {
  parseScenarioRequest,
  SCENARIO_REQUEST_FAMILIES,
  type ScenarioRequest,
  type ScenarioRequestFamily,
} from "@/app/lib/llm/scenario-generation/scenario-request";
import type { RuntimeRoadSegment } from "@/app/lib/llm/scenario-generation/runtime-road-snap";

export const BATCH_COLLISION_FAMILIES = SCENARIO_REQUEST_FAMILIES;

const DRAFT_DURATION_S = 20;
const DRAFT_FIXED_DELTA_S = 0.05;
const GENERATOR_TAG = "simforge.batch_collision.v1";

const FAMILY_LABEL: Record<ScenarioRequestFamily, string> = {
  pedestrian_crossing: "Ped crossing",
  unprotected_left_turn: "Left turn",
  right_turn_hook: "Right hook",
  bicycle_merge: "Bike merge",
  left_turn_ped_crosswalk: "Left turn ped crosswalk",
  right_turn_ped_crosswalk: "Right turn ped crosswalk",
};

/** The dataset-batch request: a `ScenarioRequest` plus the maps to sweep. */
export type BatchCollisionRequest = Omit<Partial<ScenarioRequest>, "scenarioFamily"> & {
  scenarioFamily: ScenarioRequestFamily;
  /** Map asset ids to generate across; `count` is the TOTAL across all maps. */
  mapAssetIds: string[];
};

export type BatchCollisionResult = {
  requested: number;
  created: Array<{
    id: string;
    displayName: string;
    mapName: string;
    family: ScenarioRequestFamily;
    siteId: string;
    fitScore: number;
    plannedOutcome: ScenarioRequest["outcome"];
  }>;
  skipped: Array<{ mapAssetId: string; reason: string }>;
};

/** The persisted provenance blob (variation_params). Auditable + reproducible. */
function variationParams(
  scenario: GeneratedScenario,
  request: ScenarioRequest,
): Record<string, unknown> {
  return {
    generator: GENERATOR_TAG,
    family: scenario.generation.family,
    siteId: scenario.generation.siteId,
    fitScore: scenario.generation.fitScore,
    plannedOutcome: scenario.generation.plannedOutcome,
    conflictTimeS: scenario.generation.conflictTimeS,
    seed: scenario.generation.seed,
    subjectSpeedKph: request.subjectSpeedKph,
    npcSpeedKph: request.npcSpeedKph ?? null,
    npcVehicleType: request.npcVehicleType ?? null,
    aggressiveness: request.aggressiveness ?? null,
    locationConstraints: request.locationConstraints,
    population: request.population,
  };
}

export async function batchGenerateCollisionScenarios(
  context: AppContext,
  datasetId: string,
  request: BatchCollisionRequest,
): Promise<BatchCollisionResult> {
  const { mapAssetIds, ...requestFields } = request;
  // Validate + default the generation knobs through the shared contract.
  const parsed = parseScenarioRequest(requestFields);

  const created: BatchCollisionResult["created"] = [];
  const skipped: BatchCollisionResult["skipped"] = [];
  // Per-map lane-direction index for the wrong-way authoring guard (built lazily).
  const laneDirIndexByMap = new Map<string, LaneDirectionIndex>();

  for (const mapAssetId of mapAssetIds) {
    if (created.length >= parsed.count) break;

    const ref = await resolveScenarioMapReference({ mapAssetId });
    const backendMapName = ref.backendMapName ?? ref.mapName;
    if (!backendMapName) {
      skipped.push({ mapAssetId, reason: "no backend map name" });
      continue;
    }

    let topology, corpus, regions, segments;
    try {
      [topology, corpus, regions, segments] = await Promise.all([
        getMapTopologyIndex(mapAssetId, "carla_ue5"),
        loadMapSearchCorpus(mapAssetId),
        loadProjectedPedestrianRegions(mapAssetId),
        readSemanticRoadSegmentsByMapAssetId(mapAssetId),
      ]);
    } catch (error) {
      skipped.push({
        mapAssetId,
        reason: error instanceof Error ? error.message : "map load failed",
      });
      continue;
    }

    const semanticSegments: RuntimeRoadSegment[] = segments ?? [];
    if (semanticSegments.length === 0) {
      skipped.push({ mapAssetId, reason: "no accepted semantic execution road network" });
      continue;
    }
    const junctionIndex = buildJunctionConstraintIndex(corpus?.documents ?? []);

    // `count` is the TOTAL budget across maps — only ask each map for what's
    // left so a single multi-map request fills exactly `count` rows in order.
    const remaining = parsed.count - created.length;
    const batch = generateCollisionScenarioBatch(
      { ...parsed, count: remaining },
      { mapAssetId, topology, segments: semanticSegments, regions, junctionIndex },
    );
    if (batch.scenarios.length === 0) {
      skipped.push({
        mapAssetId,
        reason: `no viable ${parsed.scenarioFamily} sites (considered ${batch.sitesConsidered}, gate-rejected ${batch.rejectedByGate})`,
      });
      continue;
    }

    for (const scenario of batch.scenarios) {
      // Turn families now author the subject's junction maneuver as a behavior clip.
      // The existing runtime-map availability gate still consumes the legacy
      // compiler input, so project the clip transiently at this compatibility
      // boundary and DROP an unavailable turn before it counts as created.
      const subject = scenario.actors.find((a) => a.role === "subject");
      // Generator intermediates can still carry the legacy field top-level;
      // migrated drafts carry it (if at all) in the wire envelope.
      const intent =
        (subject as RuntimeScenarioEditorActor | undefined)?.timedInstructions?.intent ??
        subject?.legacy_wire?.timedInstructions?.intent;
      const behaviorTurn = subject ? authoredJunctionTurn(subject) : null;
      // A u-turn has no legacy primitive to project onto, so the availability gate
      // simply cannot be consulted for one. The gate exists to DROP a turn the
      // runtime map cannot serve; with nothing to ask, the turn passes unchecked
      // rather than being silently discarded. No collision family authors a u-turn
      // subject today, so this is a boundary condition, not a hole in the gate.
      const legacyTurnPrimitive =
        behaviorTurn && behaviorTurn !== "u_turn"
          ? TIMED_INSTRUCTION_PRIMITIVE_FOR_JUNCTION_DIRECTION[behaviorTurn]
          : undefined;
      const hasTurnIntent =
        Array.isArray(intent) &&
        intent.some((r) => r != null && r.enabled !== false && r.primitiveId);
      if (subject && (behaviorTurn || hasTurnIntent)) {
        try {
          const validationActor = legacyTurnPrimitive
            ? {
                ...subject,
                timedInstructions: {
                  schemaVersion: "simforge.timed-instructions.v1" as const,
                  intent: [
                    {
                      id: "tii_behavior_turn_validation",
                      timestampSeconds: 0,
                      rowOrder: 0,
                      enabled: true,
                      primitiveId: legacyTurnPrimitive,
                      args: { speedKph: subject.speed_kph },
                      source: "generator" as const,
                      validationErrors: [],
                    },
                  ],
                  resolvedPlan: null,
                  status: "draft" as const,
                  manifest: [],
                },
              }
            : subject;
          compileTimedInstructions({
            actor: validationActor,
            runtimeMap: {
              map_name: backendMapName,
              normalized_map_name: backendMapName,
              road_segments: semanticSegments,
            },
            durationSeconds: DRAFT_DURATION_S,
            fixedDeltaSeconds: DRAFT_FIXED_DELTA_S,
          });
        } catch (error) {
          skipped.push({
            mapAssetId,
            reason: `turn primitive unavailable at ${scenario.generation.siteId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          continue;
        }
      }

      // Wrong-way authoring guard (dib review 2026-07-17): reject any draft
      // whose planner-authored VEHICLE path runs against the nearest lane's
      // stored travel yaw for a sustained stretch (dirosa left-686-0 drove
      // 100+ m head-on down the subject's lane — reversed-lane data poisons the
      // planner's turn-exit choice). Walkers are exempt (they cross lanes).
      //
      // EGO INCLUDED (2026-08-02, allfam-avoid ledger): all 16 wrong-way /
      // U-turn losses were AUTHORED — the subject drove its route at sub-metre
      // cross-track; the route itself ran against flow (positive-id lane
      // polylines used raw) or hopped anti-parallel successors. The subject is
      // checked over its DRIVEN-WINDOW prefix only (time <= draft duration):
      // authored tails beyond the clip legitimately wander (post-conflict
      // continuation) and must not reject the draft.
      {
        const idx = laneDirIndexByMap.get(mapAssetId) ??
          buildLaneDirectionIndex(semanticSegments);
        laneDirIndexByMap.set(mapAssetId, idx);
        let wrongWay: string | null = null;
        for (const actor of scenario.actors) {
          if (actor.kind !== "vehicle") continue;
          const allWps = actor.timed_waypoints;
          if (!Array.isArray(allWps) || allWps.length < 2) continue;
          const who = actor.role === "subject" ? "subject" : (actor.id ?? "npc");
          const wps = actor.role === "subject"
            ? allWps.filter(
                (w) => typeof w.time !== "number" || w.time <= DRAFT_DURATION_S,
              )
            : allWps;
          if (wps.length < 2) continue;
          const verdict = wrongWayVerdictForPath(idx, wps);
          if (verdict.rejected) {
            wrongWay =
              `${who} path runs wrong-way ` +
              `${verdict.longestOpposedM.toFixed(0)}m against lane direction`;
            break;
          }
        }
        if (wrongWay) {
          skipped.push({
            mapAssetId,
            reason: `wrong-way authored path at ${scenario.generation.siteId}: ${wrongWay}`,
          });
          continue;
        }
      }

      const ordinal = created.length + 1;
      const displayName = `${FAMILY_LABEL[parsed.scenarioFamily]} ${String(ordinal).padStart(4, "0")}`;
      const subjectId = scenario.actors.find((a) => a.role === "subject")?.id ?? null;
      const persisted = await createDatasetScenario(context, datasetId, {
        mapAssetId,
        mapName: backendMapName,
        displayName,
        variationParams: variationParams(scenario, parsed),
        draftTransform: (draft) => ({
          ...draft,
          actors: scenario.actors,
          selectedActorId: subjectId ?? draft.selectedActorId,
          durationSeconds: DRAFT_DURATION_S,
          fixedDeltaSeconds: DRAFT_FIXED_DELTA_S,
          // Explicit conflict actors are placed by the planner; keep the legacy
          // subject-lane traffic cloning off so the render doesn't double-spawn.
          carLedTrafficEnabled: false,
          metadata: {
            ...draft.metadata,
            // Data-driven verdict: judge this render against what it was
            // generated to produce (see the resolved esmini-validation gap).
            validationIntent: {
              expectedOutcome: scenario.generation.plannedOutcome,
              conflictTimeS: scenario.generation.conflictTimeS,
            },
            scenarioIntention: scenario.scenarioIntention,
            scenarioMetadata: scenario.scenarioMetadata,
            // Rule 3: pin the actor-randomness authority to the generation
            // seed. semantic_default hashes the WHOLE actors array, so the 2D
            // repair loop retiming ONE conflict walker re-rolled the TM seed —
            // and with it every ambient actor's behaviour.
            actorRandomnessSeed: scenario.generation.seed,
          },
        }),
      });
      created.push({
        id: persisted.id,
        displayName,
        mapName: backendMapName,
        family: parsed.scenarioFamily,
        siteId: scenario.generation.siteId,
        fitScore: scenario.generation.fitScore,
        plannedOutcome: scenario.generation.plannedOutcome,
      });
      if (created.length >= parsed.count) break;
    }
  }

  return { requested: parsed.count, created, skipped };
}
