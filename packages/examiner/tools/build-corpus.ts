#!/usr/bin/env node
/**
 * Build the examiner's real-trace corpus: example templates × the dev-assets
 * maps → materialized instances → two deterministic passes each:
 *
 *  - `runSimulation` for per-tick actor tracks (poses, lanes, presence), and
 *  - an `EnvSession` rollout (zero action) for the versioned causal
 *    ground-truth channel (`info.causalChannel()`).
 *
 * The engine is byte-deterministic, so both passes describe the same world;
 * the corpus decimates tracks to the decision grid so the fixture stays small.
 * Output: `fixtures/corpus.v1.json`, committed and consumed by the vitest
 * suite and the grader benchmark. Requires dev-assets (git-ignored); point
 * SCEN_DEV_ASSETS at a tree that carries `topology-index.json.gz` +
 * `derived/topology-derived.json.gz` per map.
 *
 * Templates whose anchors match no site or fail materialization are skipped
 * with a logged reason; the build fails only if fewer than {@link MIN_SCENARIOS}
 * distinct scenarios succeed.
 *
 * Run: pnpm --filter @uniscenarios/examiner corpus:build
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORPUS_VERSION = 1;
const DECISION_HZ = 10;

import {
  matchOnMaps,
  materialize,
  readTemplate,
  writeJsonFile,
  type MapBundle,
} from '@uniscenarios/cli';
import type { MatchedSite } from '@uniscenarios/anchor-matcher';
import { EnvSession, type CausalChannel } from '@uniscenarios/rl-env';
import {
  runSimulation,
  traceDigest,
  type Interaction,
  type SimScenarioInput,
  type SimTrace,
} from '@uniscenarios/sim-engine';
import type { ScenarioTemplateV2 } from '@uniscenarios/scenario-model';

/**
 * Candidate templates; ≥5 distinct successful simulated scenarios are
 * required by the WS2 gate, and ~20+ give the perturbation benchmark its
 * ≥200-case pool. Failures (no matchable site, unbindable signal, unknown
 * catalog id) are skipped with a logged reason.
 */
const TEMPLATES: ReadonlyArray<{ file: string; seeds: readonly string[] }> = [
  ...[
    'examples/bus-stop-emergence.template.json',
    'examples/multiple-threat.template.json',
    'examples/cpnco-dartout.template.json',
    'examples/cpnco-parked-row.template.json',
    'examples/ltap-opposing.template.json',
    'examples/school-dartout.template.json',
  ].map((file) => ({ file, seeds: ['examiner-a', 'examiner-b', 'examiner-c'] as const })),
  ...['01-construction-chicane-reversing-truck', '02-police-roadside-stop', '03-red-light-ambulance-preemption',
    '04-child-emerging-behind-bus', '05-cyclist-occlusion-conflict', '06-wrong-way-vehicle-blind-approach',
    '07-protected-left-red-runner', '08-zipper-merge-lane-closure', '09-stalled-vehicle-beyond-sight',
    '10-officer-flashing-red-junction', '11-double-threat-crosswalk', '12-fire-engine-gridlock-escape',
  ].map((dir) => ({
    file: `examples/edge-cases/${dir}/scenario.template.json`,
    seeds: ['examiner-a', 'examiner-b'] as const,
  })),
  ...['corridor/cut-in-brake', 'corridor/lead-hard-brake', 'junction-vru/left-turn-crosswalk',
    'junction-vru/right-turn-crosswalk', 'obstacle/disabled-vehicle', 'parking-transit/driveway-emergence',
  ].map((stem) => ({
    file: `examples/mechanisms/${stem}.template.json`,
    seeds: ['examiner-a', 'examiner-b'] as const,
  })),
];
const MIN_SCENARIOS = 5;

export interface DecimatedTrack {
  readonly t: number[];
  readonly x: number[];
  readonly y: number[];
  readonly headingRad: number[];
  readonly speedMps: number[];
  /** RSL lane id per decision tick ('' while absent). */
  readonly laneRsl: string[];
  /** 0/1 presence per decision tick. */
  readonly present: number[];
}

export interface CorpusScenario {
  readonly id: string;
  readonly templatePath: string;
  readonly mapId: string;
  readonly siteId: string;
  readonly seed: string;
  readonly traceDigest: string;
  readonly egoId: string;
  readonly decisionHz: number;
  readonly clipSeconds: number;
  /** Non-ego actor kinds by id. */
  readonly actorKinds: Record<string, string>;
  /** Authored interactions — the intent ground truth. */
  readonly interactions: readonly Interaction[];
  readonly tracks: Record<string, DecimatedTrack>;
  readonly causalChannel: CausalChannel;
}

export interface Corpus {
  readonly corpusVersion: typeof CORPUS_VERSION;
  readonly generator: 'packages/examiner tools/build-corpus.ts';
  readonly scenarios: readonly CorpusScenario[];
}

interface PickedSite {
  readonly bundle: MapBundle;
  readonly site: MatchedSite;
  readonly mapId: string;
}

/** Pick the best site across maps deterministically (highest score wins ties lexicographically). */
async function pickSite(template: ScenarioTemplateV2): Promise<PickedSite | null> {
  const maps = [
    'yale-street',
    'belmont-research-center',
    'el-camino-road',
    'easterbrook-discovery-school',
    'richmond-field-station',
  ];
  const matches = await matchOnMaps(template, maps);
  let best: PickedSite | null = null;
  for (const m of matches) {
    for (const s of m.report.sites) {
      if (
        !best ||
        s.score > best.site.score ||
        (s.score === best.site.score && `${m.mapId}/${s.siteId}` < `${best.mapId}/${best.site.siteId}`)
      ) {
        best = { mapId: m.mapId, site: s, bundle: m.bundle };
      }
    }
  }
  return best;
}

/** Sample the engine trace at the causal channel's decision ticks. */
function decimate(trace: SimTrace, channel: CausalChannel): Record<string, DecimatedTrack> {
  const t = trace.ticks.t;
  let cursor = 0;
  const indices: number[] = [];
  for (const frame of channel.frames) {
    while (cursor + 1 < t.length && Math.abs(t[cursor + 1]! - frame.tS) <= Math.abs(t[cursor]! - frame.tS)) cursor += 1;
    indices.push(cursor);
  }
  const out: Record<string, DecimatedTrack> = {};
  for (const [id, track] of Object.entries(trace.ticks.actors).sort()) {
    const t2: number[] = [];
    const x: number[] = [];
    const y: number[] = [];
    const headingRad: number[] = [];
    const speedMps: number[] = [];
    const laneRsl: string[] = [];
    const present: number[] = [];
    for (const i of indices) {
      t2.push(t[i]!);
      x.push(track.x[i] ?? 0);
      y.push(track.y[i] ?? 0);
      headingRad.push(track.headingRad[i] ?? 0);
      speedMps.push(track.speedMps[i] ?? 0);
      laneRsl.push(track.laneRsl[i] ?? '');
      present.push(track.present[i] ?? 0);
    }
    out[id] = { t: t2, x, y, headingRad, speedMps, laneRsl, present };
  }
  return out;
}

/** Zero-action rollout; the causal channel is the point, not the policy. */
function runEpisode(input: SimScenarioInput, bundle: MapBundle, seed: string): CausalChannel {
  const env = new EnvSession({ input, graph: bundle.graph, episode: { decisionHz: DECISION_HZ } });
  let result = env.reset(seed);
  while (!result.terminated && !result.truncated) result = env.step({});
  return result.info.causalChannel();
}

interface BuiltCell {
  readonly scenario: CorpusScenario;
}

/** Materialize + simulate one template×site×seed cell; throws with the CLI's reason on failure. */
async function buildOne(templatePath: string, picked: PickedSite, seed: string): Promise<BuiltCell> {
  const template = await readTemplate(path.join(REPO_ROOT, templatePath));
  const { input, manifest } = materialize(template, picked.bundle, picked.site, { seed });
  const sim = runSimulation(input, { graph: picked.bundle.graph, guards: 'collect' });
  const channel = runEpisode(input, picked.bundle, seed);
  const egoId = channel.egoId;
  const actorKinds: Record<string, string> = {};
  for (const a of input.actors) if (a.id !== egoId) actorKinds[a.id] = a.kind;
  return {
    scenario: {
      id: `${manifest.replayKey.templateId}__${picked.mapId}__${picked.site.siteId}`,
      templatePath,
      mapId: picked.mapId,
      siteId: picked.site.siteId,
      seed,
      traceDigest: traceDigest(sim.trace),
      egoId,
      decisionHz: DECISION_HZ,
      clipSeconds: input.clipSeconds,
      actorKinds,
      interactions: input.interactions,
      tracks: decimate(sim.trace, channel),
      causalChannel: channel,
    },
  };
}

async function main(): Promise<void> {
  const scenarios: CorpusScenario[] = [];
  const skipped: string[] = [];
  for (const entry of TEMPLATES) {
    let template: ScenarioTemplateV2;
    try {
      template = await readTemplate(path.join(REPO_ROOT, entry.file));
    } catch (err) {
      skipped.push(`${entry.file}: unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    let picked: PickedSite | null = null;
    try {
      picked = await pickSite(template);
    } catch (err) {
      skipped.push(`${entry.file}: matching failed (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!picked) {
      skipped.push(`${entry.file}: no matchable site on any map`);
      continue;
    }
    for (const seed of entry.seeds) {
      try {
        process.stdout.write(`simulating ${entry.file} [${seed}] … `);
        const { scenario } = await buildOne(entry.file, picked, seed);
        const triggers = scenario.causalChannel.frames.flatMap((f) => f.triggers);
        const genesisFrames = scenario.causalChannel.frames.filter((f) => f.conflictGenesis.length > 0).length;
        console.log(
          `site=${scenario.siteId} actors=${Object.keys(scenario.actorKinds).length + 1}` +
            ` decisions=${scenario.causalChannel.frames.length} triggers=${triggers.length}` +
            ` genesisFrames=${genesisFrames}`,
        );
        scenarios.push(scenario);
      } catch (err) {
        console.log('skipped');
        skipped.push(
          `${entry.file} [${seed}]: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  if (scenarios.length < MIN_SCENARIOS) {
    throw new Error(`only ${scenarios.length} scenarios built (< ${MIN_SCENARIOS}); skips:\n${skipped.join('\n')}`);
  }
  const corpus: Corpus = {
    corpusVersion: CORPUS_VERSION,
    generator: 'packages/examiner tools/build-corpus.ts',
    scenarios,
  };
  const out = path.join(REPO_ROOT, 'packages/examiner/fixtures/corpus.v1.json');
  await writeJsonFile(out, corpus);
  console.log(`wrote ${out} (${scenarios.length} scenarios; ${skipped.length} skips)`);
  for (const s of skipped) console.log(`  skip: ${s}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
