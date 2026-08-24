import type { JunctionSignalPlan, ScenarioEditorActorDraft } from "@simcloud/shared";
import type { AppContext } from "@/app/lib/db/app-context";
import { execute, queryOne, queryRows, withTransaction } from "@/app/lib/db/data-api";
import {
  isRuntimeMapAssetId,
  runtimeMapNameFromAssetId,
} from "@/app/lib/scenario-editor/map-asset-utils";
import {
  normalizeCarlaRuntime,
  type CarlaRuntime,
} from "@/app/lib/scenario/renderer/runtime-profile";
import {
  normalizeScenarioDraft,
  toPersistedScenarioSetupDraft,
  type NormalizedScenarioDraft,
  type PersistedScenarioDraft,
} from "./draft-normalization";

export type EditorScenarioListRow = {
  id: string;
  display_name: string;
  status: string;
  map_asset_id: string | null;
  map_name: string | null;
  runtime: CarlaRuntime;
  actor_count: number;
  simulation_count: number;
  cosmos_count: number;
  dataset_id: string | null;
  scenario_metadata: string | null;
  created_at: string;
  updated_at: string;
};

export type ScenarioMetadataListFilters = {
  tags?: readonly string[];
  criticality?: number;
};

export type EditorScenarioRecordRow = {
  id: string;
  display_name: string;
  description: string | null;
  status: string;
  dataset_id: string | null;
  map_asset_id: string | null;
  map_name: string | null;
  runtime: CarlaRuntime;
  draft_json: string | null;
  created_at: string;
  updated_at: string;
  latest_simulation_id: string | null;
  source_kind: string;
};

/**
 * Thrown when a scenario cannot be loaded through an editor code path.
 */
export class ScenarioNotEditableError extends Error {
  readonly code = "scenario_not_editable";
  readonly sourceKind: string;
  readonly scenarioId: string;

  constructor(scenarioId: string, sourceKind: string) {
    super(`Scenario ${scenarioId} is not editable (source_kind=${sourceKind})`);
    this.name = "ScenarioNotEditableError";
    this.scenarioId = scenarioId;
    this.sourceKind = sourceKind;
  }
}

type MapAssetReferenceRow = {
  map_asset_id: string;
  name: string;
  carla_map_name: string | null;
  ue5_carla_map_name: string | null;
};

export type ScenarioMapReference = {
  mapAssetId: string | null;
  mapName: string | null;
  backendMapName: string | null;
  mapLabel?: string | null;
};

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function resolveMapAssetReference(
  mapName: string | null | undefined,
  runtime?: CarlaRuntime,
) {
  const trimmedMapName = trimToNull(mapName);
  if (!trimmedMapName) {
    return {
      mapAssetId: null,
      mapName: null,
      backendMapName: null,
      mapLabel: null,
    };
  }

  const row = await queryOne<MapAssetReferenceRow>(
    `
      SELECT
        id AS map_asset_id,
        name,
        carla_map_name,
        ue5_carla_map_name
      FROM map_assets
      WHERE is_active = TRUE
        AND (
          carla_map_name = :map_name
          OR ue5_carla_map_name = :map_name
          OR name = :map_name
        )
      ORDER BY CASE
        WHEN carla_map_name = :map_name OR ue5_carla_map_name = :map_name THEN 0
        ELSE 1
      END
      LIMIT 1
    `,
    { map_name: trimmedMapName },
  );

  const runtimeMapName =
    runtime === "carla_ue5"
      ? trimToNull(row?.ue5_carla_map_name)
      : trimToNull(row?.carla_map_name);
  return {
    mapAssetId: row?.map_asset_id ?? null,
    mapName: runtimeMapName ?? trimToNull(row?.name ?? trimmedMapName),
    backendMapName: runtimeMapName ?? trimmedMapName,
    mapLabel: trimToNull(row?.name ?? runtimeMapName ?? trimmedMapName),
  };
}

export async function resolveMapAssetReferenceById(
  mapAssetId: string | null | undefined,
  runtime?: CarlaRuntime,
): Promise<ScenarioMapReference> {
  const trimmedMapAssetId = trimToNull(mapAssetId);
  if (!trimmedMapAssetId) {
    return {
      mapAssetId: null,
      mapName: null,
      backendMapName: null,
      mapLabel: null,
    };
  }

  const row = await queryOne<MapAssetReferenceRow>(
    `
      SELECT
        id AS map_asset_id,
        name,
        carla_map_name,
        ue5_carla_map_name
      FROM map_assets
      WHERE is_active = TRUE
        AND id = :map_asset_id
      LIMIT 1
    `,
    { map_asset_id: trimmedMapAssetId },
  );

  const runtimeMapName =
    runtime === "carla_ue5"
      ? trimToNull(row?.ue5_carla_map_name)
      : trimToNull(row?.carla_map_name);
  return {
    mapAssetId: row?.map_asset_id ?? null,
    mapName: runtimeMapName ?? trimToNull(row?.name ?? null),
    backendMapName: runtimeMapName ?? trimToNull(row?.name ?? null),
    mapLabel: trimToNull(row?.name ?? runtimeMapName ?? null),
  };
}

export async function resolveScenarioMapReference(input: {
  mapAssetId?: string | null;
  mapName?: string | null;
  backendMapName?: string | null;
  runtime?: CarlaRuntime;
}): Promise<ScenarioMapReference> {
  const trimmedMapAssetId = trimToNull(input.mapAssetId);
  if (trimmedMapAssetId) {
    if (isRuntimeMapAssetId(trimmedMapAssetId)) {
      const runtimeName = runtimeMapNameFromAssetId(trimmedMapAssetId);
      return {
        mapAssetId: null,
        mapName: runtimeName,
        backendMapName: runtimeName,
        mapLabel: runtimeName,
      };
    }
    return resolveMapAssetReferenceById(trimmedMapAssetId, input.runtime);
  }

  return resolveMapAssetReference(
    input.mapName ?? input.backendMapName ?? null,
    input.runtime,
  );
}

export async function buildInitialScenarioDraft(input: {
  scenarioId: string;
  mapReference: ScenarioMapReference;
  runtime?: CarlaRuntime;
  createdAt: string;
  updatedAt: string;
}) {
  const normalizedDraft = normalizeScenarioDraft(
    input.mapReference.mapName ? { map_name: input.mapReference.mapName } : {},
    {
      fallbackMapName: input.mapReference.mapName,
      scenarioId: input.scenarioId,
      mapAssetId: input.mapReference.mapAssetId,
      backendMapName: input.mapReference.backendMapName,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    },
  );
  const seededDraft = {
    ...normalizedDraft,
    // New scenarios are persisted without server-generated actors. Once the
    // editor has loaded the exact CARLA runtime geometry, its runtime actor
    // bootstrap chooses a real drivable lane and creates the starter subject.
    // Semantic topology is intentionally reserved for scenario transfer.
    actors: normalizedDraft.actors,
    selectedActorId: normalizedDraft.selectedActorId ?? null,
  };
  const draft = toPersistedScenarioSetupDraft(seededDraft, null, {
    scenarioId: input.scenarioId,
    mapAssetId: input.mapReference.mapAssetId,
    backendMapName: input.mapReference.backendMapName,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });

  return {
    normalizedDraft: seededDraft,
    draft,
  };
}

export async function listEditorScenariosForWorkspace(
  workspaceId: string,
  filters: ScenarioMetadataListFilters = {},
): Promise<EditorScenarioListRow[]> {
  const tags = [
    ...new Set(
      (filters.tags ?? [])
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    ),
  ];
  const params: Record<string, string | number> = {
    workspace_id: workspaceId,
  };
  const filterClauses: string[] = [];
  for (const [index, tag] of tags.entries()) {
    const name = `scenario_tag_${index}`;
    params[name] = tag;
    filterClauses.push(`(
      (s.scenario_metadata -> 'tags' -> 'actor_types') ? :${name}
      OR (s.scenario_metadata -> 'tags' -> 'maneuver') ? :${name}
      OR (s.scenario_metadata -> 'tags' -> 'environmental') ? :${name}
      OR s.scenario_metadata -> 'tags' ->> 'interaction_type' = :${name}
      OR s.scenario_metadata -> 'tags' ->> 'legality' = :${name}
      OR s.scenario_metadata -> 'tags' ->> 'occlusion' = :${name}
      OR s.scenario_metadata -> 'tags' ->> 'relative_direction' = :${name}
    )`);
  }
  if (filters.criticality !== undefined) {
    params.scenario_criticality = String(filters.criticality);
    filterClauses.push(
      "s.scenario_metadata -> 'tags' ->> 'criticality' = :scenario_criticality",
    );
  }
  const filterSql =
    filterClauses.length > 0
      ? `\n        AND ${filterClauses.join("\n        AND ")}`
      : "";
  return queryRows<EditorScenarioListRow>(
    `
      SELECT
        s.id,
        s.display_name,
        s.description,
        s.status,
        s.map_asset_id,
        s.runtime AS runtime,
        NULLIF(
          BTRIM(
            COALESCE(
              s.draft_json::jsonb->'setup'->'map'->>'mapName',
              s.draft_json::jsonb->'metadata'->>'mapName',
              s.draft_json::jsonb->>'map_name',
              s.draft_json::jsonb->>'mapName',
              ma.carla_map_name,
              ma.name,
              ''
            )
          ),
          ''
        ) AS map_name,
        CASE
          WHEN jsonb_typeof(COALESCE(s.draft_json::jsonb->'setup'->'scene'->'actors', s.draft_json::jsonb->'actors', '[]'::jsonb)) = 'array'
            THEN jsonb_array_length(COALESCE(s.draft_json::jsonb->'setup'->'scene'->'actors', s.draft_json::jsonb->'actors', '[]'::jsonb))
          ELSE 0
        END AS actor_count,
        0::int AS simulation_count,
        0::int AS cosmos_count,
        s.dataset_id,
        s.scenario_metadata::text AS scenario_metadata,
        s.created_at::text AS created_at,
        s.updated_at::text AS updated_at
      FROM scenarios s
      LEFT JOIN map_assets ma
        ON ma.id = s.map_asset_id
      WHERE s.workspace_id = :workspace_id
        ${filterSql}
      ORDER BY s.updated_at DESC, s.created_at DESC
      -- Aurora Data API caps results at 1 MB; batch-generated workspaces hold
      -- thousands of scenarios and an unbounded list 500s the whole endpoint.
      LIMIT 1000
    `,
    params,
  );
}

export async function getEditorScenarioRecord(
  workspaceId: string,
  scenarioId: string,
): Promise<EditorScenarioRecordRow | null> {
  const row = await queryOne<EditorScenarioRecordRow>(
    `
      SELECT
        s.id,
        s.display_name,
        s.status,
        s.dataset_id,
        s.map_asset_id,
        s.runtime AS runtime,
        NULLIF(
          BTRIM(
            COALESCE(
              s.draft_json::jsonb->'setup'->'map'->>'mapName',
              s.draft_json::jsonb->'metadata'->>'mapName',
              s.draft_json::jsonb->>'map_name',
              s.draft_json::jsonb->>'mapName',
              ma.carla_map_name,
              ma.name,
              ''
            )
          ),
          ''
        ) AS map_name,
        -- Strip the per-frame actor positions out of the saved preview
        -- timeline before returning the row. The frames blob can run >1MB
        -- on long sims, which trips Aurora Data API's 1MB result-set cap.
        -- The frames are stored in the saved timeline artifact, so we don't
        -- need them on the row at all.
        (s.draft_json::jsonb #- '{savedPreviewTimeline,frames}')::text AS draft_json,
        s.created_at::text AS created_at,
        s.updated_at::text AS updated_at,
        COALESCE(s.source_kind, 'native') AS source_kind,
        NULL::text AS latest_simulation_id
      FROM scenarios s
      LEFT JOIN map_assets ma
        ON ma.id = s.map_asset_id
      WHERE s.workspace_id = :workspace_id
        AND s.id = :scenario_id
      LIMIT 1
    `,
    {
      workspace_id: workspaceId,
      scenario_id: scenarioId,
    },
  );
  if (!row) return null;
  // Editor code paths may only operate on native scenarios.
  if (row.source_kind && row.source_kind !== "native") {
    throw new ScenarioNotEditableError(scenarioId, row.source_kind);
  }
  return row;
}

export async function getScenarioRuntime(
  workspaceId: string,
  scenarioId: string,
): Promise<CarlaRuntime> {
  const row = await queryOne<{ runtime: string | null }>(
    `
      SELECT runtime
      FROM scenarios
      WHERE workspace_id = :workspace_id
        AND id = :scenario_id
      LIMIT 1
    `,
    {
      workspace_id: workspaceId,
      scenario_id: scenarioId,
    },
  );
  return normalizeCarlaRuntime(row?.runtime);
}

export async function createEditorScenario(
  context: AppContext,
  input: {
    displayName: string;
    mapAssetId?: string | null;
    mapName?: string | null;
    runtime?: CarlaRuntime;
  },
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const runtime = normalizeCarlaRuntime(input.runtime);
  const mapReference = await resolveScenarioMapReference({
    mapAssetId: input.mapAssetId ?? null,
    mapName: input.mapName ?? null,
    runtime,
  });
  const { normalizedDraft, draft } = await buildInitialScenarioDraft({
    scenarioId: id,
    mapReference,
    runtime,
    createdAt: now,
    updatedAt: now,
  });

  await execute(
    `
      INSERT INTO scenarios (
        id,
        workspace_id,
        map_asset_id,
        runtime,
        display_name,
        status,
        draft_json,
        created_by_user_id,
        created_at,
        updated_at
      )
      VALUES (
        :id,
        :workspace_id,
        :map_asset_id,
        :runtime,
        :display_name,
        'draft',
        :draft_json::jsonb,
        :created_by_user_id,
        NOW(),
        NOW()
      )
    `,
    {
      id,
      workspace_id: context.workspaceId,
      map_asset_id: mapReference.mapAssetId,
      runtime,
      display_name: input.displayName,
      draft_json: draft,
      created_by_user_id: context.userId,
    },
  );

  return {
    id,
    displayName: input.displayName,
    draft,
    mapName: normalizedDraft.mapName || null,
    mapAssetId: mapReference.mapAssetId,
    runtime,
    createdAt: now,
    updatedAt: now,
  };
}

export async function createCrossMapVariationScenarios(
  context: AppContext,
  inputs: Array<{
    displayName: string;
    sourceScenarioId: string;
    targetMapAssetId: string;
    runtime: CarlaRuntime;
    actors: ScenarioEditorActorDraft[];
    semanticFormations: NonNullable<NormalizedScenarioDraft["semanticFormations"]>;
    semanticFormationSolutions: NonNullable<NormalizedScenarioDraft["semanticFormationSolutions"]>;
    /** Signal plans REBUILT on the target junctions' movement tables by the
     * cross-map compiler. Source plans are keyed by the source map's
     * junction/movement ids and must never be carried over verbatim. */
    signalPlans: JunctionSignalPlan[];
    sourceDraft: NormalizedScenarioDraft;
    variationParams: Record<string, unknown>;
  }>,
  options: { datasetId?: string } = {},
) {
  const prepared = await Promise.all(inputs.map(async (input) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const runtime = normalizeCarlaRuntime(input.runtime);
    const mapReference = await resolveScenarioMapReference({
      mapAssetId: input.targetMapAssetId,
      mapName: null,
      runtime,
    });
    if (!mapReference.mapAssetId || !mapReference.mapName) {
      throw new Error(`Target map asset is unavailable: ${input.targetMapAssetId}`);
    }
    const normalizedDraft: NormalizedScenarioDraft = {
      ...input.sourceDraft,
      mapName: mapReference.mapName,
      actors: input.actors,
      semanticFormations: input.semanticFormations,
      semanticFormationSolutions: input.semanticFormationSolutions,
      // Source signal plans are keyed by the SOURCE map's junction/movement
      // ids and mean nothing on the target map; what persists is the plan set
      // the cross-map compiler rebuilt on the target junctions' own movement
      // tables (empty when the source authored none, with every drop reported
      // in the match's relaxation ledger).
      signalPlans: input.signalPlans,
      selectedActorId:
        input.actors.find((actor) => actor.id === input.sourceDraft.selectedActorId)?.id ??
        input.actors[0]?.id ??
        null,
      metadata: {
        ...input.sourceDraft.metadata,
        sourceScenarioId: input.sourceScenarioId,
        mapAssetId: mapReference.mapAssetId,
        backendMapName: mapReference.backendMapName,
        activeScenarioSimulationId: null,
        latestScenarioSimulationId: null,
        createdAt: now,
        updatedAt: now,
      },
    };
    const draft = toPersistedScenarioSetupDraft(normalizedDraft, null, {
      scenarioId: id,
      mapAssetId: mapReference.mapAssetId,
      backendMapName: mapReference.backendMapName,
      createdAt: now,
      updatedAt: now,
    });
    return { id, runtime, mapReference, draft, input };
  }));

  await withTransaction(async (tx) => {
    let nextDatasetSortOrder = 0;
    if (options.datasetId) {
      const sourceScenarioIds = [...new Set(prepared.map((row) => row.input.sourceScenarioId))];
      if (sourceScenarioIds.length !== 1) {
        throw new Error("Cross-map variations in a dataset must share one source scenario");
      }
      const membership = await tx.queryOne<{
        next_sort_order: number;
        source_membership_count: number;
      }>(
        `
          SELECT
            (
              COALESCE((
                SELECT MAX(sort_order)
                FROM dataset_scenarios
                WHERE workspace_id = :workspace_id
                  AND dataset_id = :dataset_id
              ), -1) + 1
            )::int AS next_sort_order,
            CASE WHEN
              EXISTS (
                SELECT 1
                FROM dataset_scenarios
                WHERE workspace_id = :workspace_id
                  AND dataset_id = :dataset_id
                  AND scenario_id = :source_scenario_id
              )
              OR EXISTS (
                SELECT 1
                FROM scenarios
                WHERE workspace_id = :workspace_id
                  AND dataset_id = :dataset_id
                  AND id = :source_scenario_id
              )
            THEN 1 ELSE 0 END::int AS source_membership_count
        `,
        {
          workspace_id: context.workspaceId,
          dataset_id: options.datasetId,
          source_scenario_id: sourceScenarioIds[0]!,
        },
      );
      if (!membership || membership.source_membership_count !== 1) {
        throw new Error("The source scenario is not part of the requested dataset");
      }
      nextDatasetSortOrder = membership.next_sort_order;
    }

    for (const row of prepared) {
      await tx.execute(
        `
      INSERT INTO scenarios (
        id,
        workspace_id,
        dataset_id,
        map_asset_id,
        runtime,
        display_name,
        status,
        parent_scenario_id,
        variation_params,
        draft_json,
        created_by_user_id,
        created_at,
        updated_at
      )
      VALUES (
        :id,
        :workspace_id,
        :dataset_id,
        :map_asset_id,
        :runtime,
        :display_name,
        'draft',
        :parent_scenario_id,
        :variation_params::jsonb,
        :draft_json::jsonb,
        :created_by_user_id,
        NOW(),
        NOW()
      )
    `,
        {
          id: row.id,
          workspace_id: context.workspaceId,
          dataset_id: options.datasetId ?? null,
          map_asset_id: row.mapReference.mapAssetId,
          runtime: row.runtime,
          display_name: row.input.displayName,
          parent_scenario_id: row.input.sourceScenarioId,
          variation_params: row.input.variationParams,
          draft_json: row.draft,
          created_by_user_id: context.userId,
        },
      );
      if (options.datasetId) {
        await tx.execute(
          `
            INSERT INTO dataset_scenarios (
              workspace_id,
              dataset_id,
              scenario_id,
              role,
              sort_order,
              added_by_user_id,
              updated_by_user_id,
              created_at,
              updated_at
            )
            VALUES (
              :workspace_id,
              :dataset_id,
              :scenario_id,
              'variation',
              :sort_order,
              :user_id,
              :user_id,
              NOW(),
              NOW()
            )
          `,
          {
            workspace_id: context.workspaceId,
            dataset_id: options.datasetId,
            scenario_id: row.id,
            sort_order: nextDatasetSortOrder,
            user_id: context.userId,
          },
        );
        nextDatasetSortOrder += 1;
      }
    }
    if (options.datasetId && prepared.length > 0) {
      await tx.execute(
        `
          UPDATE datasets
          SET stats_scenario_count = stats_scenario_count + :created_count,
              stats_updated_at = NOW()
          WHERE workspace_id = :workspace_id
            AND id = :dataset_id
        `,
        {
          workspace_id: context.workspaceId,
          dataset_id: options.datasetId,
          created_count: prepared.length,
        },
      );
    }
  });

  return prepared.map((row) => ({
    id: row.id,
    displayName: row.input.displayName,
    mapAssetId: row.mapReference.mapAssetId!,
    mapName: row.mapReference.mapName!,
    runtime: row.runtime,
  }));
}

export async function renameEditorScenarioForWorkspace(
  workspaceId: string,
  scenarioId: string,
  displayName: string,
) {
  await updateEditorScenarioMetadataForWorkspace(workspaceId, scenarioId, {
    displayName,
  });
}

export async function updateEditorScenarioMetadataForWorkspace(
  workspaceId: string,
  scenarioId: string,
  updates: { displayName?: string; description?: string | null },
) {
  const parts: string[] = [];
  const params: Record<string, string | null> = {
    workspace_id: workspaceId,
    scenario_id: scenarioId,
  };

  if (updates.displayName !== undefined) {
    parts.push("display_name = :display_name");
    params.display_name = updates.displayName;
  }
  if ("description" in updates) {
    parts.push("description = :description");
    params.description = updates.description ?? null;
  }
  if (parts.length === 0) return;

  await execute(
    `
      UPDATE scenarios
      SET
        ${parts.join(", ")},
        updated_at = NOW()
      WHERE workspace_id = :workspace_id
        AND id = :scenario_id
    `,
    params,
  );
}

export async function duplicateEditorScenarioForWorkspace(
  context: AppContext,
  scenarioId: string,
  options: { displayName?: string | null } = {},
) {
  const id = crypto.randomUUID();

  await execute(
    `
      INSERT INTO scenarios (
        id,
        workspace_id,
        map_asset_id,
        runtime,
        display_name,
        status,
        dataset_id,
        parent_scenario_id,
        variation_params,
        draft_json,
        created_by_user_id,
        created_at,
        updated_at
      )
      SELECT
        :new_id,
        s.workspace_id,
        s.map_asset_id,
        s.runtime,
        COALESCE(:display_name, CONCAT(COALESCE(NULLIF(BTRIM(s.display_name), ''), 'Untitled Scenario'), ' (Variation)')),
        'draft',
        s.dataset_id,
        s.id,
        s.variation_params,
        s.draft_json,
        :created_by_user_id,
        NOW(),
        NOW()
      FROM scenarios s
      WHERE s.workspace_id = :workspace_id
        AND s.id = :scenario_id
    `,
    {
      new_id: id,
      workspace_id: context.workspaceId,
      scenario_id: scenarioId,
      display_name: options.displayName?.trim() || null,
      created_by_user_id: context.userId,
    },
  );

  const row = await getEditorScenarioRecord(context.workspaceId, id);
  if (!row) {
    throw new Error(`Scenario not found after duplication: ${scenarioId}`);
  }

  return row;
}

export function parseScenarioDraftJson(draftJson: string | null): PersistedScenarioDraft | null {
  if (!draftJson) return null;

  try {
    const parsed = JSON.parse(draftJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PersistedScenarioDraft)
      : null;
  } catch {
    return null;
  }
}
