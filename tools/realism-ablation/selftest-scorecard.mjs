#!/usr/bin/env node
/**
 * Self-test stub emitting a schema-valid bridge-fidelity scorecard.
 *
 * Purpose: exercise run-ablation.mjs's scoring/validation/comparison path
 * before WS1's real corpus + detector land. The metrics are synthetic and
 * derived from the directory name so stage A/B produce deterministic,
 * deliberately different numbers. NEVER cite its output as a measurement.
 */
import { createHash } from 'node:crypto';

const framesDir = process.argv[2] ?? '.';
const seed = createHash('sha256').update(framesDir).digest()[0] / 255;
const scorecard = {
  corpusHash: 'selftest-corpus-0000000000000000000000000000000000000000000000000000000000000000',
  detector: {
    name: 'selftest-detector',
    version: '0.0.0',
    weightsSha256: '0000000000000000000000000000000000000000000000000000000000000000',
  },
  perClass: {
    ap: Number((0.40 + seed * 0.10).toFixed(4)),
    recall: Number((0.55 + seed * 0.10).toFixed(4)),
  },
  hallucinationRate: Number((0.05 + seed * 0.02).toFixed(4)),
  deletionRate: Number((0.04 + seed * 0.02).toFixed(4)),
  fid: Number((60 + seed * 10).toFixed(2)),
  verdict: 'selftest',
};
process.stdout.write(`${JSON.stringify(scorecard)}\n`);
