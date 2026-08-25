import type { AppContext } from "../db/app-context";
import { queryOne, queryRows, withTransaction } from "../db/data-api";
import { modelEndpointId, modelVersionId } from "../db/ids";
import {
  ModelEndpointDescriptorSchema,
  type CreateModelEndpointInput,
  type CreateModelVersionInput,
  type ModelEndpointDescriptor,
  type ModelEndpointRecord,
  type ModelVersionRecord,
} from "./contracts";

type VersionRow = {
  id: string;
  family: string;
  name: string;
  source: string;
  checkpoint_digest: string;
  quant: string;
  license: string;
  status: string;
  promoted_run_id: string | null;
  created_at: string;
  updated_at: string;
};

type EndpointRow = {
  id: string;
  model_version_id: string;
  name: string;
  kind: "process" | "socket";
  command_json: unknown;
  cwd: string | null;
  env_json: Record<string, string>;
  socket_path: string | null;
  health_json: Record<string, unknown>;
  invoke_json: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
};

function versionRecord(row: VersionRow): ModelVersionRecord {
  return {
    id: row.id,
    family: row.family,
    name: row.name,
    source: row.source,
    checkpointDigest: row.checkpoint_digest,
    quant: row.quant,
    license: row.license,
    status: row.status,
    promotedRunId: row.promoted_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Re-assemble the split endpoint columns into the descriptor the worker consumes. */
export function endpointDescriptorOfRow(row: EndpointRow): ModelEndpointDescriptor {
  const shared = { health: row.health_json, invoke: row.invoke_json };
  const raw = row.kind === "process"
    ? {
      kind: "process",
      cmd: row.command_json,
      ...(row.cwd ? { cwd: row.cwd } : {}),
      env: row.env_json,
      ...(row.socket_path ? { socketPath: row.socket_path } : {}),
      ...shared,
    }
    : { kind: "socket", socketPath: row.socket_path, ...shared };
  return ModelEndpointDescriptorSchema.parse(raw);
}

function endpointRecord(row: EndpointRow): ModelEndpointRecord {
  return {
    id: row.id,
    modelVersionId: row.model_version_id,
    name: row.name,
    kind: row.kind,
    descriptor: endpointDescriptorOfRow(row),
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /duplicate key value|unique constraint/i.test(error.message);
}

export async function createModelVersion(
  context: AppContext,
  input: CreateModelVersionInput,
): Promise<{ kind: "created"; version: ModelVersionRecord } | { kind: "conflict" }> {
  const id = modelVersionId();
  try {
    const row = await queryOne<VersionRow>(
      `INSERT INTO simforge.model_versions
         (id, workspace_id, family, name, source, checkpoint_digest, quant, license)
       VALUES (:id, :workspace_id, :family, :name, :source, :checkpoint_digest, :quant, :license)
       RETURNING *`,
      {
        id,
        workspace_id: context.workspaceId,
        family: input.family,
        name: input.name,
        source: input.source,
        checkpoint_digest: input.checkpointDigest,
        quant: input.quant,
        license: input.license,
      },
    );
    return { kind: "created", version: versionRecord(row!) };
  } catch (error) {
    if (isUniqueViolation(error)) return { kind: "conflict" };
    throw error;
  }
}

export async function listModelVersions(context: AppContext): Promise<ModelVersionRecord[]> {
  const rows = await queryRows<VersionRow>(
    `SELECT * FROM simforge.model_versions
     WHERE workspace_id = :workspace_id
     ORDER BY created_at DESC, id`,
    { workspace_id: context.workspaceId },
  );
  return rows.map(versionRecord);
}

export async function getModelVersion(
  context: AppContext,
  versionId: string,
): Promise<{ version: ModelVersionRecord; endpoints: ModelEndpointRecord[] } | null> {
  const row = await queryOne<VersionRow>(
    `SELECT * FROM simforge.model_versions WHERE id = :id AND workspace_id = :workspace_id`,
    { id: versionId, workspace_id: context.workspaceId },
  );
  if (!row) return null;
  const endpoints = await queryRows<EndpointRow>(
    `SELECT * FROM simforge.model_endpoints
     WHERE model_version_id = :id AND workspace_id = :workspace_id
     ORDER BY created_at, id`,
    { id: versionId, workspace_id: context.workspaceId },
  );
  return { version: versionRecord(row), endpoints: endpoints.map(endpointRecord) };
}

/**
 * Promote a version. The `simforge_model_versions_promotion_evidence` trigger
 * is the actual gate: the referenced run must be a SUCCEEDED openloop or
 * policy_episode run of this same version.
 */
export async function promoteModelVersion(
  context: AppContext,
  versionId: string,
  runId: string,
): Promise<
  | { kind: "promoted"; version: ModelVersionRecord }
  | { kind: "not_found" }
  | { kind: "invalid_promotion"; message: string }
> {
  try {
    return await withTransaction(async (tx) => {
      const row = await tx.queryOne<VersionRow>(
        `UPDATE simforge.model_versions
         SET status = 'promoted', promoted_run_id = :run_id, updated_at = NOW()
         WHERE id = :id AND workspace_id = :workspace_id
         RETURNING *`,
        { id: versionId, workspace_id: context.workspaceId, run_id: runId },
      );
      if (!row) return { kind: "not_found" as const };
      return { kind: "promoted" as const, version: versionRecord(row) };
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("model_version_promotion")) {
      return { kind: "invalid_promotion", message: error.message };
    }
    throw error;
  }
}

export async function createModelEndpoint(
  context: AppContext,
  input: CreateModelEndpointInput,
): Promise<
  | { kind: "created"; endpoint: ModelEndpointRecord }
  | { kind: "version_not_found" }
  | { kind: "conflict" }
> {
  const descriptor = input.descriptor;
  const id = modelEndpointId();
  try {
    return await withTransaction(async (tx) => {
      const version = await tx.queryOne<{ id: string }>(
        `SELECT id FROM simforge.model_versions WHERE id = :id AND workspace_id = :workspace_id`,
        { id: input.modelVersionId, workspace_id: context.workspaceId },
      );
      if (!version) return { kind: "version_not_found" as const };
      const row = await tx.queryOne<EndpointRow>(
        `INSERT INTO simforge.model_endpoints
           (id, workspace_id, model_version_id, name, kind, command_json, cwd, env_json,
            socket_path, health_json, invoke_json)
         VALUES (:id, :workspace_id, :model_version_id, :name, :kind, :command_json, :cwd,
            :env_json, :socket_path, :health_json, :invoke_json)
         RETURNING *`,
        {
          id,
          workspace_id: context.workspaceId,
          model_version_id: input.modelVersionId,
          name: input.name,
          kind: descriptor.kind,
          command_json: descriptor.kind === "process" ? descriptor.cmd : null,
          cwd: descriptor.kind === "process" ? descriptor.cwd ?? null : null,
          env_json: descriptor.kind === "process" ? descriptor.env : {},
          socket_path: descriptor.socketPath ?? null,
          health_json: descriptor.health,
          invoke_json: descriptor.invoke,
        },
      );
      return { kind: "created" as const, endpoint: endpointRecord(row!) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { kind: "conflict" };
    throw error;
  }
}

export async function listModelEndpoints(
  context: AppContext,
  filter: { modelVersionId?: string } = {},
): Promise<ModelEndpointRecord[]> {
  const rows = await queryRows<EndpointRow>(
    `SELECT * FROM simforge.model_endpoints
     WHERE workspace_id = :workspace_id
       AND (:model_version_id::TEXT IS NULL OR model_version_id = :model_version_id)
     ORDER BY created_at, id`,
    { workspace_id: context.workspaceId, model_version_id: filter.modelVersionId ?? null },
  );
  return rows.map(endpointRecord);
}
