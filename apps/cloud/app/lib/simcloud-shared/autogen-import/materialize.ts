import { ScenarioEditorDraftSchema } from "../scenario-editor";

/**
 * Recovering a canonical, editor-native scenario draft from an offline run.
 *
 * Historical runs predate canonical spec emission: the fleet wrote a compiled
 * worker job and a replay sidecar, but no `scenario-spec.v1`. Since the bundle
 * contract requires the UNCOMPILED draft — a later phase has to open the
 * scenario and compile it against an operator-chosen rig — the draft has to be
 * reconstructed from the compiled request.
 *
 * Newly generated runs should write the spec at emission time instead; this
 * exists for the back catalogue.
 */

export const SCENARIO_SPEC_SCHEMA_VERSION = "simforge.scenario-spec.v1" as const;

/**
 * Local copy rather than an import from ./evidence: that module reads the
 * filesystem, and materialization is otherwise pure, so a server route could
 * reuse it without pulling node builtins in behind it.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Execution-only fields on a compiled worker job. They describe HOW one render
 * was run, not WHAT the scenario is, so they must not survive into the draft —
 * otherwise a later production render inherits the offline run's camera and
 * output settings instead of the operator's chosen rig.
 */
const EXECUTION_ONLY_KEYS = new Set([
  "output_spec",
  "recording_fps",
  "recording_height",
  "recording_width",
  "render_enabled",
  "trailing_camera",
  "trailing_camera_fps",
  "type",
]);

/** Keys consumed into the draft's own structure rather than carried as extras. */
const STRUCTURAL_KEYS = new Set([
  "actors",
  "simulationConfig",
  "scenario_id",
  "mapName",
  "map_name",
]);

export type MaterializeInput = {
  request: Record<string, unknown>;
  sceneId: string;
  mapName: string;
  mapAssetId: string;
  datasetId: string | null;
  navPrompt: string | null;
  /**
   * Timestamps for the draft metadata. Passed in rather than read from the
   * clock so materializing the same run twice produces byte-identical output,
   * which is what lets the spec hash be a stable identity.
   */
  createdAt: string;
  updatedAt: string;
};

export type MaterializeResult =
  | { ok: true; spec: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Materialize a `simforge.scenario-spec.v1` from a compiled worker job.
 *
 * The draft is validated against `ScenarioEditorDraftSchema` before being
 * returned. Without that check the bundle can advertise an "editor-native
 * draft" that the editor cannot actually load — the failure would only surface
 * later, when a customer or a production render tried to open it, by which
 * point the scenario is already published.
 */
export function materializeSpec(input: MaterializeInput): MaterializeResult {
  const { request } = input;
  const actors = Array.isArray(request.actors) ? request.actors : [];
  const simulationConfig = asRecord(request.simulationConfig) ?? {
    duration_seconds: request.duration_seconds ?? 20,
    fixed_delta_seconds: request.fixed_delta_seconds ?? 0.05,
    physics_profile_id: "carla_default",
  };

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (EXECUTION_ONLY_KEYS.has(key) || STRUCTURAL_KEYS.has(key)) continue;
    extras[key] = value;
  }

  const draft = {
    version: 2 as const,
    metadata: {
      sourceScenarioId: input.sceneId,
      mapAssetId: input.mapAssetId,
      mapName: input.mapName,
      backendMapName: input.mapName,
      notes: "materialized from the offline compiled worker job",
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    },
    actors,
    simulationConfig,
    worldSensors: [],
    trafficEnabled: actors.some((a) => asRecord(a)?.role === "traffic"),
  };

  const parsed = ScenarioEditorDraftSchema.safeParse(draft);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `draft_rejected_by_editor_schema:${issue?.path.join(".") || "?"}:${
        issue?.message ?? "unknown"
      }`,
    };
  }

  return {
    ok: true,
    spec: {
      schemaVersion: SCENARIO_SPEC_SCHEMA_VERSION,
      datasetId: input.datasetId,
      scenarioId: input.sceneId,
      map: input.mapName,
      mapAssetId: input.mapAssetId,
      annotation: {
        kind: "autogen_offline_render",
        navPrompt: input.navPrompt,
        // Recorded so a reader knows the draft was recovered from a compiled
        // job rather than emitted canonically, without having to infer it.
        materializedFrom: "compiled_worker_request",
      },
      // The validated draft, plus the generator fields that are neither
      // execution config nor part of the editor shape. Kept beside the draft
      // rather than inside it so the draft stays schema-clean.
      draft: parsed.data,
      generatorExtras: extras,
    },
  };
}
