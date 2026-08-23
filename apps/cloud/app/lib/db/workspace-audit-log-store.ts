import { execute, queryRows } from "./data-api";
import { workspaceAuditLogId } from "./ids";

export type WorkspaceAuditAction =
  | "workspace.updated"
  | "workspace.deleted"
  | "workspace_member.role_changed"
  | "workspace_member.removed"
  | "workspace_invitation.created"
  | "workspace_invitation.revoked"
  | "deployment.created"
  | "deployment.draft"
  | "deployment.active"
  | "deployment.degraded"
  | "deployment.paused"
  | "deployment.archived"
  | "deployment_camera.upserted"
  | "camera_calibration.upserted"
  | "deployment_incident.ingested"
  | "deployment_incident.verify"
  | "deployment_incident.reject"
  | "deployment_incident.resolve"
  | "traffic_metric.ingested"
  | "billing.refunded"
  | "billing.manual_adjustment"
  | "artifact.trash_created"
  | "artifact.restored"
  | "artifact.storage_policy_updated";

export type WorkspaceAuditLogRecord = {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export async function recordWorkspaceAuditLog(input: {
  workspaceId: string;
  actorUserId?: string | null;
  action: WorkspaceAuditAction;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const id = workspaceAuditLogId();
  await execute(
    `
      INSERT INTO workspace_audit_logs (
        id, workspace_id, actor_user_id, action, target_type, target_id,
        metadata_json, created_at
      )
      VALUES (
        :id, :workspace_id, :actor_user_id, :action, :target_type, :target_id,
        :metadata_json::jsonb, NOW()
      )
    `,
    {
      id,
      workspace_id: input.workspaceId,
      actor_user_id: input.actorUserId ?? null,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId ?? null,
      metadata_json: input.metadata ?? {},
    },
  );
  return id;
}

export async function listWorkspaceAuditLogs(
  workspaceId: string,
  limit = 100,
): Promise<WorkspaceAuditLogRecord[]> {
  return queryRows<WorkspaceAuditLogRecord>(
    `
      SELECT
        id,
        workspace_id AS "workspaceId",
        actor_user_id AS "actorUserId",
        action,
        target_type AS "targetType",
        target_id AS "targetId",
        COALESCE(metadata_json, '{}'::jsonb) AS metadata,
        created_at::text AS "createdAt"
      FROM workspace_audit_logs
      WHERE workspace_id = :workspace_id
      ORDER BY created_at DESC
      LIMIT :limit
    `,
    { workspace_id: workspaceId, limit },
  );
}
