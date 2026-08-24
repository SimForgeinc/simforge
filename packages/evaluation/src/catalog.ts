/**
 * Catalog/episode-bank ingestion and per-entry materialization for the
 * policy-eval suite. Shared by the suite builder CLI and the eval server so
 * a committed suite entry always means the same concrete world.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CatalogSlotView,
  PolicyEvalSuite,
  SuiteEntry,
  TrainingEpisodeSpec,
} from './suite.js';
import type { RlRuntime } from './runtime.js';
import type { EnvSession, MaterializeResult } from './rl-bridge-types.js';

/** Parse one rl episode-bank file (env-server episode spec form B). */
export async function loadTrainingBank(source: string): Promise<TrainingEpisodeSpec> {
  const doc = JSON.parse(await readFile(source, 'utf8')) as {
    template?: string;
    map?: string;
    site?: string;
    seeds?: Array<string | number>;
  };
  if (!doc.template || !doc.map || !doc.site || !doc.seeds) {
    throw new Error(`${source} is not a template×map×site×seeds episode bank`);
  }
  return {
    source,
    template: doc.template,
    map: doc.map,
    site: doc.site,
    seeds: doc.seeds.map(String),
  };
}

export async function loadTrainingBanks(sources: readonly string[]): Promise<TrainingEpisodeSpec[]> {
  const banks: TrainingEpisodeSpec[] = [];
  for (const source of sources) banks.push(await loadTrainingBank(source));
  return banks;
}

/** Reduce catalog slots to the view suite construction consumes. */
export function slotsFromCatalog(catalog: unknown): CatalogSlotView[] {
  const doc = catalog as {
    slots?: Array<{
      identity: string;
      seed: string;
      mapId: string;
      variant: Record<string, string>;
      implementation?: { templateSource?: string; matcherSiteId?: string };
    }>;
  };
  const out: CatalogSlotView[] = [];
  for (const slot of doc.slots ?? []) {
    const impl = slot.implementation;
    if (!impl?.templateSource || !impl.matcherSiteId) continue;
    out.push({
      identity: slot.identity,
      seed: slot.seed,
      mapId: slot.mapId,
      matcherSiteId: impl.matcherSiteId,
      templateSource: impl.templateSource,
      variant: {
        id: slot.variant.id ?? '',
        title: slot.variant.title ?? '',
        weather: slot.variant.weather ?? '',
        timeOfDay: slot.variant.timeOfDay ?? '',
        traffic: slot.variant.traffic ?? '',
        visibility: slot.variant.visibility ?? '',
      },
    });
  }
  return out;
}

export interface ResolvedEntryWorld {
  readonly input: MaterializeResult['input'];
  readonly graph: unknown;
}

export async function resolveEntryWorld(
  runtime: RlRuntime,
  repoRoot: string,
  entry: SuiteEntry,
): Promise<ResolvedEntryWorld> {
  const template = await runtime.readTemplate(path.resolve(repoRoot, entry.templateSource));
  const { bundle, site } = await runtime.findSite(template, entry.mapId, entry.matcherSiteId);
  const result = runtime.materialize(template, bundle, site, {
    seed: entry.seed,
    ...(entry.variant === null ? {} : { variant: entry.variant }),
  });
  let input = result.input;
  // Templates predating the metric-subject field (e.g. queue-tail) leave
  // `metricSubject` null; the rl env then cannot resolve an ego because the
  // actor-kind vocabulary is 'car'/'van', not 'vehicle'. Complete the input
  // with the template's authored ego role instead of editing the engine.
  const actors = (input['actors'] ?? []) as Array<{ id?: unknown }>;
  const hasAuthoredEgo = actors.some((a) => a.id === 'ego');
  if ((input['metricSubject'] ?? null) === null && hasAuthoredEgo) {
    input = { ...input, metricSubject: 'ego' };
  }
  return { input, graph: bundle.graph };
}

/** Materialize-probe one suite entry; true when the cell resolves end to end. */
export function entryValidator(
  runtime: RlRuntime,
  repoRoot: string,
): (entry: SuiteEntry) => Promise<boolean> {
  return async (entry: SuiteEntry) => {
    try {
      await resolveEntryWorld(runtime, repoRoot, entry);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Build the reactive EnvSession for one suite entry. Configuration is
 * byte-for-byte the training shim's contract (reactive ambient, mid-level
 * BEV, routeEnd goal) so suite numbers stay comparable with rl runs.
 */
export async function sessionForEntry(
  runtime: RlRuntime,
  repoRoot: string,
  entry: SuiteEntry,
  options: { decisionHz: number; reward: Record<string, unknown>; maxDecisions?: number | undefined },
): Promise<EnvSession> {
  const { input, graph } = await resolveEntryWorld(runtime, repoRoot, entry);
  return new runtime.EnvSession({
    input,
    graph,
    runOptions: { ambientReactivity: 'reactive' },
    episode: {
      decisionHz: options.decisionHz,
      ...(options.maxDecisions === undefined ? {} : { maxDecisions: options.maxDecisions }),
      reward: options.reward,
      goal: { routeEnd: true },
      observation: { stateVector: true, bev: { resolutionM: 0.5, forwardM: 32, backwardM: 8, halfWidthM: 10 } },
    },
  });
}

/** Load a committed suite file and validate its shape + hash. */
export async function loadSuiteFile(suitePath: string): Promise<PolicyEvalSuite> {
  const [{ policyEvalSuiteSchema, computeSuiteHash }, raw] = await Promise.all([
    import('./suite.js'),
    readFile(suitePath, 'utf8'),
  ]);
  const suite = policyEvalSuiteSchema.parse(JSON.parse(raw)) as PolicyEvalSuite;
  const { suiteHash, ...rest } = suite;
  const recomputed = computeSuiteHash(rest);
  if (recomputed !== suiteHash) {
    throw new Error(`suite hash mismatch: file says ${suiteHash}, content hashes to ${recomputed}`);
  }
  return suite;
}
