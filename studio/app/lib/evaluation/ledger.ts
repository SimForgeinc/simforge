import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { AppContext } from "../db/app-context";
import { listModelVersions } from "../models/model-registry-store";
import {
  EvalCampaignSpecSchema,
  EvalEventsSchema,
  EvalLedgerLineSchema,
  EvalProvenanceSchema,
  EvalScoreSchema,
  EvalTraceLineSchema,
  type EvalCampaignSummary,
  type EvalEpisodeComparison,
  type EvalEpisodePayload,
  type EvalEvent,
  type EvalLedgerLine,
  type EvalPolicyDetail,
  type EvalPolicySummary,
  type EvalProvenance,
  type EvalRunComparison,
  type EvalScore,
  type EvalViewTick,
} from "./contracts";

/**
 * Filesystem reader for eval campaign artifacts (layout in ./contracts.ts).
 * Read-tolerant throughout: malformed lines are skipped, missing optional
 * artifacts degrade to `null`/empty instead of failing the page.
 */

/** Same resolution as worker/model-run.ts so runner and studio agree. */
export function runsRoot(): string {
  return process.env.SIMFORGE_RUNS_ROOT?.trim() || join(homedir(), "simforge-assets", "runs");
}

/** Ids double as directory names; reject anything path-like. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeArtifactId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..");
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readLedgerLines(campaignId: string): Promise<EvalLedgerLine[]> {
  let text: string;
  try {
    text = await readFile(join(runsRoot(), campaignId, "ledger.jsonl"), "utf8");
  } catch {
    return [];
  }
  const lines: EvalLedgerLine[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = EvalLedgerLineSchema.safeParse(raw);
    if (parsed.success) lines.push(parsed.data);
  }
  return lines;
}

function summarizePolicies(
  lines: EvalLedgerLine[],
  versionIdByDigest: Record<string, string>,
  digestByPolicyId: Record<string, string>,
): EvalPolicySummary[] {
  const byPolicy = new Map<string, EvalLedgerLine[]>();
  for (const line of lines) {
    const bucket = byPolicy.get(line.policyId);
    if (bucket) bucket.push(line);
    else byPolicy.set(line.policyId, [line]);
  }
  const policies: EvalPolicySummary[] = [];
  for (const [policyId, episodes] of byPolicy) {
    const digest = digestByPolicyId[policyId];
    policies.push({
      policyId,
      episodes: episodes.length,
      meanScore: episodes.reduce((sum, e) => sum + e.score, 0) / episodes.length,
      meanRouteCompletion:
        episodes.reduce((sum, e) => sum + e.routeCompletion, 0) / episodes.length,
      infractionEpisodes: episodes.filter((e) => e.score < 1).length,
      lastCompletedAt:
        episodes.map((e) => e.completedAt).sort((a, b) => b.localeCompare(a))[0] ?? null,
      modelVersionId: digest ? (versionIdByDigest[digest] ?? null) : null,
    });
  }
  policies.sort((a, b) => a.policyId.localeCompare(b.policyId));
  return policies;
}

/**
 * checkpointDigest is the join key between eval provenance and the simforge.*
 * model registry: read one provenance.json per policy (first ledger episode).
 */
async function policyDigests(
  campaignId: string,
  lines: EvalLedgerLine[],
): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const line of lines) {
    if (digests[line.policyId] !== undefined) continue;
    if (!isSafeArtifactId(line.episodeId)) continue;
    const provenance = await readEpisodeProvenance(campaignId, line.episodeId);
    digests[line.policyId] = provenance?.policy.checkpointDigest ?? "";
  }
  return digests;
}

async function versionIdsByDigest(context: AppContext | null): Promise<Record<string, string>> {
  if (!context) return {};
  try {
    const versions = await listModelVersions(context);
    const byDigest: Record<string, string> = {};
    for (const version of versions) byDigest[version.checkpointDigest] = version.id;
    return byDigest;
  } catch {
    return {};
  }
}

async function campaignSummary(
  campaignId: string,
  versionIdByDigest: Record<string, string>,
): Promise<EvalCampaignSummary | null> {
  const [lines, specRaw] = await Promise.all([
    readLedgerLines(campaignId),
    readJsonFile(join(runsRoot(), campaignId, "campaign.json")),
  ]);
  const spec = EvalCampaignSpecSchema.safeParse(specRaw);
  if (lines.length === 0 && specRaw === null) return null;
  let hasReport = false;
  try {
    hasReport = (await stat(join(runsRoot(), campaignId, "report.json"))).isFile();
  } catch {
    hasReport = false;
  }
  const digests = await policyDigests(campaignId, lines);
  return {
    campaignId,
    name: (spec.success ? spec.data.name : null) ?? campaignId,
    createdAt: (spec.success ? spec.data.createdAt : null) ?? null,
    episodes: lines.length,
    hasReport,
    policies: summarizePolicies(lines, versionIdByDigest, digests),
  };
}

/** Campaign dirs are the runs-root children holding a ledger or campaign spec. */
export async function listCampaigns(context: AppContext | null): Promise<EvalCampaignSummary[]> {
  let entries: string[];
  try {
    entries = (await readdir(runsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isSafeArtifactId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const versionIdByDigest = await versionIdsByDigest(context);
  const campaigns: EvalCampaignSummary[] = [];
  for (const campaignId of entries) {
    const summary = await campaignSummary(campaignId, versionIdByDigest);
    if (summary) campaigns.push(summary);
  }
  campaigns.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return campaigns;
}

export async function getCampaign(
  context: AppContext | null,
  campaignId: string,
): Promise<EvalCampaignSummary | null> {
  if (!isSafeArtifactId(campaignId)) return null;
  return campaignSummary(campaignId, await versionIdsByDigest(context));
}

function episodeDir(campaignId: string, episodeId: string): string {
  return join(runsRoot(), campaignId, episodeId);
}

async function readEpisodeProvenance(
  campaignId: string,
  episodeId: string,
): Promise<EvalProvenance | null> {
  const raw = await readJsonFile(join(episodeDir(campaignId, episodeId), "provenance.json"));
  const parsed = EvalProvenanceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function readEpisodeScore(
  campaignId: string,
  episodeId: string,
): Promise<EvalScore | null> {
  const raw = await readJsonFile(join(episodeDir(campaignId, episodeId), "score.json"));
  const parsed = EvalScoreSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function getPolicyDetail(
  context: AppContext | null,
  campaignId: string,
  policyId: string,
): Promise<EvalPolicyDetail | null> {
  if (!isSafeArtifactId(campaignId) || !isSafeArtifactId(policyId)) return null;
  const summary = await campaignSummary(campaignId, await versionIdsByDigest(context));
  const policy = summary?.policies.find((candidate) => candidate.policyId === policyId);
  if (!summary || !policy) return null;
  const lines = (await readLedgerLines(campaignId)).filter((line) => line.policyId === policyId);
  const episodes = [];
  let provenanceSample: EvalProvenance | null = null;
  for (const line of lines) {
    if (!isSafeArtifactId(line.episodeId)) continue;
    const score = await readEpisodeScore(campaignId, line.episodeId);
    if (!provenanceSample) {
      provenanceSample = await readEpisodeProvenance(campaignId, line.episodeId);
    }
    episodes.push({
      episodeId: line.episodeId,
      scenarioId: line.scenarioId,
      seed: line.seed,
      completedAt: line.completedAt,
      score,
      ledgerScore: line.score,
      ledgerRouteCompletion: line.routeCompletion,
    });
  }
  episodes.sort(
    (a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.seed - b.seed,
  );
  return { campaignId, policy, provenanceSample, episodes };
}

/**
 * trace.jsonl → normalized playback ticks. Decision lines only: the leading
 * `{reset:...}` and trailing `{summary:...}` lines don't parse as decisions
 * and are dropped, as is any malformed line.
 */
async function readViewTicks(campaignId: string, episodeId: string): Promise<EvalViewTick[]> {
  let text: string;
  try {
    text = await readFile(join(episodeDir(campaignId, episodeId), "trace.jsonl"), "utf8");
  } catch {
    return [];
  }
  const ticks: EvalViewTick[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = EvalTraceLineSchema.safeParse(raw);
    if (!parsed.success) continue;
    const decision = parsed.data;
    const sv = decision.sv;
    ticks.push({
      step: decision.step,
      tS: decision.t,
      x: sv[0] ?? 0,
      y: sv[1] ?? 0,
      yawRad: Math.atan2(sv[3] ?? 0, sv[2] ?? 1),
      speedMps: sv[4] ?? 0,
      accelMps2: sv[5] ?? 0,
      latOffM: sv[6] ?? 0,
      miss: Boolean(decision.miss),
      rw: decision.rw ?? null,
      inferMs: decision.timing?.infer_ms ?? null,
      roundtripMs: decision.timing?.roundtrip_ms ?? null,
      reasoning: decision.reasoning ?? null,
      action: decision.a ?? null,
      thumbs: decision.frames?.thumbs ?? null,
    });
  }
  ticks.sort((a, b) => a.step - b.step);
  return ticks;
}

async function readEpisodeEvents(campaignId: string, episodeId: string): Promise<EvalEvent[]> {
  const raw = await readJsonFile(join(episodeDir(campaignId, episodeId), "events.json"));
  const parsed = EvalEventsSchema.safeParse(raw);
  return parsed.success ? parsed.data.events : [];
}

export async function getEpisodePayload(
  campaignId: string,
  episodeId: string,
): Promise<EvalEpisodePayload | null> {
  if (!isSafeArtifactId(campaignId) || !isSafeArtifactId(episodeId)) return null;
  const [ticks, events, score, provenance] = await Promise.all([
    readViewTicks(campaignId, episodeId),
    readEpisodeEvents(campaignId, episodeId),
    readEpisodeScore(campaignId, episodeId),
    readEpisodeProvenance(campaignId, episodeId),
  ]);
  if (ticks.length === 0 && !score && !provenance) return null;
  let complete = false;
  try {
    complete = (await stat(join(episodeDir(campaignId, episodeId), "COMPLETE"))).isFile();
  } catch {
    complete = false;
  }
  return { campaignId, episodeId, score, provenance, ticks, events, complete };
}

/**
 * Resolve a frame path relative to the episode's directory. Null for unsafe
 * ids, traversal outside the episode dir, or a missing/non-file target.
 */
export async function resolveEpisodeFramePath(
  campaignId: string,
  episodeId: string,
  relativePath: string,
): Promise<string | null> {
  if (!isSafeArtifactId(campaignId) || !isSafeArtifactId(episodeId)) return null;
  if (isAbsolute(relativePath) || relativePath.includes("\0")) return null;
  const base = resolve(episodeDir(campaignId, episodeId));
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) return null;
  try {
    const info = await stat(target);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  return target;
}

export const DIVERGENCE_THRESHOLD_M = 0.5;

/** First step both traces cover where ego positions differ by more than the threshold. */
export function divergenceStep(
  a: EvalViewTick[],
  b: EvalViewTick[],
  thresholdM = DIVERGENCE_THRESHOLD_M,
): { step: number; tS: number } | null {
  const byStep = new Map<number, EvalViewTick>();
  for (const tick of a) byStep.set(tick.step, tick);
  const thresholdSq = thresholdM * thresholdM;
  for (const tick of b) {
    const other = byStep.get(tick.step);
    if (!other) continue;
    const dx = tick.x - other.x;
    const dy = tick.y - other.y;
    if (dx * dx + dy * dy > thresholdSq) return { step: tick.step, tS: tick.tS };
  }
  return null;
}

export async function comparePolicies(
  context: AppContext | null,
  campaignId: string,
  aPolicyId: string,
  bPolicyId: string,
): Promise<EvalRunComparison | null> {
  if (!isSafeArtifactId(campaignId)) return null;
  const summary = await campaignSummary(campaignId, await versionIdsByDigest(context));
  const a = summary?.policies.find((policy) => policy.policyId === aPolicyId);
  const b = summary?.policies.find((policy) => policy.policyId === bPolicyId);
  if (!summary || !a || !b) return null;

  const lines = await readLedgerLines(campaignId);
  const cells = new Map<string, { a?: EvalLedgerLine; b?: EvalLedgerLine }>();
  for (const line of lines) {
    if (line.policyId !== aPolicyId && line.policyId !== bPolicyId) continue;
    const key = `${line.scenarioId}\u0000${line.seed}`;
    const cell = cells.get(key) ?? {};
    if (line.policyId === aPolicyId) cell.a = line;
    else cell.b = line;
    cells.set(key, cell);
  }

  const episodes: EvalEpisodeComparison[] = [];
  for (const [key, cell] of cells) {
    const [scenarioId = "", seedText = ""] = key.split("\u0000");
    let divergence: { step: number; tS: number } | null = null;
    if (
      cell.a &&
      cell.b &&
      isSafeArtifactId(cell.a.episodeId) &&
      isSafeArtifactId(cell.b.episodeId)
    ) {
      const [traceA, traceB] = await Promise.all([
        readViewTicks(campaignId, cell.a.episodeId),
        readViewTicks(campaignId, cell.b.episodeId),
      ]);
      divergence = divergenceStep(traceA, traceB);
    }
    episodes.push({
      scenarioId,
      seed: Number(seedText),
      aEpisodeId: cell.a?.episodeId ?? null,
      bEpisodeId: cell.b?.episodeId ?? null,
      aScore: cell.a?.score ?? null,
      bScore: cell.b?.score ?? null,
      scoreDelta: cell.a && cell.b ? cell.b.score - cell.a.score : null,
      divergenceStep: divergence?.step ?? null,
      divergenceTS: divergence?.tS ?? null,
    });
  }
  episodes.sort((x, y) => x.scenarioId.localeCompare(y.scenarioId) || x.seed - y.seed);

  return { campaignId, divergenceThresholdM: DIVERGENCE_THRESHOLD_M, a, b, episodes };
}
