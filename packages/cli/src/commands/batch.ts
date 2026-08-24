/**
 * `uniscenarios batch <template> --maps a,b,c --draws N --out dir/` — the matrix.
 *
 * ```
 * for each map:   sites = match(anchor, map)
 * for each site:  for draw in 0..N-1:  instantiate → simulate → evaluate
 * ```
 *
 * Three properties make this usable at generation scale:
 *
 * - **Resumable.** A cell whose `.result.json` already carries the expected
 *   `paramSeed` *and* whose instance carries the expected template digest,
 *   matcher version, solver version and topology digest is skipped. Change any
 *   of those and the cell re-runs, because its old answer no longer means what
 *   it says.
 * - **Order-independent.** A cell's seed is a hash of its coordinates, so the
 *   worker that happens to pick it up cannot change its result. The summary is
 *   sorted before it is written.
 * - **Parallel.** A small worker-thread pool, because the engine is synchronous
 *   CPU work and an async pool in one thread would run it strictly serially.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { MATCH_SEMANTICS_VERSION } from '@simforge/compiler/node';
import {
  ENGINE_VERSION,
  contentHash,
  resolveAmbientTrafficProfile,
  type AmbientTrafficProfile,
} from '@simforge/engine';

import { cellPaths, runCell, type CellOptions, type CellResult } from '../batch-cell.js';
import { EXIT } from '../errors.js';
import { emit, emitLines, fixed, pad } from '../output.js';
import { cellSeed, paramsVersion, templateId } from '../params.js';
import { matchOnMaps } from '@simforge/compiler/node';
import { readTemplate, writeJsonFile } from '@simforge/compiler/node';
import type { EvaluateFilterMode } from './evaluate.js';

export interface BatchOptions {
  readonly file: string;
  readonly mapIds: readonly string[];
  readonly draws: number;
  readonly outDir: string;
  readonly minScore?: number | undefined;
  readonly maxSites?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly writeTrace: boolean;
  readonly filter: EvaluateFilterMode;
  readonly trivialTtcS?: number | undefined;
  readonly force: boolean;
  readonly pretty: boolean;
  /** Generated background road users; absent leaves the roads empty. */
  readonly ambient?: AmbientTrafficProfile | undefined;
  /**
   * AMBIENT WARM-UP: seconds of ambient-only integration before `t = 0`, so the
   * road is already in motion (and already queued) when the clip starts.
   * Authored actors are not advanced by it. `0` or absent is the old behaviour.
   */
  readonly ambientSettleSeconds?: number | undefined;
}

interface PlannedCell extends CellOptions {
  readonly expectedSeed: string;
}

export async function batch(options: BatchOptions): Promise<number> {
  const started = Date.now();
  const template = await readTemplate(options.file);
  const matches = await matchOnMaps(template, options.mapIds, {
    minScore: options.minScore,
    maxSites: options.maxSites,
  });

  const tid = templateId(template);
  const pv = paramsVersion(template);
  const templateDigest = contentHash(template).slice(0, 16);

  // Resolve once so every cell, every worker and the replay key see one
  // canonical profile rather than re-defaulting per cell.
  const ambient = options.ambient === undefined ? undefined : options.ambient;
  const ambientSettleSeconds = ambient === undefined ? 0 : options.ambientSettleSeconds ?? 0;
  const ambientProfileHash = ambient === undefined
    ? 'none'
    : resolveAmbientTrafficProfile(ambient).preset === 'off'
      ? 'none'
      // Must match what `materialize` stamps into the manifest replay key, or a
      // resumed cell settled for a different length would be served as fresh.
      : ambientSettleSeconds > 0
        ? `${contentHash(resolveAmbientTrafficProfile(ambient))}+settle${ambientSettleSeconds}`
        : contentHash(resolveAmbientTrafficProfile(ambient));

  const cells: PlannedCell[] = [];
  const perMapSites: Array<{ mapId: string; sites: number; matcherIndexDigest: string; engineGraphDigest: string }> = [];
  for (const match of matches) {
    perMapSites.push({
      mapId: match.mapId,
      sites: match.report.sites.length,
      matcherIndexDigest: match.bundle.index.topologyDigest,
      engineGraphDigest: match.bundle.graph.topologyDigest,
    });
    for (const site of match.report.sites) {
      for (let draw = 0; draw < options.draws; draw += 1) {
        cells.push({
          mapId: match.mapId,
          siteId: site.siteId,
          drawIndex: draw,
          outDir: options.outDir,
          writeTrace: options.writeTrace,
          filter: options.filter,
          trivialTtcS: options.trivialTtcS,
          ...(ambient === undefined ? {} : { ambient }),
          ...(ambientSettleSeconds > 0 ? { ambientSettleSeconds } : {}),
          expectedSeed: cellSeed(tid, pv, site.siteId, draw),
        });
      }
    }
  }
  // Sorted plan → sorted summary, whatever order the pool completes in.
  cells.sort(
    (a, b) =>
      (a.mapId < b.mapId ? -1 : a.mapId > b.mapId ? 1 : 0) ||
      (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0) ||
      a.drawIndex - b.drawIndex,
  );

  // --- resume ---------------------------------------------------------------
  const results = new Map<string, CellResult>();
  const todo: PlannedCell[] = [];
  let resumed = 0;
  for (const cell of cells) {
    const key = cellKey(cell);
    if (!options.force) {
      const reused = await tryResume(cell, {
        templateDigest,
        matcherVersion: MATCH_SEMANTICS_VERSION,
        solverVersion: ENGINE_VERSION,
        matcherIndexDigest: matches.find((m) => m.mapId === cell.mapId)?.bundle.index.topologyDigest ?? '',
        engineGraphDigest: matches.find((m) => m.mapId === cell.mapId)?.bundle.graph.topologyDigest ?? '',
        ambientProfileHash,
      });
      if (reused) {
        results.set(key, reused);
        resumed += 1;
        continue;
      }
    }
    todo.push(cell);
  }

  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Math.min(4, Math.max(1, os.cpus().length - 1)), todo.length || 1),
  );

  if (concurrency === 1 || todo.length <= 1) {
    for (const cell of todo) results.set(cellKey(cell), await runCell(template, cell));
  } else {
    const done = await runPool(options.file, todo, concurrency);
    for (const [key, value] of done) results.set(key, value);
  }

  const ordered = cells.map((c) => results.get(cellKey(c))).filter((r): r is CellResult => !!r);

  const bands: Record<string, number> = {};
  for (const r of ordered) bands[r.band ?? 'unknown'] = (bands[r.band ?? 'unknown'] ?? 0) + 1;
  const accepted = ordered.filter((r) => r.verdict === 'accept').length;
  const infeasible = ordered.filter((r) => !r.feasible || r.status === 'error').length;
  const ttcs = ordered
    .map((r) => (r.metrics?.['minTTC'] as { value: number } | null | undefined)?.value)
    .filter((v): v is number => typeof v === 'number');

  const ambientCounts = ordered
    .map((r) => r.ambient?.actorCount)
    .filter((v): v is number => typeof v === 'number');
  const ambientNear = ordered
    .map((r) => r.ambient?.nearSubjectAtT0)
    .filter((v): v is number => typeof v === 'number');

  const summary = {
    kind: 'scenario-batch-summary',
    version: 1,
    template: path.resolve(options.file),
    templateId: tid,
    templateDigest,
    paramsVersion: pv,
    matcherVersion: MATCH_SEMANTICS_VERSION,
    solverVersion: ENGINE_VERSION,
    archetype: template.meta.archetype ?? null,
    negativeControl: template.meta.negativeControl,
    maps: perMapSites,
    draws: options.draws,
    // Present only when ambient traffic was requested, so an empty-road summary
    // is byte-identical to the ones this command wrote before.
    ...(ambient === undefined ? {} : {
      ambient: {
        profile: resolveAmbientTrafficProfile(ambient),
        profileHash: ambientProfileHash,
        cellsWithAmbient: ambientCounts.filter((v) => v > 0).length,
        actorsPerCell: ambientCounts.length
          ? { min: Math.min(...ambientCounts), median: median(ambientCounts), max: Math.max(...ambientCounts) }
          : null,
        // The measure that matters: how much traffic the metric subject can
        // actually see at t = 0, not how much was placed somewhere on the map.
        nearSubjectAtT0: ambientNear.length
          ? { min: Math.min(...ambientNear), median: median(ambientNear), max: Math.max(...ambientNear) }
          : null,
      },
    }),
    cells: ordered.length,
    resumed,
    concurrency,
    elapsedMs: Date.now() - started,
    criticality: {
      accepted,
      rejected: ordered.length - accepted,
      infeasible,
      bands,
      minTTC: ttcs.length
        ? {
            min: round(Math.min(...ttcs)),
            median: round(median(ttcs)),
            max: round(Math.max(...ttcs)),
            n: ttcs.length,
          }
        : null,
    },
    results: ordered,
  };

  const summaryFile = path.join(options.outDir, 'batch-summary.json');
  await writeJsonFile(summaryFile, summary);

  if (!options.pretty) {
    emit({ ...summary, summaryFile: path.resolve(summaryFile) }, options);
  } else {
    const lines = [
      `${template.meta.name} — ${ordered.length} cell(s) over ${perMapSites.length} map(s) × ${options.draws} draw(s) in ${(
        (Date.now() - started) / 1000
      ).toFixed(1)} s (${resumed} resumed, ${concurrency} worker(s))`,
      '',
      `${pad('map', 32)}${pad('sites', 7)}cells`,
      ...perMapSites.map(
        (m) => pad(m.mapId, 32) + pad(String(m.sites), 7) + String(m.sites * options.draws),
      ),
      '',
      'criticality:',
      ...Object.entries(bands)
        .sort()
        .map(([band, n]) => `  ${pad(band, 20)}${n}  (${((100 * n) / Math.max(1, ordered.length)).toFixed(1)}%)`),
      `  ${pad('accepted', 20)}${accepted}`,
      `  ${pad('infeasible', 20)}${infeasible}`,
      ttcs.length
        ? `  minTTC min/median/max: ${fixed(Math.min(...ttcs))} / ${fixed(median(ttcs))} / ${fixed(Math.max(...ttcs))} s over ${ttcs.length} cell(s)`
        : '  minTTC: no pair ever closed',
      '',
      `summary: ${path.resolve(summaryFile)}`,
    ];
    emitLines(lines);
  }

  return ordered.length > 0 ? EXIT.ok : EXIT.validationFindings;
}

function cellKey(cell: { mapId: string; siteId: string; drawIndex: number }): string {
  return `${cell.mapId}|${cell.siteId}|${cell.drawIndex}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Reuse a previous cell only when every part of the replay key still holds.
 *
 * The seed alone is not enough: it does not move when the *matcher* or the
 * *engine* changes, and a cached verdict from an older matcher is exactly the
 * kind of stale answer a resumable batch is supposed to prevent.
 */
async function tryResume(
  cell: PlannedCell,
  expect: {
    templateDigest: string;
    matcherVersion: string;
    solverVersion: string;
    matcherIndexDigest: string;
    engineGraphDigest: string;
    ambientProfileHash: string;
  },
): Promise<CellResult | null> {
  const paths = cellPaths(cell.outDir, cell);
  if (!existsSync(paths.result) || !existsSync(paths.instance)) return null;
  try {
    const result = JSON.parse(await readFile(paths.result, 'utf8')) as CellResult;
    if (result.status !== 'ok' || result.paramSeed !== cell.expectedSeed) return null;
    const instance = JSON.parse(await readFile(paths.instance, 'utf8')) as {
      manifest?: { replayKey?: Record<string, string> };
    };
    const key = instance.manifest?.replayKey;
    if (!key) return null;
    if (key['templateDigest'] !== expect.templateDigest) return null;
    if (key['matcherVersion'] !== expect.matcherVersion) return null;
    if (key['solverVersion'] !== expect.solverVersion) return null;
    if (key['matcherIndexDigest'] !== expect.matcherIndexDigest) return null;
    if (key['engineGraphDigest'] !== expect.engineGraphDigest) return null;
    if (key['paramSeed'] !== cell.expectedSeed) return null;
    // A cell simulated on an empty road is not the answer to the same question
    // as a cell simulated in traffic. An instance predating this field has no
    // recorded ambient population, so it can only be reused for `'none'`.
    if ((key['ambientProfileHash'] ?? 'none') !== expect.ambientProfileHash) return null;
    if (cell.writeTrace && !existsSync(paths.trace)) return null;
    return result;
  } catch {
    return null;
  }
}

/** Hand cells out to a worker pool, one at a time, until they are all done. */
async function runPool(
  templateFile: string,
  cells: readonly PlannedCell[],
  concurrency: number,
): Promise<Map<string, CellResult>> {
  const out = new Map<string, CellResult>();
  const queue = [...cells];
  const workerUrl = new URL('../batch-worker.mjs', import.meta.url);

  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let finished = 0;
    const workers: Worker[] = [];

    const shutdown = (): void => {
      for (const w of workers) void w.terminate();
    };

    for (let i = 0; i < concurrency; i += 1) {
      const worker = new Worker(workerUrl, {
        workerData: { templateFile } satisfies { templateFile: string },
      });
      workers.push(worker);

      const pump = (): void => {
        const next = queue.shift();
        if (!next) {
          if (active === 0 && finished === cells.length) {
            shutdown();
            resolve();
          }
          return;
        }
        active += 1;
        worker.postMessage({ kind: 'cell', id: finished, options: stripPlan(next) });
      };

      worker.on('message', (message: { kind: string; result?: CellResult }) => {
        if (message.kind === 'ready') {
          pump();
          return;
        }
        if (message.kind === 'done' && message.result) {
          out.set(cellKey(message.result), message.result);
          active -= 1;
          finished += 1;
          if (finished === cells.length) {
            shutdown();
            resolve();
            return;
          }
          pump();
        }
      });
      worker.on('error', (error) => {
        shutdown();
        reject(error);
      });
    }
  });

  return out;
}

function stripPlan(cell: PlannedCell): CellOptions {
  const { expectedSeed: _ignored, ...rest } = cell;
  return rest;
}
