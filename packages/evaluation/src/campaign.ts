/**
 * Closed-loop evaluation campaigns: scenario × seed × policy episode grids
 * run SEQUENTIALLY through the policy_step reference runner
 * (`adapters/policy-runner`), scored by `scoring.ts`, persisted as
 * immutable per-episode artifact directories with an append-only ledger.
 *
 * Layout (under `<runsRoot>/<campaignId>/`):
 *
 *   campaign.json      frozen resolved spec (fixture digests pin immutability)
 *   ledger.jsonl       append-only; one line per completed episode
 *                      (readers take the LAST line per episodeId)
 *   report.json/.md    aggregation (written by `writeReport`)
 *   <episodeId>/       episodeId = <scenarioId>__<policyId>__seed<seed>
 *     trace.jsonl        policy-runner rich trace
 *     runner-summary.json  runner stdout (episode digest, checkpoint, timing)
 *     events.json        per-event records (tick + position)
 *     score.json         route-completion × infraction-penalty score
 *     provenance.json    checkpoint digest, adapter version, seed, schedule
 *     COMPLETE           marker written last; dirs without it are rerun
 *
 * Kill/resume is idempotent: completed episodes are recognized by their
 * COMPLETE marker and skipped; anything else is wiped and rerun. Reruns of
 * a completed episode (`rerunEpisode`) go to a scratch dir and must
 * reproduce the stored `episode_digest` byte-for-byte for deterministic
 * policies.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  parseTraceJsonl,
  scoreEpisode,
  type EpisodeScore,
  type InfractionType,
  type ScenarioScoringContext,
  type ScoringConfig,
} from './scoring.js';

/** `packages/evaluation/src` → repo root (mirrors compiler/src/maps.ts). */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const RUNNER_DIR = path.join(REPO_ROOT, 'adapters', 'policy-runner');

/** Engine default when a lane names no limit (lane-graph DEFAULT_SPEED_LIMIT_MPS). */
const DEFAULT_SPEED_LIMIT_MPS = 13.4;

/* ------------------------------------------------------------------ config */

const scenarioSchema = z.object({
  scenarioId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Episode spec file for the env-server, relative to the config file. */
  spec: z.string(),
  /** Env session (scenario instance) index inside the spec. */
  session: z.number().int().nonnegative().default(0),
  /** Decision budget per episode. */
  steps: z.number().int().positive(),
  /** Route-completion denominator; null derives cruiseSpeed × clipSeconds. */
  expectedRouteM: z.number().positive().nullable().default(null),
  /** Authored speed limit override; null derives it from the fixture topology. */
  speedLimitMps: z.number().positive().nullable().default(null),
  /** Per-scenario scoring overrides (thresholds, penalty factors). */
  scoring: z.record(z.string(), z.unknown()).default({}),
});

const policySchema = z.object({
  policyId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Runner policy name (`--policy`). */
  runnerPolicy: z.enum(['scripted', 'torch']),
  policySeed: z.number().int().nonnegative().default(0),
  deadlineMs: z.number().positive().default(50),
  fallback: z.enum(['repeat-last', 'zero-control', 'scripted']).default('zero-control'),
  forceMissAt: z.array(z.number().int().nonnegative()).default([]),
});

export const campaignConfigSchema = z.object({
  campaignId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  runsRoot: z.string().default('~/simforge-assets/runs'),
  decisionHz: z.number().int().positive().default(10),
  suite: z.array(scenarioSchema).min(1),
  seeds: z.array(z.union([z.number().int(), z.string()])).min(1),
  policies: z.array(policySchema).min(1),
});

export type CampaignConfig = z.infer<typeof campaignConfigSchema>;
export type CampaignScenario = z.infer<typeof scenarioSchema>;
export type CampaignPolicy = z.infer<typeof policySchema>;

export interface EpisodePlan {
  readonly episodeId: string;
  readonly scenario: CampaignScenario;
  readonly policy: CampaignPolicy;
  readonly seed: number | string;
}

export interface ResolvedCampaign {
  readonly config: CampaignConfig;
  readonly configDir: string;
  readonly campaignDir: string;
  readonly episodes: readonly EpisodePlan[];
  /** scenarioId → derived scoring context + fixture digest. */
  readonly scenarios: ReadonlyMap<string, ResolvedScenario>;
}

export interface ResolvedScenario {
  readonly scenario: CampaignScenario;
  readonly specPath: string;
  readonly fixtureSha256: string;
  readonly context: ScenarioScoringContext;
  readonly scoring: Partial<ScoringConfig>;
}

/* ------------------------------------------------- fixture context derivation */

interface FixtureFacts {
  readonly actorKinds: Record<string, string>;
  readonly egoId: string | null;
  readonly cruiseSpeedMps: number | null;
  readonly clipSeconds: number | null;
  readonly signalsPresent: boolean;
  readonly speedLimitMps: number;
}

/**
 * Pull the authored facts scoring needs out of an episode spec (form A).
 * Mirrors the env-server's instance resolution for inline/path instances.
 */
async function fixtureFacts(specPath: string, session: number): Promise<FixtureFacts> {
  const specDir = path.dirname(specPath);
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as Record<string, unknown>;
  const instances = spec['instances'];
  if (!Array.isArray(instances) || instances.length <= session) {
    throw new Error(`${specPath}: no instance ${session} (campaigns need form-A specs)`);
  }
  let entry: unknown = instances[session];
  if (typeof entry === 'string') {
    entry = { input: entry };
  }
  const entryObj = entry as { input: unknown; topology?: unknown };
  let input = entryObj.input;
  if (typeof input === 'string') {
    input = JSON.parse(await readFile(path.resolve(specDir, input), 'utf8'));
  }
  // Unwrap the CLI's scenario-instance envelope.
  const inputObj = input as Record<string, unknown>;
  const unwrapped = (
    inputObj['kind'] === 'scenario-instance' && inputObj['input'] !== undefined
      ? inputObj['input']
      : inputObj
  ) as Record<string, unknown>;

  const actors = Array.isArray(unwrapped['actors']) ? (unwrapped['actors'] as Array<Record<string, unknown>>) : [];
  const actorKinds: Record<string, string> = {};
  for (const actor of actors) {
    if (typeof actor['id'] === 'string' && typeof actor['kind'] === 'string') {
      actorKinds[actor['id']] = actor['kind'];
    }
  }
  const vehicleIds = actors
    .filter((a) => a['kind'] === 'vehicle' && typeof a['id'] === 'string')
    .map((a) => a['id'] as string)
    .sort();
  const egoId = typeof unwrapped['metricSubject'] === 'string' ? unwrapped['metricSubject'] : vehicleIds[0] ?? null;
  const ego = actors.find((a) => a['id'] === egoId);
  const behavior = (ego?.['behavior'] ?? {}) as Record<string, unknown>;
  const initial = (ego?.['initial'] ?? {}) as Record<string, unknown>;
  const cruiseSpeedMps =
    typeof behavior['cruiseSpeedMps'] === 'number'
      ? behavior['cruiseSpeedMps']
      : typeof initial['speedMps'] === 'number'
        ? initial['speedMps']
        : null;

  const conditions = (unwrapped['operationalConditions'] ?? {}) as Record<string, unknown>;
  const effects = (conditions['effects'] ?? {}) as Record<string, unknown>;
  const trafficSpeedFactor = typeof effects['trafficSpeedFactor'] === 'number' ? effects['trafficSpeedFactor'] : 1;

  // Authored limit: the ego route's start lane, else any lane, else default.
  let topology = entryObj.topology ?? spec['topology'];
  if (typeof topology === 'string') {
    topology = JSON.parse(await readFile(path.resolve(specDir, topology), 'utf8'));
  }
  const lanes = ((topology as Record<string, unknown> | undefined)?.['lanes'] ?? {}) as Record<
    string,
    { speedLimitKph?: number | null }
  >;
  const route = (behavior['route'] ?? {}) as Record<string, unknown>;
  const startRsl = typeof route['startRsl'] === 'string' ? route['startRsl'] : null;
  const laneLimits = Object.values(lanes)
    .map((l) => l.speedLimitKph)
    .filter((v): v is number => typeof v === 'number' && v > 0);
  const startLimit = startRsl ? lanes[startRsl]?.speedLimitKph : undefined;
  const limitKph = typeof startLimit === 'number' && startLimit > 0 ? startLimit : laneLimits[0];
  const speedLimitMps = (limitKph !== undefined ? limitKph / 3.6 : DEFAULT_SPEED_LIMIT_MPS) * trafficSpeedFactor;

  return {
    actorKinds,
    egoId,
    cruiseSpeedMps,
    clipSeconds: typeof unwrapped['clipSeconds'] === 'number' ? unwrapped['clipSeconds'] : null,
    signalsPresent: Array.isArray(unwrapped['signalPrograms']) && unwrapped['signalPrograms'].length > 0,
    speedLimitMps,
  };
}

/* ---------------------------------------------------------------- resolution */

export async function resolveCampaign(configPath: string): Promise<ResolvedCampaign> {
  const absConfig = path.resolve(configPath);
  const configDir = path.dirname(absConfig);
  const config = campaignConfigSchema.parse(JSON.parse(await readFile(absConfig, 'utf8')));

  const runsRoot = config.runsRoot.startsWith('~')
    ? path.join(os.homedir(), config.runsRoot.slice(1))
    : path.resolve(configDir, config.runsRoot);
  const campaignDir = path.join(runsRoot, config.campaignId);

  const scenarios = new Map<string, ResolvedScenario>();
  for (const scenario of config.suite) {
    if (scenarios.has(scenario.scenarioId)) throw new Error(`duplicate scenarioId ${scenario.scenarioId}`);
    const specPath = path.resolve(configDir, scenario.spec);
    const fixtureSha256 = createHash('sha256').update(await readFile(specPath)).digest('hex');
    const facts = await fixtureFacts(specPath, scenario.session);
    const expectedRouteM =
      scenario.expectedRouteM ??
      (facts.cruiseSpeedMps !== null && facts.clipSeconds !== null
        ? facts.cruiseSpeedMps * facts.clipSeconds
        : null);
    scenarios.set(scenario.scenarioId, {
      scenario,
      specPath,
      fixtureSha256,
      context: {
        decisionHz: config.decisionHz,
        actorKinds: facts.actorKinds,
        speedLimitMps: scenario.speedLimitMps ?? facts.speedLimitMps,
        expectedRouteM,
      },
      scoring: scenario.scoring as Partial<ScoringConfig>,
    });
  }

  // Sequential grid: scenario-major, then policy, then seed.
  const episodes: EpisodePlan[] = [];
  for (const scenario of config.suite) {
    for (const policy of config.policies) {
      for (const seed of config.seeds) {
        episodes.push({
          episodeId: `${scenario.scenarioId}__${policy.policyId}__seed${seed}`,
          scenario,
          policy,
          seed,
        });
      }
    }
  }
  return { config, configDir, campaignDir, episodes, scenarios };
}

/* ------------------------------------------------------------------ episodes */

export interface EpisodeRunResult {
  readonly episodeId: string;
  readonly status: 'complete' | 'skipped';
  readonly drivingScore: number | null;
  readonly episodeDigest: string | null;
}

interface RunnerOutcome {
  readonly summary: Record<string, unknown>;
  readonly traceText: string;
  readonly traceSha256: string;
}

/** Run one episode through the policy_step reference runner into `dir`. */
function invokeRunner(campaign: ResolvedCampaign, plan: EpisodePlan, dir: string): RunnerOutcome {
  const resolved = campaign.scenarios.get(plan.scenario.scenarioId)!;
  const tracePath = path.join(dir, 'trace.jsonl');
  const args = [
    '-m', 'simforge_policy_runner',
    '--spec', resolved.specPath,
    '--session', String(plan.scenario.session),
    '--policy', plan.policy.runnerPolicy,
    '--seed', String(plan.seed),
    '--policy-seed', String(plan.policy.policySeed),
    '--steps', String(plan.scenario.steps),
    '--deadline-ms', String(plan.policy.deadlineMs),
    '--fallback', plan.policy.fallback,
    '--decision-hz', String(campaign.config.decisionHz),
    '--out', tracePath,
    ...plan.policy.forceMissAt.flatMap((s) => ['--force-miss-at', String(s)]),
  ];
  const proc = spawnSync('python3', args, {
    cwd: RUNNER_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    throw new Error(
      `policy-runner failed for ${plan.episodeId} (exit ${String(proc.status)}):\n${proc.stderr ?? ''}`,
    );
  }
  const summary = JSON.parse(proc.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
  const traceBytes = readFileSync(tracePath);
  return {
    summary,
    traceText: traceBytes.toString('utf8'),
    traceSha256: createHash('sha256').update(traceBytes).digest('hex'),
  };
}

/** Adapter identity for provenance: policy-runner package version + git HEAD. */
function adapterVersion(): { version: string; gitSha: string | null } {
  let version = 'unknown';
  try {
    const pyproject = readFileSync(path.join(RUNNER_DIR, 'pyproject.toml'), 'utf8');
    version = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? 'unknown';
  } catch {
    /* provenance stays 'unknown' */
  }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { version, gitSha: git.status === 0 ? git.stdout.trim() : null };
}

async function writeEpisodeArtifacts(
  campaign: ResolvedCampaign,
  plan: EpisodePlan,
  dir: string,
  outcome: RunnerOutcome,
): Promise<{ score: EpisodeScore }> {
  const resolved = campaign.scenarios.get(plan.scenario.scenarioId)!;
  const trace = parseTraceJsonl(outcome.traceText);
  const score = scoreEpisode(trace, resolved.context, resolved.scoring);

  const events = {
    schema: 'simforge.eval-events/v1',
    episodeId: plan.episodeId,
    events: score.events,
  };
  const scoreDoc = {
    schema: 'simforge.eval-score/v1',
    episodeId: plan.episodeId,
    scenarioId: plan.scenario.scenarioId,
    policyId: plan.policy.policyId,
    seed: plan.seed,
    drivingScore: score.drivingScore,
    routeCompletion: score.routeCompletion,
    penaltyProduct: score.penaltyProduct,
    infractions: score.infractions,
    ttc: score.ttc,
    comfort: score.comfort,
    terminal: score.terminal,
    steps: score.steps,
    deadlineMisses: score.deadlineMisses,
  };
  const adapter = adapterVersion();
  const provenance = {
    schema: 'simforge.eval-provenance/v1',
    campaignId: campaign.config.campaignId,
    episodeId: plan.episodeId,
    scenario: {
      scenarioId: plan.scenario.scenarioId,
      spec: path.relative(REPO_ROOT, resolved.specPath),
      fixtureSha256: resolved.fixtureSha256,
      session: plan.scenario.session,
    },
    policy: {
      policyId: plan.policy.policyId,
      kind: plan.policy.runnerPolicy,
      checkpointDigest: outcome.summary['policy_checkpoint'] ?? null,
      adapterVersion: adapter.version,
      gitSha: adapter.gitSha,
    },
    seed: plan.seed,
    policySeed: plan.policy.policySeed,
    decisionHz: campaign.config.decisionHz,
    schedule: {
      steps: plan.scenario.steps,
      deadlineMs: plan.policy.deadlineMs,
      fallback: plan.policy.fallback,
      forceMissAt: plan.policy.forceMissAt,
    },
    episodeDigest: outcome.summary['episode_digest'] ?? null,
    traceSha256: outcome.traceSha256,
    createdAt: new Date().toISOString(),
  };

  await writeFile(path.join(dir, 'runner-summary.json'), `${JSON.stringify(outcome.summary, null, 1)}\n`);
  await writeFile(path.join(dir, 'events.json'), `${JSON.stringify(events, null, 1)}\n`);
  await writeFile(path.join(dir, 'score.json'), `${JSON.stringify(scoreDoc, null, 1)}\n`);
  await writeFile(path.join(dir, 'provenance.json'), `${JSON.stringify(provenance, null, 1)}\n`);
  return { score };
}

/** Run (or resume) the whole campaign sequentially. */
export async function runCampaign(
  campaign: ResolvedCampaign,
  log: (line: string) => void = () => {},
): Promise<EpisodeRunResult[]> {
  await mkdir(campaign.campaignDir, { recursive: true });
  await freezeCampaignSpec(campaign);

  const results: EpisodeRunResult[] = [];
  for (const plan of campaign.episodes) {
    const dir = path.join(campaign.campaignDir, plan.episodeId);
    if (existsSync(path.join(dir, 'COMPLETE'))) {
      log(`skip ${plan.episodeId} (complete)`);
      results.push({ episodeId: plan.episodeId, status: 'skipped', drivingScore: null, episodeDigest: null });
      continue;
    }
    if (existsSync(dir)) {
      log(`wipe ${plan.episodeId} (incomplete)`);
      await rm(dir, { recursive: true, force: true });
    }
    await mkdir(dir, { recursive: true });
    log(`run  ${plan.episodeId}`);
    const outcome = invokeRunner(campaign, plan, dir);
    const { score } = await writeEpisodeArtifacts(campaign, plan, dir, outcome);

    const ledgerLine = {
      episodeId: plan.episodeId,
      scenarioId: plan.scenario.scenarioId,
      policyId: plan.policy.policyId,
      seed: plan.seed,
      status: 'complete',
      drivingScore: score.drivingScore,
      routeCompletion: score.routeCompletion,
      episodeDigest: outcome.summary['episode_digest'] ?? null,
      traceSha256: outcome.traceSha256,
      completedAt: new Date().toISOString(),
    };
    await appendFile(path.join(campaign.campaignDir, 'ledger.jsonl'), `${JSON.stringify(ledgerLine)}\n`);
    await writeFile(
      path.join(dir, 'COMPLETE'),
      `${JSON.stringify({ traceSha256: outcome.traceSha256, completedAt: ledgerLine.completedAt })}\n`,
    );
    log(`done ${plan.episodeId} score=${score.drivingScore.toFixed(4)}`);
    results.push({
      episodeId: plan.episodeId,
      status: 'complete',
      drivingScore: score.drivingScore,
      episodeDigest: (outcome.summary['episode_digest'] as string | undefined) ?? null,
    });
  }
  return results;
}

/** Pin the campaign spec; refuses to resume a campaign whose inputs changed. */
async function freezeCampaignSpec(campaign: ResolvedCampaign): Promise<void> {
  const frozen = {
    schema: 'simforge.eval-campaign/v1',
    campaignId: campaign.config.campaignId,
    decisionHz: campaign.config.decisionHz,
    seeds: campaign.config.seeds,
    policies: campaign.config.policies,
    suite: [...campaign.scenarios.values()].map((s) => ({
      ...s.scenario,
      spec: path.relative(REPO_ROOT, s.specPath),
      fixtureSha256: s.fixtureSha256,
      context: s.context,
    })),
    episodeOrder: campaign.episodes.map((e) => e.episodeId),
  };
  const file = path.join(campaign.campaignDir, 'campaign.json');
  const next = `${JSON.stringify(frozen, null, 1)}\n`;
  if (existsSync(file)) {
    const prior = await readFile(file, 'utf8');
    if (prior !== next) {
      throw new Error(`campaign.json mismatch in ${campaign.campaignDir}: inputs changed; use a new campaignId`);
    }
    return;
  }
  await writeFile(file, next);
}

/* --------------------------------------------------------------------- rerun */

export interface RerunVerdict {
  readonly episodeId: string;
  readonly match: boolean;
  readonly original: { episodeDigest: string | null; traceSha256Deterministic: string };
  readonly rerun: { episodeDigest: string | null; traceSha256Deterministic: string };
}

/** Sha256 over the trace with wall-clock `timing` stripped from every line. */
function deterministicTraceSha256(traceText: string): string {
  const hash = createHash('sha256');
  for (const line of traceText.split('\n')) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line) as Record<string, unknown>;
    delete doc['timing'];
    if (doc['summary']) {
      const summary = doc['summary'] as Record<string, unknown>;
      delete summary['infer_ms'];
      delete summary['roundtrip_ms'];
    }
    hash.update(JSON.stringify(doc, Object.keys(doc).sort()));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Re-execute one completed episode into a scratch dir and compare digests.
 * Deterministic policies must reproduce the stored trace exactly.
 */
export async function rerunEpisode(campaign: ResolvedCampaign, episodeId: string): Promise<RerunVerdict> {
  const plan = campaign.episodes.find((e) => e.episodeId === episodeId);
  if (!plan) throw new Error(`episode ${episodeId} is not in this campaign`);
  const originalDir = path.join(campaign.campaignDir, episodeId);
  if (!existsSync(path.join(originalDir, 'COMPLETE'))) {
    throw new Error(`episode ${episodeId} has no COMPLETE artifact to compare against`);
  }
  const originalTrace = await readFile(path.join(originalDir, 'trace.jsonl'), 'utf8');
  const originalSummary = JSON.parse(await readFile(path.join(originalDir, 'runner-summary.json'), 'utf8')) as Record<string, unknown>;

  const scratch = path.join(campaign.campaignDir, '.rerun', episodeId);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  const outcome = invokeRunner(campaign, plan, scratch);
  await writeFile(path.join(scratch, 'runner-summary.json'), `${JSON.stringify(outcome.summary, null, 1)}\n`);

  const original = {
    episodeDigest: (originalSummary['episode_digest'] as string | undefined) ?? null,
    traceSha256Deterministic: deterministicTraceSha256(originalTrace),
  };
  const rerun = {
    episodeDigest: (outcome.summary['episode_digest'] as string | undefined) ?? null,
    traceSha256Deterministic: deterministicTraceSha256(outcome.traceText),
  };
  return {
    episodeId,
    match:
      original.episodeDigest !== null &&
      original.episodeDigest === rerun.episodeDigest &&
      original.traceSha256Deterministic === rerun.traceSha256Deterministic,
    original,
    rerun,
  };
}

/* -------------------------------------------------------------------- report */

export interface CampaignReport {
  readonly schema: 'simforge.eval-report/v1';
  readonly campaignId: string;
  readonly perScenario: ReadonlyArray<{
    scenarioId: string;
    policyId: string;
    episodes: number;
    meanDrivingScore: number;
    meanRouteCompletion: number;
    infractions: Record<string, number>;
  }>;
  readonly aggregate: { drivingScore: number; episodes: number; byPolicy: Record<string, number> };
  readonly infractionHistogram: Record<string, number>;
}

export async function buildReport(campaign: ResolvedCampaign): Promise<CampaignReport> {
  interface Row {
    scenarioId: string;
    policyId: string;
    score: {
      drivingScore: number;
      routeCompletion: number;
      infractions: Record<InfractionType, number>;
    };
  }
  const rows: Row[] = [];
  for (const plan of campaign.episodes) {
    const scoreFile = path.join(campaign.campaignDir, plan.episodeId, 'score.json');
    if (!existsSync(scoreFile)) throw new Error(`missing score.json for ${plan.episodeId}; campaign incomplete`);
    const doc = JSON.parse(await readFile(scoreFile, 'utf8')) as {
      drivingScore: number;
      routeCompletion: number;
      infractions: Record<InfractionType, number>;
    };
    rows.push({ scenarioId: plan.scenario.scenarioId, policyId: plan.policy.policyId, score: doc });
  }

  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.scenarioId}\u0000${row.policyId}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const perScenario = [...groups.entries()].map(([key, group]) => {
    const [scenarioId, policyId] = key.split('\u0000') as [string, string];
    const infractions: Record<string, number> = {};
    for (const row of group) {
      for (const [type, count] of Object.entries(row.score.infractions)) {
        if (count > 0) infractions[type] = (infractions[type] ?? 0) + count;
      }
    }
    return {
      scenarioId,
      policyId,
      episodes: group.length,
      meanDrivingScore: group.reduce((acc, r) => acc + r.score.drivingScore, 0) / group.length,
      meanRouteCompletion: group.reduce((acc, r) => acc + r.score.routeCompletion, 0) / group.length,
      infractions,
    };
  });

  const histogram: Record<string, number> = {};
  for (const row of rows) {
    for (const [type, count] of Object.entries(row.score.infractions)) {
      if (count > 0) histogram[type] = (histogram[type] ?? 0) + count;
    }
  }
  const byPolicy: Record<string, number> = {};
  for (const policy of campaign.config.policies) {
    const own = rows.filter((r) => r.policyId === policy.policyId);
    byPolicy[policy.policyId] = own.reduce((acc, r) => acc + r.score.drivingScore, 0) / Math.max(own.length, 1);
  }
  return {
    schema: 'simforge.eval-report/v1',
    campaignId: campaign.config.campaignId,
    perScenario,
    aggregate: {
      drivingScore: rows.reduce((acc, r) => acc + r.score.drivingScore, 0) / Math.max(rows.length, 1),
      episodes: rows.length,
      byPolicy,
    },
    infractionHistogram: histogram,
  };
}

export function reportMarkdown(report: CampaignReport): string {
  const lines: string[] = [];
  lines.push(`# Campaign ${report.campaignId}`);
  lines.push('');
  lines.push(`Aggregate driving score: **${(report.aggregate.drivingScore * 100).toFixed(1)}** / 100 over ${report.aggregate.episodes} episodes.`);
  const policies = Object.entries(report.aggregate.byPolicy)
    .map(([policyId, score]) => `${policyId} ${(score * 100).toFixed(1)}`)
    .join(' · ');
  lines.push(`By policy: ${policies}`);
  lines.push('');
  lines.push('| scenario | policy | episodes | mean driving score | mean route completion | infractions |');
  lines.push('|---|---|---:|---:|---:|---|');
  for (const row of report.perScenario) {
    const infractions =
      Object.entries(row.infractions)
        .map(([type, count]) => `${type}×${count}`)
        .join(', ') || '—';
    lines.push(
      `| ${row.scenarioId} | ${row.policyId} | ${row.episodes} | ${(row.meanDrivingScore * 100).toFixed(1)} | ${(row.meanRouteCompletion * 100).toFixed(1)}% | ${infractions} |`,
    );
  }
  lines.push('');
  lines.push('## Infraction histogram');
  lines.push('');
  if (Object.keys(report.infractionHistogram).length === 0) {
    lines.push('No infractions.');
  } else {
    lines.push('| infraction | count |');
    lines.push('|---|---:|');
    for (const [type, count] of Object.entries(report.infractionHistogram).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${type} | ${count} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export async function writeReport(campaign: ResolvedCampaign): Promise<CampaignReport> {
  const report = await buildReport(campaign);
  await writeFile(path.join(campaign.campaignDir, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  await writeFile(path.join(campaign.campaignDir, 'report.md'), reportMarkdown(report));
  return report;
}
