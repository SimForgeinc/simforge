import { redirect } from "next/navigation";
import { requireAdminDeploymentIdentity } from "@/app/lib/admin/environments";
import { queryOne, queryRows } from "@/app/lib/db/data-api";
import { getCurrentSession, type AuthenticatedUser } from "./session";

export type AdminEnvironment = "dev" | "staging" | "prod";

export type AdminRole = "support" | "ops" | "billing" | "superadmin";

export type AdminCapability =
  | "admin:access"
  | "accounts:create"
  | "accounts:password"
  | "sessions:revoke"
  | "audit:read"
  | "billing:read"
  | "billing:write"
  | "datasets:read"
  | "diagnostics:read"
  | "impersonation:start"
  | "maps:read"
  | "ops:read"
  | "ops:safe-action"
  | "roles:write"
  | "users:read"
  | "users:usage";

export type AdminAccess = {
  user: AuthenticatedUser;
  roles: AdminRole[];
  capabilities: AdminCapability[];
};

type RoleAssignmentRow = {
  role: string;
  environment: string | null;
};

const ROLE_CAPABILITIES: Record<AdminRole, AdminCapability[]> = {
  support: ["admin:access", "users:read", "users:usage", "impersonation:start", "audit:read"],
  ops: [
    "admin:access",
    "ops:read",
    "ops:safe-action",
    "datasets:read",
    "maps:read",
    "diagnostics:read",
    "audit:read",
  ],
  billing: ["admin:access", "billing:read", "billing:write", "users:usage", "audit:read"],
  superadmin: [
    "admin:access",
    "accounts:create",
    "accounts:password",
    "sessions:revoke",
    "audit:read",
    "billing:read",
    "billing:write",
    "datasets:read",
    "diagnostics:read",
    "impersonation:start",
    "maps:read",
    "ops:read",
    "ops:safe-action",
    "roles:write",
    "users:read",
    "users:usage",
  ],
};

const ADMIN_ROLES = new Set<AdminRole>(["support", "ops", "billing", "superadmin"]);

export function isAdminRole(value: string): value is AdminRole {
  return ADMIN_ROLES.has(value as AdminRole);
}

function currentAdminEnvironment(): AdminEnvironment {
  return requireAdminDeploymentIdentity().environment;
}

async function loadRoleAssignments(userId: string): Promise<AdminRole[]> {
  const environment = currentAdminEnvironment();
  try {
    const rows = await queryRows<RoleAssignmentRow>(
      `SELECT role, environment
       FROM admin_role_assignments
       WHERE user_id = :userId
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
         AND (environment IS NULL OR environment = :environment)`,
      { userId, environment },
    );
    return rows
      .filter((row) => row.environment === null || row.environment === environment)
      .map((row) => row.role)
      .filter(isAdminRole);
  } catch {
    return [];
  }
}

async function isActiveImpersonationTargetSession(
  sessionTokenHash: string | undefined,
): Promise<boolean> {
  if (!sessionTokenHash) return false;
  try {
    const row = await queryOne<{ id: string }>(
      `SELECT id
       FROM admin_impersonation_sessions
       WHERE status = 'active'
         AND target_session_token_hash = :sessionTokenHash
         AND expires_at > now()
       LIMIT 1`,
      { sessionTokenHash },
    );
    return Boolean(row);
  } catch {
    return false;
  }
}

export async function resolveAdminAccess(user: AuthenticatedUser): Promise<AdminAccess> {
  const roles = new Set<AdminRole>();

  if (user.role === "admin") {
    roles.add("superadmin");
  } else if (isAdminRole(user.role)) {
    roles.add(user.role);
  }

  for (const role of await loadRoleAssignments(user.sub)) {
    roles.add(role);
  }

  const capabilities = new Set<AdminCapability>();
  for (const role of roles) {
    for (const capability of ROLE_CAPABILITIES[role]) {
      capabilities.add(capability);
    }
  }

  return {
    user,
    roles: Array.from(roles),
    capabilities: Array.from(capabilities),
  };
}

export function hasCapability(access: AdminAccess, capability: AdminCapability): boolean {
  return access.capabilities.includes(capability);
}

export function canPerformAdminAction(
  access: AdminAccess,
  capability: AdminCapability,
  environment?: AdminEnvironment,
): boolean {
  if (!hasCapability(access, capability)) return false;
  const mutatingCapabilities = new Set<AdminCapability>([
    "accounts:create",
    "accounts:password",
    "billing:write",
    "ops:safe-action",
    "roles:write",
    "sessions:revoke",
  ]);
  if (environment && environment !== "dev" && mutatingCapabilities.has(capability)) return false;
  return true;
}

export async function requireAdminAccess(): Promise<AdminAccess> {
  requireAdminDeploymentIdentity();
  const session = await getCurrentSession();
  if (!session) {
    redirect("/auth?next=/");
  }

  if (await isActiveImpersonationTargetSession(session.sessionTokenHash)) {
    redirect("/unauthorized");
  }

  const access = await resolveAdminAccess(session);
  if (!hasCapability(access, "admin:access")) {
    redirect("/unauthorized");
  }

  return access;
}

export async function requireCapability(capability: AdminCapability): Promise<AuthenticatedUser> {
  const access = await requireAdminAccess();
  if (!hasCapability(access, capability)) {
    redirect("/unauthorized");
  }

  return access.user;
}
