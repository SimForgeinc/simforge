import { execute, queryOne, queryRows, withTransaction } from "./data-api";
import { DEFAULT_WORKSPACE_CREDITS_CENTS } from "@simcloud/shared";
import {
  provisionAppContextForWorkspaceAccess,
  provisionDefaultAppContextForUser,
} from "./app-context";
import {
  invitationId,
  invitationTokenId,
  organizationIdForWorkspace,
  organizationMemberId,
  projectId,
  teamWorkspaceId,
} from "./ids";
import { recordWorkspaceAuditLog } from "./workspace-audit-log-store";

const BILLING_DEDUCTION_FAILED_AUDIT_ACTION =
  "billing.deduction_failed" as Parameters<typeof recordWorkspaceAuditLog>[0]["action"];

// --- Types ---

export type Workspace = {
  id: string;
  type: string;
  slug: string;
  name: string;
  creditsBalance: number;
  createdByUserId: string | null;
  createdAt: string;
};

export type WorkspaceMember = {
  userId: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
};

export type WorkspaceInvitation = {
  id: string;
  email: string;
  role: string;
  invitedByUserId: string | null;
  token: string;
  status: string;
  createdAt: string;
  expiresAt: string;
};

type WorkspaceRole = "owner" | "admin" | "member";

const ROLE_HIERARCHY: Record<string, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

async function findWorkspaceRole(userId: string, workspaceId: string) {
  return queryOne<{ role: string }>(
    `SELECT m.role
       FROM workspaces w
       JOIN ba_member m ON m."organizationId" = w.auth_organization_id
      WHERE w.id = :workspaceId
        AND m."userId" = :userId
        AND w.deleted_at IS NULL`,
    { workspaceId, userId },
  );
}

async function organizationIdForWorkspaceRow(workspaceId: string) {
  const row = await queryOne<{ organizationId: string }>(
    `SELECT auth_organization_id AS "organizationId"
       FROM workspaces
      WHERE id = :workspaceId
        AND deleted_at IS NULL`,
    { workspaceId },
  );
  if (!row?.organizationId) throw new Error("Workspace not found");
  return row.organizationId;
}

// --- Role validation middleware ---

export async function requireWorkspaceRole(
  userId: string,
  workspaceId: string,
  minimumRole: WorkspaceRole,
): Promise<string> {
  let row = await findWorkspaceRole(userId, workspaceId);

  if (!row) {
    await provisionAppContextForWorkspaceAccess(userId, workspaceId);
    row = await findWorkspaceRole(userId, workspaceId);
  }

  if (!row) {
    throw new Error("Not a member of this workspace");
  }

  const userLevel = ROLE_HIERARCHY[row.role] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[minimumRole] ?? 0;

  if (userLevel < requiredLevel) {
    throw new Error(`Requires ${minimumRole} role or higher`);
  }

  return row.role;
}

// --- Workspace CRUD ---

export async function listWorkspacesForUser(userId: string): Promise<Workspace[]> {
  let workspaces = await queryRows<Workspace>(
    `SELECT w.id, w.type, w.slug, w.name,
            w.credits_balance AS "creditsBalance",
            w.created_by_user_id AS "createdByUserId",
            w.created_at::text AS "createdAt"
     FROM workspaces w
     JOIN ba_member m ON m."organizationId" = w.auth_organization_id
     WHERE m."userId" = :userId AND w.deleted_at IS NULL
     ORDER BY w.type ASC, w.created_at ASC`,
    { userId },
  );
  if (workspaces.length === 0) {
    await provisionDefaultAppContextForUser(userId);
    workspaces = await queryRows<Workspace>(
      `SELECT w.id, w.type, w.slug, w.name,
              w.credits_balance AS "creditsBalance",
              w.created_by_user_id AS "createdByUserId",
              w.created_at::text AS "createdAt"
       FROM workspaces w
       JOIN ba_member m ON m."organizationId" = w.auth_organization_id
       WHERE m."userId" = :userId AND w.deleted_at IS NULL
       ORDER BY w.type ASC, w.created_at ASC`,
      { userId },
    );
  }
  return workspaces;
}

export async function createTeamWorkspace(
  userId: string,
  name: string,
  slug: string,
): Promise<Workspace> {
  const wsId = teamWorkspaceId();
  const orgId = organizationIdForWorkspace(wsId);
  const defaultProjId = projectId();

  return withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO ba_organization (id, name, slug, metadata, "createdAt", "updatedAt")
       VALUES (:id, :name, :slug, CAST(:metadata AS jsonb)::text, NOW(), NOW())`,
      {
        id: orgId,
        name,
        slug,
        metadata: { workspaceId: wsId, source: "workspace-create" },
      },
    );

    await tx.execute(
      `INSERT INTO workspaces (id, type, slug, name, credits_balance, created_by_user_id, auth_organization_id)
       VALUES (:id, 'team', :slug, :name, :creditsBalance, :userId, :organizationId)`,
      {
        id: wsId,
        slug,
        name,
        creditsBalance: DEFAULT_WORKSPACE_CREDITS_CENTS,
        userId,
        organizationId: orgId,
      },
    );

    await tx.execute(
      `INSERT INTO ba_member (id, "organizationId", "userId", role, "createdAt")
       VALUES (:id, :organizationId, :userId, 'owner', NOW())`,
      { id: organizationMemberId(orgId, userId), organizationId: orgId, userId },
    );

    await tx.execute(
      `INSERT INTO projects (id, workspace_id, name, description, is_default, created_by_user_id)
       VALUES (:id, :workspaceId, 'Default', 'Default project', TRUE, :userId)`,
      { id: defaultProjId, workspaceId: wsId, userId },
    );

    return {
      id: wsId,
      type: "team",
      slug,
      name,
      creditsBalance: DEFAULT_WORKSPACE_CREDITS_CENTS,
      createdByUserId: userId,
      createdAt: new Date().toISOString(),
    };
  });
}

export async function updateWorkspace(
  workspaceId: string,
  updates: { name?: string },
  actorUserId?: string | null,
): Promise<void> {
  if (updates.name) {
    await execute(
      `UPDATE workspaces SET name = :name, updated_at = now()
       WHERE id = :workspaceId AND deleted_at IS NULL`,
      { name: updates.name, workspaceId },
    );
    await execute(
      `UPDATE ba_organization
          SET name = :name,
              "updatedAt" = NOW()
        WHERE id = (
          SELECT auth_organization_id FROM workspaces WHERE id = :workspaceId
        )`,
      { name: updates.name, workspaceId },
    );
    await recordWorkspaceAuditLog({
      workspaceId,
      actorUserId,
      action: "workspace.updated",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: { fields: ["name"] },
    });
  }
}

export async function softDeleteWorkspace(
  workspaceId: string,
  actorUserId?: string | null,
): Promise<void> {
  const ws = await queryOne<{ type: string }>(
    `SELECT type FROM workspaces WHERE id = :workspaceId AND deleted_at IS NULL`,
    { workspaceId },
  );

  if (!ws) throw new Error("Workspace not found");
  if (ws.type === "personal") throw new Error("Cannot delete personal workspace");

  const inFlight = await queryOne<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM uniscenario.operational_jobs
     WHERE workspace_id = :workspaceId AND status IN ('queued', 'running')`,
    { workspaceId },
  );

  if (inFlight && inFlight.cnt > 0) {
    throw new Error("Cannot delete workspace with in-flight simulations");
  }

  await execute(
    `UPDATE workspaces SET deleted_at = now(), updated_at = now()
     WHERE id = :workspaceId`,
    { workspaceId },
  );
  await recordWorkspaceAuditLog({
    workspaceId,
    actorUserId,
    action: "workspace.deleted",
    targetType: "workspace",
    targetId: workspaceId,
    metadata: { type: ws.type },
  });
}

export async function getWorkspaceCreditsBalance(workspaceId: string): Promise<number> {
  const row = await queryOne<{ credits_balance: number }>(
    `SELECT credits_balance FROM workspaces WHERE id = :workspaceId AND deleted_at IS NULL`,
    { workspaceId },
  );
  return row?.credits_balance ?? 0;
}

export type WorkspaceCreditSummary = {
  creditsBalance: number;
  pendingCreditsCents: number;
  availableCreditsCents: number;
};

type BillingLedgerRow = {
  id: string;
  status: "pending" | "settled" | "released";
  reserved_cents: number;
  amount_cents: number;
  metadata_json: Record<string, unknown> | null;
};

function normalizeCreditAmount(amountCents: number, label: string) {
  const amount = Math.trunc(amountCents);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return amount;
}

export async function getWorkspaceCreditSummary(
  workspaceId: string,
): Promise<WorkspaceCreditSummary> {
  const row = await queryOne<{
    credits_balance: number;
    pending_credits_cents: number;
  }>(
    `SELECT w.credits_balance,
            COALESCE((
              SELECT SUM(bl.reserved_cents)
              FROM billing_ledger bl
              WHERE bl.workspace_id = w.id
                AND bl.status = 'pending'
            ), 0)::int AS pending_credits_cents
       FROM workspaces w
      WHERE w.id = :workspaceId
        AND w.deleted_at IS NULL`,
    { workspaceId },
  );
  const creditsBalance = row?.credits_balance ?? 0;
  const pendingCreditsCents = row?.pending_credits_cents ?? 0;
  return {
    creditsBalance,
    pendingCreditsCents,
    availableCreditsCents: creditsBalance - pendingCreditsCents,
  };
}

export async function reserveWorkspaceCredits(input: {
  workspaceId: string;
  amountCents: number;
  jobFamily: string;
  jobId: string;
  metadata?: Record<string, unknown>;
}): Promise<{
  reserved: boolean;
  duplicate?: boolean;
  insufficient?: boolean;
  conflict?: boolean;
  conflictReason?: string;
  amountCents: number;
  creditsBalance?: number;
  pendingCreditsCents?: number;
  availableCreditsCents?: number;
}> {
  const amountCents = normalizeCreditAmount(input.amountCents, "Credit reservation amount");

  return withTransaction(async (tx) => {
    const existing = await tx.queryOne<BillingLedgerRow>(
      `SELECT id, status, reserved_cents, amount_cents, metadata_json
         FROM billing_ledger
        WHERE workspace_id = :workspaceId
          AND job_family = :jobFamily
          AND job_id = :jobId
        LIMIT 1
        FOR UPDATE`,
      {
        workspaceId: input.workspaceId,
        jobFamily: input.jobFamily,
        jobId: input.jobId,
      },
    );
    if (existing) {
      const exactPendingReservation =
        existing.status === "pending" &&
        existing.reserved_cents === amountCents;
      return {
        reserved: exactPendingReservation,
        duplicate: true,
        conflict: !exactPendingReservation,
        conflictReason: exactPendingReservation
          ? undefined
          : "existing_reservation_mismatch",
        amountCents: existing.reserved_cents,
      };
    }

    const workspace = await tx.queryOne<{
      credits_balance: number;
      pending_credits_cents: number;
    }>(
      `SELECT w.credits_balance,
              COALESCE((
                SELECT SUM(bl.reserved_cents)
                FROM billing_ledger bl
                WHERE bl.workspace_id = w.id
                  AND bl.status = 'pending'
              ), 0)::int AS pending_credits_cents
         FROM workspaces w
        WHERE w.id = :workspaceId
          AND w.deleted_at IS NULL
        FOR UPDATE`,
      { workspaceId: input.workspaceId },
    );
    if (!workspace) {
      throw new Error("Workspace credit reservation failed: workspace not found.");
    }

    const pendingCreditsCents = workspace.pending_credits_cents ?? 0;
    const availableCreditsCents = workspace.credits_balance - pendingCreditsCents;
    if (availableCreditsCents < amountCents) {
      return {
        reserved: false,
        insufficient: true,
        amountCents,
        creditsBalance: workspace.credits_balance,
        pendingCreditsCents,
        availableCreditsCents,
      };
    }

    const ledger = await tx.queryOne<{ id: string }>(
      `INSERT INTO billing_ledger (
          workspace_id,
          job_family,
          job_id,
          amount_cents,
          reserved_cents,
          status,
          metadata_json
        )
        VALUES (
          :workspaceId,
          :jobFamily,
          :jobId,
          0,
          :amountCents,
          'pending',
          :metadata::jsonb
        )
        ON CONFLICT (job_family, job_id) DO NOTHING
        RETURNING id`,
      {
        workspaceId: input.workspaceId,
        jobFamily: input.jobFamily,
        jobId: input.jobId,
        amountCents,
        metadata: input.metadata ?? {},
      },
    );

    if (!ledger) {
      // Another same-job transaction can win the unique insert after our
      // initial lookup. Re-read the durable winner and accept it only when it
      // belongs to this workspace and reserves the exact same amount.
      const winner = await tx.queryOne<BillingLedgerRow>(
        `SELECT id, status, reserved_cents, amount_cents, metadata_json
           FROM billing_ledger
          WHERE workspace_id = :workspaceId
            AND job_family = :jobFamily
            AND job_id = :jobId
          LIMIT 1
          FOR UPDATE`,
        {
          workspaceId: input.workspaceId,
          jobFamily: input.jobFamily,
          jobId: input.jobId,
        },
      );
      const exactPendingReservation =
        winner?.status === "pending" &&
        winner.reserved_cents === amountCents;
      return {
        reserved: exactPendingReservation,
        duplicate: true,
        conflict: !exactPendingReservation,
        conflictReason: exactPendingReservation
          ? undefined
          : "concurrent_reservation_mismatch",
        amountCents: winner?.reserved_cents ?? amountCents,
        creditsBalance: workspace.credits_balance,
        pendingCreditsCents,
        availableCreditsCents,
      };
    }

    return {
      reserved: true,
      amountCents,
      creditsBalance: workspace.credits_balance,
      pendingCreditsCents: pendingCreditsCents + amountCents,
      availableCreditsCents: availableCreditsCents - amountCents,
    };
  });
}

export async function settleWorkspaceCreditReservation(input: {
  workspaceId: string;
  amountCents: number;
  jobFamily: string;
  jobId: string;
  metadata?: Record<string, unknown>;
}): Promise<{
  settled: boolean;
  duplicate?: boolean;
  released?: boolean;
  amountCents: number;
  creditsBalance?: number;
}> {
  const amountCents = normalizeCreditAmount(input.amountCents, "Credit settlement amount");

  try {
    return await withTransaction(async (tx) => {
      const existing = await tx.queryOne<BillingLedgerRow>(
        `SELECT id, status, reserved_cents, amount_cents, metadata_json
           FROM billing_ledger
          WHERE workspace_id = :workspaceId
            AND job_family = :jobFamily
            AND job_id = :jobId
          LIMIT 1
          FOR UPDATE`,
        {
          workspaceId: input.workspaceId,
          jobFamily: input.jobFamily,
          jobId: input.jobId,
        },
      );

      if (existing?.status === "settled") {
        if (existing.amount_cents !== amountCents) {
          throw new Error(
            `Workspace credit settlement failed: settled amount ${existing.amount_cents} does not match requested settlement ${amountCents}.`,
          );
        }
        return {
          settled: false,
          duplicate: true,
          amountCents: existing.amount_cents,
        };
      }
      if (existing?.status === "released") {
        return {
          settled: false,
          released: true,
          amountCents: existing.amount_cents,
        };
      }

      if (existing && existing.reserved_cents !== amountCents) {
        throw new Error(
          `Workspace credit settlement failed: pending reservation amount ${existing.reserved_cents} does not match requested settlement ${amountCents}.`,
        );
      }

      if (existing) {
        await tx.execute(
          `UPDATE billing_ledger
              SET status = 'settled',
                  amount_cents = :amountCents,
                  metadata_json = metadata_json || :metadata::jsonb,
                  settled_at = NOW(),
                  updated_at = NOW()
            WHERE job_family = :jobFamily
              AND workspace_id = :workspaceId
              AND job_id = :jobId`,
          {
            amountCents,
            metadata: input.metadata ?? {},
            workspaceId: input.workspaceId,
            jobFamily: input.jobFamily,
            jobId: input.jobId,
          },
        );
      } else {
        const inserted = await tx.queryOne<{ id: string }>(
          `INSERT INTO billing_ledger (
              workspace_id,
              job_family,
              job_id,
              amount_cents,
              reserved_cents,
              status,
              metadata_json,
              settled_at
            )
            VALUES (
              :workspaceId,
              :jobFamily,
              :jobId,
              :amountCents,
              0,
              'settled',
              :metadata::jsonb,
              NOW()
            )
            ON CONFLICT (job_family, job_id) DO NOTHING
            RETURNING id`,
          {
            workspaceId: input.workspaceId,
            jobFamily: input.jobFamily,
            jobId: input.jobId,
            amountCents,
            metadata: input.metadata ?? {},
          },
        );
        if (!inserted) {
          // A concurrent reservation or settlement may win the global unique
          // key after the initial lookup. Re-read only this workspace's row;
          // a collision owned by another workspace is never a valid receipt.
          const winner = await tx.queryOne<BillingLedgerRow>(
            `SELECT id, status, reserved_cents, amount_cents, metadata_json
               FROM billing_ledger
              WHERE workspace_id = :workspaceId
                AND job_family = :jobFamily
                AND job_id = :jobId
              LIMIT 1
              FOR UPDATE`,
            {
              workspaceId: input.workspaceId,
              jobFamily: input.jobFamily,
              jobId: input.jobId,
            },
          );
          if (!winner) {
            throw new Error(
              "Workspace credit settlement failed: conflicting ledger belongs to another workspace.",
            );
          }
          if (winner.status === "settled") {
            if (winner.amount_cents !== amountCents) {
              throw new Error(
                `Workspace credit settlement failed: settled amount ${winner.amount_cents} does not match requested settlement ${amountCents}.`,
              );
            }
            return { settled: false, duplicate: true, amountCents };
          }
          if (winner.status === "released") {
            return { settled: false, released: true, amountCents: 0 };
          }
          if (
            winner.status !== "pending" ||
            winner.reserved_cents !== amountCents
          ) {
            throw new Error(
              "Workspace credit settlement failed: concurrent ledger does not match the requested settlement.",
            );
          }
          await tx.execute(
            `UPDATE billing_ledger
                SET status = 'settled',
                    amount_cents = :amountCents,
                    metadata_json = metadata_json || :metadata::jsonb,
                    settled_at = NOW(),
                    updated_at = NOW()
              WHERE job_family = :jobFamily
                AND workspace_id = :workspaceId
                AND job_id = :jobId
                AND status = 'pending'`,
            {
              amountCents,
              metadata: input.metadata ?? {},
              workspaceId: input.workspaceId,
              jobFamily: input.jobFamily,
              jobId: input.jobId,
            },
          );
        }
      }

      if (amountCents === 0) {
        return { settled: true, amountCents };
      }

      const rows = await tx.queryRows<{ credits_balance: number }>(
        `UPDATE workspaces
            SET credits_balance = credits_balance - :amountCents,
                updated_at = now()
          WHERE id = :workspaceId
            AND deleted_at IS NULL
            AND credits_balance >= :amountCents
          RETURNING credits_balance`,
        { workspaceId: input.workspaceId, amountCents },
      );
      const updated = rows[0];
      if (!updated) {
        throw new Error("Workspace credit deduction failed: insufficient settled balance.");
      }

      return {
        settled: true,
        amountCents,
        creditsBalance: updated.credits_balance,
      };
    });
  } catch (error) {
    await recordWorkspaceAuditLog({
      workspaceId: input.workspaceId,
      actorUserId: null,
      action: BILLING_DEDUCTION_FAILED_AUDIT_ACTION,
      targetType: input.jobFamily,
      targetId: input.jobId,
      metadata: {
        amountCents,
        jobFamily: input.jobFamily,
        error: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
    throw error;
  }
}

export async function releaseWorkspaceCreditReservation(input: {
  workspaceId: string;
  jobFamily: string;
  jobId: string;
  metadata?: Record<string, unknown>;
}): Promise<{
  released: boolean;
  duplicate?: boolean;
  missing?: boolean;
  amountCents: number;
}> {
  return withTransaction(async (tx) => {
    const existing = await tx.queryOne<BillingLedgerRow>(
      `SELECT id, status, reserved_cents, amount_cents, metadata_json
         FROM billing_ledger
        WHERE workspace_id = :workspaceId
          AND job_family = :jobFamily
          AND job_id = :jobId
        LIMIT 1
        FOR UPDATE`,
      {
        workspaceId: input.workspaceId,
        jobFamily: input.jobFamily,
        jobId: input.jobId,
      },
    );
    if (!existing) return { released: false, missing: true, amountCents: 0 };
    if (existing.status !== "pending") {
      return {
        released: false,
        duplicate: true,
        amountCents: existing.amount_cents,
      };
    }

    await tx.execute(
      `UPDATE billing_ledger
          SET status = 'released',
              amount_cents = 0,
              metadata_json = metadata_json || :metadata::jsonb,
              released_at = NOW(),
              updated_at = NOW()
        WHERE job_family = :jobFamily
          AND workspace_id = :workspaceId
          AND job_id = :jobId`,
      {
        metadata: input.metadata ?? {},
        workspaceId: input.workspaceId,
        jobFamily: input.jobFamily,
        jobId: input.jobId,
      },
    );

    return { released: true, amountCents: 0 };
  });
}

export async function deductWorkspaceCredits(input: {
  workspaceId: string;
  amountCents: number;
  jobFamily: string;
  jobId: string;
  metadata?: Record<string, unknown>;
}): Promise<{
  deducted: boolean;
  duplicate?: boolean;
  amountCents: number;
  creditsBalance?: number;
}> {
  const result = await settleWorkspaceCreditReservation(input);
  return {
    deducted: result.settled,
    duplicate: result.duplicate,
    amountCents: result.amountCents,
    creditsBalance: result.creditsBalance,
  };
}

export async function reconcileWorkspaceUsageReservations(
  workspaceId: string,
  limit = 100,
): Promise<{ settled: number; released: number }> {
  const rows = await queryRows<{
    job_family: string;
    job_id: string;
    reserved_cents: number;
    job_status: string | null;
  }>(
    `SELECT bl.job_family,
            bl.job_id,
            bl.reserved_cents,
            oj.state AS job_status
       FROM billing_ledger bl
       LEFT JOIN uniscenario.operational_jobs oj
         ON oj.workspace_id = bl.workspace_id
        AND oj.job_family = bl.job_family
        AND oj.id = bl.job_id
      WHERE bl.workspace_id = :workspaceId
        AND bl.status = 'pending'
      ORDER BY bl.created_at ASC
      LIMIT :limit`,
    { workspaceId, limit },
  );

  let settled = 0;
  let released = 0;
  for (const row of rows) {
    const status = row.job_status?.trim().toLowerCase();
    if (status === "completed" || status === "succeeded") {
      const result = await settleWorkspaceCreditReservation({
        workspaceId,
        jobFamily: row.job_family,
        jobId: row.job_id,
        amountCents: row.reserved_cents,
        metadata: { reconciledFromJobStatus: status },
      });
      if (result.settled) settled += 1;
    } else if (status === "failed" || status === "cancelled") {
      const result = await releaseWorkspaceCreditReservation({
        workspaceId,
        jobFamily: row.job_family,
        jobId: row.job_id,
        metadata: { reconciledFromJobStatus: status },
      });
      if (result.released) released += 1;
    }
  }

  return { settled, released };
}

// --- Members ---

export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  return queryRows<WorkspaceMember>(
    `SELECT m."userId" AS "userId",
            COALESCE(bu.email, '') AS email,
            COALESCE(bu.name, '') AS name,
            m.role,
            m."createdAt"::text AS "createdAt"
     FROM workspaces w
     JOIN ba_member m ON m."organizationId" = w.auth_organization_id
     LEFT JOIN ba_user bu ON bu.id = m."userId"
     WHERE w.id = :workspaceId
       AND w.deleted_at IS NULL
     ORDER BY
       CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
       m."createdAt" ASC`,
    { workspaceId },
  );
}

export async function changeMemberRole(
  workspaceId: string,
  targetUserId: string,
  newRole: WorkspaceRole,
  actorUserId?: string | null,
): Promise<void> {
  if (newRole === "owner") {
    throw new Error("Cannot promote to owner directly");
  }

  const current = await queryOne<{ role: string; memberId: string; organizationId: string }>(
    `SELECT m.role, m.id AS "memberId", m."organizationId" AS "organizationId"
       FROM workspaces w
       JOIN ba_member m ON m."organizationId" = w.auth_organization_id
      WHERE w.id = :workspaceId
        AND m."userId" = :targetUserId
        AND w.deleted_at IS NULL`,
    { workspaceId, targetUserId },
  );

  if (!current) throw new Error("Member not found");

  if (current.role === "owner") {
    const ownerCount = await queryOne<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
         FROM ba_member
        WHERE "organizationId" = :organizationId
          AND role = 'owner'`,
      { organizationId: current.organizationId },
    );
    if (ownerCount && ownerCount.cnt <= 1) {
      throw new Error("Cannot demote last owner");
    }
  }

  await execute(
    `UPDATE ba_member SET role = :newRole
     WHERE id = :memberId`,
    { memberId: current.memberId, newRole },
  );
  await recordWorkspaceAuditLog({
    workspaceId,
    actorUserId,
    action: "workspace_member.role_changed",
    targetType: "workspace_member",
    targetId: targetUserId,
    metadata: { previousRole: current.role, newRole },
  });
}

export async function removeMember(
  workspaceId: string,
  targetUserId: string,
  actorUserId?: string | null,
): Promise<void> {
  const current = await queryOne<{ role: string; memberId: string; organizationId: string }>(
    `SELECT m.role, m.id AS "memberId", m."organizationId" AS "organizationId"
       FROM workspaces w
       JOIN ba_member m ON m."organizationId" = w.auth_organization_id
      WHERE w.id = :workspaceId
        AND m."userId" = :targetUserId
        AND w.deleted_at IS NULL`,
    { workspaceId, targetUserId },
  );

  if (!current) throw new Error("Member not found");

  if (current.role === "owner") {
    const ownerCount = await queryOne<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
         FROM ba_member
        WHERE "organizationId" = :organizationId
          AND role = 'owner'`,
      { organizationId: current.organizationId },
    );
    if (ownerCount && ownerCount.cnt <= 1) {
      throw new Error("Cannot remove last owner");
    }
  }

  await execute(
    `DELETE FROM ba_member
     WHERE id = :memberId`,
    { memberId: current.memberId },
  );
  await recordWorkspaceAuditLog({
    workspaceId,
    actorUserId,
    action: "workspace_member.removed",
    targetType: "workspace_member",
    targetId: targetUserId,
    metadata: { previousRole: current.role },
  });
}

// --- Invitations ---

export async function createInvitation(
  workspaceId: string,
  rawEmail: string,
  role: WorkspaceRole,
  invitedByUserId: string,
): Promise<WorkspaceInvitation> {
  const email = rawEmail.trim().toLowerCase();
  const organizationId = await organizationIdForWorkspaceRow(workspaceId);

  const existingMember = await queryOne<{ user_id: string }>(
    `SELECT m."userId" AS user_id
       FROM ba_member m
       JOIN ba_user bu ON bu.id = m."userId"
      WHERE m."organizationId" = :organizationId
        AND lower(bu.email) = :email`,
    { organizationId, email },
  );

  if (existingMember) {
    throw new Error("User is already a member of this workspace");
  }

  const id = invitationId();
  const token = invitationTokenId(id);

  await execute(
    `INSERT INTO ba_invitation (
       id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId"
     )
     VALUES (
       :id, :organizationId, :email, :role, 'pending',
       NOW() + INTERVAL '7 days', NOW(), :invitedByUserId
     )`,
    { id, organizationId, email, role, invitedByUserId },
  );
  await recordWorkspaceAuditLog({
    workspaceId,
    actorUserId: invitedByUserId,
    action: "workspace_invitation.created",
    targetType: "workspace_invitation",
    targetId: id,
    metadata: { email, role },
  });

  return {
    id,
    email,
    role,
    invitedByUserId: invitedByUserId,
    token,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export async function listPendingInvitations(
  workspaceId: string,
): Promise<WorkspaceInvitation[]> {
  return queryRows<WorkspaceInvitation>(
    `SELECT bi.id, bi.email, bi.role,
            bi."inviterId" AS "invitedByUserId",
            bi.id AS token,
            bi.status,
            bi."createdAt"::text AS "createdAt",
            bi."expiresAt"::text AS "expiresAt"
     FROM workspaces w
     JOIN ba_invitation bi ON bi."organizationId" = w.auth_organization_id
     WHERE w.id = :workspaceId
       AND bi.status = 'pending'
       AND bi."expiresAt" > NOW()
     ORDER BY bi."createdAt" DESC`,
    { workspaceId },
  );
}

export async function revokeInvitation(
  workspaceId: string,
  invitationIdParam: string,
  actorUserId?: string | null,
): Promise<void> {
  await execute(
    `UPDATE ba_invitation
        SET status = 'canceled'
      WHERE id = :invitationId
        AND "organizationId" = (
          SELECT auth_organization_id FROM workspaces WHERE id = :workspaceId
        )
        AND status = 'pending'`,
    { invitationId: invitationIdParam, workspaceId },
  );
  await recordWorkspaceAuditLog({
    workspaceId,
    actorUserId,
    action: "workspace_invitation.revoked",
    targetType: "workspace_invitation",
    targetId: invitationIdParam,
  });
}

export async function acceptInvitation(
  token: string,
  userId: string,
  userEmail?: string | null,
): Promise<{ workspaceId: string; workspaceName: string }> {
  return withTransaction(async (tx) => {
    const inv = await tx.queryOne<{
      id: string;
      organization_id: string;
      role: string;
      status: string;
      expires_at: string;
      email: string;
    }>(
      `SELECT id,
              "organizationId" AS organization_id,
              email,
              role,
              status,
              "expiresAt"::text AS expires_at
       FROM ba_invitation
       WHERE id = :token
       LIMIT 1`,
      { token },
    );

    if (!inv) throw new Error("Invitation not found");
    if (inv.status !== "pending") throw new Error("Invitation already used");
    if (new Date(inv.expires_at) < new Date()) throw new Error("Invitation expired");
    if (userEmail?.trim().toLowerCase() !== inv.email.trim().toLowerCase()) {
      throw new Error("Invitation email does not match the signed-in account");
    }

    await tx.execute(
      `INSERT INTO ba_member (id, "organizationId", "userId", role, "createdAt")
       VALUES (:id, :organizationId, :userId, :role, NOW())
       ON CONFLICT ("organizationId", "userId") DO NOTHING`,
      {
        id: organizationMemberId(inv.organization_id, userId),
        organizationId: inv.organization_id,
        userId,
        role: inv.role,
      },
    );

    await tx.execute(
      `UPDATE ba_invitation SET status = 'accepted'
       WHERE id = :invitationId`,
      { invitationId: inv.id },
    );

    const ws = await tx.queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM workspaces WHERE auth_organization_id = :organizationId`,
      { organizationId: inv.organization_id },
    );
    if (!ws) throw new Error("Invitation workspace not found");

    return {
      workspaceId: ws.id,
      workspaceName: ws.name,
    };
  });
}
