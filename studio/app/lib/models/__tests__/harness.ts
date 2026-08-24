import "./test-env";

import { migrate } from "../../../../scripts/migrate";
import {
  LOCAL_ORGANIZATION_ID,
  LOCAL_SESSION,
  LOCAL_USER_ID,
  LOCAL_WORKSPACE_ID,
} from "../../auth/session";
import { getAppContext, type AppContext } from "../../db/app-context";
import { withTransaction } from "../../db/data-api";
import { CreateModelEndpointSchema, type ModelEndpointDescriptor } from "../contracts";

/** Fresh PGlite: apply EVERY migration, then the minimal local identity rows. */
export async function bootModelTestDatabase(): Promise<AppContext> {
  await migrate();
  await withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO public.ba_user (id, name, email, "emailVerified", role)
       VALUES (:id, 'Local Owner', 'owner@local.simforge', TRUE, 'owner')
       ON CONFLICT (id) DO NOTHING`,
      { id: LOCAL_USER_ID },
    );
    await tx.execute(
      `INSERT INTO public.ba_organization (id, name, slug)
       VALUES (:id, 'Local Workspace', 'local') ON CONFLICT (id) DO NOTHING`,
      { id: LOCAL_ORGANIZATION_ID },
    );
    await tx.execute(
      `INSERT INTO public.workspaces (id, type, slug, name, created_by_user_id, auth_organization_id)
       VALUES (:id, 'personal', 'local', 'Local Workspace', :user_id, :organization_id)
       ON CONFLICT (id) DO NOTHING`,
      { id: LOCAL_WORKSPACE_ID, user_id: LOCAL_USER_ID, organization_id: LOCAL_ORGANIZATION_ID },
    );
  });
  return getAppContext(LOCAL_SESSION);
}

/** A `process` + `http-json` descriptor for the echo stub, defaults applied. */
export function echoEndpointDescriptor(scriptPath: string): ModelEndpointDescriptor {
  return CreateModelEndpointSchema.parse({
    modelVersionId: "placeholder",
    name: "placeholder",
    descriptor: {
      kind: "process",
      cmd: ["node", scriptPath],
      health: { kind: "http", path: "/healthz", timeoutMs: 15_000 },
      invoke: { kind: "http-json", path: "/invoke", timeoutMs: 30_000 },
    },
  }).descriptor;
}
