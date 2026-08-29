import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENARIO_REVIEW_PROVENANCE_FILES,
  adjudicateScenarioReview,
  classifyVisualArtifact,
  createScenarioReviewTemplate,
  upsertScenarioReview,
} from '../scenario-review-ledger-lib.mjs';

const phases = ['pre-event', 'reveal', 'conflict', 'aftermath'];

function hash(character) {
  return character.repeat(64);
}

function scenarioManifest() {
  return {
    schema: 'simforge-oss.scenario-visual-evidence.v1',
    evidenceClass: 'scenario-instance-incident',
    scenarioId: 'scenario-1',
    mapId: 'yale-st-palo-alto-ca',
    inputHash: hash('a'),
    traceDigest: hash('b'),
    renderer: { cameraMode: 'incident-composition' },
    actors: {
      models: [
        { id: 'ego', kind: 'vehicle', static: false, catalogId: 'vehicle.sedan' },
        { id: 'bus', kind: 'vehicle', static: true, catalogId: 'vehicle.bus' },
      ],
      staticInvariant: ['bus'],
    },
    frames: phases.map((phase, index) => ({
      phase,
      t: index,
      poses: [{ id: 'ego', present: true }, { id: 'bus', present: true }],
      camera: { basis: 'incident-composition' },
      artifact: { file: `frames/${phase}.png`, sha256: String(index + 1).repeat(64) },
    })),
    video: { file: 'incident.mp4', sha256: hash('f') },
    videoSequence: { startT: 0, endT: 3, frameCount: 24 },
    artifacts: {
      instance: { file: 'source/instance.json', sha256: hash('c') },
      traceFile: { file: 'source/trace.json.gz', sha256: hash('d') },
    },
    machineAssessment: { verdict: 'pass', gates: [] },
  };
}

function reviewContext({ articulated = true } = {}) {
  return {
    instanceSha256: hash('c'),
    traceFileSha256: hash('d'),
    rendererSources: SCENARIO_REVIEW_PROVENANCE_FILES.map((file, index) => ({
      file,
      sha256: String((index % 9) + 1).repeat(64),
    })),
    instanceDoc: {
      input: {
        actors: [
          { id: 'ego', kind: 'vehicle', static: false, tags: ['catalog:vehicle.sedan'] },
          { id: 'bus', kind: 'vehicle', static: true, tags: ['catalog:vehicle.bus'] },
        ],
        occluders: [],
        occlusionPairs: [{ observer: 'ego', target: 'ped', occluderId: 'actor:bus' }],
        interactions: articulated ? [{
          id: 'open-door',
          actorId: 'bus',
          verb: 'set',
          target: { key: 'doors.right', value: 'open' },
        }] : [],
      },
    },
    trace: {
      events: articulated
        ? [{ kind: 'state_set', actorId: 'bus', key: 'doors.right', value: 'open', t: 1 }]
        : [],
    },
  };
}

function completeReview(review, verdict = 'accepted') {
  review.inspection.reviewer = 'visual-qa-agent';
  review.inspection.completedAt = '2026-08-01T00:00:00.000Z';
  review.inspection.verdict = verdict;
  review.inspection.environment.studioUrl = 'http://127.0.0.1:5199/?map=yale-street';
  review.inspection.environment.sessionId = 'browser-session-1';
  review.inspection.frames = review.inspection.frames.map((frame) => ({
    ...frame,
    observedSha256: frame.sha256,
  }));
  review.inspection.video.observedSha256 = review.inspection.video.sha256;
  review.inspection.checklist = review.inspection.checklist.map((criterion) => ({
    ...criterion,
    status: criterion.applicable ? 'pass' : 'unchecked',
  }));
  return review;
}

test('classifies map orbit and stress screenshots as diagnostic-only', () => {
  const orbit = {
    schema: 'simforge-oss.render-export.v1',
    renderer: { cameraMode: 'incident-composition' },
    purpose: 'stress smoke',
    frames: [{ cameraMode: 'orbit' }],
  };
  const classification = classifyVisualArtifact(orbit);
  assert.equal(classification.kind, 'diagnostic-only');
  assert.equal(classification.eligibleForHumanScenarioReview, false);
  assert.match(classification.reasons.join('\n'), /orbit captures/);
  assert.match(classification.reasons.join('\n'), /stress\/smoke captures/);
});

test('requires reviewer-entered exact frame/video digests and every applicable checklist criterion', () => {
  const manifest = scenarioManifest();
  const context = reviewContext();
  const review = createScenarioReviewTemplate(manifest, 'manifest.json', context);
  assert.equal(review.decision.countsTowardScenarioCoverage, false);
  assert.equal(adjudicateScenarioReview(manifest, review, context).status, 'invalid');
  assert.equal(review.inspection.frames[0].observedSha256, null);
  assert.equal(
    review.inspection.checklist.find((item) => item.id === 'articulated-actions-and-doors').applicable,
    true,
  );

  completeReview(review);
  const decision = adjudicateScenarioReview(manifest, review, context);
  assert.deepEqual(decision, { status: 'accepted', countsTowardScenarioCoverage: true, reasons: [] });

  const ledger = upsertScenarioReview(null, manifest, review, context);
  assert.deepEqual(ledger.summary, {
    reviewed: 1,
    accepted: 1,
    rejected: 0,
    byMap: { 'yale-st-palo-alto-ca': { reviewed: 1, accepted: 1, rejected: 0 } },
  });
  assert.equal(ledger.entries[0].countsTowardScenarioCoverage, true);

  review.inspection.frames[0].observedSha256 = hash('0');
  assert.throws(
    () => upsertScenarioReview(ledger, manifest, review, context),
    /all four exact observed key-frame digests/,
  );
});

test('unchecked applicable criteria reject an otherwise accepted review', () => {
  const manifest = scenarioManifest();
  const context = reviewContext();
  const review = completeReview(createScenarioReviewTemplate(manifest, 'manifest.json', context));
  const camera = review.inspection.checklist.find((item) => item.id === 'camera-suitability');
  camera.status = 'unchecked';
  assert.deepEqual(adjudicateScenarioReview(manifest, review, context), {
    status: 'rejected',
    countsTowardScenarioCoverage: false,
    reasons: ['required criterion camera-suitability did not pass'],
  });
});

test('requires a bound SimForge Studio browser inspection session', () => {
  const manifest = scenarioManifest();
  const context = reviewContext();
  const review = completeReview(createScenarioReviewTemplate(manifest, 'manifest.json', context));
  review.inspection.environment.sessionId = null;
  const decision = adjudicateScenarioReview(manifest, review, context);
  assert.equal(decision.status, 'invalid');
  assert.match(decision.reasons.join('\n'), /browser inspection session id/);
});

test('checklist applicability is hash-closed to instance/trace semantics', () => {
  const manifest = scenarioManifest();
  const context = reviewContext({ articulated: false });
  const review = completeReview(createScenarioReviewTemplate(manifest, 'manifest.json', context));
  const articulated = review.inspection.checklist.find((item) => item.id === 'articulated-actions-and-doors');
  assert.equal(articulated.applicable, false);
  assert.equal(adjudicateScenarioReview(manifest, review, context).status, 'accepted');

  const changedContext = reviewContext({ articulated: true });
  const stale = adjudicateScenarioReview(manifest, review, changedContext);
  assert.equal(stale.status, 'invalid');
  assert.match(stale.reasons.join('\n'), /applicability|binding differs/);
});

test('renderer or Studio source drift invalidates a completed review', () => {
  const manifest = scenarioManifest();
  const context = reviewContext();
  const review = completeReview(createScenarioReviewTemplate(manifest, 'manifest.json', context));
  const ledger = upsertScenarioReview(null, manifest, review, context);
  const drifted = {
    ...context,
    rendererSources: context.rendererSources.map((source, index) => (
      index === 0 ? { ...source, sha256: hash('8') } : source
    )),
  };
  const decision = adjudicateScenarioReview(manifest, review, drifted);
  assert.equal(decision.status, 'invalid');
  assert.match(decision.reasons.join('\n'), /source provenance is missing or stale/);

  const rerenderedManifest = scenarioManifest();
  rerenderedManifest.scenarioId = 'scenario-after-renderer-change';
  rerenderedManifest.inputHash = hash('7');
  rerenderedManifest.traceDigest = hash('6');
  const rerenderedReview = completeReview(
    createScenarioReviewTemplate(rerenderedManifest, 'manifest.json', drifted),
  );
  assert.throws(
    () => upsertScenarioReview(ledger, rerenderedManifest, rerenderedReview, drifted),
    /cannot reuse.*provenance changed/,
  );
});

test('cannot count the same instance and trace twice under different scenario ids', () => {
  const first = scenarioManifest();
  const context = reviewContext();
  const firstReview = completeReview(createScenarioReviewTemplate(first, 'manifest.json', context));
  const ledger = upsertScenarioReview(null, first, firstReview, context);

  const duplicate = scenarioManifest();
  duplicate.scenarioId = 'scenario-duplicate';
  const duplicateReview = completeReview(createScenarioReviewTemplate(duplicate, 'manifest.json', context));
  duplicateReview.inspection.completedAt = '2026-08-01T00:01:00.000Z';
  assert.throws(
    () => upsertScenarioReview(ledger, duplicate, duplicateReview, context),
    /same instance\/trace evidence is already counted/,
  );
});

test('refuses to put an orbit manifest in the scenario review ledger', () => {
  const manifest = scenarioManifest();
  manifest.renderer.cameraMode = 'orbit';
  const context = reviewContext();
  const review = completeReview(createScenarioReviewTemplate(manifest, 'manifest.json', context), 'rejected');
  assert.throws(() => upsertScenarioReview(null, manifest, review, context), /orbit captures are renderer diagnostics/);
});
