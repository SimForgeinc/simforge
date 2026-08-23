#!/usr/bin/env node
/**
 * `bench:claims` — run the grader benchmark over the committed corpus and
 * write `benchmark/report.v1.json` plus a stdout summary.
 *
 * Exit 1 when the ≥90 % recovery gate fails, so CI-style callers can gate on it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

import type { Corpus } from '../corpus.js';
import { runBenchmark } from '../benchmark.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');

function main(): number {
  const corpusFile = process.argv[2] ?? path.join(PKG, 'fixtures', 'corpus.v1.json');
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8')) as Corpus;
  const report = runBenchmark(corpus.scenarios);

  const outDir = path.join(PKG, 'benchmark');
  mkdirSync(outDir, { recursive: true });
  const reportFile = path.join(outDir, 'report.v1.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

  const t = report.totals;
  process.stdout.write(
    [
      `scenarios=${t.scenarios} cases=${t.cases} (clean=${t.cleanControls})`,
      `injected=${t.injectedErrors} recovered=${t.recoveredErrors} recall=${(t.recall * 100).toFixed(1)}%`,
      `precision=${(t.precision * 100).toFixed(1)}% spuriousFlags=${t.spuriousFlags}`,
      `gate ≥${report.gate.threshold * 100}%: ${report.gate.passed ? 'PASS' : 'FAIL'}`,
      `report: ${reportFile}`,
      '',
      'by operator:',
      ...Object.entries(report.byOp).map(
        ([op, b]) => `  ${op.padEnd(22)} ${b.recovered}/${b.injected}`,
      ),
      ...(report.residuals.length > 0
        ? ['', 'residuals:', ...report.residuals.slice(0, 20).map((r) => `  ${r.caseId}: ${r.detail} — ${r.reason}`)]
        : []),
    ].join('\n') + '\n',
  );
  return report.gate.passed ? 0 : 1;
}

process.exit(main());
