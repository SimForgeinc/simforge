/**
 * `simforge sites match <template> --map <id> | --all-maps`.
 *
 * The mechanical stage of the generation pipeline: no LLM, no randomness, and
 * the same site ids on every machine. Failure is as informative as success —
 * an empty result carries `failureSummary` and the required clauses that failed
 * most often, because "nothing matched" without a reason is what makes an agent
 * start guessing.
 */

import { EXIT } from '../errors.js';
import { emit, emitLines, fixed, pad } from '../output.js';
import { matchOnMaps, siteSummary, round3 } from '@simforge/compiler/node';
import { readTemplate } from '@simforge/compiler/node';

export interface SitesMatchOptions {
  readonly file: string;
  readonly mapIds: readonly string[];
  readonly minScore?: number | undefined;
  readonly maxSites?: number | undefined;
  readonly includeRejected: boolean;
  readonly pretty: boolean;
}

export async function sitesMatch(options: SitesMatchOptions): Promise<number> {
  const template = await readTemplate(options.file);
  const matches = await matchOnMaps(template, options.mapIds, {
    minScore: options.minScore,
    maxSites: options.maxSites,
  });

  const maps = matches.map((m) => {
    const scores = m.report.sites.map((s) => s.score);
    return {
      mapId: m.mapId,
      topologyDigest: m.bundle.index.topologyDigest,
      siteCount: m.report.sites.length,
      scoreRange:
        scores.length > 0
          ? { min: round3(Math.min(...scores)), max: round3(Math.max(...scores)) }
          : null,
      verdicts: {
        exact: m.report.sites.filter((s) => s.degradation.verdict === 'exact').length,
        degraded: m.report.sites.filter((s) => s.degradation.verdict === 'degraded').length,
      },
      stats: m.report.stats,
      warnings: m.report.warnings,
      failureSummary: m.report.failureSummary,
      sites: m.report.sites.map(siteSummary),
      ...(options.includeRejected
        ? { rejected: m.report.rejected.slice(0, 25).map(siteSummary) }
        : {}),
    };
  });

  const total = maps.reduce((acc, m) => acc + m.siteCount, 0);
  const payload = {
    template: options.file,
    templateId: template.anchor.id ?? template.meta.name,
    archetype: template.meta.archetype ?? null,
    adapterNotes: matches[0]?.notes ?? [],
    totalSites: total,
    maps,
  };

  if (!options.pretty) {
    emit(payload, options);
    return total > 0 ? EXIT.ok : EXIT.validationFindings;
  }

  const lines = [
    `${template.meta.name} (${template.meta.archetype ?? 'no archetype'}) — ${total} site(s) across ${maps.length} map(s)`,
    '',
    `${pad('map', 32)}${pad('sites', 7)}${pad('score min–max', 16)}${pad('exact/deg', 12)}${pad('cands', 8)}frames`,
  ];
  for (const m of maps) {
    lines.push(
      pad(m.mapId, 32) +
        pad(String(m.siteCount), 7) +
        pad(
          m.scoreRange ? `${fixed(m.scoreRange.min, 3)}–${fixed(m.scoreRange.max, 3)}` : '—',
          16,
        ) +
        pad(`${m.verdicts.exact}/${m.verdicts.degraded}`, 12) +
        pad(String(m.stats.candidatesConsidered), 8) +
        String(m.stats.framesBuilt),
    );
    if (m.siteCount === 0 && m.failureSummary) lines.push(`    ${m.failureSummary}`);
  }
  lines.push('');
  for (const m of maps) {
    for (const s of m.sites) {
      lines.push(
        `${pad(String(s['siteId']), 22)}${pad(m.mapId, 30)}${pad(fixed(s['score'] as number, 3), 8)}${pad(
          String(s['verdict']),
          10,
        )}${String(s['origin'])} via ${String(s['entryLaneRsl'])} turn ${String(s['egoTurn'])}`,
      );
    }
  }
  emitLines(lines);
  return total > 0 ? EXIT.ok : EXIT.validationFindings;
}
