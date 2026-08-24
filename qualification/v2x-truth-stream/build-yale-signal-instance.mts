/**
 * Builds the V1 TruthStream e2e fixture: a yale-street scenario instance whose
 * signalPrograms come from the real map signal-plan compiler (synthetic-default
 * timing, physical head ids preserved), plus an episode spec for env-server.
 *
 * Usage: npx tsx qualification/v2x-truth-stream/build-yale-signal-instance.mts
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Direct dist imports: this fixture tool lives outside the workspace package graph.
import { loadMap } from '../../packages/cli/dist/index.js';
import { buildMapControlPlan } from '../../packages/compiler/dist/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SOURCE_INSTANCE = path.join(
  REPO,
  'examples',
  'edge-cases',
  '10-officer-flashing-red-junction',
  'scenario.instance.json',
);
const OUT_INSTANCE = path.join(HERE, 'yale-signal.instance.json');
const OUT_SPEC = path.join(HERE, 'episodes.spec.json');

const bundle = await loadMap('yale-street');
const plan = buildMapControlPlan({
  index: bundle.index,
  graph: bundle.graph,
  topology: bundle.topology,
  signalCatalog: bundle.signalCatalog,
});
if (plan.signalPrograms.length === 0) throw new Error('yale-street produced no signal programs');

// The donor actors already drive coherent yale-street routes through the
// signalized junction; swap their empty program list for the compiled map plan
// so the live stream carries real SPaT truth, and stretch the clip so a full
// cycle transition is observable.
const envelope = JSON.parse(await readFile(SOURCE_INSTANCE, 'utf8')) as {
  kind: string;
  version: number;
  manifest?: unknown;
  input: Record<string, unknown> & {
    mapId: string;
    clipSeconds: number;
    warmupSeconds: number;
    dt: number;
    seed: string;
    signalPrograms?: unknown[];
    actors: Array<{ id: string; behavior?: { rules?: Record<string, unknown> } }>;
  };
};
envelope.input.mapId = 'yale-street';
envelope.input.clipSeconds = 12;
envelope.input.warmupSeconds = 0;
envelope.input.seed = 'v2x-truthstream-yale-signal-1';
envelope.input.signalPrograms = plan.signalPrograms;
for (const actor of envelope.input.actors) {
  actor.behavior ??= {};
  actor.behavior.rules = { ...(actor.behavior.rules ?? {}), obeySignals: true };
}

await writeFile(OUT_INSTANCE, JSON.stringify({ kind: 'scenario-instance', version: 1, input: envelope.input }, null, 1));
await writeFile(
  OUT_SPEC,
  JSON.stringify({ version: 1, instances: [{ input: 'yale-signal.instance.json' }] }, null, 2),
);
console.log(
  `wrote ${OUT_INSTANCE}: ${plan.signalPrograms.length} signal programs, ${plan.roadControls.length} road controls`,
);
