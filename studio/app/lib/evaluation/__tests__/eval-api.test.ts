import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { before, test } from "node:test";

import { TEST_RUNS_ROOT } from "../../models/__tests__/test-env";
import { bootModelTestDatabase, echoEndpointDescriptor } from "../../models/__tests__/harness";
import { GET as getCampaigns } from "../../../api/evaluation/campaigns/route";
import { GET as getCampaign } from "../../../api/evaluation/campaigns/[campaignId]/route";
import { GET as getCompare } from "../../../api/evaluation/campaigns/[campaignId]/compare/route";
import { GET as getEpisode } from "../../../api/evaluation/campaigns/[campaignId]/episodes/[episodeId]/route";
// eslint-disable-next-line max-len
import { GET as getFrame } from "../../../api/evaluation/campaigns/[campaignId]/episodes/[episodeId]/frames/[...framePath]/route";
import { GET as getPolicy } from "../../../api/evaluation/campaigns/[campaignId]/policies/[policyId]/route";
import { POST as postPromote } from "../../../api/models/versions/[versionId]/promote/route";
import type { AppContext } from "../../db/app-context";
import { CreateModelRunSchema } from "../../models/contracts";
import { createModelEndpoint, createModelVersion } from "../../models/model-registry-store";
import { completeModelRun, createModelRun, leaseNextModelRun } from "../../models/model-run-store";
import type {
  EvalCampaignSummary,
  EvalEpisodePayload,
  EvalPolicyDetail,
  EvalRunComparison,
} from "../contracts";
import {
  FIXTURE_BASELINE_POLICY_ID,
  FIXTURE_CAMPAIGN_ID,
  FIXTURE_CANDIDATE_POLICY_ID,
  FIXTURE_DIVERGENCE_AFTER_STEP,
  FIXTURE_SEED,
  FIXTURE_STEPS,
  fixtureCheckpointDigest,
  fixtureEpisodeId,
  writeEvalFixture,
} from "../fixture";

let context: AppContext;
let versionId: string;
let endpointId: string;

const CANDIDATE_EPISODE = fixtureEpisodeId(
  "richmond.ped-crossing.v1",
  FIXTURE_CANDIDATE_POLICY_ID,
  FIXTURE_SEED,
);

function params<T extends Record<string, unknown>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

const request = (url: string) => new Request(`http://localhost${url}`);

before(async () => {
  context = await bootModelTestDatabase();
  await writeEvalFixture(TEST_RUNS_ROOT);
  // Register the fixture's candidate policy so the digest join resolves.
  const version = await createModelVersion(context, {
    family: "alpamayo",
    name: "Alpamayo R1 10B nf4 (fixture candidate)",
    source: "nvidia/Alpamayo-R1-10B",
    checkpointDigest: fixtureCheckpointDigest(FIXTURE_CANDIDATE_POLICY_ID),
    quant: "nf4",
    license: "nvidia-open-model",
  });
  assert.equal(version.kind, "created");
  if (version.kind !== "created") return;
  versionId = version.version.id;
  const endpoint = await createModelEndpoint(context, {
    modelVersionId: versionId,
    name: "echo",
    descriptor: echoEndpointDescriptor("worker/testing/echo-endpoint.mjs"),
  });
  assert.equal(endpoint.kind, "created");
  if (endpoint.kind === "created") endpointId = endpoint.endpoint.id;
}, { timeout: 240_000 });

test("campaign list aggregates the ledger per policy and joins the registry", async () => {
  const response = await getCampaigns();
  assert.equal(response.status, 200);
  const body = (await response.json()) as { campaigns: EvalCampaignSummary[] };
  const campaign = body.campaigns.find((entry) => entry.campaignId === FIXTURE_CAMPAIGN_ID);
  assert.ok(campaign, "fixture campaign listed");
  assert.equal(campaign.episodes, 6);
  assert.equal(campaign.hasReport, true);
  assert.equal(campaign.policies.length, 2);

  const baseline = campaign.policies.find((p) => p.policyId === FIXTURE_BASELINE_POLICY_ID)!;
  const candidate = campaign.policies.find((p) => p.policyId === FIXTURE_CANDIDATE_POLICY_ID)!;
  assert.equal(baseline.episodes, 3);
  // (0.924 + 0.71 + 0.846) / 3
  assert.ok(Math.abs(baseline.meanScore - 0.8266666) < 1e-4);
  // Only the candidate digest is registered.
  assert.equal(baseline.modelVersionId, null);
  assert.equal(candidate.modelVersionId, versionId);
});

test("campaign detail 404s for unknown and path-like ids", async () => {
  const missing = await getCampaign(request("/x"), params({ campaignId: "nope" }));
  assert.equal(missing.status, 404);
  const traversal = await getCampaign(request("/x"), params({ campaignId: "../evil" }));
  assert.equal(traversal.status, 404);
});

test("policy detail lists episodes with parsed scores", async () => {
  const response = await getPolicy(
    request("/x"),
    params({ campaignId: FIXTURE_CAMPAIGN_ID, policyId: FIXTURE_BASELINE_POLICY_ID }),
  );
  assert.equal(response.status, 200);
  const detail = (await response.json()) as EvalPolicyDetail;
  assert.equal(detail.episodes.length, 3);
  const pedCrossing = detail.episodes.find((e) => e.scenarioId === "richmond.ped-crossing.v1")!;
  assert.equal(pedCrossing.score?.drivingScore, 0.71);
  assert.deepEqual(pedCrossing.score?.infractions, { "ttc-critical": 1 });
  assert.ok(detail.provenanceSample, "provenance sample present");
  assert.equal(detail.provenanceSample?.policy.policyId, FIXTURE_BASELINE_POLICY_ID);
});

test("episode payload normalizes trace decisions and keeps events", async () => {
  const response = await getEpisode(
    request("/x"),
    params({ campaignId: FIXTURE_CAMPAIGN_ID, episodeId: CANDIDATE_EPISODE }),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as EvalEpisodePayload;
  assert.equal(payload.complete, true);
  // reset + summary lines dropped, decisions kept.
  assert.equal(payload.ticks.length, FIXTURE_STEPS);
  assert.equal(payload.ticks[0].step, 0);
  assert.ok(typeof payload.ticks[0].x === "number");
  assert.ok(payload.ticks[0].reasoning, "decision 0 carries reasoning text");
  assert.equal(payload.ticks[1].reasoning, null);
  assert.ok(payload.ticks[0].thumbs?.front, "candidate episode has thumbnails");
  assert.ok(payload.events.length >= 3);
  assert.ok(payload.score);
  assert.ok(payload.provenance);
});

test("frame route serves episode-jailed images only", async () => {
  const thumb = ["frames", "front", "000000.png"];
  const ok = await getFrame(
    request("/x"),
    params({
      campaignId: FIXTURE_CAMPAIGN_ID,
      episodeId: CANDIDATE_EPISODE,
      framePath: thumb,
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.ok((await ok.arrayBuffer()).byteLength > 0);

  const nonImage = await getFrame(
    request("/x"),
    params({
      campaignId: FIXTURE_CAMPAIGN_ID,
      episodeId: CANDIDATE_EPISODE,
      framePath: ["..", "..", "ledger.jsonl"],
    }),
  );
  assert.equal(nonImage.status, 404);

  const traversalPng = await getFrame(
    request("/x"),
    params({
      campaignId: FIXTURE_CAMPAIGN_ID,
      episodeId: CANDIDATE_EPISODE,
      framePath: [
        "..",
        fixtureEpisodeId("richmond.signal-left.v2", FIXTURE_CANDIDATE_POLICY_ID, FIXTURE_SEED),
        "frames",
        "front",
        "000000.png",
      ],
    }),
  );
  assert.equal(traversalPng.status, 404);
});

test("compare reports per-scenario deltas and the divergence step", async () => {
  const response = await getCompare(
    request(
      `/api/evaluation/campaigns/${FIXTURE_CAMPAIGN_ID}/compare` +
        `?a=${FIXTURE_BASELINE_POLICY_ID}&b=${FIXTURE_CANDIDATE_POLICY_ID}`,
    ),
    params({ campaignId: FIXTURE_CAMPAIGN_ID }),
  );
  assert.equal(response.status, 200);
  const comparison = (await response.json()) as EvalRunComparison;
  assert.equal(comparison.episodes.length, 3);

  const pedCrossing = comparison.episodes.find(
    (episode) => episode.scenarioId === "richmond.ped-crossing.v1",
  )!;
  // Candidate drifts laterally after step 60 → divergence detected shortly after.
  assert.ok(pedCrossing.divergenceStep !== null, "ped-crossing diverges");
  assert.ok(pedCrossing.divergenceStep! > FIXTURE_DIVERGENCE_AFTER_STEP);
  assert.ok(Math.abs(pedCrossing.scoreDelta! - (0.885 - 0.71)) < 1e-9);

  // signal-left has no drift and both fixture traces share the generator
  // phase, so its traces are identical → no divergence.
  const signalLeft = comparison.episodes.find(
    (episode) => episode.scenarioId === "richmond.signal-left.v2",
  )!;
  assert.equal(signalLeft.divergenceStep, null);
  assert.equal(typeof signalLeft.scoreDelta, "number");

  const missing = await getCompare(
    request(`/api/evaluation/campaigns/${FIXTURE_CAMPAIGN_ID}/compare?a=x&b=y`),
    params({ campaignId: FIXTURE_CAMPAIGN_ID }),
  );
  assert.equal(missing.status, 404);

  const badQuery = await getCompare(
    request(`/api/evaluation/campaigns/${FIXTURE_CAMPAIGN_ID}/compare?a=x`),
    params({ campaignId: FIXTURE_CAMPAIGN_ID }),
  );
  assert.equal(badQuery.status, 400);
});

test("promotion gate: queued run refused, succeeded run promotes", async () => {
  const runInput = (seed: number) =>
    CreateModelRunSchema.parse({
      modelVersionId: versionId,
      endpointId,
      kind: "openloop",
      params: { input: { items: [{ prompt: "fixture" }] } },
      seed,
    });

  // Oldest-first lease: create the to-be-succeeded run first.
  const toSucceed = await createModelRun(context, runInput(2));
  assert.equal(toSucceed.kind, "created");
  if (toSucceed.kind !== "created") return;
  const lease = (await leaseNextModelRun({ workerId: "eval-tab-test", kinds: ["openloop"] }))!;
  assert.equal(lease.runId, toSucceed.run.id);
  await completeModelRun(lease, { metrics: {}, outputRefs: [] });

  const queued = await createModelRun(context, runInput(1));
  assert.equal(queued.kind, "created");
  if (queued.kind !== "created") return;

  const promoteRequest = (runId: string) =>
    new Request(`http://localhost/api/models/versions/${versionId}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });

  const refused = await postPromote(promoteRequest(queued.run.id), params({ versionId }));
  assert.equal(refused.status, 409);
  const refusal = (await refused.json()) as { error: string; detail?: string };
  assert.equal(refusal.error, "promotion_requires_succeeded_eval_run");
  assert.ok(refusal.detail, "refusal carries the gate's reason");

  const promoted = await postPromote(promoteRequest(toSucceed.run.id), params({ versionId }));
  assert.equal(promoted.status, 200);
  const version = (await promoted.json()) as { status: string; promotedRunId: string };
  assert.equal(version.status, "promoted");
  assert.equal(version.promotedRunId, toSucceed.run.id);
});
