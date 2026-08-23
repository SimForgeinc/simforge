import { execute, queryOne } from "./data-api";

export type DatasetCompileReadinessResponse = {
  dataset_id: string;
  summary: {
    total: number;
    rendered: number;
    cosmosed: number;
    vlmed: number;
  };
  scenarios: {
    id: string;
    display_name: string | null | undefined;
    has_render: boolean;
    has_cosmos: boolean;
    has_vlm: boolean;
  }[];
};

type CacheRow = {
  response_json: string | null;
  generated_at: string;
  expires_at: string;
};

export type DatasetCompileReadinessCacheEntry = {
  response: DatasetCompileReadinessResponse;
  generatedAt: string;
  expiresAt: string;
};

export function isDatasetCompileReadinessCacheUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("dataset_compile_readiness_cache") &&
    (message.includes("does not exist") ||
      message.includes("relation") ||
      message.includes("42P01"))
  );
}

function parseResponseJson(raw: string | null): DatasetCompileReadinessResponse | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DatasetCompileReadinessResponse;
    if (!parsed?.dataset_id || !parsed.summary || !Array.isArray(parsed.scenarios)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function getDatasetCompileReadinessCache(
  workspaceId: string,
  datasetId: string,
): Promise<DatasetCompileReadinessCacheEntry | null> {
  const row = await queryOne<CacheRow>(
    `
      SELECT
        response_json::text AS response_json,
        generated_at::text AS generated_at,
        expires_at::text AS expires_at
      FROM dataset_compile_readiness_cache
      WHERE workspace_id = :workspace_id
        AND dataset_id = :dataset_id
        AND expires_at > NOW()
      LIMIT 1
    `,
    { workspace_id: workspaceId, dataset_id: datasetId },
  );
  const response = parseResponseJson(row?.response_json ?? null);
  if (!row || !response) return null;
  return {
    response,
    generatedAt: row.generated_at,
    expiresAt: row.expires_at,
  };
}

export async function upsertDatasetCompileReadinessCache(input: {
  workspaceId: string;
  datasetId: string;
  response: DatasetCompileReadinessResponse;
  ttlSeconds: number;
  reason: "miss" | "refresh";
}) {
  await execute(
    `
      INSERT INTO dataset_compile_readiness_cache (
        workspace_id,
        dataset_id,
        response_json,
        generated_at,
        expires_at,
        last_refresh_reason,
        updated_at
      )
      VALUES (
        :workspace_id,
        :dataset_id,
        CAST(:response_json AS JSONB),
        NOW(),
        NOW() + (:ttl_seconds * INTERVAL '1 second'),
        :last_refresh_reason,
        NOW()
      )
      ON CONFLICT (workspace_id, dataset_id)
      DO UPDATE SET
        response_json = EXCLUDED.response_json,
        generated_at = EXCLUDED.generated_at,
        expires_at = EXCLUDED.expires_at,
        last_refresh_reason = EXCLUDED.last_refresh_reason,
        updated_at = NOW()
    `,
    {
      workspace_id: input.workspaceId,
      dataset_id: input.datasetId,
      response_json: JSON.stringify(input.response),
      ttl_seconds: input.ttlSeconds,
      last_refresh_reason: input.reason,
    },
  );
}
