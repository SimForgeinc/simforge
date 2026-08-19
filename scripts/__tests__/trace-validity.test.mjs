import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import {
  DEFECT_CODES,
  RETRY_KINDS,
  authoredCollisions,
  classifyRenderFailure,
  collisionPolicyForContract,
  evaluateTraceValidity,
  findFrozenTails,
  findInteractionFailures,
  findOffRoadEvidence,
  frozenTailSpan,
  mergeDefectCodes,
  retryForDefectCode,
  retryForDefectCodes,
} from '../trace-validity-lib.mjs';
import { clipVideoWindow, selectClipVideoFrames, selectIncidentFrames } from '../export-render-lib.mjs';

const GOLDEN_TRACE = new URL('../../fixtures/evidence/golden-yale-bus-stop/trace.json.gz', import.meta.url);
// A committed trace where the merger hits a work-zone prop, the ego then hits the
// disabled merger, and both bodies sit still for the remaining 14s of a 16s clip.
const CRASHED_TRACE = new URL(
  '../../research/edge-case-corpus/gold-agent-authored/c8-taper-merge/el-camino-road__2dfa4c7661f965ef__draw-005.trace.json.gz',
  import.meta.url,
);

async function loadTrace(url) {
  return JSON.parse(gunzipSync(await readFile(url)).toString('utf8'));
}

/**
 * A minimal synthetic trace: two authored vehicles on a dynamic backend, closing
 * on each other and both still rolling at the last tick.
 */
function syntheticTrace({ ticks = 400, dt = 0.02 } = {}) {
  const t = Array.from({ length: ticks }, (_, index) => Number((index * dt).toFixed(6)));
  const track = (speed, x0) => ({
    x: t.map((time) => x0 + speed * time),
    y: t.map(() => 0),
    headingRad: t.map(() => 0),
    speedMps: t.map(() => speed),
    lateralOffsetM: t.map(() => 0),
    laneRsl: t.map(() => '1:0:-1'),
    s: t.map((time) => speed * time),
    present: t.map(() => 1),
  });
  return {
    header: {
      dt,
      clipSeconds: ticks * dt,
      warmupSeconds: 0,
      mapId: 'yale-street',
      actorIds: ['ego', 'lead'],
      actorMetadata: {
        ego: { kind: 'car', static: false, dims: { l: 4.6, w: 1.9, h: 1.5 }, tags: ['role:ego'] },
        lead: { kind: 'car', static: false, dims: { l: 4.6, w: 1.9, h: 1.5 }, tags: ['role:lead'] },
      },
      physics: {
        actorBackends: {
          ego: { mode: 'dynamic-v1', profile: 'car' },
          lead: { mode: 'dynamic-v1', profile: 'car' },
        },
      },
      metricSubject: 'ego',
    },
    ticks: { t, actors: { ego: track(12, 0), lead: track(6, 40) } },
    events: [{ t: 1, kind: 'trigger_fired', interactionId: 'i0', actorId: 'lead', verb: 'brake', forced: false }],
    metrics: {
      collisions: [],
      triggerNeverFired: [],
      minTTC: { value: 1.2, t: 4, pair: ['ego', 'lead'] },
      minDistance: [{ pair: ['ego', 'lead'], minDistanceM: 3.5, t: 5.2 }],
    },
  };
}

/** Freeze an actor from `fromT` to the end of the recording. */
function freezeFrom(trace, actorId, fromT) {
  const times = trace.ticks.t;
  const track = trace.ticks.actors[actorId];
  const at = times.findIndex((time) => time >= fromT - 1e-9);
  for (let index = at; index < times.length; index += 1) {
    track.speedMps[index] = 0;
    track.x[index] = track.x[at];
    track.y[index] = track.y[at];
    track.s[index] = track.s[at];
  }
  return trace;
}

test('the retry vocabulary is derived from the defect namespace, deepest cause first', () => {
  assert.deepEqual(RETRY_KINDS, ['reauthor', 'resimulate', 'rerender', 'recapture', 'manual-review', 'none']);
  for (const code of Object.keys(DEFECT_CODES)) {
    assert.ok(RETRY_KINDS.includes(retryForDefectCode(code)), `${code} maps to a known retry`);
  }
  assert.equal(retryForDefectCode('scenario.review_rejected'), 'reauthor');
  assert.equal(retryForDefectCode('simulation.actor.off_road'), 'resimulate');
  assert.equal(retryForDefectCode('render.camera.composition_failed'), 'rerender');
  assert.equal(retryForDefectCode('render.asset.scene_mismatch'), 'rerender');
  assert.equal(retryForDefectCode('capture.missing_video'), 'recapture');
  assert.equal(retryForDefectCode('judge.uncertain'), 'manual-review');
  assert.throws(() => retryForDefectCode('mystery.code'), /unknown defect namespace/);
  assert.equal(retryForDefectCodes([]), 'none');
  // Precedence: the deepest authorised cause wins, so a job that is both
  // mis-authored and mis-framed reauthors rather than re-rendering.
  assert.equal(retryForDefectCodes(['render.camera.composition_failed', 'scenario.review_rejected']), 'reauthor');
  assert.equal(retryForDefectCodes(['capture.missing_video', 'render.camera.clearance_violation']), 'rerender');
  assert.equal(retryForDefectCodes(['capture.missing_video', 'judge.uncertain']), 'recapture');
  assert.deepEqual(mergeDefectCodes(['b'], ['a', 'b'], undefined), ['a', 'b']);
});

test('renderer failures classify into the presentation namespace that owns them', () => {
  assert.equal(
    classifyRenderFailure('incident composition failed at t=6.2 for every searched camera: ego(inFrame=false)'),
    'render.camera.composition_failed',
  );
  assert.equal(
    classifyRenderFailure('camera intersects actor clearance at t=6.2: ego 1.400m'),
    'render.camera.clearance_violation',
  );
  assert.equal(
    classifyRenderFailure('map evidence file is missing: dev-assets/yale-street/map.xodr'),
    'render.asset.map_evidence_missing',
  );
  assert.equal(classifyRenderFailure('Studio loaded map el-camino-road, expected yale-street'), 'render.asset.scene_mismatch');
  // The exporter now names the blocking condition instead of reporting a byte
  // count, and a lost context or a stalled stream is exactly the transient a
  // fresh browser fixes.
  assert.equal(
    classifyRenderFailure('renderer is not capture-ready: WebGL context is lost'),
    'capture.transient_browser_failure',
  );
  assert.equal(classifyRenderFailure('renderer wrote no mp4 in /tmp/out'), 'capture.missing_video');
  assert.equal(classifyRenderFailure('renderer wrote no manifest in /tmp/out'), 'capture.missing_manifest');
  assert.equal(classifyRenderFailure('ffprobe failed: no such file'), 'capture.encoder_unavailable');
  assert.equal(classifyRenderFailure('Target closed'), 'capture.transient_browser_failure');
  // Every classification stays inside the presentation namespaces, so a render
  // fault can never authorise a reauthor or a resimulate.
  for (const message of ['incident composition failed', 'Target closed', 'ffmpeg not installed']) {
    assert.ok(['rerender', 'recapture'].includes(retryForDefectCode(classifyRenderFailure(message))));
  }
});

test('a contract-forbidden collision rejects the trace before any render', async () => {
  const trace = await loadTrace(CRASHED_TRACE);
  assert.ok(authoredCollisions(trace).length > 0, 'fixture records authored-involved collisions');
  const rejected = evaluateTraceValidity(trace, { collisionPolicy: 'reject' });
  assert.equal(rejected.semanticAccepted, false);
  assert.ok(rejected.defectCodes.includes('simulation.collision.contract_violation'));
  assert.ok(rejected.defectCodes.every((code) => code.startsWith('simulation.')));
  assert.equal(retryForDefectCodes(rejected.defectCodes), 'resimulate');
  // The same trace under a scenario that permits collisions keeps the collision
  // as a recorded fact instead of a defect.
  const allowed = evaluateTraceValidity(trace, { collisionPolicy: 'allow' });
  assert.equal(allowed.defectCodes.includes('simulation.collision.contract_violation'), false);
  assert.equal(allowed.findings.collisions.authoredInvolved.length, rejected.findings.collisions.authoredInvolved.length);
  assert.equal(collisionPolicyForContract({ obligations: [{ kind: 'collision_free' }] }), 'reject');
  assert.equal(collisionPolicyForContract({ obligations: [{ kind: 'junction' }] }), 'allow');
  assert.throws(() => evaluateTraceValidity(trace, { collisionPolicy: 'maybe' }), /collisionPolicy/);
});

test('an actor frozen by an engine-recorded failure rejects the trace, a held stop does not', async () => {
  const crashed = await loadTrace(CRASHED_TRACE);
  const attributed = findFrozenTails(crashed).filter((span) => span.cause !== null);
  assert.ok(attributed.length > 0, 'the crashed fixture freezes actors after its collisions');
  assert.ok(attributed.every((span) => span.causeT <= span.startT));
  assert.ok(evaluateTraceValidity(crashed).defectCodes.includes('simulation.actor.frozen_tail'));

  // The golden fixture ends with a pedestrian standing still for 7.1s. That is a
  // legitimate held stop, so the span is reported with no cause and no defect.
  const golden = await loadTrace(GOLDEN_TRACE);
  const goldenSpans = findFrozenTails(golden);
  assert.ok(goldenSpans.length > 0, 'the golden fixture ends with a stopped authored actor');
  assert.ok(goldenSpans.every((span) => span.cause === null));
  assert.equal(evaluateTraceValidity(golden).semanticAccepted, true);
  assert.deepEqual(evaluateTraceValidity(golden).defectCodes, []);
});

test('frozen tails are only measured while the actor is present and at rest', () => {
  const trace = syntheticTrace();
  assert.equal(frozenTailSpan(trace, 'ego'), null, 'a rolling actor has no frozen tail');
  freezeFrom(trace, 'ego', 5);
  const span = frozenTailSpan(trace, 'ego');
  assert.equal(span.startT, 5);
  assert.equal(span.endT, trace.ticks.t.at(-1));
  assert.ok(Math.abs(span.seconds - (span.endT - 5)) < 1e-9);
  // Unattributed: nothing in the trace explains the stop, so it is not a defect.
  assert.deepEqual(findFrozenTails(trace).map((row) => row.cause), [null]);
  assert.equal(evaluateTraceValidity(trace).semanticAccepted, true);
  // Attributed: the recorded collision precedes the stop inside the settling time.
  trace.metrics.collisions = [{ a: 'ego', b: 'lead', t: 4.5 }];
  trace.events.push({ t: 4.5, kind: 'crash_disabled', actorId: 'ego', otherId: 'lead', reason: 'material-collision' });
  const attributed = findFrozenTails(trace).find((row) => row.actorId === 'ego');
  assert.equal(attributed.cause, 'collision');
  assert.equal(attributed.causeT, 4.5);
  assert.ok(evaluateTraceValidity(trace).defectCodes.includes('simulation.actor.frozen_tail'));
});

test('off-road is decided from the lane-corridor guard, and reported unsupported otherwise', () => {
  const trace = syntheticTrace();
  assert.deepEqual(findOffRoadEvidence(trace), []);
  assert.equal(evaluateTraceValidity(trace).unsupportedReason, null);

  // A transient clamp on a body that keeps driving is not off-road evidence:
  // every authored clamp in the committed corpus is this shape.
  trace.events.push({
    t: 3, kind: 'road_departure_prevented', actorId: 'ego', laneRsl: '1:0:-1', lateralErrorM: 1.8, allowedCenterOffsetM: 1.1,
  });
  const transient = findOffRoadEvidence(trace);
  assert.equal(transient.length, 1);
  assert.equal(transient[0].movingBefore, true);
  assert.equal(transient[0].permanentStall, false);
  assert.equal(evaluateTraceValidity(trace).defectCodes.includes('simulation.actor.off_road'), false);

  // The same clamp that stops a moving body for good is a stalled, off-route
  // body sitting in the shot.
  freezeFrom(trace, 'ego', 3);
  const stalled = findOffRoadEvidence(trace).find((row) => row.actorId === 'ego');
  assert.equal(stalled.permanentStall, true);
  const validity = evaluateTraceValidity(trace);
  assert.ok(validity.defectCodes.includes('simulation.actor.off_road'));
  assert.ok(validity.defectCodes.includes('simulation.actor.frozen_tail'));
  assert.equal(validity.findings.frozenTails.find((row) => row.actorId === 'ego').cause, 'road-departure');

  // An actor whose motion backend never runs the guard cannot be judged, and
  // that is stated rather than assumed either way.
  const unguarded = syntheticTrace();
  unguarded.header.physics.actorBackends.lead = { mode: 'fixed-static-v1', profile: 'car' };
  const unsupported = evaluateTraceValidity(unguarded);
  assert.match(unsupported.unsupportedReason, /no lane-corridor guard runs for lead/);
  assert.equal(unsupported.semanticAccepted, true, 'an undecidable check never rejects');
  assert.deepEqual(unsupported.unsupported.map((item) => item.check), ['off_road']);
});

test('interaction failures separate genuine aborts from scheduled terminations', () => {
  const trace = syntheticTrace();
  trace.events.push(
    { t: 5, kind: 'interaction_aborted', actorId: 'lead', interactionId: 'i0', reason: 'clip_end' },
    { t: 5.1, kind: 'interaction_aborted', actorId: 'lead', interactionId: 'i1', reason: 'preempted' },
  );
  assert.equal(evaluateTraceValidity(trace).semanticAccepted, true);
  assert.equal(findInteractionFailures(trace).benign.length, 2);

  trace.events.push({ t: 6, kind: 'interaction_aborted', actorId: 'lead', interactionId: 'i2', reason: 'tracking_error' });
  trace.events.push({ t: 6.2, kind: 'lane_change_rejected', actorId: 'lead', interactionId: 'i3', reason: 'illegal_or_missing_neighbour' });
  trace.events.push({ t: 6.4, kind: 'trigger_skipped', actorId: 'lead', interactionId: 'i4', reason: 'actor-crash-disabled' });
  trace.metrics.triggerNeverFired = ['i4'];
  const validity = evaluateTraceValidity(trace);
  assert.deepEqual(validity.defectCodes, [
    'simulation.interaction.aborted',
    'simulation.interaction.rejected',
    'simulation.interaction.skipped',
    'simulation.trigger.never_fired',
  ]);
  assert.equal(validity.semanticAccepted, false);
  assert.equal(validity.findings.interactions.aborted.length, 1);
});

test('an undecodable trace is rejected instead of silently passing', () => {
  const empty = evaluateTraceValidity({ header: {}, ticks: { t: [], actors: {} } });
  assert.deepEqual(empty.defectCodes, ['simulation.trace.unreadable']);
  assert.equal(empty.semanticAccepted, false);
  assert.equal(empty.findings, null);
  assert.deepEqual(evaluateTraceValidity(null).defectCodes, ['simulation.trace.unreadable']);
});

test('the trimmed clip keeps pre-event, reveal, conflict and a bounded aftermath', async () => {
  const trace = await loadTrace(GOLDEN_TRACE);
  const window = clipVideoWindow(trace);
  const times = trace.ticks.t;
  const phases = selectIncidentFrames(trace);

  assert.ok(window.startT <= window.revealT, 'the reveal is inside the clip');
  assert.ok(window.startT < phases.find((frame) => frame.phase === 'reveal').t + 1e-9);
  assert.ok(window.startT <= phases.find((frame) => frame.phase === 'pre-event').t + 1e-9);
  assert.ok(window.endT > window.conflictT, 'the conflict and its aftermath are inside the clip');
  assert.ok(window.endT - window.conflictT >= 1, 'the aftermath is at least a full second');
  assert.ok(window.endT - window.startT < times.at(-1) - times[0], 'the clip is shorter than the recording');
  assert.equal(window.startT, times[window.startIndex]);
  assert.equal(window.endT, times[window.endIndex]);

  const selection = selectClipVideoFrames(trace, 12);
  assert.equal(selection.coverage, 'incident-clip');
  assert.equal(selection.frames[0].t, window.startT);
  assert.equal(selection.frames.at(-1).t, window.endT);
  assert.ok(selection.frames.length >= Math.floor((window.endT - window.startT) * 12));
  assert.ok(selection.frames.every((frame, index, frames) => index === 0 || frame.t > frames[index - 1].t));
  assert.ok(selection.frames.some((frame) => Math.abs(frame.t - window.conflictT) <= 0.5));
});

test('the clip stops holding once every incident participant is at rest', () => {
  const trace = syntheticTrace({ ticks: 1001 });
  trace.metrics.minTTC = { value: 1, t: 5, pair: ['ego', 'lead'] };
  trace.metrics.minDistance = [{ pair: ['ego', 'lead'], minDistanceM: 2, t: 6 }];
  const untrimmed = clipVideoWindow(trace);
  assert.equal(untrimmed.trimmedTail, null);
  assert.equal(untrimmed.endT, untrimmed.aftermathEndT);

  freezeFrom(trace, 'ego', 6.5);
  freezeFrom(trace, 'lead', 6.5);
  const trimmed = clipVideoWindow(trace);
  assert.equal(trimmed.trimmedTail.restT, 6.5);
  assert.ok(trimmed.endT < trimmed.aftermathEndT, 'the dead tail is dropped');
  assert.ok(trimmed.endT > trimmed.conflictT, 'the conflict still has aftermath');
  assert.ok(trimmed.endT >= 6.5, 'the moment of coming to rest is still shown');
  assert.deepEqual(trimmed.trimmedTail.actorIds, ['ego', 'lead']);
  assert.ok(trimmed.trimmedTail.droppedSeconds > 0);

  // One participant still rolling means the tail is still aftermath.
  const partial = freezeFrom(syntheticTrace({ ticks: 1001 }), 'ego', 6.5);
  partial.metrics.minTTC = { value: 1, t: 5, pair: ['ego', 'lead'] };
  partial.metrics.minDistance = [{ pair: ['ego', 'lead'], minDistanceM: 2, t: 6 }];
  assert.equal(clipVideoWindow(partial).trimmedTail, null);
});

test('a clip window is refused when the recording never reached the declared conflict', () => {
  const trace = syntheticTrace();
  trace.metrics.revealToConflict = {
    observer: 'ego', target: 'lead', value: 1.4, firstBlockedT: 1, losOpenT: 2, conflictT: 40,
    pair: ['ego', 'lead'], relevantOccluderIds: [],
  };
  assert.throws(() => clipVideoWindow(trace), /does not record its declared incident window/);
});
