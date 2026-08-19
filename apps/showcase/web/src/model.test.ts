import { describe, expect, it } from 'vitest';
import { artifactUrl, campaignCaseProgress, normalizeCampaign } from './api';
import { artifactKind, cells, formatRate, normalizeGallery, normalizeJob, scopeStageArtifacts, stageList, threeDVideos } from './model';
import type { CampaignBenchmark, CampaignReport, Rate } from './types';

describe('showcase contract adapters', () => {
  it('merges object-shaped stage indexes with live SSE updates', () => {
    const result = stageList({ stages: { '00-brief': { status: 'complete' }, '10-route': { status: 'running' } } }, {
      '10': { stage: '10-route', status: 'complete', artifacts: [{ path: 'job/10-route.json' }] },
    });
    expect(result[0].status).toBe('complete');
    expect(result[1].status).toBe('complete');
    expect(result[1].artifacts).toHaveLength(1);
  });
  it('accepts keyed cells and detects media', () => {
    expect(cells({ cells: { alpha: { map: 'sf' } } })[0].cellId).toBe('alpha');
    expect(artifactKind({ path: 'rollout.mp4' })).toBe('video');
    expect(artifactKind({ path: 'frame.png' })).toBe('image');
  });
  it('adapts the real server file index into stages, cells, and scoped artifacts', () => {
    const job = normalizeJob({ jobId: 'abc', files: [
      { path: '00-brief.json', json: { brief: 'A real brief', engine: 'auto' } },
      { path: '10-route.json', json: { engine: 'compiler' } },
      { path: '40-cells/index.json', json: { cells: [{ cellId: 'cell-1', mapId: 'yale-street' }] } },
      { path: '50-gate.json', json: { cells: [{ cellId: 'cell-1', pass: true }] } },
      { path: '60-render2d/cell-1/rollout.mp4', size: 12 },
      { path: '75-product.json', json: { cells: [{ cellId: 'cell-1', semanticAccepted: true, accepted: true }] } },
    ] });
    expect(job.brief).toBe('A real brief');
    expect(job.engine).toBe('compiler');
    expect(cells(job)[0].gate).toMatchObject({ pass: true });
    expect(cells(job)[0].product).toMatchObject({ semanticAccepted: true, accepted: true });
    expect(cells(job)[0].artifacts?.[0].path).toBe('jobs/abc/60-render2d/cell-1/rollout.mp4');
  });
  it('selects one preferred 3D rollout video only when accepted', () => {
    const job = normalizeJob({ jobId: 'abc', files: [
      { path: '40-cells/index.json', json: { cells: [{ cellId: 'cell-1', mapId: 'el-camino-road' }, { cellId: 'cell-2', mapId: 'yale-street' }] } },
      { path: '65-render3d/cell-1/frame.png', size: 12 },
      { path: '65-render3d/cell-1/video.mp4', size: 13 },
      { path: '65-render3d/cell-1/rollout.mp4', size: 14 },
      { path: '60-render2d/cell-2/rollout.mp4', size: 15 },
      { path: '75-product.json', json: { cells: [{ cellId: 'cell-1', semanticAccepted: true, accepted: true }] } },
      { path: '90-gallery.json', json: { accepted: true } },
    ] });
    const videos = threeDVideos(job);
    expect(videos[0].cell.cellId).toBe('cell-1');
    expect(videos[0].artifact.path).toBe('jobs/abc/65-render3d/cell-1/rollout.mp4');
    expect(threeDVideos({ ...job, status: 'running' })).toHaveLength(0);
    expect(threeDVideos({ ...job, cells: [{ ...cells(job)[0], product: { semanticAccepted: true, accepted: false } }] })).toHaveLength(0);
  });
  it('normalizes nested gallery metrics and SSE paths from the real server', () => {
    const [card] = normalizeGallery([{ jobId: 'abc', headline: '/artifacts/jobs/abc/movie.mp4', gate: { passed: 2, cells: 3 }, scores: { realism: 8.2, dynamism: 7.4 } }]);
    expect(card).toMatchObject({ media: '/artifacts/jobs/abc/movie.mp4', admittedCells: 2, totalCells: 3, realism: 8.2, dynamism: 7.4 });
    expect(scopeStageArtifacts('abc', { stage: '20-author', status: 'complete', artifacts: [{ path: '20-author/template.json' }] }).artifacts?.[0].path).toBe('jobs/abc/20-author/template.json');
  });
});

describe('campaign report contract', () => {
  const rawCampaign: unknown = {
    campaignId: 'edge-cases-67x5', targetValidVideos: 5, updatedAt: '2026-08-17T04:00:00Z',
    cases: [
      { id: 'unprotected-left-dense', title: 'Unprotected left turn across dense traffic', index: 0,
        attempts: [
          { number: 1, jobId: 'job-1', status: 'complete', metrics: { wallS: 912, tokens: { calls: 4, inputTokens: 10, outputTokens: 5, reasoningTokens: 1, modelWallS: 30 } } },
          { number: 2, jobId: 'job-2', status: 'running' },
        ],
        validVideos: [
          { sha256: 'aa11', url: '/artifacts/campaigns/edge-cases-67x5/videos/unprotected-left-dense/aa11.mp4', jobId: 'job-1', semanticAccepted: true, accepted: true, productContractVersion: 'showcase-deterministic-product/v1' },
          { sha256: 'aa11', url: '/artifacts/campaigns/edge-cases-67x5/videos/unprotected-left-dense/aa11.mp4' },
          { sha256: 'bb22' },
        ] },
      { id: 'wave-through', title: 'Drivers waving you through against right-of-way',
        attempts: [{ number: 1, jobId: 'job-3', status: 'failed', error: 'render crashed' }], validVideos: [] },
    ],
    validityContract: {
      semanticAcceptedRequired: true, acceptedRequired: true,
      briefAware2dSemanticOracleRequired: true, currentProductContractRequired: true, productContractVersion: 'showcase-deterministic-product/v1', minimumPerCase: 5,
    },
  };
  const report = normalizeCampaign(rawCampaign as Partial<CampaignReport>);

  it('presents only uniquely hashed, published videos and recomputes progress totals', () => {
    expect(report.cases[0].validVideos.map((video) => video.sha256)).toEqual(['aa11']);
    expect(report.cases[1].index).toBe(1);
    expect(report.totals).toMatchObject({ cases: 2, completeCases: 0, targetVideos: 10, validVideos: 1, jobs: 0, activeJobs: 0 });
    expect(report.totals.tokens).toMatchObject({ calls: 0, inputTokens: 0 });
    expect(report.totals.meanTokensPerValidVideo).toBeNull();
  });
  it('preserves published benchmark evidence and leaves legacy reports without fabricated evidence', () => {
    const benchmark = {
      schema: 'showcase-benchmark-report/v1',
      campaignId: 'edge-cases-67x5',
      generatedAt: '2026-08-18T19:21:23.122Z',
    } as CampaignBenchmark;
    const withBenchmark = normalizeCampaign({
      ...(rawCampaign as CampaignReport),
      totals: { benchmark },
    } as Partial<CampaignReport>);
    expect(withBenchmark.totals.benchmark).toBe(benchmark);
    expect(report.totals.benchmark).toBeUndefined();
  });
  it('formats a zero-denominator rate as unavailable rather than zero percent', () => {
    const unavailable = { numerator: 0, denominator: 0, value: null, wilson95: null } satisfies Rate;
    expect(formatRate(unavailable)).toBe('n/a');
    expect(formatRate({
      numerator: 3,
      denominator: 4,
      value: 0.75,
      wilson95: { low: 0.3006, high: 0.9544, z: 1.959964 },
    })).toBe('3/4 (75.0%)');
  });
  it('derives per-case state without promoting failed or pending attempts to results', () => {
    expect(campaignCaseProgress(report.cases[0], 5)).toMatchObject({ state: 'running', accepted: 1, attempts: 2, active: 1, failed: 0 });
    expect(campaignCaseProgress(report.cases[1], 5)).toMatchObject({ state: 'blocked', accepted: 0, attempts: 1, failed: 1 });
    expect(campaignCaseProgress({ ...report.cases[1], attempts: [] }, 5).state).toBe('idle');
    const filled = { ...report.cases[0], validVideos: [0, 1, 2, 3, 4].map((n) => ({ sha256: `hash-${n}`, url: `/artifacts/campaigns/x/videos/${n}.mp4` })) };
    expect(campaignCaseProgress(filled, 5).state).toBe('complete');
  });
  it('prefers the runner outcome over the status-derived state, and only falls back when it is absent', () => {
    // The runner knows things attempt statuses cannot express.
    const exhausted = { ...report.cases[1], outcome: 'exhausted' as const };
    expect(campaignCaseProgress(exhausted, 5)).toMatchObject({ state: 'blocked', outcome: 'exhausted' });
    const unsupported = {
      ...report.cases[1],
      outcome: 'unsupported' as const,
      unsupported: { reason: 'precheck-infeasible', detail: 'missing primitives', evidence: ['tram_track'], agreeingAttempts: 2, attempts: [1, 2], minimumAgreeingAttempts: 2 },
    };
    expect(campaignCaseProgress(unsupported, 5)).toMatchObject({
      state: 'unsupported', outcome: 'unsupported', unsupportedReason: 'precheck-infeasible',
    });
    // A report written before outcomes existed keeps the status-derived state.
    expect(report.cases[0].outcome).toBeNull();
    expect(campaignCaseProgress(report.cases[0], 5)).toMatchObject({ state: 'running', outcome: null });
  });
  it('keeps the observation window attached to every per-hour rate', () => {
    const measured = normalizeCampaign({
      ...(rawCampaign as CampaignReport),
      totals: { validVideosPerHour: { numerator: 12, denominatorHours: 4, value: 3 } },
    } as Partial<CampaignReport>);
    expect(measured.totals.validVideosPerHour).toEqual({ numerator: 12, denominatorHours: 4, value: 3 });
    // Too short a window: the runner publishes a null rate, which must stay null.
    const unmeasured = normalizeCampaign({
      ...(rawCampaign as CampaignReport),
      totals: { validVideosPerHour: { numerator: 3, denominatorHours: null, value: null } },
    } as Partial<CampaignReport>);
    expect(unmeasured.totals.validVideosPerHour.value).toBeNull();
    expect(unmeasured.totals.validVideosPerHour.denominatorHours).toBeNull();
    // A legacy bare number is preserved but its window is honestly unknown.
    const legacy = normalizeCampaign({
      ...(rawCampaign as CampaignReport),
      totals: { validVideosPerHour: 10800 },
    } as unknown as Partial<CampaignReport>);
    expect(legacy.totals.validVideosPerHour).toEqual({ numerator: 1, denominatorHours: null, value: 10800 });
  });
  it('plays accepted campaign videos through the artifact route', () => {
    expect(artifactUrl(report.cases[0].validVideos[0].url)).toBe('/artifacts/campaigns/edge-cases-67x5/videos/unprotected-left-dense/aa11.mp4');
    expect(artifactKind(report.cases[0].validVideos[0].url)).toBe('video');
  });
});
