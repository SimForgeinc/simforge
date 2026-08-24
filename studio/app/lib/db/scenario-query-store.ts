import { ScenarioSchema, type Scenario } from "@simcloud/shared";
import { datasetScenarioId, scenarioRowId } from "./ids";
import { queryOne, queryRows, withTransaction } from "./data-api";
import type { AppContext } from "./app-context";
import {
  buildInitialScenarioDraft,
  resolveScenarioMapReference,
} from "@/app/lib/scenario-editor/scenario-api-store";
import {
  toPersistedScenarioSetupDraft,
  type NormalizedScenarioDraft,
} from "@/app/lib/scenario-editor/draft-normalization";
import {
  SYSTEM_GLOBAL_WORKSPACE_ID,
  TEMPLATE_SCENARIOS_DATASET_ID,
} from "./dataset-store";
import {
  normalizeCarlaRuntime,
  type CarlaRuntime,
} from "@/app/lib/scenario/renderer/runtime-profile";

type ScenarioRow = {
  id?: string;
  display_name?: string;
  status?: string;
  created_at?: string;
  draft_json?: string;
};

type SimulationArtifactRow = {
  scenario_id: string;
  backend_run_id: string;
  finished_at: string | null;
  updated_at: string;
  s3_recording_bucket: string | null;
  s3_recording_key: string | null;
  size_bytes: number | null;
};

export type { StoredSimulationArtifact } from "./scenario-query-types";

function scenarioWithSimulationArtifacts(
  scenario: Scenario,
  simulationArtifacts: Map<string, Scenario["artifacts"]>,
) {
  const synthesizedArtifacts = simulationArtifacts.get(scenario.id) ?? [];
  if (synthesizedArtifacts.length === 0) return scenario;

  const existingUris = new Set(
    scenario.artifacts.map((artifact) => artifact.uri),
  );
  const mergedArtifacts = [
    ...scenario.artifacts,
    ...synthesizedArtifacts.filter(
      (artifact) => !existingUris.has(artifact.uri),
    ),
  ];
  return {
    ...scenario,
    artifacts: mergedArtifacts,
  };
}

function parseSimulationArtifacts(rows: SimulationArtifactRow[]) {
  const byRunId = new Map<string, Scenario["artifacts"]>();
  for (const row of rows) {
    if (!row.s3_recording_bucket || !row.s3_recording_key) continue;

    const createdAt = row.finished_at ?? row.updated_at;
    const key = row.s3_recording_key;
    const uri = `/api/scenarios/${row.scenario_id}/media?key=${encodeURIComponent(key)}`;

    const artifact = {
      id: `runtime:${row.backend_run_id}:mp4`,
      simulationId: row.backend_run_id,
      type: "MP4" as const,
      uri,
      sizeBytes: row.size_bytes ?? 0,
      createdAt: new Date(createdAt).toISOString(),
      isAvailable: true,
      environmentPresetRef: [],
      generatedBy: "CARLA Simulator" as const,
      metadata: row.backend_run_id ?? undefined,
    };

    const current = byRunId.get(row.scenario_id) ?? [];
    current.push(artifact);
    byRunId.set(row.scenario_id, current);
  }
  return byRunId;
}

/**
 * Normalise case for status values.
 * The editor stores lowercase ("draft") but the schema expects uppercase ("DRAFT").
 */
function normaliseEnum(value: string | undefined): string | undefined {
  return value?.toUpperCase();
}

function parseScenarioRows(
  rows: ScenarioRow[],
  simulationArtifacts: Map<string, Scenario["artifacts"]> = new Map(),
) {
  return rows
    .map((row) => {
      // Build scenario data from columns and draft_json
      let draftData: Record<string, unknown> = {};
      if (row.draft_json) {
        try {
          draftData = JSON.parse(row.draft_json) as Record<string, unknown>;
        } catch {
          // ignore malformed draft_json
        }
      }

      const merged: Record<string, unknown> = {
        id: row.id,
        displayName: row.display_name,
        status: normaliseEnum(row.status),
        engine: "CARLA",
        createdAt: row.created_at,
        ...draftData,
      };

      // Ensure column values win when draft_json fields are empty
      if (!merged.id && row.id) merged.id = row.id;
      if (!merged.displayName && row.display_name)
        merged.displayName = row.display_name;
      if (!merged.status && row.status)
        merged.status = normaliseEnum(row.status);
      if (!merged.createdAt && row.created_at)
        merged.createdAt = row.created_at;

      // Always hardcode engine
      merged.engine = "CARLA";

      return ScenarioSchema.safeParse(merged);
    })
    .filter(
      (result): result is { success: true; data: Scenario } => result.success,
    )
    .map((result) =>
      scenarioWithSimulationArtifacts(result.data, simulationArtifacts),
    );
}

export async function listScenariosForWorkspace(
  workspaceId: string,
  limit = 25,
) {
  const rows = await queryRows<ScenarioRow>(
      `
        SELECT
          s.id,
          s.display_name,
          s.status,
          s.created_at::text AS created_at,
          s.draft_json::text AS draft_json
        FROM scenarios s
        WHERE s.workspace_id = :workspace_id
          AND s.dataset_id IS NULL
        ORDER BY s.created_at DESC
        LIMIT :row_limit
      `,
      { workspace_id: workspaceId, row_limit: limit },
    );

  return parseScenarioRows(rows, parseSimulationArtifacts([]));
}

export async function getScenarioById(workspaceId: string, scenarioId: string) {
  const row = await queryOne<ScenarioRow>(
      `
        SELECT
          s.id,
          s.display_name,
          s.status,
          s.created_at::text AS created_at,
          s.draft_json::text AS draft_json
        FROM scenarios s
        WHERE s.workspace_id = :workspace_id
          AND s.id = :id
        LIMIT 1
      `,
      {
        workspace_id: workspaceId,
        id: scenarioId,
      },
    );

  return row
    ? (parseScenarioRows([row], parseSimulationArtifacts([]))[0] ??
        null)
    : null;
}

export async function upsertScenarioForWorkspace(
  context: AppContext,
  scenario: Scenario,
) {
  await withTransaction(async (tx) => {
    await tx.execute(
      `
        INSERT INTO scenarios (
          id,
          workspace_id,
          map_asset_id,
          display_name,
          status,
          created_by_user_id,
          updated_by_user_id,
          created_at,
          updated_at
        )
        VALUES (
          :id,
          :workspace_id,
          :map_asset_id,
          :display_name,
          :status,
          :created_by_user_id,
          :created_by_user_id,
          CAST(REPLACE(REPLACE(:created_at, 'T', ' '), 'Z', '') AS TIMESTAMPTZ),
          NOW()
        )
        ON CONFLICT (id)
        DO UPDATE SET
          map_asset_id = EXCLUDED.map_asset_id,
          display_name = EXCLUDED.display_name,
          status = EXCLUDED.status,
          updated_by_user_id = EXCLUDED.created_by_user_id,
          updated_at = NOW()
      `,
      {
        id: scenarioRowId(context.workspaceId, scenario.id),
        workspace_id: context.workspaceId,
        map_asset_id: scenario.location.map_asset_id,
        display_name: scenario.displayName,
        status: scenario.status,
        created_by_user_id: context.userId,
        created_at: scenario.createdAt,
      },
    );

    await tx.execute(
      `
        UPDATE artifacts
        SET scenario_id = :scenario_id
        WHERE workspace_id = :workspace_id
          AND scenario_id = :id
          AND scenario_id IS NULL
      `,
      {
        scenario_id: scenarioRowId(context.workspaceId, scenario.id),
        workspace_id: context.workspaceId,
        id: scenario.id,
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Dataset variation helpers
// ---------------------------------------------------------------------------

type VariationRow = {
  id: string;
  display_name: string | null;
  status: string | null;
  dataset_id: string | null;
  parent_scenario_id: string | null;
  variation_params: string | null;
  created_at: string;
};

export async function listVariationsForDataset(
  workspaceId: string,
  datasetId: string,
): Promise<VariationRow[]> {
  return queryRows<VariationRow>(
    `
      SELECT
        s.id,
        s.display_name,
        s.status,
        s.dataset_id,
        s.parent_scenario_id,
        s.variation_params::text AS variation_params,
        s.created_at::text AS created_at
      FROM scenarios s
      WHERE s.workspace_id = :workspace_id
        AND s.dataset_id = :dataset_id
      ORDER BY s.created_at ASC
    `,
    { workspace_id: workspaceId, dataset_id: datasetId },
  );
}

/** Bare count for seed/name numbering — the full listing exceeds the Aurora
 * Data API 1 MB response cap once a dataset accumulates a few thousand
 * scenarios with non-trivial variation_params. */
export async function countScenariosForDataset(
  workspaceId: string,
  datasetId: string,
): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    `
      SELECT count(*)::int AS n
      FROM scenarios s
      WHERE s.workspace_id = :workspace_id
        AND s.dataset_id = :dataset_id
    `,
    { workspace_id: workspaceId, dataset_id: datasetId },
  );
  return rows[0]?.n ?? 0;
}

/** Slim per-dataset listing (no variation_params) that stays under the 1 MB
 * Data API cap at realistic dataset sizes; pair with
 * getVariationRowsByIds for the few rows that need full params. */
export async function listScenarioRefsForDataset(
  workspaceId: string,
  datasetId: string,
): Promise<Array<Pick<VariationRow, "id" | "display_name" | "status" | "created_at">>> {
  return queryRows(
    `
      SELECT
        s.id,
        s.display_name,
        s.status,
        s.created_at::text AS created_at
      FROM scenarios s
      WHERE s.workspace_id = :workspace_id
        AND s.dataset_id = :dataset_id
      ORDER BY s.created_at ASC
    `,
    { workspace_id: workspaceId, dataset_id: datasetId },
  );
}

const SCENARIO_ID_SHAPE = /^[A-Za-z0-9_-]+$/;

export async function getVariationRowsByIds(
  workspaceId: string,
  datasetId: string,
  scenarioIds: readonly string[],
): Promise<VariationRow[]> {
  const safeIds = [
    ...new Set(
      scenarioIds
        .map((id) => id.trim())
        .filter((id) => SCENARIO_ID_SHAPE.test(id)),
    ),
  ];
  if (safeIds.length === 0) return [];
  const params: Record<string, string> = {
    workspace_id: workspaceId,
    dataset_id: datasetId,
  };
  const placeholders = safeIds
    .map((id, index) => {
      const key = `scenario_id_${index}`;
      params[key] = id;
      return `:${key}`;
    })
    .join(", ");
  return queryRows<VariationRow>(
    `
      SELECT
        s.id,
        s.display_name,
        s.status,
        s.dataset_id,
        s.parent_scenario_id,
        s.variation_params::text AS variation_params,
        s.created_at::text AS created_at
      FROM scenarios s
      WHERE s.workspace_id = :workspace_id
        AND s.dataset_id = :dataset_id
        AND s.id IN (${placeholders})
      ORDER BY s.created_at ASC
    `,
    params,
  );
}

export async function getBaseScenario(
  workspaceId: string,
  scenarioId: string,
): Promise<VariationRow | null> {
  return queryOne<VariationRow>(
    `
      SELECT
        s.id,
        s.display_name,
        s.status,
        s.dataset_id,
        s.parent_scenario_id,
        s.variation_params::text AS variation_params,
        s.created_at::text AS created_at
      FROM scenarios s
      WHERE s.workspace_id = :workspace_id
        AND s.id = :id
        AND s.dataset_id IS NULL
      LIMIT 1
    `,
    { workspace_id: workspaceId, id: scenarioId },
  );
}

export async function createVariationScenario(
  context: AppContext,
  input: {
    id: string;
    datasetId: string;
    parentScenarioId: string;
    displayName: string;
    mapAssetId: string | null;
    variationParams: Record<string, unknown>;
    draftJson: unknown;
  },
): Promise<void> {
  const params = {
    id: input.id,
    workspace_id: context.workspaceId,
    map_asset_id: input.mapAssetId,
    display_name: input.displayName,
    dataset_id: input.datasetId,
    parent_scenario_id: input.parentScenarioId,
    variation_params: input.variationParams,
    created_by_user_id: context.userId,
  };
  await withTransaction(async (tx) => {
    await tx.execute(
      `
        INSERT INTO scenarios (
          id,
          workspace_id,
          map_asset_id,
          display_name,
          status,
          dataset_id,
          parent_scenario_id,
          variation_params,
          created_by_user_id,
          created_at,
          updated_at
        )
        VALUES (
          :id,
          :workspace_id,
          :map_asset_id,
          :display_name,
          'draft',
          :dataset_id,
          :parent_scenario_id,
          :variation_params,
          :created_by_user_id,
          NOW(),
          NOW()
        )
      `,
      params,
    );
    await tx.execute(
      `
        UPDATE datasets
        SET stats_scenario_count = stats_scenario_count + 1,
            stats_updated_at = NOW()
        WHERE workspace_id = :workspace_id
          AND id = :dataset_id
      `,
      params,
    );
  });
}

export async function deleteScenarioForWorkspace(
  workspaceId: string,
  scenarioId: string,
) {
  await withTransaction(async (tx) => {
    const datasetRows = await tx.queryRows<{ dataset_id: string }>(
      `
        SELECT DISTINCT dataset_id
        FROM (
          SELECT dataset_id
          FROM scenarios
          WHERE workspace_id = :workspace_id
            AND id = :id
            AND dataset_id IS NOT NULL
          UNION ALL
          SELECT dataset_id
          FROM dataset_scenarios
          WHERE workspace_id = :workspace_id
            AND scenario_id = :id
        ) scenario_datasets
      `,
      {
        workspace_id: workspaceId,
        id: scenarioId,
      },
    );

    await tx.execute(
      `
        DELETE FROM artifacts
        WHERE workspace_id = :workspace_id
          AND scenario_id = :id
      `,
      {
        workspace_id: workspaceId,
        id: scenarioId,
      },
    );

    await tx.execute(
      `
        DELETE FROM scenarios
        WHERE workspace_id = :workspace_id
          AND id = :id
      `,
      {
        workspace_id: workspaceId,
        id: scenarioId,
      },
    );

    for (const row of datasetRows) {
      await tx.execute(
        `
          UPDATE datasets
          SET stats_scenario_count = GREATEST(0, stats_scenario_count - 1),
              stats_updated_at = NOW()
          WHERE workspace_id = :workspace_id
            AND id = :dataset_id
        `,
        {
          workspace_id: workspaceId,
          dataset_id: row.dataset_id,
        },
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Dataset-first scenario queries
// ---------------------------------------------------------------------------

export type DatasetScenarioRow = {
  id: string;
  display_name: string | null;
  description?: string | null;
  map_asset_id: string | null;
  map_name: string | null;
  backend_map_name: string | null;
  actor_count: number | null;
  dataset_id: string | null;
  dataset_role?: string | null;
  mutability?: string | null;
  copy_policy?: string | null;
  source_scenario_id?: string | null;
  /** Scenario this row is a generated/derived variation of (cross-map
   * variations record it in variation_params; in-map ones use
   * parent_scenario_id). Null for original scenarios. */
  variation_source_scenario_id?: string | null;
  runtime?: string | null;
  created_by_user_id?: string | null;
  created_by_user_name?: string | null;
  created_by_user_email?: string | null;
  updated_by_user_id?: string | null;
  updated_by_user_name?: string | null;
  updated_by_user_email?: string | null;
  updated_at?: string | null;
  source_kind: "native";
  created_at: string;
};

export type DatasetScenarioDraftRow = DatasetScenarioRow & {
  draft_json: string | null;
};

export type CreatedDatasetScenario = {
  id: string;
  description: string | null;
  map_asset_id: string | null;
  map_name: string | null;
  backend_map_name: string | null;
  created_by_user_id?: string | null;
  created_by_user_name?: string | null;
  created_by_user_email?: string | null;
  updated_by_user_id?: string | null;
  updated_by_user_name?: string | null;
  updated_by_user_email?: string | null;
  created_at: string;
  updated_at?: string | null;
};

export type MapTemplateScenarioRow = DatasetScenarioRow;

type DatasetScenarioPageRow = DatasetScenarioRow & {
  sort_order: number;
};

export type DatasetScenarioCursor = {
  sortOrder: number;
  createdAt: string;
  id: string;
};

export type DatasetScenarioPage = {
  scenarios: DatasetScenarioRow[];
  nextCursor: string | null;
};

export function encodeDatasetScenarioCursor(
  cursor: DatasetScenarioCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeDatasetScenarioCursor(
  value: string | null | undefined,
): DatasetScenarioCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<DatasetScenarioCursor>;
    if (
      typeof parsed.sortOrder !== "number" ||
      !Number.isInteger(parsed.sortOrder) ||
      typeof parsed.createdAt !== "string" ||
      !parsed.createdAt.trim() ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !parsed.id.trim()
    ) {
      return null;
    }
    return {
      sortOrder: parsed.sortOrder,
      createdAt: parsed.createdAt,
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

export async function listScenariosForDatasetPage(
  workspaceId: string,
  datasetId: string,
  options: {
    limit?: number;
    cursor?: DatasetScenarioCursor | null;
  } = {},
): Promise<DatasetScenarioPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursorClause = options.cursor
    ? `
        AND (
          COALESCE(ds.sort_order, 0),
          s.created_at,
          s.id
        ) > (
          :cursor_sort_order,
          CAST(:cursor_created_at AS TIMESTAMPTZ),
          :cursor_id
        )
      `
    : "";
  const rows = await queryRows<DatasetScenarioPageRow>(
    `
      SELECT
        s.id,
        s.display_name,
        s.description,
        s.map_asset_id,
        COALESCE(
          s.summary_map_name,
          NULLIF(BTRIM(ma.carla_map_name), ''),
          NULLIF(BTRIM(ma.name), '')
        ) AS map_name,
        COALESCE(
          s.summary_backend_map_name,
          NULLIF(BTRIM(ma.carla_map_name), ''),
          s.summary_map_name
        ) AS backend_map_name,
        COALESCE(s.summary_actor_count, 0) AS actor_count,
        COALESCE(s.dataset_id, ds.dataset_id) AS dataset_id,
        COALESCE(
          ds.role,
          CASE WHEN s.parent_scenario_id IS NOT NULL THEN 'variation' ELSE 'source' END
        ) AS dataset_role,
        s.mutability,
        s.copy_policy,
        s.source_scenario_id,
        COALESCE(
          NULLIF(BTRIM(s.variation_params->>'sourceScenarioId'), ''),
          s.parent_scenario_id
        ) AS variation_source_scenario_id,
        s.created_by_user_id,
        COALESCE(NULLIF(BTRIM(author.name), ''), NULLIF(BTRIM(author.email), '')) AS created_by_user_name,
        NULLIF(BTRIM(author.email), '') AS created_by_user_email,
        s.updated_by_user_id,
        COALESCE(NULLIF(BTRIM(editor.name), ''), NULLIF(BTRIM(editor.email), '')) AS updated_by_user_name,
        NULLIF(BTRIM(editor.email), '') AS updated_by_user_email,
        COALESCE(s.source_kind, 'native') AS source_kind,
        s.runtime,
        s.created_at::text AS created_at,
        s.updated_at::text AS updated_at,
        COALESCE(ds.sort_order, 0) AS sort_order
      FROM scenarios s
      LEFT JOIN dataset_scenarios ds
        ON ds.workspace_id = s.workspace_id
       AND ds.scenario_id = s.id
       AND ds.dataset_id = :dataset_id
      LEFT JOIN map_assets ma ON ma.id = s.map_asset_id
      LEFT JOIN ba_user author ON author.id = s.created_by_user_id
      LEFT JOIN ba_user editor ON editor.id = s.updated_by_user_id
      WHERE s.workspace_id = :workspace_id
        AND (s.dataset_id = :dataset_id OR ds.dataset_id = :dataset_id)
        ${cursorClause}
      ORDER BY COALESCE(ds.sort_order, 0) ASC, s.created_at ASC, s.id ASC
      LIMIT :row_limit
    `,
    {
      workspace_id: workspaceId,
      dataset_id: datasetId,
      row_limit: limit + 1,
      ...(options.cursor
        ? {
            cursor_sort_order: options.cursor.sortOrder,
            cursor_created_at: options.cursor.createdAt,
            cursor_id: options.cursor.id,
          }
        : {}),
    },
  );
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    scenarios: pageRows.map(({ sort_order: _sortOrder, ...scenario }) => scenario),
    nextCursor:
      hasMore && last
        ? encodeDatasetScenarioCursor({
            sortOrder: Number(last.sort_order),
            createdAt: last.created_at,
            id: last.id,
          })
        : null,
  };
}

export async function listScenariosForDataset(
  workspaceId: string,
  datasetId: string,
): Promise<DatasetScenarioRow[]> {
  return queryRows<DatasetScenarioRow>(
    `
      SELECT
        s.id,
        s.display_name,
        s.description,
        s.map_asset_id,
        COALESCE(
          NULLIF(BTRIM(s.draft_json::jsonb->'setup'->'map'->>'mapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->'metadata'->>'mapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->>'map_name'), ''),
          NULLIF(BTRIM(ma.carla_map_name), ''),
          NULLIF(BTRIM(ma.name), '')
        ) AS map_name,
        COALESCE(
          NULLIF(BTRIM(s.draft_json::jsonb->'setup'->'map'->>'backendMapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->'metadata'->>'backendMapName'), ''),
          NULLIF(BTRIM(ma.carla_map_name), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->>'map_name'), '')
        ) AS backend_map_name,
        CASE
          WHEN jsonb_typeof(COALESCE(s.draft_json::jsonb->'setup'->'scene'->'actors', s.draft_json::jsonb->'actors', '[]'::jsonb)) = 'array'
            THEN jsonb_array_length(COALESCE(s.draft_json::jsonb->'setup'->'scene'->'actors', s.draft_json::jsonb->'actors', '[]'::jsonb))
          ELSE 0
        END AS actor_count,
        COALESCE(s.dataset_id, ds.dataset_id) AS dataset_id,
        COALESCE(
          ds.role,
          CASE WHEN s.parent_scenario_id IS NOT NULL THEN 'variation' ELSE 'source' END
        ) AS dataset_role,
        s.mutability,
        s.copy_policy,
        s.source_scenario_id,
        s.created_by_user_id,
        COALESCE(
          NULLIF(BTRIM(author.name), ''),
          NULLIF(BTRIM(author.email), '')
        ) AS created_by_user_name,
        NULLIF(BTRIM(author.email), '') AS created_by_user_email,
        s.updated_by_user_id,
        COALESCE(
          NULLIF(BTRIM(editor.name), ''),
          NULLIF(BTRIM(editor.email), '')
        ) AS updated_by_user_name,
        NULLIF(BTRIM(editor.email), '') AS updated_by_user_email,
        COALESCE(s.source_kind, 'native') AS source_kind,
        s.runtime,
        s.created_at::text AS created_at,
        s.updated_at::text AS updated_at
      FROM scenarios s
      LEFT JOIN dataset_scenarios ds
        ON ds.workspace_id = s.workspace_id
       AND ds.scenario_id = s.id
       AND ds.dataset_id = :dataset_id
      LEFT JOIN map_assets ma
        ON ma.id = s.map_asset_id
      LEFT JOIN ba_user author
        ON author.id = s.created_by_user_id
      LEFT JOIN ba_user editor
        ON editor.id = s.updated_by_user_id
      WHERE s.workspace_id = :workspace_id
        AND (
          s.dataset_id = :dataset_id
          OR ds.dataset_id = :dataset_id
        )
      ORDER BY COALESCE(ds.sort_order, 0) ASC, s.created_at ASC
    `,
    { workspace_id: workspaceId, dataset_id: datasetId },
  );
}

export async function getScenarioForDataset(
  workspaceId: string,
  datasetId: string,
  scenarioId: string,
): Promise<DatasetScenarioRow | null> {
  return queryOne<DatasetScenarioRow>(
    `
      SELECT
        s.id,
        s.display_name,
        s.description,
        s.map_asset_id,
        COALESCE(
          NULLIF(BTRIM(s.draft_json::jsonb->'setup'->'map'->>'mapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->'metadata'->>'mapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->>'map_name'), ''),
          NULLIF(BTRIM(ma.carla_map_name), ''),
          NULLIF(BTRIM(ma.name), '')
        ) AS map_name,
        COALESCE(
          NULLIF(BTRIM(s.draft_json::jsonb->'setup'->'map'->>'backendMapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->'metadata'->>'backendMapName'), ''),
          NULLIF(BTRIM(ma.carla_map_name), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->>'map_name'), '')
        ) AS backend_map_name,
        CASE
          WHEN jsonb_typeof(COALESCE(s.draft_json::jsonb->'setup'->'scene'->'actors', s.draft_json::jsonb->'actors', '[]'::jsonb)) = 'array'
            THEN jsonb_array_length(COALESCE(s.draft_json::jsonb->'setup'->'scene'->'actors', s.draft_json::jsonb->'actors', '[]'::jsonb))
          ELSE 0
        END AS actor_count,
        COALESCE(s.dataset_id, ds.dataset_id) AS dataset_id,
        COALESCE(
          ds.role,
          CASE WHEN s.parent_scenario_id IS NOT NULL THEN 'variation' ELSE 'source' END
        ) AS dataset_role,
        s.mutability,
        s.copy_policy,
        s.source_scenario_id,
        s.created_by_user_id,
        COALESCE(
          NULLIF(BTRIM(author.name), ''),
          NULLIF(BTRIM(author.email), '')
        ) AS created_by_user_name,
        NULLIF(BTRIM(author.email), '') AS created_by_user_email,
        s.updated_by_user_id,
        COALESCE(
          NULLIF(BTRIM(editor.name), ''),
          NULLIF(BTRIM(editor.email), '')
        ) AS updated_by_user_name,
        NULLIF(BTRIM(editor.email), '') AS updated_by_user_email,
        COALESCE(s.source_kind, 'native') AS source_kind,
        s.runtime,
        s.created_at::text AS created_at,
        s.updated_at::text AS updated_at
      FROM scenarios s
      LEFT JOIN dataset_scenarios ds
        ON ds.workspace_id = s.workspace_id
       AND ds.scenario_id = s.id
       AND ds.dataset_id = :dataset_id
      LEFT JOIN map_assets ma
        ON ma.id = s.map_asset_id
      LEFT JOIN ba_user author
        ON author.id = s.created_by_user_id
      LEFT JOIN ba_user editor
        ON editor.id = s.updated_by_user_id
      WHERE s.workspace_id = :workspace_id
        AND s.id = :scenario_id
        AND (
          s.dataset_id = :dataset_id
          OR ds.dataset_id = :dataset_id
        )
      LIMIT 1
    `,
    {
      workspace_id: workspaceId,
      dataset_id: datasetId,
      scenario_id: scenarioId,
    },
  );
}

export async function getScenarioDraftForDataset(
  workspaceId: string,
  datasetId: string,
  scenarioId: string,
): Promise<DatasetScenarioDraftRow | null> {
  return queryOne<DatasetScenarioDraftRow>(
    `
      SELECT
        s.id,
        s.display_name,
        s.description,
        s.map_asset_id,
        COALESCE(
          NULLIF(BTRIM(s.draft_json::jsonb->'setup'->'map'->>'mapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->'metadata'->>'mapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->>'map_name'), ''),
          NULLIF(BTRIM(ma.carla_map_name), ''),
          NULLIF(BTRIM(ma.name), '')
        ) AS map_name,
        COALESCE(
          NULLIF(BTRIM(s.draft_json::jsonb->'setup'->'map'->>'backendMapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->'metadata'->>'backendMapName'), ''),
          NULLIF(BTRIM(ma.carla_map_name), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->>'map_name'), '')
        ) AS backend_map_name,
        CASE
          WHEN jsonb_typeof(COALESCE(s.draft_json::jsonb->'setup'->'scene'->'actors', s.draft_json::jsonb->'actors', '[]'::jsonb)) = 'array'
            THEN jsonb_array_length(COALESCE(s.draft_json::jsonb->'setup'->'scene'->'actors', s.draft_json::jsonb->'actors', '[]'::jsonb))
          ELSE 0
        END AS actor_count,
        COALESCE(s.dataset_id, ds.dataset_id) AS dataset_id,
        COALESCE(
          ds.role,
          CASE WHEN s.parent_scenario_id IS NOT NULL THEN 'variation' ELSE 'source' END
        ) AS dataset_role,
        s.mutability,
        s.copy_policy,
        s.source_scenario_id,
        s.created_by_user_id,
        COALESCE(
          NULLIF(BTRIM(author.name), ''),
          NULLIF(BTRIM(author.email), '')
        ) AS created_by_user_name,
        NULLIF(BTRIM(author.email), '') AS created_by_user_email,
        s.updated_by_user_id,
        COALESCE(
          NULLIF(BTRIM(editor.name), ''),
          NULLIF(BTRIM(editor.email), '')
        ) AS updated_by_user_name,
        NULLIF(BTRIM(editor.email), '') AS updated_by_user_email,
        COALESCE(s.source_kind, 'native') AS source_kind,
        s.created_at::text AS created_at,
        s.updated_at::text AS updated_at,
        s.draft_json::text AS draft_json
      FROM scenarios s
      LEFT JOIN dataset_scenarios ds
        ON ds.workspace_id = s.workspace_id
       AND ds.scenario_id = s.id
       AND ds.dataset_id = :dataset_id
      LEFT JOIN map_assets ma
        ON ma.id = s.map_asset_id
      LEFT JOIN ba_user author
        ON author.id = s.created_by_user_id
      LEFT JOIN ba_user editor
        ON editor.id = s.updated_by_user_id
      WHERE s.workspace_id = :workspace_id
        AND s.id = :scenario_id
        AND (
          s.dataset_id = :dataset_id
          OR ds.dataset_id = :dataset_id
        )
      LIMIT 1
    `,
    {
      workspace_id: workspaceId,
      dataset_id: datasetId,
      scenario_id: scenarioId,
    },
  );
}

export async function listTemplateScenariosForMap(input: {
  mapAssetId?: string | null;
  mapName?: string | null;
  assetName?: string | null;
}): Promise<MapTemplateScenarioRow[]> {
  return queryRows<MapTemplateScenarioRow>(
    `
      SELECT
        s.id,
        s.display_name,
        s.description,
        s.map_asset_id,
        COALESCE(
          NULLIF(BTRIM(s.draft_json::jsonb->'setup'->'map'->>'mapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->'metadata'->>'mapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->>'map_name'), ''),
          NULLIF(BTRIM(ma.carla_map_name), ''),
          NULLIF(BTRIM(ma.name), '')
        ) AS map_name,
        COALESCE(
          NULLIF(BTRIM(s.draft_json::jsonb->'setup'->'map'->>'backendMapName'), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->'metadata'->>'backendMapName'), ''),
          NULLIF(BTRIM(ma.carla_map_name), ''),
          NULLIF(BTRIM(s.draft_json::jsonb->>'map_name'), '')
        ) AS backend_map_name,
        CASE
          WHEN jsonb_typeof(COALESCE(s.draft_json::jsonb->'setup'->'scene'->'actors', s.draft_json::jsonb->'actors', '[]'::jsonb)) = 'array'
            THEN jsonb_array_length(COALESCE(s.draft_json::jsonb->'setup'->'scene'->'actors', s.draft_json::jsonb->'actors', '[]'::jsonb))
          ELSE 0
        END AS actor_count,
        s.dataset_id,
        s.mutability,
        s.copy_policy,
        s.source_scenario_id,
        COALESCE(s.source_kind, 'native') AS source_kind,
        s.created_at::text AS created_at
      FROM scenarios s
      LEFT JOIN map_assets ma
        ON ma.id = s.map_asset_id
      WHERE s.workspace_id = :workspace_id
        AND s.dataset_id = :dataset_id
        AND (
          -- PGlite: untyped parameter in IS NOT NULL
          (CAST(:map_asset_id AS TEXT) IS NOT NULL AND s.map_asset_id = :map_asset_id)
          OR (
            COALESCE(
              NULLIF(BTRIM(s.draft_json::jsonb->'setup'->'map'->>'backendMapName'), ''),
              NULLIF(BTRIM(s.draft_json::jsonb->'metadata'->>'backendMapName'), ''),
              NULLIF(BTRIM(ma.carla_map_name), ''),
              NULLIF(BTRIM(s.draft_json::jsonb->>'map_name'), ''),
              NULLIF(BTRIM(ma.name), '')
            ) IN (:map_name, :asset_name)
          )
          OR (
            COALESCE(
              NULLIF(BTRIM(s.draft_json::jsonb->'setup'->'map'->>'mapName'), ''),
              NULLIF(BTRIM(s.draft_json::jsonb->'metadata'->>'mapName'), ''),
              NULLIF(BTRIM(s.draft_json::jsonb->>'map_name'), ''),
              NULLIF(BTRIM(ma.carla_map_name), ''),
              NULLIF(BTRIM(ma.name), '')
            ) IN (:map_name, :asset_name)
          )
        )
      ORDER BY s.created_at ASC
    `,
    {
      workspace_id: SYSTEM_GLOBAL_WORKSPACE_ID,
      dataset_id: TEMPLATE_SCENARIOS_DATASET_ID,
      map_asset_id: input.mapAssetId ?? null,
      map_name: input.mapName ?? null,
      asset_name: input.assetName ?? null,
    },
  );
}

export async function createDatasetScenario(
  context: AppContext,
  datasetId: string,
  input: {
    mapAssetId?: string | null;
    mapName?: string | null;
    runtime?: CarlaRuntime;
    displayName: string;
    variationParams?: Record<string, unknown> | null;
    draftTransform?: (draft: NormalizedScenarioDraft) => NormalizedScenarioDraft;
  },
): Promise<CreatedDatasetScenario> {
  const id = datasetScenarioId();
  const now = new Date().toISOString();
  const runtime = normalizeCarlaRuntime(input.runtime);
  const mapReference = await resolveScenarioMapReference({
    mapAssetId: input.mapAssetId ?? null,
    mapName: input.mapName ?? null,
    runtime,
  });
  const initialDraft = await buildInitialScenarioDraft({
    scenarioId: id,
    mapReference,
    runtime,
    createdAt: now,
    updatedAt: now,
  });
  const normalizedDraft = input.draftTransform
    ? input.draftTransform(initialDraft.normalizedDraft)
    : initialDraft.normalizedDraft;
  const draft = input.draftTransform
    ? toPersistedScenarioSetupDraft(normalizedDraft, null, {
        scenarioId: id,
        mapAssetId: mapReference.mapAssetId,
        backendMapName: mapReference.backendMapName,
        createdAt: now,
        updatedAt: now,
      })
    : initialDraft.draft;

  const params = {
    id,
    workspace_id: context.workspaceId,
    map_asset_id: mapReference.mapAssetId,
    display_name: input.displayName,
    dataset_id: datasetId,
    runtime,
    draft_json: draft,
    variation_params: input.variationParams ?? null,
    created_by_user_id: context.userId,
  };
  await withTransaction(async (tx) => {
    await tx.execute(
      `
        INSERT INTO scenarios (
          id,
          workspace_id,
          map_asset_id,
          display_name,
          status,
          runtime,
          dataset_id,
          variation_params,
          draft_json,
          created_by_user_id,
          updated_by_user_id,
          created_at,
          updated_at
        )
        VALUES (
          :id,
          :workspace_id,
          :map_asset_id,
          :display_name,
          'draft',
          :runtime,
          :dataset_id,
          :variation_params::jsonb,
          :draft_json::jsonb,
          :created_by_user_id,
          :created_by_user_id,
          NOW(),
          NOW()
        )
      `,
      params,
    );
    await tx.execute(
      `
        UPDATE datasets
        SET stats_scenario_count = stats_scenario_count + 1,
            stats_updated_at = NOW()
        WHERE workspace_id = :workspace_id
          AND id = :dataset_id
      `,
      params,
    );
  });

  return {
    id,
    description: null,
    map_asset_id: mapReference.mapAssetId,
    map_name: normalizedDraft.mapName || null,
    backend_map_name: mapReference.backendMapName,
    created_by_user_id: context.userId,
    created_by_user_name:
      context.session.name?.trim() || context.session.email?.trim() || null,
    created_by_user_email: context.session.email?.trim() || null,
    updated_by_user_id: context.userId,
    updated_by_user_name:
      context.session.name?.trim() || context.session.email?.trim() || null,
    updated_by_user_email: context.session.email?.trim() || null,
    created_at: now,
    updated_at: now,
  };
}
