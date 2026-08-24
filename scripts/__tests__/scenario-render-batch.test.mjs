import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalJson,
  selectIncidentFrames,
  selectIncidentVideoFrames,
} from '../export-render-lib.mjs';
import {
  SCENARIO_REVIEW_PROVENANCE_FILES,
  createScenarioReviewTemplate,
} from '../scenario-review-ledger-lib.mjs';
import {
  REQUIRED_MACHINE_GATES,
  createBatchLedger,
  inspectBatchEntry,
  markRenderCancelled,
  markRenderFailed,
  reconcileBatchLedger,
  resumeBatchLedger,
  sha256,
  summarizeBatchEntries,
  validateBatchCatalog,
} from '../scenario-render-batch-lib.mjs';

const mapIds = [
  'yale-street',
  'belmont-research-center',
  'el-camino-road',
  'easterbrook-discovery-school',
  'richmond-field-station',
];

function hash(character) {
  return character.repeat(64);
}

function catalog() {
  const maps = mapIds.map((mapId) => ({ mapId, slots: 100 }));
  const slots = maps.flatMap((map, mapIndex) => Array.from({ length: 100 }, (_, mapOrdinal) => {
    const ordinal = mapOrdinal;
    const scenarioId = `${map.mapId}-${String(mapOrdinal + 1).padStart(3, '0')}`;
    const root = `evidence/${map.mapId}/${scenarioId}`;
    return {
      identity: scenarioId,
      ordinal,
      seed: sha256(`seed:${scenarioId}`),
      mapId: map.mapId,
      provenance: {
        namespace: 'catalog',
        generatorVersion: '2.0.0',
        mapCatalogRevision: 'revision',
        matcherIndexDigest: hash(String(mapIndex + 1)),
        engineGraphDigest: hash(String(mapIndex + 5)),
        locationCatalogDigest: hash('7'),
        taxonomyDigest: hash('8'),
        templateDigest: hash('9'),
      },
      scenario: { incidentId: 'incident.example' },
      site: { locationId: `location-${scenarioId}` },
      variant: {
        id: 'clear-day', title: 'Clear day', weather: 'clear', timeOfDay: 'day',
        traffic: 'moderate', visibility: 'clear',
      },
      implementation: {
        state: 'template-backed',
        templateId: 'example-template',
        materializedVariantId: 'clear-day',
        matcherSiteId: `site-${scenarioId}`,
        matchedLocationId: `location-${scenarioId}`,
      },
      evidencePaths: {
        instance: `${root}/instance.json`,
        trace: `${root}/trace.json.gz`,
        result: `${root}/result.json`,
        renderManifest: `${root}/render/manifest.json`,
        frame: `${root}/render/frame.png`,
        video: `${root}/render/video.mp4`,
        visualInspection: `${root}/render/visual-inspection.json`,
      },
      designDigest: sha256(`design:${scenarioId}`),
    };
  }));
  return {
    kind: 'uniscenarios-scenario-catalog',
    version: 2,
    maps,
    slots,
    progress: { target: 500 },
  };
}

function provenance() {
  return {
    catalog: { file: 'catalog.json', sha256: hash('a'), declaredDigest: hash('b') },
    rendererSources: SCENARIO_REVIEW_PROVENANCE_FILES.map((file, index) => ({
      file,
      sha256: String((index % 9) + 1).repeat(64),
    })),
  };
}

function config() {
  return { url: 'http://127.0.0.1:5199', width: 1600, height: 960, fps: 12, headless: true, includeUi: false };
}

test('plans exactly 500 deterministic slots and reports a zero-credit denominator per map', () => {
  const source = catalog();
  assert.deepEqual(validateBatchCatalog(source), {
    total: 500,
    byMap: Object.fromEntries(mapIds.map((mapId) => [mapId, 100])),
  });
  const ledger = createBatchLedger(source, provenance(), config());
  assert.equal(ledger.entries.length, 500);
  assert.deepEqual(ledger.entries.map((entry) => entry.ordinal), Array.from({ length: 500 }, (_, index) => index));
  assert.equal(ledger.summary.expected, 500);
  assert.equal(ledger.summary.accepted, 0);
  assert.equal(ledger.summary.remainingToAccept, 500);
  for (const mapId of mapIds) {
    assert.equal(ledger.summary.byMap[mapId].expected, 100);
    assert.equal(ledger.summary.byMap[mapId].accepted, 0);
    assert.equal(ledger.summary.byMap[mapId].remainingToAccept, 100);
  }
});

test('refuses resume after catalog, renderer, or render-setting drift', () => {
  const source = catalog();
  const ledger = createBatchLedger(source, provenance(), config());
  assert.equal(resumeBatchLedger(ledger, source, provenance(), config()).entries.length, 500);
  assert.throws(
    () => resumeBatchLedger(ledger, source, { ...provenance(), catalog: { ...provenance().catalog, sha256: hash('d') } }, config()),
    /provenance changed/,
  );
  const studioDrift = provenance();
  studioDrift.rendererSources = studioDrift.rendererSources.map((item) => (
    item.file === 'studio/src/editor/actorRenderer.ts' ? { ...item, sha256: hash('0') } : item
  ));
  assert.throws(
    () => resumeBatchLedger(ledger, source, studioDrift, config()),
    /provenance changed/,
  );
  assert.throws(
    () => resumeBatchLedger(ledger, source, provenance(), { ...config(), fps: 24 }),
    /settings changed/,
  );
});

async function writeAcceptedEvidence(repositoryRoot, entry) {
  const instanceFile = path.join(repositoryRoot, entry.evidencePaths.instance);
  const traceFile = path.join(repositoryRoot, entry.evidencePaths.trace);
  const renderDir = path.dirname(path.join(repositoryRoot, entry.evidencePaths.renderManifest));
  await mkdir(path.join(renderDir, 'frames'), { recursive: true });
  await mkdir(path.join(renderDir, 'source'), { recursive: true });
  const catalogSlot = { ...entry.catalogReservation, attemptSeed: sha256(`attempt:${entry.scenarioId}`) };
  const times = [0, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2];
  const input = {
    mapId: entry.mapId,
    actors: [
      { id: 'ego', kind: 'vehicle', static: false, tags: ['catalog:vehicle.sedan'], dims: { l: 4, w: 2, h: 1.5 } },
      { id: 'bus', kind: 'vehicle', static: true, tags: ['catalog:vehicle.bus'], dims: { l: 10, w: 2.5, h: 3 } },
    ],
    occluders: [],
    occlusionPairs: [{ observer: 'ego', target: 'bus', occluderId: 'actor:bus' }],
    interactions: [],
  };
  const inputHash = sha256(Buffer.from(canonicalJson(input)));
  const instanceDoc = {
    catalogSlot,
    manifest: {
      instanceId: entry.scenarioId,
      inputHash,
      replayKey: {
        mapId: entry.mapId,
        matcherIndexDigest: entry.expectedTopology.matcherIndexDigest,
        engineGraphDigest: entry.expectedTopology.engineGraphDigest,
      },
      actors: [{ id: 'ego' }, { id: 'bus' }],
    },
    input,
  };
  const moving = times.map((time) => time);
  const stationary = times.map(() => 5);
  const zeros = times.map(() => 0);
  const ones = times.map(() => 1);
  const lane = times.map(() => '1:0:-1');
  const trace = {
    header: {
      catalogSlot,
      inputHash,
      mapId: entry.mapId,
      engineGraphDigest: entry.expectedTopology.engineGraphDigest,
      topologyDigest: entry.expectedTopology.engineGraphDigest,
      actorIds: ['ego', 'bus'],
      metricSubject: 'ego',
    },
    ticks: {
      t: times,
      actors: {
        ego: { x: moving, y: zeros, headingRad: zeros, speedMps: ones, laneRsl: lane, s: moving, present: ones },
        bus: { x: stationary, y: zeros, headingRad: zeros, speedMps: zeros, laneRsl: lane, s: stationary, present: ones },
      },
    },
    metrics: { revealToConflict: { pair: ['ego', 'bus'], losOpenT: 1, conflictT: 1.4 } },
    events: [],
  };
  const instanceBytes = Buffer.from(`${JSON.stringify(instanceDoc)}\n`);
  const traceBytes = Buffer.from(`${JSON.stringify(trace)}\n`);
  await mkdir(path.dirname(instanceFile), { recursive: true });
  await writeFile(instanceFile, instanceBytes);
  await writeFile(traceFile, traceBytes);
  const resultBytes = Buffer.from(`${JSON.stringify({
    catalogSlot,
    instanceId: entry.scenarioId,
    status: 'ok',
    feasible: true,
    verdict: 'accept',
    eligibility: { eligible: true, collisionPolicy: 'reject', hardFailureCodes: [] },
    inputHash,
    traceDigest: sha256(Buffer.from(canonicalJson(trace))),
    artifactHashes: {
      instanceSha256: sha256(instanceBytes),
      traceSha256: sha256(traceBytes),
    },
  })}\n`);
  await writeFile(path.join(repositoryRoot, entry.evidencePaths.result), resultBytes);
  await writeFile(path.join(renderDir, 'source/instance.json'), instanceBytes);
  await writeFile(path.join(renderDir, 'source/trace.json.gz'), traceBytes);
  await writeFile(path.join(renderDir, 'source/result.json'), resultBytes);
  const selectedFrames = selectIncidentFrames(trace).map(({ targetT, ...selected }) => ({
    ...selected,
    requestedT: targetT,
  }));
  const frames = [];
  for (const [index, selected] of selectedFrames.entries()) {
    const { phase } = selected;
    const bytes = Buffer.from(`png:${phase}`);
    const file = phase === 'conflict' ? 'frame.png' : `frames/frame-${String(index).padStart(3, '0')}.png`;
    await writeFile(path.join(renderDir, file), bytes);
    frames.push({ ...selected, artifact: { file, sha256: sha256(bytes) } });
  }
  const videoBytes = Buffer.from('deterministic-mp4');
  await writeFile(path.join(renderDir, 'video.mp4'), videoBytes);
  const videoSelection = selectIncidentVideoFrames(trace, 5);
  const videoFrames = videoSelection.frames.map(({ targetT, ...frame }) => ({
    ...frame,
    requestedT: targetT,
  }));
  const manifest = {
    schema: 'uniscenarios.scenario-visual-evidence.v1',
    evidenceClass: 'scenario-instance-incident',
    scenarioId: entry.scenarioId,
    catalogSlot,
    mapId: entry.mapId,
    inputHash,
    traceDigest: sha256(Buffer.from(canonicalJson(trace))),
    topologyDomains: {
      authoringMatcherTopology: { digest: entry.expectedTopology.matcherIndexDigest },
      simulationRoadGraph: { digest: entry.expectedTopology.engineGraphDigest },
      studioRenderScene: { digest: hash('f') },
    },
    renderer: { cameraMode: 'incident-composition' },
    frames,
    videoSequence: {
      startT: videoSelection.startT,
      endT: videoSelection.endT,
      fps: 5,
      frameCount: videoFrames.length,
      frames: videoFrames,
    },
    video: {
      file: 'video.mp4', sha256: sha256(videoBytes), fps: 5,
      frameCount: videoFrames.length, durationSeconds: videoFrames.length / 5,
    },
    artifacts: {
      instance: { file: 'source/instance.json', sha256: sha256(instanceBytes) },
      traceFile: { file: 'source/trace.json.gz', sha256: sha256(traceBytes) },
      result: { file: 'source/result.json', sha256: sha256(resultBytes) },
    },
    machineAssessment: {
      verdict: 'pass',
      gates: REQUIRED_MACHINE_GATES.map((id) => ({ id, status: 'pass' })),
    },
  };
  await writeFile(path.join(renderDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const review = createScenarioReviewTemplate(manifest, 'manifest.json', {
    instanceDoc,
    trace,
    instanceSha256: sha256(instanceBytes),
    traceFileSha256: sha256(traceBytes),
    resultSha256: sha256(resultBytes),
    rendererSources: entry.reviewProvenance,
  });
  review.inspection.reviewer = 'visual-qa-agent:smoke';
  review.inspection.completedAt = '2026-08-01T12:00:00.000Z';
  review.inspection.verdict = 'accepted';
  review.inspection.environment.studioUrl = 'http://127.0.0.1:5199/?map=yale-street';
  review.inspection.environment.sessionId = 'browser-session-smoke';
  review.inspection.frames = review.inspection.frames.map((frame) => ({
    ...frame,
    observedSha256: frame.sha256,
  }));
  review.inspection.video.observedSha256 = review.inspection.video.sha256;
  review.inspection.checklist = review.inspection.checklist.map((criterion) => ({
    ...criterion,
    status: criterion.applicable ? 'pass' : 'unchecked',
  }));
  await writeFile(path.join(renderDir, 'visual-inspection.json'), `${JSON.stringify(review, null, 2)}\n`);
  return { manifest, renderDir };
}

test('counts only byte-verified, machine-passed evidence with an exact observed review binding', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-render-batch-'));
  const source = catalog();
  const ledger = createBatchLedger(source, provenance(), config());
  const entry = ledger.entries[0];
  const { renderDir } = await writeAcceptedEvidence(repositoryRoot, entry);
  const accepted = await inspectBatchEntry(entry, repositoryRoot);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.countsTowardScenarioCoverage, true);
  assert.equal(accepted.evidence.frames.length, 4);
  assert.equal(accepted.review.reviewer, 'visual-qa-agent:smoke');

  await writeFile(path.join(renderDir, 'frames/frame-000.png'), 'tampered');
  const tampered = await inspectBatchEntry(accepted, repositoryRoot);
  assert.equal(tampered.status, 'invalid-evidence');
  assert.equal(tampered.countsTowardScenarioCoverage, false);
  assert.match(tampered.issues.join('\n'), /digest mismatch/);

  const entries = ledger.entries.map((item, index) => index === 0 ? tampered : item);
  const summary = summarizeBatchEntries(entries, source.maps);
  assert.equal(summary.accepted, 0);
  assert.equal(summary.byMap['yale-street'].accepted, 0);
});

test('missing source evidence always has zero credit even if stale ledger state claimed acceptance', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-render-missing-'));
  const ledger = createBatchLedger(catalog(), provenance(), config());
  const stale = {
    ...ledger.entries[0],
    status: 'accepted',
    countsTowardScenarioCoverage: true,
    evidence: { manifestSha256: sha256(canonicalJson({ stale: true })) },
  };
  const inspected = await inspectBatchEntry(stale, repositoryRoot);
  assert.equal(inspected.status, 'missing-inputs');
  assert.equal(inspected.countsTowardScenarioCoverage, false);
});

test('refuses a rejected or tampered result even when instance, trace, and render evidence exist', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-render-result-'));
  const ledger = createBatchLedger(catalog(), provenance(), config());
  const entry = ledger.entries[0];
  await writeAcceptedEvidence(repositoryRoot, entry);
  const resultFile = path.join(repositoryRoot, entry.evidencePaths.result);
  const rejected = JSON.parse(await readFile(resultFile, 'utf8'));
  rejected.verdict = 'reject';
  await writeFile(resultFile, `${JSON.stringify(rejected)}\n`);
  const inspected = await inspectBatchEntry(entry, repositoryRoot);
  assert.equal(inspected.status, 'rejected-input');
  assert.equal(inspected.countsTowardScenarioCoverage, false);
  assert.match(inspected.issues.join('\n'), /not hard-eligible/);
});

test('refuses non-hard-eligible results and broken atomic artifact commit hashes', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-render-hard-eligibility-'));
  const ledger = createBatchLedger(catalog(), provenance(), config());
  const entry = ledger.entries[0];
  await writeAcceptedEvidence(repositoryRoot, entry);
  const resultFile = path.join(repositoryRoot, entry.evidencePaths.result);
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  result.eligibility = { eligible: false, collisionPolicy: 'allow', hardFailureCodes: ['collision'] };
  result.artifactHashes.instanceSha256 = hash('0');
  await writeFile(resultFile, `${JSON.stringify(result)}\n`);
  const inspected = await inspectBatchEntry(entry, repositoryRoot);
  assert.equal(inspected.status, 'rejected-input');
  assert.equal(inspected.countsTowardScenarioCoverage, false);
  assert.match(inspected.issues.join('\n'), /not catalog hard-eligible/);
  assert.match(inspected.issues.join('\n'), /artifactHashes\.instanceSha256/);
});

test('source byte mutation invalidates the result commit marker before render', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-render-commit-marker-'));
  const ledger = createBatchLedger(catalog(), provenance(), config());
  const entry = ledger.entries[0];
  await writeAcceptedEvidence(repositoryRoot, entry);
  await writeFile(path.join(repositoryRoot, entry.evidencePaths.trace), '{"tampered":true}\n');
  const inspected = await inspectBatchEntry(entry, repositoryRoot);
  assert.equal(inspected.status, 'rejected-input');
  assert.equal(inspected.countsTowardScenarioCoverage, false);
  assert.match(inspected.issues.join('\n'), /catalogSlot|artifactHashes\.traceSha256|traceDigest/);
});

test('cancelled renders are truthful, terminal attempts and deterministic resume candidates', () => {
  const ledger = createBatchLedger(catalog(), provenance(), config());
  const cancelled = markRenderCancelled({
    ...ledger.entries[0],
    status: 'rendering',
    renderAttempts: 1,
    lastAttempt: { startedAt: '2026-08-01T12:00:00.000Z', finishedAt: null, exitCode: null, error: null },
  }, '2026-08-01T12:00:01.000Z');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.lastAttempt.exitCode, 130);
  assert.equal(cancelled.countsTowardScenarioCoverage, false);
  const resumed = resumeBatchLedger(
    { ...ledger, entries: [cancelled, ...ledger.entries.slice(1)] },
    catalog(), provenance(), config(),
  );
  assert.equal(resumed.entries[0].status, 'cancelled');
});

test('a failed attempt cannot inherit credit from an older bundle at the same output path', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-render-failed-stale-'));
  const ledger = createBatchLedger(catalog(), provenance(), config());
  const entry = ledger.entries[0];
  await writeAcceptedEvidence(repositoryRoot, entry);
  const failed = markRenderFailed({
    ...entry,
    status: 'rendering',
    renderAttempts: 1,
    lastAttempt: { startedAt: '2026-08-01T12:00:00.000Z', finishedAt: null, exitCode: null, error: null },
  }, '2026-08-01T12:00:01.000Z', 1, 'renderer rejected the new attempt');
  const inspected = await inspectBatchEntry(failed, repositoryRoot);
  assert.equal(inspected.status, 'render-failed');
  assert.equal(inspected.countsTowardScenarioCoverage, false);
  assert.match(inspected.issues.join('\n'), /rejected the new attempt/);
});

test('duplicate instance/trace provenance cannot fill two catalog slots', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-render-duplicate-'));
  const source = catalog();
  const ledger = createBatchLedger(source, provenance(), config());
  await writeAcceptedEvidence(repositoryRoot, ledger.entries[0]);
  const firstRoot = path.dirname(path.join(repositoryRoot, ledger.entries[0].evidencePaths.instance));
  const secondRoot = path.dirname(path.join(repositoryRoot, ledger.entries[1].evidencePaths.instance));
  await mkdir(path.dirname(secondRoot), { recursive: true });
  await cp(firstRoot, secondRoot, { recursive: true });
  const reconciled = await reconcileBatchLedger(
    { ...ledger, entries: ledger.entries.slice(0, 2) },
    { maps: source.maps },
    repositoryRoot,
  );
  assert.equal(reconciled.summary.accepted, 1);
  assert.deepEqual(reconciled.entries.map((entry) => entry.status), ['accepted', 'rejected-input']);
  assert.match(reconciled.entries[1].issues.join('\n'), /reserved catalog slot|result instanceId/);
});
