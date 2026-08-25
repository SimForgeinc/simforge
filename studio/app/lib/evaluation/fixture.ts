import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  EVAL_EVENTS_SCHEMA,
  EVAL_PROVENANCE_SCHEMA,
  EVAL_REPORT_SCHEMA,
  EVAL_SCORE_SCHEMA,
  type EvalEvent,
} from "./contracts";

/**
 * Deterministic eval-campaign fixture in EvalLane's wave-3 layout: one
 * campaign, two policies (baseline vs candidate), three scenarios, one seed —
 * six episode directories. The candidate trace deliberately drifts from the
 * baseline mid-episode in `ped-crossing` so the A/B divergence detector has
 * something real to find. Used by the API tests and by
 * `scripts/seed-eval-fixture.ts` for browser verification.
 */

export const FIXTURE_CAMPAIGN_ID = "fixture-richmond-nightly";
export const FIXTURE_BASELINE_POLICY_ID = "alpamayo-nf4-base";
export const FIXTURE_CANDIDATE_POLICY_ID = "alpamayo-nf4-cand";
export const FIXTURE_SEED = 7;
export const FIXTURE_STEPS = 120;
export const DECISION_HZ = 10;
/** Candidate trace veers off after this step in ped-crossing. */
export const FIXTURE_DIVERGENCE_AFTER_STEP = 60;

export const FIXTURE_SCENARIOS = [
  { scenarioId: "richmond.signal-left.v2", name: "Signalized left turn" },
  { scenarioId: "richmond.ped-crossing.v1", name: "Pedestrian crossing" },
  { scenarioId: "richmond.merge-dense.v3", name: "Dense merge" },
] as const;

export function fixtureEpisodeId(scenarioId: string, policyId: string, seed: number): string {
  return `${scenarioId}__${policyId}__seed${seed}`;
}

/** Digest a policy's weights would hash to; the registry seed uses the same value. */
export function fixtureCheckpointDigest(policyId: string): string {
  return createHash("sha256").update(`simforge-fixture:${policyId}`).digest("hex");
}

type TraceLine = {
  step: number;
  t: number;
  a: number[];
  miss: boolean;
  applied: number[];
  rw: number;
  term: boolean;
  trunc: boolean;
  sv: number[];
  objs: Array<[string, number, number, number, number]>;
  terms: [number, number, number];
  digest: string;
  timing: { infer_ms: number; roundtrip_ms: number };
  reasoning?: string;
  frames?: { thumbs: Record<string, string> };
};

type PolicySpec = {
  policyId: string;
  kind: string;
  driftPerStep: number;
  seedPhase: number;
  withThumbs: boolean;
  perScenario: Record<
    string,
    { drivingScore: number; routeCompletion: number; infractions: Record<string, number> }
  >;
};

function buildTrace(spec: PolicySpec, scenarioIndex: number, drifts: boolean): TraceLine[] {
  const lines: TraceLine[] = [];
  for (let step = 0; step < FIXTURE_STEPS; step += 1) {
    const t = step / DECISION_HZ;
    const speed = 6 + 2.5 * Math.sin(t * 0.7 + spec.seedPhase + scenarioIndex);
    const drift =
      drifts && step > FIXTURE_DIVERGENCE_AFTER_STEP
        ? (step - FIXTURE_DIVERGENCE_AFTER_STEP) * spec.driftPerStep
        : 0;
    const x = t * speed * 0.9;
    const y = 3.2 * Math.sin(t * 0.35 + scenarioIndex) + drift;
    const heading = 0.35 * Math.cos(t * 0.35 + scenarioIndex);
    const steer = 0.2 * Math.sin(t * 0.9);
    const line: TraceLine = {
      step,
      t: Number(t.toFixed(3)),
      a: [Number(steer.toFixed(4)), Number((0.4 + 0.2 * Math.sin(t)).toFixed(3))],
      miss: false,
      applied: [Number(steer.toFixed(4)), Number((0.4 + 0.2 * Math.sin(t)).toFixed(3))],
      rw: Number((0.8 + 0.15 * Math.sin(t * 1.3)).toFixed(4)),
      term: false,
      trunc: step === FIXTURE_STEPS - 1,
      sv: [
        Number(x.toFixed(3)),
        Number(y.toFixed(3)),
        Number(Math.cos(heading).toFixed(5)),
        Number(Math.sin(heading).toFixed(5)),
        Number(speed.toFixed(3)),
        Number((0.3 * Math.cos(t * 0.7)).toFixed(3)),
        Number((y * 0.1).toFixed(3)),
        Number((0.05 * Math.cos(t)).toFixed(4)),
        Number((t * speed).toFixed(2)),
        Number((18 - 6 * Math.sin(t * 0.5)).toFixed(2)),
      ],
      objs: [["veh-12", Number((18 - 6 * Math.sin(t * 0.5)).toFixed(2)), 0.12, -0.4, 1]],
      terms: [0.6, 0.25, 0.15],
      digest: createHash("sha256").update(`${spec.policyId}:${scenarioIndex}:${step}`).digest("hex").slice(0, 16),
      timing: { infer_ms: Number((22 + 6 * ((step % 5) / 5)).toFixed(1)), roundtrip_ms: Number((28 + 6 * ((step % 5) / 5)).toFixed(1)) },
    };
    // Reasoning text every 10th decision (1 Hz), exercising the playback panel.
    if (step % 10 === 0) {
      line.reasoning =
        `[${spec.policyId}] t=${line.t}s: tracking lane center at ${speed.toFixed(1)} m/s. ` +
        (step <= FIXTURE_DIVERGENCE_AFTER_STEP
          ? "Signal green, proceeding through the junction with a 1.8 s headway on veh-12."
          : drifts && spec.driftPerStep > 0
            ? "Yielding wide around the crossing pedestrian, biasing left of the reference line."
            : "Reference line clear, no conflicting agents inside the planning horizon.");
    }
    lines.push(line);
  }
  return lines;
}

/** 64x36 RGB gradient PNG whose hue tracks the step so scrubbing is visible. */
function thumbPng(step: number, camIndex: number): Promise<Buffer> {
  const width = 64;
  const height = 36;
  const raw = Buffer.alloc(width * height * 3);
  for (let yPix = 0; yPix < height; yPix += 1) {
    for (let xPix = 0; xPix < width; xPix += 1) {
      const offset = (yPix * width + xPix) * 3;
      raw[offset] = (step * 2 + xPix * 3) % 256;
      raw[offset + 1] = (80 + camIndex * 90 + yPix * 4) % 256;
      raw[offset + 2] = (200 - step + xPix) % 256;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function eventsFor(episodeId: string, infractions: Record<string, number>): EvalEvent[] {
  const events: EvalEvent[] = [
    { type: "episode-start", tick: 0, tS: 0, severity: "info", position: null },
    { type: "signal-green", tick: 40, tS: 4, severity: "info", position: { x: 21.4, y: 2.9 } },
  ];
  let tick = 50;
  for (const [type, count] of Object.entries(infractions)) {
    for (let index = 0; index < count; index += 1) {
      tick += 24;
      events.push({
        type,
        tick,
        tS: tick / DECISION_HZ,
        severity: "infraction",
        position: { x: tick * 0.5, y: 1.2 },
        data: { episodeId },
      });
    }
  }
  events.push({
    type: "goal-reached",
    tick: FIXTURE_STEPS - 1,
    tS: (FIXTURE_STEPS - 1) / DECISION_HZ,
    severity: "info",
    position: null,
  });
  return events;
}

async function writeEpisode(
  campaignDir: string,
  spec: PolicySpec,
  scenario: (typeof FIXTURE_SCENARIOS)[number],
  scenarioIndex: number,
): Promise<{ ledgerLine: Record<string, unknown> }> {
  const episodeId = fixtureEpisodeId(scenario.scenarioId, spec.policyId, FIXTURE_SEED);
  const dir = join(campaignDir, episodeId);
  await mkdir(dir, { recursive: true });

  const drifts = scenario.scenarioId === "richmond.ped-crossing.v1";
  const trace = buildTrace(spec, scenarioIndex, drifts);

  if (spec.withThumbs) {
    for (const [camIndex, cam] of ["front", "rear"].entries()) {
      await mkdir(join(dir, "frames", cam), { recursive: true });
      for (const line of trace) {
        if (line.step % 10 !== 0) continue;
        const rel = join("frames", cam, `${String(line.step).padStart(6, "0")}.png`);
        await writeFile(join(dir, rel), await thumbPng(line.step, camIndex));
        line.frames = { thumbs: { ...(line.frames?.thumbs ?? {}), [cam]: rel } };
      }
    }
  }

  const scoreSpec = spec.perScenario[scenario.scenarioId];
  if (!scoreSpec) throw new Error(`fixture: no score spec for ${scenario.scenarioId}`);
  const traceBody =
    JSON.stringify({ reset: { episodeId, seed: FIXTURE_SEED, scenarioId: scenario.scenarioId } }) +
    "\n" +
    trace.map((line) => JSON.stringify(line)).join("\n") +
    "\n" +
    JSON.stringify({ summary: { episode_digest: createHash("sha256").update(episodeId).digest("hex") } }) +
    "\n";
  await writeFile(join(dir, "trace.jsonl"), traceBody);
  const traceSha256 = createHash("sha256").update(traceBody).digest("hex");

  await writeFile(
    join(dir, "events.json"),
    JSON.stringify(
      { schema: EVAL_EVENTS_SCHEMA, episodeId, events: eventsFor(episodeId, scoreSpec.infractions) },
      null,
      2,
    ),
  );
  await writeFile(
    join(dir, "score.json"),
    JSON.stringify(
      {
        schema: EVAL_SCORE_SCHEMA,
        episodeId,
        scenarioId: scenario.scenarioId,
        policyId: spec.policyId,
        seed: FIXTURE_SEED,
        drivingScore: scoreSpec.drivingScore,
        routeCompletion: scoreSpec.routeCompletion,
        penaltyProduct: Number((scoreSpec.drivingScore / Math.max(scoreSpec.routeCompletion, 1e-6)).toFixed(4)),
        infractions: scoreSpec.infractions,
        ttc: { minTtcS: 2.4, criticalCount: Object.keys(scoreSpec.infractions).length > 0 ? 1 : 0 },
        comfort: { maxAbsAccelMps2: 2.1, maxAbsJerkMps3: 3.4, accelViolations: 0, jerkViolations: 0 },
        terminal: { collision: false, goal: true },
        steps: FIXTURE_STEPS,
        deadlineMisses: 0,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(dir, "provenance.json"),
    JSON.stringify(
      {
        schema: EVAL_PROVENANCE_SCHEMA,
        campaignId: FIXTURE_CAMPAIGN_ID,
        episodeId,
        scenario: { scenarioId: scenario.scenarioId, spec: `${scenario.scenarioId}.json`, fixtureSha256: "0".repeat(64), session: "fixture" },
        policy: {
          policyId: spec.policyId,
          kind: spec.kind,
          checkpointDigest: fixtureCheckpointDigest(spec.policyId),
          adapterVersion: "fixture-1",
        },
        seed: FIXTURE_SEED,
        policySeed: FIXTURE_SEED,
        decisionHz: DECISION_HZ,
        schedule: { steps: FIXTURE_STEPS, deadlineMs: 100, fallback: "hold", forceMissAt: null },
        episodeDigest: createHash("sha256").update(episodeId).digest("hex"),
        traceSha256,
        createdAt: "2026-08-24T04:00:00.000Z",
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(dir, "runner-summary.json"),
    JSON.stringify({ episodeId, steps: FIXTURE_STEPS, wallS: FIXTURE_STEPS / DECISION_HZ }, null, 2),
  );
  await writeFile(join(dir, "COMPLETE"), "");

  return {
    ledgerLine: {
      episodeId,
      scenarioId: scenario.scenarioId,
      policyId: spec.policyId,
      seed: FIXTURE_SEED,
      status: "complete",
      drivingScore: scoreSpec.drivingScore,
      routeCompletion: scoreSpec.routeCompletion,
      traceSha256,
      episodeDigest: createHash("sha256").update(episodeId).digest("hex"),
      completedAt: `2026-08-24T04:${String(10 + scenarioIndex).padStart(2, "0")}:00.000Z`,
    },
  };
}

/** Write the whole fixture campaign under `runsRootDir`. */
export async function writeEvalFixture(
  runsRootDir: string,
): Promise<{ campaignId: string; policyIds: [string, string] }> {
  const campaignDir = join(runsRootDir, FIXTURE_CAMPAIGN_ID);
  await mkdir(campaignDir, { recursive: true });

  const baseline: PolicySpec = {
    policyId: FIXTURE_BASELINE_POLICY_ID,
    kind: "alpamayo-nf4",
    driftPerStep: 0,
    seedPhase: 0,
    withThumbs: false,
    perScenario: {
      "richmond.signal-left.v2": { drivingScore: 0.924, routeCompletion: 1, infractions: {} },
      "richmond.ped-crossing.v1": {
        drivingScore: 0.71,
        routeCompletion: 0.97,
        infractions: { "ttc-critical": 1 },
      },
      "richmond.merge-dense.v3": {
        drivingScore: 0.846,
        routeCompletion: 1,
        infractions: { "off-road": 1 },
      },
    },
  };
  const candidate: PolicySpec = {
    policyId: FIXTURE_CANDIDATE_POLICY_ID,
    kind: "alpamayo-nf4",
    driftPerStep: 0.08,
    // Same phase as baseline: pre-drift traces are identical, so the A/B
    // divergence detector keys on the deliberate ped-crossing drift alone.
    seedPhase: 0,
    withThumbs: true,
    perScenario: {
      "richmond.signal-left.v2": { drivingScore: 0.931, routeCompletion: 1, infractions: {} },
      "richmond.ped-crossing.v1": { drivingScore: 0.885, routeCompletion: 1, infractions: {} },
      "richmond.merge-dense.v3": {
        drivingScore: 0.792,
        routeCompletion: 0.98,
        infractions: { "off-road": 1, "accel-bound": 1 },
      },
    },
  };

  const ledgerLines: Record<string, unknown>[] = [];
  for (const spec of [baseline, candidate]) {
    for (const [scenarioIndex, scenario] of FIXTURE_SCENARIOS.entries()) {
      const { ledgerLine } = await writeEpisode(campaignDir, spec, scenario, scenarioIndex);
      ledgerLines.push(ledgerLine);
    }
  }

  await writeFile(
    join(campaignDir, "campaign.json"),
    JSON.stringify(
      {
        campaignId: FIXTURE_CAMPAIGN_ID,
        name: "Richmond nightly — Alpamayo NF4 (fixture)",
        createdAt: "2026-08-24T04:00:00.000Z",
        scenarios: FIXTURE_SCENARIOS.map((scenario) => scenario.scenarioId),
        policies: [FIXTURE_BASELINE_POLICY_ID, FIXTURE_CANDIDATE_POLICY_ID],
        seeds: [FIXTURE_SEED],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(campaignDir, "ledger.jsonl"),
    ledgerLines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );

  const perScenario = [];
  for (const spec of [baseline, candidate]) {
    for (const scenario of FIXTURE_SCENARIOS) {
      const cell = spec.perScenario[scenario.scenarioId];
      if (!cell) throw new Error(`fixture: no score spec for ${scenario.scenarioId}`);
      perScenario.push({
        scenarioId: scenario.scenarioId,
        policyId: spec.policyId,
        episodes: 1,
        meanDrivingScore: cell.drivingScore,
        meanRouteCompletion: cell.routeCompletion,
        infractions: cell.infractions,
      });
    }
  }
  const allScores = perScenario.map((cell) => cell.meanDrivingScore);
  await writeFile(
    join(campaignDir, "report.json"),
    JSON.stringify(
      {
        schema: EVAL_REPORT_SCHEMA,
        campaignId: FIXTURE_CAMPAIGN_ID,
        perScenario,
        aggregate: {
          drivingScore: Number((allScores.reduce((sum, s) => sum + s, 0) / allScores.length).toFixed(4)),
          episodes: perScenario.length,
        },
        infractionHistogram: { "ttc-critical": 1, "off-road": 2, "accel-bound": 1 },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(campaignDir, "report.md"),
    `# ${FIXTURE_CAMPAIGN_ID}\n\nFixture campaign for the Studio evaluation tab.\n`,
  );

  return {
    campaignId: FIXTURE_CAMPAIGN_ID,
    policyIds: [FIXTURE_BASELINE_POLICY_ID, FIXTURE_CANDIDATE_POLICY_ID],
  };
}
