import { createHash } from "crypto";
import type {
  RuntimeScenarioEditorActor,
  ScenarioEditorActorDraft,
  ScenarioEditorRoadAnchor,
  SemanticExecutionIndex,
  TimedInstructionIntent,
  TimedInstructionManifestRow,
  TimedInstructionResolvedPlan,
  TimedInstructions,
} from "@simcloud/shared";
import { TimedInstructionsSchema } from "@simcloud/shared";
import type {
  RuntimeMapResponse,
  RuntimeRoadSegment,
  RuntimeTurnOption,
  RuntimeWaypointRef,
} from "@/app/lib/runtime/runtime-types";

export const TIMED_INSTRUCTIONS_COMPILER_VERSION =
  "simforge.timed-instructions.compiler.runtime-native.v1";
export const SEMANTIC_TIMED_INSTRUCTIONS_COMPILER_VERSION =
  "simforge.timed-instructions.compiler.semantic-execution.v1";

const LEGACY_STEERING_ACTIONS = new Set([
  "lane_change_left",
  "lane_change_right",
  "turn_left_at_next_intersection",
  "turn_right_at_next_intersection",
  "swerve",
]);

type CompileTimedInstructionsInput = {
  actor: ScenarioEditorActorDraft;
  runtimeMap: RuntimeMapResponse;
  durationSeconds: number;
  fixedDeltaSeconds: number;
  runtimeCatalogVersion?: string | null;
};

type CompileTimedInstructionsResult = {
  timedInstructions: TimedInstructions;
  projectedActor: ScenarioEditorActorDraft;
};

type CompileSemanticTimedInstructionsInput = {
  actor: ScenarioEditorActorDraft;
  executionIndex: SemanticExecutionIndex;
  durationSeconds: number;
  fixedDeltaSeconds: number;
};

export class TimedInstructionCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimedInstructionCompileError";
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function enabledIntentRows(timedInstructions: TimedInstructions): TimedInstructionIntent[] {
  return [...timedInstructions.intent]
    .filter((row) => row.enabled !== false)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds || a.rowOrder - b.rowOrder);
}

export function defaultTimedInstructions(): TimedInstructions {
  return TimedInstructionsSchema.parse({
    schemaVersion: "simforge.timed-instructions.v1",
    intent: [
      {
        id: `tii_${crypto.randomUUID()}`,
        timestampSeconds: 0,
        rowOrder: 0,
        enabled: true,
        primitiveId: "lane_follow",
        args: { speedKph: 35, distanceMeters: 40 },
        source: "manual",
        validationErrors: [],
      },
    ],
    resolvedPlan: null,
    status: "draft",
    manifest: [],
  });
}

export function assertNoLegacySteeringClips(actor: ScenarioEditorActorDraft) {
  // Legacy clips survive top-level only on raw/runtime records; a migrated
  // draft carries them (if at all) in the wire envelope.
  const timeline =
    (actor as RuntimeScenarioEditorActor).timeline ??
    actor.legacy_wire?.timeline ??
    [];
  const legacy = timeline.find(
    (clip) => clip.enabled !== false && LEGACY_STEERING_ACTIONS.has(clip.action),
  );
  if (!legacy) return;
  throw new TimedInstructionCompileError(
    `Actor "${actor.label}" uses legacy steering action "${legacy.action}". Use Timed instructions instead.`,
  );
}

function rslFromAnchor(anchor: ScenarioEditorRoadAnchor): string | null {
  if (anchor.lane_id == null || anchor.section_id == null) return null;
  const roadId = String(anchor.road_id ?? "").trim();
  if (!roadId) return null;
  return `${roadId}:${anchor.section_id}:${anchor.lane_id}`;
}

function rslFromWaypointRef(waypoint: RuntimeWaypointRef | null | undefined): string | null {
  if (waypoint?.rsl) return waypoint.rsl;
  if (
    waypoint?.road_id == null ||
    waypoint.section_id == null ||
    waypoint.lane_id == null
  ) {
    return null;
  }
  return `${waypoint.road_id}:${waypoint.section_id}:${waypoint.lane_id}`;
}

function segmentRsl(segment: RuntimeRoadSegment): string {
  return `${segment.road_id}:${segment.section_id}:${segment.lane_id}`;
}

function runtimeSegmentsByRsl(runtimeMap: RuntimeMapResponse) {
  const segments = new Map<string, RuntimeRoadSegment>();
  for (const segment of runtimeMap.road_segments ?? []) {
    segments.set(segmentRsl(segment), segment);
  }
  return segments;
}

function validateRows(rows: TimedInstructionIntent[]): string[] {
  const errors: string[] = [];
  const byTimestamp = new Map<number, TimedInstructionIntent[]>();
  for (const row of rows) {
    if (Math.abs(row.timestampSeconds * 10 - Math.round(row.timestampSeconds * 10)) > 1e-6) {
      errors.push(`${row.id}: timestampSeconds must be quantized to 0.1s`);
    }
    byTimestamp.set(row.timestampSeconds, [
      ...(byTimestamp.get(row.timestampSeconds) ?? []),
      row,
    ]);
    if (row.primitiveId === "set_speed" && typeof row.args.speedKph !== "number") {
      errors.push(`${row.id}: set_speed requires speedKph`);
    }
    if (row.primitiveId === "hold_position" && !(row.args.durationSeconds && row.args.durationSeconds > 0)) {
      errors.push(`${row.id}: hold_position requires durationSeconds > 0`);
    }
  }
  for (const [timestamp, timestampRows] of byTimestamp) {
    const stopLike = timestampRows.filter((row) =>
      row.primitiveId === "stop" || row.primitiveId === "hold_position",
    );
    if (stopLike.length > 0 && timestampRows.length > stopLike.length) {
      errors.push(`${timestamp.toFixed(1)}s: stop/hold_position cannot share a timestamp`);
    }
    const pathChanging = timestampRows.filter((row) =>
      [
        "turn_left_at_next_intersection",
        "turn_right_at_next_intersection",
        "go_straight_at_next_intersection",
        "lane_change_left",
        "lane_change_right",
      ].includes(row.primitiveId),
    );
    if (pathChanging.length > 1) {
      errors.push(`${timestamp.toFixed(1)}s: only one path-changing primitive is allowed`);
    }
  }
  return errors;
}

function rejectedPlan(
  rows: TimedInstructionIntent[],
  categories: string[],
  repairSuggestions: string[] = [],
): TimedInstructionResolvedPlan {
  return {
    kind: "rejected",
    schemaVersion: "simforge.timed-instruction-plan.v1",
    blockingInstructionIds: rows.map((row) => row.id),
    categories,
    candidateCounts: {},
    repairSuggestions,
  };
}

/** Lane types a vehicle can drive on, CASE-INSENSITIVELY.
 *
 * The runtime BUNDLE road network spells these "Driving"/"Bidirectional" (CARLA's own
 * casing); the SEMANTIC road network — which the generator reads since the semantic-map
 * migration, and which is now the only road network there is — spells them lowercase.
 * A case-sensitive compare here made every adjacent lane read as undrivable, so the
 * compiler rejected EVERY lane change (`lane_change_left_unavailable`) and the batch
 * emitted zero lane-change scenes. Same bug class as batch-scenario-generator/graph.ts.
 * Normalize; never compare raw. */
const DRIVABLE_LANE_TYPES = new Set(["driving", "bidirectional"]);

function laneTypeIs(segment: RuntimeRoadSegment | null | undefined, laneType: string): boolean {
  return String(segment?.lane_type ?? "").toLowerCase() === laneType.toLowerCase();
}

function isRuntimeDrivable(segment: RuntimeRoadSegment | null | undefined): segment is RuntimeRoadSegment {
  return Boolean(segment && DRIVABLE_LANE_TYPES.has(String(segment.lane_type ?? "").toLowerCase()));
}

function isSameDirectionLaneChange(
  currentSegment: RuntimeRoadSegment,
  targetSegment: RuntimeRoadSegment,
): boolean {
  if (laneTypeIs(currentSegment, "Bidirectional")) return true;
  if (laneTypeIs(targetSegment, "Bidirectional")) return true;
  const currentLaneId = Number(currentSegment.lane_id);
  const targetLaneId = Number(targetSegment.lane_id);
  return (
    Number.isFinite(currentLaneId) &&
    Number.isFinite(targetLaneId) &&
    Math.sign(currentLaneId) === Math.sign(targetLaneId)
  );
}

function timedCompleteSeconds(row: TimedInstructionIntent, actor: ScenarioEditorActorDraft): number {
  if (row.primitiveId === "hold_position") {
    return row.timestampSeconds + (row.args.durationSeconds ?? 0);
  }
  if (row.primitiveId === "stop") {
    return row.timestampSeconds + (row.args.brakingWindowSeconds ?? 2);
  }
  if (row.primitiveId === "lane_change_left" || row.primitiveId === "lane_change_right") {
    const speedMps = Math.max(1, (row.args.speedKph ?? actor.speed_kph ?? 35) / 3.6);
    return row.timestampSeconds + (row.args.transitionMeters ?? 25) / speedMps;
  }
  return row.timestampSeconds;
}

function turnRelationForPrimitive(primitiveId: TimedInstructionIntent["primitiveId"]): string | null {
  if (primitiveId === "turn_left_at_next_intersection") return "Left";
  if (primitiveId === "turn_right_at_next_intersection") return "Right";
  if (primitiveId === "go_straight_at_next_intersection") return "Straight";
  return null;
}

function compileRuntimeNativePlan(
  runtimeMap: RuntimeMapResponse,
  actor: ScenarioEditorActorDraft,
  rows: TimedInstructionIntent[],
  currentLaneRsl: string,
): TimedInstructionResolvedPlan {
  const segments = runtimeSegmentsByRsl(runtimeMap);
  let currentRsl = currentLaneRsl;
  const manifest: TimedInstructionManifestRow[] = [];

  for (const row of rows) {
    const currentSegment = segments.get(currentRsl);
    if (!currentSegment) return rejectedPlan([row], [`runtime_lane_${currentRsl}_unavailable`]);
    const laneIds = [currentRsl];

    if (row.primitiveId === "lane_follow" || row.primitiveId === "set_speed") {
      const successorRsl = rslFromWaypointRef(currentSegment.successors?.[0]);
      if (successorRsl && !segments.has(successorRsl)) {
        return rejectedPlan([row], [`successor_${successorRsl}_unavailable`]);
      }
      if (successorRsl) {
        currentRsl = successorRsl;
        laneIds.push(successorRsl);
      }
    } else if (row.primitiveId === "stop" || row.primitiveId === "hold_position") {
      // Stop-like primitives are executed against the current CARLA actor state.
    } else if (row.primitiveId === "lane_change_left" || row.primitiveId === "lane_change_right") {
      const side = row.primitiveId === "lane_change_left" ? "left" : "right";
      const adjacentRsl = rslFromWaypointRef(
        side === "left" ? currentSegment.left_lane : currentSegment.right_lane,
      );
      const targetSegment = adjacentRsl ? segments.get(adjacentRsl) : null;
      if (
        currentSegment.is_junction ||
        !isRuntimeDrivable(targetSegment) ||
        !isSameDirectionLaneChange(currentSegment, targetSegment)
      ) {
        return rejectedPlan([row], [`lane_change_${side}_unavailable`], [
          "Choose a runtime lane where CARLA exposes a drivable same-direction adjacent waypoint.",
        ]);
      }
      currentRsl = adjacentRsl!;
      laneIds.push(currentRsl);
    } else {
      const relation = turnRelationForPrimitive(row.primitiveId);
      if (!relation) continue;
      if (!Array.isArray(currentSegment.turn_options)) {
        return rejectedPlan([row], ["runtime_turn_graph_unavailable"]);
      }
      const option = currentSegment.turn_options.find(
        (candidate: RuntimeTurnOption) => candidate.relation === relation,
      );
      const targetRsl =
        rslFromWaypointRef(option?.lookahead_waypoint) ??
        rslFromWaypointRef(option?.entry_waypoint);
      if (!option || !targetRsl || !segments.has(targetRsl)) {
        return rejectedPlan([row], [`${row.primitiveId}_unavailable`]);
      }
      currentRsl = targetRsl;
      laneIds.push(currentRsl);
    }

    manifest.push({
      instructionId: row.id,
      primitiveId: row.primitiveId,
      expectedStartS: row.timestampSeconds,
      expectedCompleteS: timedCompleteSeconds(row, actor),
      laneIds,
      status: "planned",
    });
  }

  return {
    kind: "runtime_native",
    schemaVersion: "simforge.timed-instruction-plan.v1",
    source: "carla_runtime_waypoints",
    actorSpawnRsl: currentLaneRsl,
    runtimeMapSchemaVersion: runtimeMap.schema_version ?? null,
    manifest,
  };
}

function runtimeRslsForCorridor(
  corridor: SemanticExecutionIndex["corridors"][number],
): string[] {
  return corridor.runtimeFragments.map((fragment) => fragment.rsl);
}

function semanticActorStart(
  actor: ScenarioEditorActorDraft,
  index: SemanticExecutionIndex,
): { corridorId: string; stationM: number } | null {
  const intent = actor.semantic_authoring?.intent;
  if (!intent || intent.graphRevision !== index.semanticMapGraphRevision) return null;
  if (intent.kind === "corridor_station") {
    return { corridorId: intent.corridorId, stationM: intent.stationM };
  }
  if (intent.kind === "corridor_route") {
    const corridorId = intent.corridorIds[0];
    return corridorId
      ? { corridorId, stationM: intent.startStationM }
      : null;
  }
  const movement = index.movements.find((row) => row.id === intent.movementId);
  const variant = intent.variantId
    ? movement?.variants.find((row) => row.id === intent.variantId)
    : movement?.variants.find((row) => row.id === movement.representativeVariantId);
  return variant
    ? { corridorId: variant.incomingCorridorId, stationM: 0 }
    : null;
}

function compileSemanticExecutionPlan(
  index: SemanticExecutionIndex,
  actor: ScenarioEditorActorDraft,
  rows: TimedInstructionIntent[],
): TimedInstructionResolvedPlan {
  const start = semanticActorStart(actor, index);
  if (!start) {
    return rejectedPlan(rows, ["semantic_actor_start_unavailable"]);
  }
  const corridors = new Map(index.corridors.map((row) => [row.id, row]));
  let corridorId = start.corridorId;
  let stationM = start.stationM;
  const manifest: TimedInstructionManifestRow[] = [];

  for (const row of rows) {
    const currentCorridor = corridors.get(corridorId);
    if (!currentCorridor || currentCorridor.authoringStatus !== "authorable") {
      return rejectedPlan([row], [`semantic_corridor_${corridorId}_unavailable`]);
    }
    let corridor: SemanticExecutionIndex["corridors"][number] = currentCorridor;
    const laneIds = runtimeRslsForCorridor(corridor);
    if (row.primitiveId === "lane_follow") {
      let remainingM = Math.max(0, row.args.distanceMeters ?? 0);
      while (remainingM > Math.max(0, corridor.lengthM - stationM) + 1e-6) {
        remainingM -= Math.max(0, corridor.lengthM - stationM);
        const successors: Array<SemanticExecutionIndex["corridors"][number]> = corridor.successorCorridorIds
          .map((id) => corridors.get(id))
          .filter(
            (candidate): candidate is SemanticExecutionIndex["corridors"][number] =>
              candidate?.authoringStatus === "authorable",
          );
        if (successors.length !== 1) {
          return rejectedPlan([row], [
            successors.length === 0
              ? "semantic_lane_follow_successor_missing"
              : "semantic_lane_follow_successor_ambiguous",
          ]);
        }
        corridor = successors[0]!;
        corridorId = corridor.id;
        stationM = 0;
        laneIds.push(...runtimeRslsForCorridor(corridor));
      }
      stationM = Math.min(corridor.lengthM, stationM + remainingM);
    } else if (
      row.primitiveId === "lane_change_left" ||
      row.primitiveId === "lane_change_right"
    ) {
      const side = row.primitiveId === "lane_change_left" ? "left" : "right";
      const insideJunctionGuard = corridor.junctionExclusionIntervals.some(
        (interval) => stationM >= interval.startM && stationM <= interval.endM,
      );
      const adjacency = corridor.lateralAdjacencies.find(
        (candidate) =>
          candidate.side === side &&
          candidate.sameDirection &&
          candidate.permissionIntervals.some(
            (interval) =>
              interval.allowed &&
              stationM >= interval.startM &&
              stationM <= interval.endM,
          ),
      );
      const target = adjacency
        ? corridors.get(adjacency.targetCorridorId)
        : null;
      if (insideJunctionGuard || !target || target.authoringStatus !== "authorable") {
        return rejectedPlan([row], [
          insideJunctionGuard
            ? "semantic_lane_change_junction_exclusion"
            : `semantic_lane_change_${side}_unavailable`,
        ]);
      }
      corridor = target;
      corridorId = target.id;
      stationM = Math.min(stationM, target.lengthM);
      laneIds.push(...runtimeRslsForCorridor(target));
    } else {
      const relation = turnRelationForPrimitive(row.primitiveId);
      if (relation) {
        const candidates = index.movements.filter(
          (movement) =>
            movement.authoringStatus === "authorable" &&
            movement.turnRelation === relation &&
            movement.incomingCorridorIds.includes(corridorId),
        );
        if (candidates.length !== 1) {
          return rejectedPlan([row], [
            candidates.length === 0
              ? `${row.primitiveId}_unavailable`
              : `${row.primitiveId}_ambiguous`,
          ]);
        }
        const movement = candidates[0]!;
        const variant = movement.variants.find(
          (candidate) =>
            candidate.id === movement.representativeVariantId &&
            candidate.authoringStatus === "authorable",
        );
        const target = variant
          ? corridors.get(variant.outgoingCorridorId)
          : null;
        if (!variant || !target || target.authoringStatus !== "authorable") {
          return rejectedPlan([row], [`${row.primitiveId}_runtime_binding_unavailable`]);
        }
        laneIds.push(...variant.runtimeLaneRsls, ...runtimeRslsForCorridor(target));
        corridor = target;
        corridorId = target.id;
        stationM = 0;
      }
    }
    manifest.push({
      instructionId: row.id,
      primitiveId: row.primitiveId,
      expectedStartS: row.timestampSeconds,
      expectedCompleteS: timedCompleteSeconds(row, actor),
      laneIds: [...new Set(laneIds)],
      status: "planned",
    });
  }
  return {
    kind: "semantic_execution",
    schemaVersion: "simforge.timed-instruction-plan.v1",
    source: "semantic_execution_index",
    actorStart: start,
    semanticMapGraphRevision: index.semanticMapGraphRevision,
    semanticExecutionIndexRevision: index.indexRevision,
    manifest,
  };
}

export function compileSemanticTimedInstructions(
  input: CompileSemanticTimedInstructionsInput,
): CompileTimedInstructionsResult {
  const parsed = TimedInstructionsSchema.parse(input.actor.timedInstructions);
  const rows = enabledIntentRows(parsed);
  if (rows.length === 0) {
    throw new TimedInstructionCompileError(
      `Actor "${input.actor.label}" has Timed instructions selected but no enabled rows.`,
    );
  }
  const rowErrors = validateRows(rows);
  const start = semanticActorStart(input.actor, input.executionIndex);
  if (!start) rowErrors.push("actor must have a current semantic execution binding");
  if (rowErrors.length > 0) {
    throw new TimedInstructionCompileError(
      `Timed instructions rejected for "${input.actor.label}": ${rowErrors.join("; ")}`,
    );
  }
  const plan = compileSemanticExecutionPlan(input.executionIndex, input.actor, rows);
  if (plan.kind === "rejected") {
    throw new TimedInstructionCompileError(
      `Timed instructions rejected for "${input.actor.label}": ${plan.categories.join("; ")}`,
    );
  }
  const hashes = {
    runtimeMapHash: sha256({
      semanticExecutionIndexRevision: input.executionIndex.indexRevision,
      runtimeProvenance: input.executionIndex.runtimeProvenance,
    }),
    runtimeMapSchemaVersion: input.executionIndex.schemaVersion,
    runtimeCatalogVersion:
      input.executionIndex.runtimeProvenance.runtimeCatalogVersion,
    compilerVersion: SEMANTIC_TIMED_INSTRUCTIONS_COMPILER_VERSION,
    actorSpawnHash: sha256(input.actor.spawn),
    instructionHash: sha256(rows),
    resolvedPlanHash: sha256(plan),
  };
  const nextTimedInstructions = TimedInstructionsSchema.parse({
    ...parsed,
    status: "resolved",
    resolvedPlan: plan,
    hashes,
    manifest: plan.manifest,
    timedInstructionValidation: {
      status: "stale",
      hashes,
      evidence: { runtimeEventIds: [], artifactIds: [] },
      primitiveResults: [],
    },
    workerValidation: {
      status: "stale",
      hashes,
      evidence: { runtimeEventIds: [], artifactIds: [] },
      primitiveResults: [],
      renderOrRuntimeArtifactIds: [],
      projectionChecks: {
        movementVariant: "semantic_execution",
        hasConstrainedEnvelope: false,
      },
    },
  });
  return {
    timedInstructions: nextTimedInstructions,
    projectedActor: {
      ...input.actor,
      autopilot: true,
      placement_mode:
        input.actor.placement_mode === "point" && input.actor.spawn_point
          ? "point"
          : "road",
      route: [],
      timed_waypoints: [],
      path_placement: [],
      timeline: [],
      timedInstructions: nextTimedInstructions,
      timed_instruction_runtime_plan: {
        schemaVersion: "simforge.timed-instruction-runtime-plan.v1",
        source: "semantic_execution_index",
        compilerVersion: SEMANTIC_TIMED_INSTRUCTIONS_COMPILER_VERSION,
        runtimeMapHash: hashes.runtimeMapHash,
        actorSpawnHash: hashes.actorSpawnHash,
        instructionHash: hashes.instructionHash,
        resolvedPlanHash: hashes.resolvedPlanHash,
        semanticMapGraphRevision: input.executionIndex.semanticMapGraphRevision,
        semanticExecutionIndexRevision: input.executionIndex.indexRevision,
        intent: rows,
        manifest: plan.manifest,
      },
    },
  };
}

export function compileTimedInstructions(
  input: CompileTimedInstructionsInput,
): CompileTimedInstructionsResult {
  const parsed = TimedInstructionsSchema.parse(input.actor.timedInstructions);
  const rows = enabledIntentRows(parsed);
  if (rows.length === 0) {
    throw new TimedInstructionCompileError(
      `Actor "${input.actor.label}" has Timed instructions selected but no enabled rows.`,
    );
  }

  const rowErrors = validateRows(rows);
  const currentLaneRsl = rslFromAnchor(input.actor.spawn);
  const segments = runtimeSegmentsByRsl(input.runtimeMap);
  if (!currentLaneRsl || !segments.has(currentLaneRsl)) {
    rowErrors.push("actor spawn must resolve to an active CARLA runtime lane");
  }
  if (rowErrors.length > 0 || !currentLaneRsl) {
    const rejected = rejectedPlan(rows, rowErrors);
    TimedInstructionsSchema.parse({
      ...parsed,
      status: "rejected",
      resolvedPlan: rejected,
      manifest: [],
      rejection: rejected,
    });
    throw new TimedInstructionCompileError(
      `Timed instructions rejected for "${input.actor.label}": ${rowErrors.join("; ")}`,
    );
  }

  const plan = compileRuntimeNativePlan(input.runtimeMap, input.actor, rows, currentLaneRsl);
  if (plan.kind === "rejected") {
    TimedInstructionsSchema.parse({
      ...parsed,
      status: "rejected",
      resolvedPlan: plan,
      manifest: [],
      rejection: plan,
    });
    throw new TimedInstructionCompileError(
      `Timed instructions rejected for "${input.actor.label}": ${plan.categories.join("; ")}`,
    );
  }

  const hashes = {
    // Hash a compact identity, NOT the full runtime map: stableStringify of a
    // large map (160MB+ of segments/centerlines) builds multi-GB intermediate
    // strings and OOM-kills even 3GB server functions. The catalog version
    // changes whenever map content changes, so this keeps the staleness
    // property consumers rely on (they only compare hash equality).
    runtimeMapHash: sha256({
      map_name: input.runtimeMap.map_name ?? null,
      normalized_map_name: input.runtimeMap.normalized_map_name ?? null,
      schema_version: input.runtimeMap.schema_version ?? null,
      runtime_catalog_version: input.runtimeCatalogVersion ?? "unknown",
      segment_count: input.runtimeMap.road_segments?.length ?? 0,
    }),
    runtimeMapSchemaVersion: `simforge.runtime-map.v${input.runtimeMap.schema_version ?? 1}`,
    runtimeCatalogVersion: input.runtimeCatalogVersion ?? "unknown",
    compilerVersion: TIMED_INSTRUCTIONS_COMPILER_VERSION,
    actorSpawnHash: sha256(input.actor.spawn),
    instructionHash: sha256(rows),
    resolvedPlanHash: sha256(plan),
  };
  const nextTimedInstructions = TimedInstructionsSchema.parse({
    ...parsed,
    status: "resolved",
    resolvedPlan: plan,
    hashes,
    manifest: plan.manifest,
    timedInstructionValidation: {
      status: "stale",
      hashes,
      evidence: { runtimeEventIds: [], artifactIds: [] },
      primitiveResults: [],
    },
    workerValidation: {
      status: "stale",
      hashes,
      evidence: { runtimeEventIds: [], artifactIds: [] },
      primitiveResults: [],
      renderOrRuntimeArtifactIds: [],
      projectionChecks: {
        movementVariant: "runtime_native",
        hasConstrainedEnvelope: false,
      },
    },
  });

  const projectedActor: ScenarioEditorActorDraft = {
    ...input.actor,
    autopilot: true,
    // Timed-instruction actors are normally road-anchored so the runtime plan
    // (built above from the ROAD spawn, currentLaneRsl) drives them. The recovery
    // family is the exception: it spawns the subject laterally OFF its lane
    // (placement_mode "point" + offset spawn_point) while keeping the same
    // road-anchored lane-follow reference, so the pursuit controller demonstrates
    // the return to lane center. Preserve that point spawn — the reference is
    // unaffected (it anchors on input.actor.spawn, not spawn_point), and the
    // worker's _actor_spawn_transform honors spawn_point for any role in point mode.
    placement_mode:
      input.actor.placement_mode === "point" && input.actor.spawn_point
        ? "point"
        : "road",
    route: [],
    timed_waypoints: [],
    path_placement: [],
    timeline: [],
    timedInstructions: nextTimedInstructions,
    timed_instruction_runtime_plan: {
      schemaVersion: "simforge.timed-instruction-runtime-plan.v1",
      source: "carla_runtime_waypoints",
      compilerVersion: TIMED_INSTRUCTIONS_COMPILER_VERSION,
      runtimeMapHash: hashes.runtimeMapHash,
      actorSpawnHash: hashes.actorSpawnHash,
      instructionHash: hashes.instructionHash,
      resolvedPlanHash: hashes.resolvedPlanHash,
      intent: rows,
      manifest: plan.manifest,
    },
  };

  return { timedInstructions: nextTimedInstructions, projectedActor };
}
