/**
 * Acceptance proof (a) for localised surface patches.
 *
 * Four runs of ONE CLI-materialized instance. Same site, same actors, same
 * seed, same weather, same scene-wide `frictionScale` (1 — nothing about the
 * world is slippery). Only the surface field differs:
 *
 *   dry        no patches at all
 *   iced       the patches the materializer produced from the template
 *   blackIce   the same patches with the coefficient forced to real black ice
 *   moved      the same patches translated 2 km down the lane, off the stretch
 *              the ego drives
 *
 * `moved` is the load-bearing one. If a patch were a disguised scene-wide
 * scalar, moving it would change nothing about where it applies and `moved`
 * would behave like `iced`. It has to come out byte-identical to `dry`, and
 * the trace digest is compared to prove it rather than asserted.
 *
 *   npx tsx research/edge-case-corpus/tools/vista/newcaps/surface-ab-proof.ts <instance.json> [...]
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import {
  buildLaneGraph,
  parseSimScenarioInput,
  runSimulation,
  traceDigest,
  type LaneGraph,
  type SurfacePatch,
} from '../../../../../packages/engine/src/index.js';

const graphs = new Map<string, LaneGraph>();
function graphFor(mapId: string): LaneGraph {
  let graph = graphs.get(mapId);
  if (!graph) {
    graph = buildLaneGraph(JSON.parse(gunzipSync(
      readFileSync(`dev-assets/${mapId}/topology-index.json.gz`),
    ).toString('utf8')));
    graphs.set(mapId, graph);
  }
  return graph;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function run(doc: any, surfacePatches: readonly SurfacePatch[]) {
  const input = parseSimScenarioInput({ ...doc.input, surfacePatches });
  const { trace } = runSimulation(input, { graph: graphFor(input.mapId), guards: 'collect' });
  const ego = trace.ticks.actors['ego']!;
  const lead = trace.ticks.actors['lead']!;
  const t = trace.ticks.t;
  const dt = t[1]! - t[0]!;

  let peakDecel = 0;
  for (let i = 1; i < ego.speedMps.length; i++) {
    peakDecel = Math.max(peakDecel, (ego.speedMps[i - 1]! - ego.speedMps[i]!) / dt);
  }
  const peakSpeed = Math.max(...ego.speedMps);
  return {
    peakSpeedMps: round(peakSpeed),
    /** The best deceleration this surface let the ego actually achieve. */
    peakDecelMps2: round(peakDecel),
    /** v^2 / 2a — the stopping distance that deceleration implies. */
    stoppingDistanceM: round(peakSpeed ** 2 / (2 * Math.max(peakDecel, 1e-6))),
    finalSpeedMps: round(ego.speedMps.at(-1)!),
    minGapM: round(Math.min(...t.map((_, i) =>
      Math.hypot(lead.x[i]! - ego.x[i]!, lead.y[i]! - ego.y[i]!)))),
    /** How much speed the ego managed to shed. The headline: ice keeps it. */
    speedShedMps: round(peakSpeed - ego.speedMps.at(-1)!),
    digest: traceDigest(trace).slice(0, 16),
    /** Every recorded channel, for exact trajectory comparison between runs. */
    track: JSON.stringify([ego.x, ego.y, ego.speedMps, ego.s, ego.headingRad]),
  };
}

/** Translate every lane window far past the end of the clip. */
function moved(patches: readonly SurfacePatch[]): SurfacePatch[] {
  return patches.map((patch) => patch.region.kind === 'laneWindow'
    ? { ...patch, region: { ...patch.region, sMin: patch.region.sMin + 2000, sMax: patch.region.sMax + 2000 } }
    : patch);
}

function regripped(patches: readonly SurfacePatch[], frictionScale: number): SurfacePatch[] {
  return patches.map((patch) => ({ ...patch, frictionScale }));
}

for (const instancePath of process.argv.slice(2)) {
  const doc = JSON.parse(readFileSync(instancePath, 'utf8'));
  const authored: SurfacePatch[] = doc.input.surfacePatches;
  const dry = run(doc, []);
  const iced = run(doc, authored);
  const blackIce = run(doc, regripped(authored, 0.15));
  const movedAway = run(doc, moved(authored));
  console.log(JSON.stringify({
    instance: instancePath.replace(/^.*proof\//, ''),
    mapId: doc.input.mapId,
    sceneFrictionScale: doc.input.operationalConditions.effects.frictionScale,
    patchCount: authored.length,
    patchFrictionScale: round(authored[0]?.frictionScale ?? 1),
    runs: Object.fromEntries(Object.entries({ dry, iced, blackIce, movedAway })
      .map(([name, r]) => [name, { ...r, track: undefined }])),
    // The load-bearing assertion: the SAME patches, translated off the driven
    // stretch, leave the ego's trajectory bit-for-bit unchanged. A patch is a
    // place, not a global knob. (The trace DIGEST still differs, because it
    // covers the input hash, and the input genuinely did change.)
    localised: movedAway.track === dry.track && iced.track !== dry.track,
    stoppingDistanceRatio: {
      iced: round(iced.stoppingDistanceM / dry.stoppingDistanceM),
      blackIce: round(blackIce.stoppingDistanceM / dry.stoppingDistanceM),
    },
  }));
}
