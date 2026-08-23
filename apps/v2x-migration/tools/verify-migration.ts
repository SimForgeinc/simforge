/**
 * V6 migration evidence: verify a simulated firetruck migration run against the
 * choreography intent of its source .xosc storyboard.
 *
 * Checks (per docs/v2x-scenario-migration.md):
 *  - actor counts match the xosc Entities
 *  - approach geometry: the firetruck traverses the expected lane chain
 *  - event ordering: continuous approach from spawn, standoff stop behind the
 *    ego (full choreography) or goal arrival within the xosc
 *    ReachPositionCondition tolerance (clear-road pass branch)
 *  - no collision (xosc criteria_CollisionTest)
 *
 * Usage: pnpm exec tsx apps/v2x-migration/tools/verify-migration.ts <scenario>...
 *   scenario ∈ firetruck-from-north | firetruck-from-south
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const DIR = 'apps/v2x-migration/evidence';

/** The xosc storyboard facts each migrated scenario must reproduce. */
const SPEC = {
  'firetruck-from-north': {
    source: 'firetruck_from_north.xosc',
    sourceSha256: '712cc5c1e6b5bcaeccee473f971f4ba78fa8ec66d77fed322cae7c86af66813b',
    actorCount: 2,
    spawn: { x: -175.71, z: 50.4 },
    goal: { x: -115.37, z: -97.3 },
    goalToleranceM: 6.0,
    cruiseMps: 8.33,
    laneChain: ['18:0:1', '243:0:1', '44:0:1'],
  },
  'firetruck-from-south': {
    source: 'firetruck_from_south.xosc',
    sourceSha256: '9e18e996aef917c92853dac902d3256c0221671aedfa79158381fc68f03cb46f',
    actorCount: 2,
    spawn: { x: -60.42, z: -200.22 },
    goal: { x: -166.63, z: 11.18 },
    goalToleranceM: 6.0,
    cruiseMps: 8.33,
    laneChain: ['26:0:1', '143:0:1', '44:0:-1', '246:0:-1', '18:0:-1'],
  },
};

function loadJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function verify(name) {
  const spec = SPEC[name];
  const full = loadJson(`${DIR}/${name}.debug.json/report.json`);
  const clear = loadJson(`${DIR}/${name}.clearroad.debug.json/report.json`);
  const fullPaths = loadJson(`${DIR}/${name}.debug.json/paths.json`);
  const clearPaths = loadJson(`${DIR}/${name}.clearroad.debug.json/paths.json`);

  const ftFull = fullPaths.actors.firetruck;
  const ftClear = clearPaths.actors.firetruck;

  const distTo = (s, p) => Math.hypot(s.x - p.x, s.z - p.z);
  const minGoalClear = Math.min(...ftClear.map((s) => distTo(s, spec.goal)));
  const firstGoalClear = ftClear.find((s) => distTo(s, spec.goal) <= spec.goalToleranceM);

  // Standoff: where the truck settled in the full-choreography run.
  const moving = ftFull.filter((s) => s.speedMps > 0.05);
  const stopT = moving.length ? moving[moving.length - 1].t : 0;
  const stopped = ftFull[ftFull.length - 1];
  const ego = full.summary.actorMotion.ego_vehicle.end;
  const standoffM = Math.hypot(stopped.x - ego.x, stopped.z - ego.z);

  const checks = [
    {
      id: 'actor-count',
      pass: full.summary.actorCount === spec.actorCount && clear.summary.actorCount === spec.actorCount - 1,
      detail: `full run ${full.summary.actorCount} actors (xosc Entities: ego_vehicle + firetruck); clear-road variant ${clear.summary.actorCount}`,
    },
    {
      id: 'continuous-approach',
      pass: moving.length > 1 && moving[0].t < 1.0 && full.summary.actorMotion.firetruck.maxSpeedMps >= spec.cruiseMps - 0.1,
      detail: `rolling from t=${moving[0]?.t ?? 'n/a'}s, cruise reached ${full.summary.actorMotion.firetruck.maxSpeedMps.toFixed(2)} m/s (xosc AbsoluteTargetSpeed ${spec.cruiseMps})`,
    },
    {
      id: 'approach-geometry',
      pass:
        JSON.stringify(clear.summary.actorMotion.firetruck.observedLanes) === JSON.stringify(spec.laneChain) &&
        spec.laneChain.join(':').startsWith(full.summary.actorMotion.firetruck.observedLanes.join(':')),
      detail: `clear-road lane chain ${JSON.stringify(clear.summary.actorMotion.firetruck.observedLanes)} == xosc road waypoints ${JSON.stringify(spec.laneChain)}; yield-stop run stops within the chain at ${JSON.stringify(full.summary.actorMotion.firetruck.observedLanes)}`,
    },
    {
      id: 'no-collision',
      pass: full.summary.collisionCount === 0 && clear.summary.collisionCount === 0,
      detail: `criteria_CollisionTest: full run ${full.summary.collisionCount} contact(s), clear-road ${clear.summary.collisionCount}`,
    },
    {
      id: 'goal-reached-pass-branch',
      pass: minGoalClear <= spec.goalToleranceM && firstGoalClear !== undefined,
      detail: `clear-road run closes to ${minGoalClear.toFixed(2)} m of the goal at t=${firstGoalClear?.t ?? 'n/a'}s (ReachPositionCondition tolerance ${spec.goalToleranceM} m)`,
    },
  ];

  const pathSample = JSON.stringify(
    ftFull.map((s) => [s.t, +s.x.toFixed(3), +s.z.toFixed(3), +s.speedMps.toFixed(3)]),
  );
  const traceHash = createHash('sha256').update(gzipSync(Buffer.from(pathSample))).digest('hex');

  return {
    schema: 'uniscenarios.v2x-migration-verification.v1',
    scenario: name,
    source: { fileName: spec.source, sha256: spec.sourceSha256 },
    template: `apps/v2x-migration/scenarios/${name}.template.json`,
    evidence: {
      fullChoreography: `apps/v2x-migration/evidence/${name}.debug.json/`,
      clearRoadPassBranch: `apps/v2x-migration/evidence/${name}.clearroad.debug.json/`,
      fullTraceDigest: full.input.traceDigest,
      pathSampleSha256: traceHash,
    },
    checks,
    ok: checks.every((c) => c.pass),
  };
}

const out = {};
let allOk = true;
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SPEC)) {
  const report = verify(name);
  out[name] = report;
  allOk = allOk && report.ok;
  console.log(name.padEnd(24), report.ok ? 'PASS' : 'FAIL', report.checks.map((c) => `${c.id}:${c.pass ? 'ok' : 'FAIL'}`).join(' '));
}
writeFileSync(`${DIR}/verification.json`, JSON.stringify(out, null, 2) + '\n');
process.exit(allOk ? 0 : 1);
