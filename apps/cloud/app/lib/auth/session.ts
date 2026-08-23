export type AuthenticatedUser = {
  sub: string;
  email: string | null;
  name: string | null;
  role: string;
  emailVerified?: boolean;
  sessionId?: string;
  activeOrganizationId?: string | null;
  sessionTokenHash?: string;
};

export const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
export const LOCAL_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";
export const LOCAL_SESSION_ID = "00000000-0000-4000-8000-000000000004";

export const LOCAL_SESSION: AuthenticatedUser = Object.freeze({
  sub: LOCAL_USER_ID,
  email: "owner@local.uniscenarios",
  name: "Local Owner",
  role: "owner",
  emailVerified: true,
  sessionId: LOCAL_SESSION_ID,
  activeOrganizationId: LOCAL_ORGANIZATION_ID,
});

export async function getCurrentSession(): Promise<AuthenticatedUser> {
  return LOCAL_SESSION;
}

export async function getRequestSession(): Promise<AuthenticatedUser> {
  return LOCAL_SESSION;
}

export async function requireRequestSession(_nextPath = "/dashboard"): Promise<AuthenticatedUser> {
  return LOCAL_SESSION;
}

export async function requireCurrentSession(_nextPath = "/dashboard"): Promise<AuthenticatedUser> {
  return LOCAL_SESSION;
}
