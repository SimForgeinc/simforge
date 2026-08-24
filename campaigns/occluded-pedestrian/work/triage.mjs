/**
 * Campaign triage: batch summaries → manifest, library, coverage ledger.
 *
 * Promotion rule for the library (stated here because it is the campaign's
 * editorial judgement, not the CLI's): an instance is promoted when
 *
 *   1. `simforge evaluate`'s reject filters accepted it (`verdict === 'accept'`,
 *      which for these templates means band `critical`), **and**
 *   2. the materializer reported no feasibility *error* (`feasible === true`) —
 *      a cell whose ego runs out of road at t = 13 s still produces a valid
 *      criticality peak at t ≈ 7 s, so the batch accepts it, but it is not a
 *      clip you would hand to a renderer.
 *
 * Traces are deliberately left in `batches/` (gitignored): the library carries
 * the instance — which is the reproducible thing — plus the metrics summary.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CAMPAIGN = path.join(ROOT, 'campaigns/occluded-pedestrian');
const BATCHES = path.join(CAMPAIGN, 'batches');
const LIBRARY = path.join(CAMPAIGN, 'library');

const TEMPLATES = ['cpnco-parked-row', 'multiple-threat', 'bus-stop-emergence', 'school-dartout'];
const MAPS = [
  'yale-street',
  'belmont-research-center',
  'el-camino-road',
  'easterbrook-discovery-school',
  'richmond-field-station',
];

/** Criticality bands used by the ledger. `minTTC` seconds. */
function ttcBand(v) {
  if (v === null || v === undefined) return 'none';
  if (v < 1.0) return 'severe';        // sub-second: contact is nearly certain
  if (v < 1.8) return 'critical';      // inside the AEB-relevant band
  if (v < 3.0) return 'marginal';      // avoidable with a firm brake
  return 'benign';
}

/** Reveal-to-conflict bands. The research doc's critical band is 0.4–1.5 s. */
function revealBand(v) {
  if (typeof v !== 'number') return 'none';
  if (v < 0.4) return 'blind';         // no useful sight line at all
  if (v <= 1.5) return 'critical';     // the band the research doc names
  if (v <= 3.0) return 'short';
  if (v <= 4.0) return 'long';
  return 'ineffective';                // the occluder is not really occluding
}

const quantiles = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return {
    n: s.length,
    min: +at(0).toFixed(3),
    p25: +at(0.25).toFixed(3),
    median: +at(0.5).toFixed(3),
    p75: +at(0.75).toFixed(3),
    max: +at(1).toFixed(3),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3),
  };
};

const manifest = { kind: 'campaign-manifest', version: 1, campaign: 'occluded-pedestrian', generatedFrom: 'simforge batch --all-maps --draws 8', templates: {}, cells: [] };
const ledger = {
  kind: 'coverage-ledger',
  version: 1,
  campaign: 'occluded-pedestrian',
  note: 'archetype x map x criticality-band counts over ACCEPTED library instances; the seed a later campaign subtracts from its coverage plan.',
  bands: {
    minTTC: { severe: '<1.0 s', critical: '1.0-1.8 s', marginal: '1.8-3.0 s', benign: '>=3.0 s' },
    revealToConflict: { blind: '<0.4 s', critical: '0.4-1.5 s', short: '1.5-3.0 s', long: '3.0-4.0 s', ineffective: '>4.0 s' },
  },
  archetypes: {},
  totals: { cells: 0, accepted: 0, promoted: 0 },
};

fs.rmSync(LIBRARY, { recursive: true, force: true });

for (const tpl of TEMPLATES) {
  const summaryPath = path.join(BATCHES, tpl, 'batch-summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const archetype = summary.archetype;
  const byMap = Object.fromEntries(summary.maps.map((m) => [m.mapId, { sites: m.sites, cells: 0, accepted: 0, promoted: 0 }]));

  const ttcs = [];
  const reveals = [];
  const bandCounts = {};
  const findingCounts = {};
  let promoted = 0;

  for (const r of summary.results) {
    const m = r.metrics ?? {};
    const minTTC = m.minTTC?.value ?? null;
    const reveal = m.revealToConflict?.value ?? null;
    const pair = m.minTTC?.pair ?? null;
    const promote = r.verdict === 'accept' && r.feasible === true;

    byMap[r.mapId].cells += 1;
    if (r.verdict === 'accept') byMap[r.mapId].accepted += 1;
    bandCounts[r.band ?? 'infeasible'] = (bandCounts[r.band ?? 'infeasible'] ?? 0) + 1;
    for (const f of r.findings ?? []) findingCounts[f.code] = (findingCounts[f.code] ?? 0) + 1;
    if (r.error) findingCounts[`error:${r.error.code}`] = (findingCounts[`error:${r.error.code}`] ?? 0) + 1;

    if (promote) {
      promoted += 1;
      byMap[r.mapId].promoted += 1;
      if (typeof minTTC === 'number') ttcs.push(minTTC);
      if (typeof reveal === 'number') reveals.push(reveal);

      const dest = path.join(LIBRARY, tpl, r.mapId, r.siteId);
      fs.mkdirSync(dest, { recursive: true });
      const stem = `draw-${String(r.drawIndex).padStart(3, '0')}`;
      fs.copyFileSync(r.instanceFile, path.join(dest, `${stem}.instance.json`));
      fs.writeFileSync(
        path.join(dest, `${stem}.metrics.json`),
        `${JSON.stringify({
          instanceId: r.instanceId,
          archetype,
          mapId: r.mapId,
          siteId: r.siteId,
          drawIndex: r.drawIndex,
          siteScore: r.siteScore,
          siteVerdict: r.siteVerdict,
          params: r.params,
          paramSeed: r.paramSeed,
          inputHash: r.inputHash,
          traceDigest: r.traceDigest,
          verdict: r.verdict,
          band: r.band,
          tags: r.tags,
          metrics: r.metrics,
        }, null, 2)}\n`,
      );

      const arch = (ledger.archetypes[archetype] ??= { template: tpl, maps: {} });
      const mp = (arch.maps[r.mapId] ??= { promoted: 0, minTTC: {}, revealToConflict: {} });
      mp.promoted += 1;
      const tb = ttcBand(minTTC);
      const rb = revealBand(reveal);
      mp.minTTC[tb] = (mp.minTTC[tb] ?? 0) + 1;
      mp.revealToConflict[rb] = (mp.revealToConflict[rb] ?? 0) + 1;
    }

    manifest.cells.push({
      template: tpl,
      archetype,
      mapId: r.mapId,
      siteId: r.siteId,
      drawIndex: r.drawIndex,
      instanceId: r.instanceId,
      replayKey: {
        templateId: summary.templateId,
        templateDigest: summary.templateDigest,
        paramsVersion: summary.paramsVersion,
        matcherVersion: summary.matcherVersion,
        solverVersion: summary.solverVersion,
        mapId: r.mapId,
        siteId: r.siteId,
        drawIndex: r.drawIndex,
        paramSeed: r.paramSeed,
      },
      inputHash: r.inputHash,
      traceDigest: r.traceDigest,
      status: r.status,
      feasible: r.feasible,
      verdict: r.verdict,
      band: r.band,
      promoted: promote,
      params: r.params,
      minTTC,
      minTTCt: m.minTTC?.t ?? null,
      minTTCpair: pair,
      revealToConflict: reveal,
      revealLosOpenT: m.revealToConflict?.losOpenT ?? null,
      requiredDecelMax: m.requiredDecelMax ?? null,
      collisions: (m.collisions ?? []).length,
      findings: (r.findings ?? []).map((f) => f.code),
      ...(r.error ? { error: r.error.code } : {}),
    });
  }

  manifest.templates[tpl] = {
    archetype,
    templateDigest: summary.templateDigest,
    paramsVersion: summary.paramsVersion,
    matcherVersion: summary.matcherVersion,
    solverVersion: summary.solverVersion,
    draws: summary.draws,
    cells: summary.results.length,
    accepted: summary.criticality.accepted,
    promoted,
    bands: bandCounts,
    findings: findingCounts,
    byMap,
    minTTC: quantiles(ttcs),
    revealToConflict: quantiles(reveals),
  };

  ledger.totals.cells += summary.results.length;
  ledger.totals.accepted += summary.criticality.accepted;
  ledger.totals.promoted += promoted;
}

manifest.cells.sort(
  (a, b) =>
    a.template.localeCompare(b.template) ||
    a.mapId.localeCompare(b.mapId) ||
    a.siteId.localeCompare(b.siteId) ||
    a.drawIndex - b.drawIndex,
);

fs.writeFileSync(path.join(CAMPAIGN, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(ROOT, 'campaigns/coverage-ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);

for (const [tpl, t] of Object.entries(manifest.templates)) {
  console.log(
    `${tpl.padEnd(20)} cells ${String(t.cells).padStart(3)}  accepted ${String(t.accepted).padStart(3)}  promoted ${String(t.promoted).padStart(3)}  ` +
      `minTTC ${t.minTTC ? `${t.minTTC.min}/${t.minTTC.median}/${t.minTTC.max}` : '—'}  reveal ${t.revealToConflict ? `${t.revealToConflict.min}/${t.revealToConflict.median}/${t.revealToConflict.max} (n=${t.revealToConflict.n})` : '—'}`,
  );
  console.log(`  maps: ${Object.entries(t.byMap).map(([m, v]) => `${m}=${v.sites}s/${v.promoted}p`).join('  ')}`);
  console.log(`  bands: ${JSON.stringify(t.bands)}  findings: ${JSON.stringify(t.findings)}`);
}
console.log('totals', JSON.stringify(ledger.totals));
