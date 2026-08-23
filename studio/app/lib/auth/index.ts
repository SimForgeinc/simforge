import { LOCAL_SESSION } from "./session";

const localBetterAuthSession = {
  user: {
    id: LOCAL_SESSION.sub,
    email: LOCAL_SESSION.email,
    name: LOCAL_SESSION.name,
    role: LOCAL_SESSION.role,
    emailVerified: true,
  },
  session: {
    id: LOCAL_SESSION.sessionId,
    activeOrganizationId: LOCAL_SESSION.activeOrganizationId,
  },
};

/** Minimal Better Auth-compatible surface retained for copied server callers. */
export const auth = {
  api: {
    async getSession(_input?: { headers?: Headers }): Promise<typeof localBetterAuthSession> {
      return localBetterAuthSession;
    },
  },
};
