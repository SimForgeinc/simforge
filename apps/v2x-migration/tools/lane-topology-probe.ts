/**
 * V6 migration helper: inspect the richmond-field-station Uni lane topology
 * around the V2XCarla xosc poses. Prints nearest-lane projections and directed
 * successor chains between a spawn lane and a goal lane.
 *
 * Usage: pnpm exec tsx apps/v2x-migration/tools/lane-topology-probe.ts
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildLaneGraph, type TopologyIndex } from '@simforge/engine';

const DIR = 'dev-assets/richmond-field-station';
const index = JSON.parse(
  gunzipSync(readFileSync(`${DIR}/topology-index.json.gz`)).toString('utf8'),
) as TopologyIndex;
const g = buildLaneGraph(index);

// Scene frame (x, z = CARLA y) → xodr-local (x, y = -z).
const POSES: Record<string, { x: number; z: number }> = {
  north_spawn: { x: -175.71, z: 50.4 },
  north_ego: { x: -157.11, z: -6.6 },
  north_intersection: { x: -139.34, z: -55.8 },
  north_goal: { x: -115.37, z: -97.3 },
  south_spawn: { x: -60.42, z: -200.22 },
  south_ego: { x: -103.66, z: -129.76 },
  south_goal: { x: -166.63, z: 11.18 },
};

function project(p: { x: number; z: number }) {
  const local = { x: p.x, y: -p.z };
  let best: { rsl: string; dist: number; s: number; headingRad: number; fwdDot: number } | null = null;
  for (const rsl of g.laneRsls()) {
    const geo = g.geometry(rsl)!;
    for (let i = 1; i < geo.points.length; i++) {
      const a = geo.points[i - 1]!;
      const b = geo.points[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1e-9;
      let t = ((local.x - a.x) * dx + (local.y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const d = Math.hypot(local.x - px, local.y - py);
      if (!best || d < best.dist) {
        best = {
          rsl,
          dist: d,
          s: geo.cum[i - 1]! + Math.sqrt(t * len2),
          headingRad: Math.atan2(dy, dx),
          fwdDot: Math.sign(dx),
        };
      }
    }
  }
  return best!;
}

const PROJECTION_BY_NAME: Record<string, ReturnType<typeof project>> = {};
for (const [name, p] of Object.entries(POSES)) {
  const pr = project(p);
  PROJECTION_BY_NAME[name] = pr;
  console.log(name.padEnd(20), pr.rsl.padEnd(12), 'dist', pr.dist.toFixed(2), 's', pr.s.toFixed(1));
}

/** BFS over directed successors from both start orientations; shortest chain wins. */
function chain(fromRsl: string, toRsl: string): string[] | null {
  type Node = { rsl: string; fwd: boolean };
  const nodeKey = (n: Node): string => `${n.rsl}|${n.fwd}`;
  const startNodes: Node[] = [
    { rsl: fromRsl, fwd: true },
    { rsl: fromRsl, fwd: false },
  ];
  const PREV_BY_KEY: Record<string, { node: Node; prevKey: string | null }> = {};
  for (const n of startNodes) PREV_BY_KEY[nodeKey(n)] = { node: n, prevKey: null };
  let frontier = startNodes;
  while (frontier.length) {
    const next: Node[] = [];
    for (const n of frontier) {
      if (n.rsl === toRsl && PREV_BY_KEY[nodeKey(n)]!.prevKey !== null) {
        const out: Node[] = [];
        let cur: string | null = nodeKey(n);
        while (cur) {
          const entry = PREV_BY_KEY[cur]!;
          out.unshift(entry.node);
          cur = entry.prevKey;
        }
        return out.map((x) => `${x.rsl}${x.fwd ? '' : ' (rev)'}`);
      }
      for (const succ of g.successors({ rsl: n.rsl, reversed: !n.fwd })) {
        const succNode: Node = { rsl: succ.rsl, fwd: !succ.reversed };
        const k = nodeKey(succNode);
        if (k in PREV_BY_KEY) continue;
        PREV_BY_KEY[k] = { node: succNode, prevKey: nodeKey(n) };
        next.push(succNode);
      }
    }
    frontier = next;
  }
  return null;
}

console.log('\nchains:');
for (const [name, spawnKey, goalKey] of [
  ['north', 'north_spawn', 'north_goal'],
  ['south', 'south_spawn', 'south_goal'],
] as const) {
  const from = PROJECTION_BY_NAME[spawnKey]!.rsl;
  const to = PROJECTION_BY_NAME[goalKey]!.rsl;
  console.log(name, from, '→', to, JSON.stringify(chain(from, to)));
}

console.log('\nego lanes:');
for (const name of ['north_ego', 'south_ego']) {
  const pr = PROJECTION_BY_NAME[name]!;
  console.log(name, pr.rsl, 'dist', pr.dist.toFixed(2));
}
