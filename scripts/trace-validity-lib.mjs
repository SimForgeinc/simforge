/**
 * Deterministic physical-validity validators for a recorded simulation trace,
 * plus the shared defect-code and retry vocabulary they feed.
 *
 * These checks are stage-specific deterministic controls that run before the
 * GPU render. Every fact is read from the trace the simulator already wrote,
 * so a physically broken execution is rejected before spending a 3D export
 * on it.
 *
 * SCOPE. This is a downstream product-eligibility layer. It never touches the
 * frozen training-grade admission gate (`tools/gates/tg_gate.py`), which keeps
 * its own C1-C6 contract and its own hashes; a cell must pass that gate first
 * and then satisfy these product checks.
 *
 * CALIBRATION. Every threshold below was measured against the 503 committed
 * traces in this repository, and the counts quoted in the comments are from
 * that corpus. Checks that cannot be decided from the trace alone report an
 * `unsupportedReason` instead of guessing.
 */

export const TRACE_VALIDITY_SCHEMA = 'uniscenarios.trace-physical-validity.v1';

/** Retry vocabulary, cheapest-first inside each namespace, deepest-first overall. */
export const RETRY_KINDS = Object.freeze([
  'reauthor',
  'resimulate',
  'rerender',
  'recapture',
  'none',
]);

/**
 * Which retry a defect namespace authorises. Precedence is the array order:
 * a job that carries both a scenario defect and a camera defect reauthors,
 * and a job that carries only camera defects can never reach the author or
 * the simulator.
 */
const RETRY_BY_PREFIX = Object.freeze([
  ['scenario.', 'reauthor'],
  ['simulation.', 'resimulate'],
  ['render.camera.', 'rerender'],
  ['render.asset.', 'rerender'],
  ['capture.', 'recapture'],
]);

/** The complete registered defect vocabulary, with the stage that owns each code. */
export const DEFECT_CODES = Object.freeze({
  'scenario.contract_violation': 'authored template violates the executable semantic contract',
  'scenario.no_eligible_simulation': 'no admitted draw survived deterministic product eligibility',
  'simulation.trace.unreadable': 'trace could not be decoded, so no physical fact is available',
  'simulation.collision.contract_violation': 'authored-involved collision while the contract forbids collisions',
  'simulation.actor.frozen_tail': 'authored actor is frozen through the end of the clip after an engine-recorded failure',
  'simulation.actor.off_road': 'lane-corridor guard permanently stalled an authored actor off its route',
  'simulation.interaction.aborted': 'authored interaction aborted by collision, rejection or tracking error',
  'simulation.interaction.rejected': 'authored lane change was rejected by the road network',
  'simulation.interaction.skipped': 'authored trigger was skipped instead of firing',
  'simulation.trigger.never_fired': 'authored trigger never fired anywhere in the clip',
  'render.camera.composition_failed': 'no searched camera composed the required actors',
  'render.camera.clearance_violation': 'camera eye intersects an actor footprint',
  'render.asset.map_evidence_missing': 'map or render-manifest evidence is absent for the scenario map',
  'render.asset.scene_mismatch': 'renderer mounted a different scene than the trace declares',
  'capture.missing_video': 'renderer produced no mp4',
  'capture.missing_manifest': 'renderer produced no render manifest',
  'capture.encoder_unavailable': 'frame encoder is unavailable or failed',
  'capture.transient_browser_failure': 'browser or transport failed mid-capture',
});

// A tyre-scrub-free body still reports a few centimetres per second while it
// settles on its suspension, so "stopped" is a band, not zero.
const FROZEN_SPEED_MPS = 0.05;
const FROZEN_DISPLACEMENT_M = 0.25;
// A frozen tail shorter than this is a legitimate stop at the end of a clip.
const FROZEN_TAIL_MIN_SECONDS = 2;
// An actor that never reached this speed was authored to stand still.
const MOVING_ACTOR_SPEED_MPS = 1;
// A body that failed at speed needs this long to settle to a stop, so a freeze
// that begins within it is attributable to that failure. 15 m/s braked at
// 5 m/s^2 stops in 3s; every attributed freeze in the corpus lands inside 0.8s.
const CAUSE_SETTLE_SECONDS = 3;
// How far back a departure check looks to decide the body was still moving.
const CAUSE_APPROACH_SECONDS = 1;
// Abort reasons that describe an ordinary end of an interaction. `preempted` is
// authored intent (a higher-priority interaction took the axis), `until` and
// `clip_end` are the scheduled terminations.
const BENIGN_ABORT_REASONS = Object.freeze(new Set(['preempted', 'until', 'clip_end']));

function actorMetadata(trace) {
  return trace?.header?.actorMetadata ?? {};
}

function ambientIds(trace) {
  return new Set(trace?.header?.ambientActorIds ?? []);
}

/** Authored, non-static actors: the ones a product clip is accountable for. */
export function authoredActorIds(trace) {
  const ambient = ambientIds(trace);
  const metadata = actorMetadata(trace);
  return Object.keys(trace?.ticks?.actors ?? {})
    .filter((id) => !ambient.has(id) && metadata[id]?.static !== true)
    .sort();
}

function backendMode(trace, actorId) {
  return trace?.header?.physics?.actorBackends?.[actorId]?.mode ?? null;
}

/**
 * The maximal trailing span in which an actor is present, below the stopped
 * speed band, and has not moved from its final pose.
 *
 * Used twice: as physical-validity evidence, and to trim dead air off the end
 * of a presentation clip. It reports the span for every stopped actor; deciding
 * whether a span is a defect is a separate, deterministic classification.
 */
export function frozenTailSpan(trace, actorId) {
  const times = trace?.ticks?.t;
  const track = trace?.ticks?.actors?.[actorId];
  if (!Array.isArray(times) || times.length < 2 || !track) return null;
  const last = times.length - 1;
  if (!track.present?.[last]) return null;
  if (Math.abs(track.speedMps?.[last] ?? 0) > FROZEN_SPEED_MPS) return null;
  let start = last;
  while (start > 0) {
    const previous = start - 1;
    if (!track.present[previous]) break;
    if (Math.abs(track.speedMps[previous]) > FROZEN_SPEED_MPS) break;
    const moved = Math.hypot(track.x[previous] - track.x[last], track.y[previous] - track.y[last]);
    if (moved > FROZEN_DISPLACEMENT_M) break;
    start = previous;
  }
  return {
    actorId,
    startIndex: start,
    startT: times[start],
    endT: times[last],
    seconds: Number((times[last] - times[start]).toFixed(6)),
  };
}

function peakSpeed(track) {
  let peak = 0;
  for (const speed of track?.speedMps ?? []) {
    const magnitude = Math.abs(speed);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

/** Collisions that condemn a clip: at least one authored side. */
export function authoredCollisions(trace) {
  const ambient = ambientIds(trace);
  return (trace?.metrics?.collisions ?? [])
    .filter((collision) => !(ambient.has(collision?.a) && ambient.has(collision?.b)));
}

/** `reject` mirrors the `collision_free` obligation the semantic contract declares. */
export function collisionPolicyForContract(semanticContract) {
  const obligations = semanticContract?.obligations ?? [];
  return obligations.some((obligation) => obligation?.kind === 'collision_free') ? 'reject' : 'allow';
}

/**
 * Engine-recorded failures that explain why an actor stopped for good, with the
 * instant each failure happened.
 *
 * Only a frozen tail whose onset FOLLOWS one of these failures within the
 * settling time is a defect. Cause attribution is not optional bookkeeping: 393
 * of the 503 committed traces end with a stopped authored actor, and all but 17
 * of those are actors legitimately holding a stop, so an unattributed
 * frozen-tail rule would reject 41% of the corpus.
 */
function failureCauses(trace) {
  const causes = [];
  const record = (actorId, t, cause) => {
    if (!actorId || !Number.isFinite(t)) return;
    causes.push({ actorId, t, cause });
  };
  for (const collision of trace?.metrics?.collisions ?? []) {
    record(collision?.a, collision?.t, 'collision');
    record(collision?.b, collision?.t, 'collision');
  }
  for (const event of trace?.events ?? []) {
    if (event?.kind === 'crash_disabled') {
      record(event.actorId, event.t, 'crash-disabled');
      record(event.otherId, event.t, 'crash-disabled');
    } else if (event?.kind === 'interaction_aborted' && event.reason === 'tracking_error') {
      record(event.actorId, event.t, 'tracking-error');
    }
  }
  for (const row of findOffRoadEvidence(trace)) {
    if (row.permanentStall) record(row.actorId, row.t, 'road-departure');
  }
  return causes;
}

function firstIndexAtOrAfter(times, time) {
  for (let index = 0; index < times.length; index += 1) {
    if (times[index] >= time - 1e-9) return index;
  }
  return times.length;
}

/**
 * Off-road evidence, taken only from the engine's own lane-corridor guard.
 *
 * `road_departure_prevented` is emitted when a physically integrated body
 * leaves `max(lane half width - body half width + 0.5, 0.2)` around its route
 * (`packages/sim-engine/src/sim/engine.ts`), so the event already carries the
 * topology support the decision needs. The guard then holds the last valid pose
 * in the shot. A single clamp is transient and harmless -- every one of the 260
 * authored clamps in the committed corpus lasts under 0.2s -- so the defect is
 * the narrower fact that the guard stopped a MOVING body which then never
 * recovered. Actors that were already stationary are excluded: an authored
 * verge or double-parked placement trips the same guard during warmup, and that
 * is intent, not a fault.
 *
 * The stronger geometric question, "was the whole footprint inside a drivable
 * surface at every tick", needs lane widths that the trace does not record, so
 * it is reported as unsupported rather than guessed.
 */
export function findOffRoadEvidence(trace) {
  const times = trace?.ticks?.t ?? [];
  const dt = Number.isFinite(trace?.header?.dt) && trace.header.dt > 0 ? trace.header.dt : 0.02;
  const authored = new Set(authoredActorIds(trace));
  const evidence = [];
  for (const event of trace?.events ?? []) {
    if (event?.kind !== 'road_departure_prevented' || !authored.has(event.actorId)) continue;
    const track = trace.ticks.actors[event.actorId];
    const at = firstIndexAtOrAfter(times, event.t);
    const from = Math.max(0, at - Math.ceil(CAUSE_APPROACH_SECONDS / dt));
    let movingBefore = false;
    for (let index = from; index < at; index += 1) {
      if (track.present[index] && Math.abs(track.speedMps[index]) > MOVING_ACTOR_SPEED_MPS) {
        movingBefore = true;
        break;
      }
    }
    let movedAfter = false;
    for (let index = at; index < times.length; index += 1) {
      if (track.present[index] && Math.abs(track.speedMps[index]) > FROZEN_SPEED_MPS) {
        movedAfter = true;
        break;
      }
    }
    evidence.push({
      actorId: event.actorId,
      t: event.t,
      laneRsl: event.laneRsl ?? null,
      lateralErrorM: event.lateralErrorM,
      allowedCenterOffsetM: event.allowedCenterOffsetM,
      movingBefore,
      permanentStall: movingBefore && !movedAfter,
    });
  }
  return evidence;
}

/** Actors whose motion backend never evaluates the lane-corridor guard. */
function offRoadUnsupportedActors(trace) {
  return authoredActorIds(trace).filter((id) => backendMode(trace, id) !== 'dynamic-v1');
}

/** Interaction failures, split from the ordinary terminations that share the event kind. */
export function findInteractionFailures(trace) {
  const authored = new Set(authoredActorIds(trace));
  const aborted = [];
  const benign = [];
  const rejected = [];
  const skipped = [];
  for (const event of trace?.events ?? []) {
    if (event?.kind === 'interaction_aborted') {
      const row = {
        actorId: event.actorId, interactionId: event.interactionId, reason: event.reason, t: event.t,
      };
      if (BENIGN_ABORT_REASONS.has(event.reason)) benign.push(row);
      else aborted.push(row);
    } else if (event?.kind === 'lane_change_rejected' && authored.has(event.actorId)) {
      rejected.push({
        actorId: event.actorId, interactionId: event.interactionId, reason: event.reason, t: event.t,
      });
    } else if (event?.kind === 'trigger_skipped' && authored.has(event.actorId)) {
      skipped.push({
        actorId: event.actorId, interactionId: event.interactionId, reason: event.reason, t: event.t,
      });
    }
  }
  return {
    aborted,
    benign,
    rejected,
    skipped,
    triggerNeverFired: [...(trace?.metrics?.triggerNeverFired ?? [])],
  };
}

/**
 * Frozen tails, each attributed to the engine-recorded failure that preceded it
 * within the settling time. An unattributed span is reported with `cause: null`
 * and is not a defect: it is an actor holding a legitimate stop.
 */
export function findFrozenTails(trace) {
  const causes = failureCauses(trace);
  const spans = [];
  for (const actorId of authoredActorIds(trace)) {
    const track = trace.ticks.actors[actorId];
    if (peakSpeed(track) < MOVING_ACTOR_SPEED_MPS) continue;
    const span = frozenTailSpan(trace, actorId);
    if (!span || span.seconds < FROZEN_TAIL_MIN_SECONDS) continue;
    const attributed = causes.find((cause) => cause.actorId === actorId
      && cause.t <= span.startT + 1e-9
      && span.startT - cause.t <= CAUSE_SETTLE_SECONDS);
    spans.push({ ...span, cause: attributed?.cause ?? null, causeT: attributed?.t ?? null });
  }
  return spans;
}

function unsupportedText(unsupported) {
  if (unsupported.length === 0) return null;
  return unsupported.map((item) => `${item.check}: ${item.reason}`).join('; ');
}

/**
 * Evaluate every deterministic physical-validity check against one trace.
 *
 * `collisionPolicy` binds the collision verdict to the scenario's own contract:
 * `reject` (a `collision_free` obligation) makes an authored-involved collision
 * a defect, `allow` records it as a fact.
 */
export function evaluateTraceValidity(trace, { collisionPolicy = 'reject' } = {}) {
  if (!['reject', 'allow'].includes(collisionPolicy)) {
    throw new RangeError(`collisionPolicy must be reject or allow, got ${collisionPolicy}`);
  }
  if (!Array.isArray(trace?.ticks?.t) || trace.ticks.t.length === 0 || !trace?.ticks?.actors) {
    return {
      schema: TRACE_VALIDITY_SCHEMA,
      collisionPolicy,
      semanticAccepted: false,
      defectCodes: ['simulation.trace.unreadable'],
      findings: null,
      unsupported: [],
      unsupportedReason: null,
    };
  }
  const defects = new Set();
  const unsupported = [];

  const collisions = authoredCollisions(trace);
  const allCollisions = trace.metrics?.collisions ?? [];
  if (collisionPolicy === 'reject' && collisions.length > 0) {
    defects.add('simulation.collision.contract_violation');
  }

  const frozenTails = findFrozenTails(trace);
  if (frozenTails.some((span) => span.cause !== null)) defects.add('simulation.actor.frozen_tail');

  const offRoad = findOffRoadEvidence(trace);
  if (offRoad.some((row) => row.permanentStall)) defects.add('simulation.actor.off_road');
  const unsupportedOffRoad = offRoadUnsupportedActors(trace);
  if (unsupportedOffRoad.length > 0) {
    unsupported.push({
      check: 'off_road',
      reason: `no lane-corridor guard runs for ${unsupportedOffRoad.join(', ')}; `
        + 'the trace records no lane width, so containment cannot be decided for them',
      actorIds: unsupportedOffRoad,
    });
  }

  const interactions = findInteractionFailures(trace);
  if (interactions.aborted.length > 0) defects.add('simulation.interaction.aborted');
  if (interactions.rejected.length > 0) defects.add('simulation.interaction.rejected');
  if (interactions.skipped.length > 0) defects.add('simulation.interaction.skipped');
  if (interactions.triggerNeverFired.length > 0) defects.add('simulation.trigger.never_fired');

  const defectCodes = [...defects].sort();
  return {
    schema: TRACE_VALIDITY_SCHEMA,
    collisionPolicy,
    semanticAccepted: defectCodes.length === 0,
    defectCodes,
    findings: {
      collisions: {
        authoredInvolved: collisions.map((collision) => ({
          a: collision.a, b: collision.b, t: collision.t,
        })),
        ambientOnly: allCollisions.length - collisions.length,
      },
      frozenTails,
      offRoad,
      interactions,
    },
    unsupported,
    unsupportedReason: unsupportedText(unsupported),
  };
}

/** The retry a single defect code authorises. */
export function retryForDefectCode(code) {
  for (const [prefix, retry] of RETRY_BY_PREFIX) {
    if (String(code).startsWith(prefix)) return retry;
  }
  throw new RangeError(`unknown defect namespace: ${code}`);
}

/**
 * The single retry a defect set authorises, deepest cause first. Presentation
 * defects can never reach the simulator or the author.
 */
export function retryForDefectCodes(codes) {
  const authorised = new Set([...(codes ?? [])].map(retryForDefectCode));
  return RETRY_KINDS.find((kind) => authorised.has(kind)) ?? 'none';
}

/**
 * Classify a renderer failure into the presentation namespace that owns it.
 *
 * The strings are the exporter's own failure messages
 * (`scripts/export-render.mjs`, `apps/showcase/server/pipeline.mjs`), so a
 * camera or capture fault is never mistaken for a simulation fault.
 */
export function classifyRenderFailure(message) {
  const text = String(message ?? '');
  if (/incident composition failed/i.test(text)) return 'render.camera.composition_failed';
  if (/camera intersects actor clearance|clearanceM/i.test(text)) return 'render.camera.clearance_violation';
  if (/map evidence file is missing|topology integrity failed/i.test(text)) return 'render.asset.map_evidence_missing';
  if (/Studio loaded map|renderer is unavailable|render-quality preference|viewer canvas not found/i.test(text)) {
    return 'render.asset.scene_mismatch';
  }
  if (/wrote no mp4|did not produce the requested H\.264|no mp4/i.test(text)) return 'capture.missing_video';
  if (/wrote no manifest|no manifest/i.test(text)) return 'capture.missing_manifest';
  if (/ffmpeg|ffprobe|encoded video mismatch/i.test(text)) return 'capture.encoder_unavailable';
  return 'capture.transient_browser_failure';
}

/** Sorted, de-duplicated union of defect-code lists. */
export function mergeDefectCodes(...lists) {
  const merged = new Set();
  for (const list of lists) {
    for (const code of list ?? []) merged.add(code);
  }
  return [...merged].sort();
}
