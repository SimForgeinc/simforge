/**
 * Campaign scratch: sweep one template's tier-1 axes by pinning them to
 * discrete values and reading the reveal-to-conflict / minTTC distributions
 * back out of `simforge batch`. Not part of the shipped library — this is how the
 * campaign found out which axis actually moves the occlusion metric.
 *
 * usage: node sweep.mjs <template.json> <maps> '<json patch fn body>' ...
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SIMFORGE = path.join(ROOT, 'packages/cli/bin/simforge.js');

export function pinParam(doc, id, value) {
  const d = doc.params.declarations.find((x) => x.id === id);
  if (!d) throw new Error(`no param ${id}`);
  d.type = 'discrete';
  d.values = [value];
  d.default = value;
  delete d.range;
  delete d.distribution;
  delete d.step;
}

export function runBatch(doc, { maps = '--all-maps', draws = 1, tag = 'sweep' } = {}) {
  const file = `/tmp/simforge-sweep-${tag}.json`;
  const out = `/tmp/simforge-sweep-out/${tag}`;
  fs.rmSync(out, { recursive: true, force: true });
  fs.writeFileSync(file, JSON.stringify(doc));
  const args = ['batch', file, ...(maps === '--all-maps' ? ['--all-maps'] : ['--maps', maps]),
    '--draws', String(draws), '--out', out, '--no-trace'];
  const stdout = execFileSync('node', [SIMFORGE, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return JSON.parse(stdout);
}

export function describe(summary) {
  const rc = summary.results.map((r) => r.metrics?.revealToConflict?.value)
    .filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const tt = summary.results.map((r) => r.metrics?.minTTC?.value)
    .filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const q = (arr, p) => (arr.length ? arr[Math.floor(p * (arr.length - 1))].toFixed(2) : '—');
  return {
    cells: summary.results.length,
    accepted: summary.criticality.accepted,
    revealN: rc.length,
    reveal: `${q(rc, 0)} / ${q(rc, 0.5)} / ${q(rc, 1)}`,
    minTTC: `${q(tt, 0)} / ${q(tt, 0.5)} / ${q(tt, 1)}`,
  };
}
