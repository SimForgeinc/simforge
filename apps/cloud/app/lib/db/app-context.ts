import {
  LOCAL_ORGANIZATION_ID,
  LOCAL_SESSION,
  LOCAL_USER_ID,
  LOCAL_WORKSPACE_ID,
  type AuthenticatedUser,
} from "@/app/lib/auth/session";

export type AppContext = {
  session: AuthenticatedUser;
  userId: string;
  workspaceId: string;
  organizationId: string;
};

export function getAppContext(session: AuthenticatedUser): AppContext {
  return {
    session,
    userId: LOCAL_USER_ID,
    workspaceId: LOCAL_WORKSPACE_ID,
    organizationId: LOCAL_ORGANIZATION_ID,
  };
}

export async function provisionAppContext(session: AuthenticatedUser): Promise<AppContext> {
  return getAppContext(session);
}

export async function provisionDefaultAppContextForUser(userId: string): Promise<AppContext | null> {
  return userId === LOCAL_USER_ID ? getAppContext(LOCAL_SESSION) : null;
}

export async function provisionAppContextForWorkspaceAccess(
  userId: string,
  workspaceId: string,
): Promise<AppContext | null> {
  return userId === LOCAL_USER_ID && workspaceId === LOCAL_WORKSPACE_ID
    ? getAppContext(LOCAL_SESSION)
    : null;
}

export async function getActiveAppContext(session: AuthenticatedUser): Promise<AppContext> {
  return getAppContext(session);
}

export async function getOptionalAppContext(): Promise<AppContext> {
  return getAppContext(LOCAL_SESSION);
}

export async function requireAppContext(_nextPath = "/dashboard"): Promise<AppContext> {
  return getAppContext(LOCAL_SESSION);
}
