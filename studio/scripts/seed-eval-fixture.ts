/**
 * Seed the evaluation-tab fixture into a running local Studio environment:
 *
 *   1. campaign artifacts (EvalLane wave-3 layout) under $SIMFORGE_RUNS_ROOT;
 *   2. one simforge.* model version whose checkpointDigest matches the
 *      fixture's candidate policy, an echo endpoint, and two eval runs —
 *      one left QUEUED (promotion must refuse) and one driven to SUCCEEDED
 *      (promotion must pass).
 *
 * Run with the same UNISCENARIOS_CLOUD_ROOT / SIMFORGE_RUNS_ROOT as the dev
 * server:  pnpm exec tsx scripts/seed-eval-fixture.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_ORGANIZATION_ID,
  LOCAL_SESSION,
  LOCAL_USER_ID,
  LOCAL_WORKSPACE_ID,
} from "../app/lib/auth/session";
import { getAppContext } from "../app/lib/db/app-context";
import { withTransaction } from "../app/lib/db/data-api";
import {
  FIXTURE_CANDIDATE_POLICY_ID,
  fixtureCheckpointDigest,
  writeEvalFixture,
} from "../app/lib/evaluation/fixture";
import { CreateModelEndpointSchema, CreateModelRunSchema } from "../app/lib/models/contracts";
import {
  createModelEndpoint,
  createModelVersion,
  listModelVersions,
} from "../app/lib/models/model-registry-store";
import {
  completeModelRun,
  createModelRun,
  leaseNextModelRun,
} from "../app/lib/models/model-run-store";
import { migrate } from "./migrate";

const runsRootDir =
  process.env.SIMFORGE_RUNS_ROOT?.trim() || join(homedir(), "simforge-assets", "runs");

await migrate();
// Minimal local identity (same rows the model-registry test harness seeds) so
// this script works on a fresh scratch cloud root without the full dev-assets seed.
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
const context = await getAppContext(LOCAL_SESSION);

const fixture = await writeEvalFixture(runsRootDir);
console.log(`campaign artifacts: ${join(runsRootDir, fixture.campaignId)}`);

const digest = fixtureCheckpointDigest(FIXTURE_CANDIDATE_POLICY_ID);
let versionId =
  (await listModelVersions(context)).find((version) => version.checkpointDigest === digest)?.id ??
  null;
if (!versionId) {
  const created = await createModelVersion(context, {
    family: "alpamayo",
    name: "Alpamayo R1 10B nf4 (fixture candidate)",
    source: "nvidia/Alpamayo-R1-10B",
    checkpointDigest: digest,
    quant: "nf4",
    license: "nvidia-open-model",
  });
  if (created.kind !== "created") throw new Error(`version create: ${created.kind}`);
  versionId = created.version.id;
}
console.log(`model version: ${versionId}`);

const endpoint = await createModelEndpoint(
  context,
  CreateModelEndpointSchema.parse({
    modelVersionId: versionId,
    name: "echo-fixture",
    descriptor: {
      kind: "process",
      cmd: ["node", "worker/testing/echo-endpoint.mjs"],
      health: { kind: "http", path: "/healthz", timeoutMs: 15_000 },
      invoke: { kind: "http-json", path: "/invoke", timeoutMs: 30_000 },
    },
  }),
);
if (endpoint.kind === "conflict") {
  // Registry rows from a previous seed run are already in place.
  console.log("registry already seeded (endpoint exists); artifacts refreshed. done");
  process.exit(0);
}
if (endpoint.kind !== "created") throw new Error(`endpoint create: ${endpoint.kind}`);
const endpointId = endpoint.endpoint.id;

function runInput(seed: number) {
  return CreateModelRunSchema.parse({
    modelVersionId: versionId,
    endpointId,
    kind: "openloop",
    params: { input: { items: [{ prompt: "fixture" }] } },
    seed,
  });
}

// Run 1: driven to succeeded — valid promotion evidence. Created first so the
// oldest-first lease picks it, leaving the second run untouched.
const succeededCreate = await createModelRun(context, runInput(2));
if (succeededCreate.kind !== "created") throw new Error(`run: ${succeededCreate.kind}`);
const lease = await leaseNextModelRun({ workerId: "fixture-seeder", kinds: ["openloop"] });
if (!lease || lease.runId !== succeededCreate.run.id) {
  throw new Error(`unexpected lease ${lease?.runId ?? "none"}; expected ${succeededCreate.run.id}`);
}
await completeModelRun(lease, {
  metrics: { minADE: 0.173 },
  outputRefs: [{ kind: "campaign", campaignId: fixture.campaignId }],
});
console.log(`succeeded run (valid promotion evidence): ${succeededCreate.run.id}`);

// Run 2: left queued — the promotion gate must refuse it.
const queued = await createModelRun(context, runInput(1));
if (queued.kind !== "created") throw new Error(`queued run: ${queued.kind}`);
console.log(`queued run (gate refusal evidence): ${queued.run.id}`);
console.log("seed-eval-fixture: done");
process.exit(0);
