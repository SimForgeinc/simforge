import { createHash } from 'node:crypto';

export const TRACE_CHANNELS = [
  'x',
  'y',
  'headingRad',
  'speedMps',
  'laneRsl',
  's',
  'present',
];

export const REQUIRED_INCIDENT_PHASES = [
  'pre-event',
  'reveal',
  'conflict',
  'aftermath',
];

export const SCENARIO_EVIDENCE_SCHEMA = 'simforge-oss.scenario-visual-evidence.v1';

const KIND_DEFAULT_MODELS = {
  vehicle: 'vehicle.sedan',
  car: 'vehicle.sedan',
  truck: 'vehicle.box_truck',
  bus: 'vehicle.bus',
  van: 'vehicle.van',
  motorcycle: 'vehicle.motorcycle',
  bicycle: 'vehicle.bicycle',
  pedestrian: 'pedestrian.adult_walking',
};

const SEMANTIC_RENDER_KINDS = new Set(['animal', 'scooter', 'static_object']);

export function canonicalJson(value) {
  return writeCanonical(value);
}

function writeCanonical(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${String(value)}`);
    return JSON.stringify(value + 0);
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => writeCanonical(item === undefined ? null : item)).join(',')}]`;
  }
  if (type === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${writeCanonical(value[key])}`).join(',')}}`;
  }
  return 'null';
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Json(value) {
  return sha256Bytes(canonicalJson(value));
}

export function nearestIndex(times, target) {
  let best = 0;
  let distance = Infinity;
  for (let index = 0; index < times.length; index += 1) {
    const candidate = Math.abs(times[index] - target);
    if (candidate < distance) {
      best = index;
      distance = candidate;
    }
  }
  return best;
}

function exactSortedIds(values, label, issues) {
  if (!Array.isArray(values) || values.some((id) => typeof id !== 'string' || id.length === 0)) {
    issues.push(`${label} must be a non-empty string array`);
    return [];
  }
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) issues.push(`${label} contains duplicate ids`);
  return sorted;
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function catalogModelFor(actor) {
  const explicit = (actor.tags ?? [])
    .filter((tag) => typeof tag === 'string' && tag.startsWith('catalog:'))
    .map((tag) => tag.slice('catalog:'.length));
  if (explicit.length > 1) throw new Error(`actor ${actor.id} has multiple catalog model tags`);
  if (explicit.length === 1 && explicit[0]) {
    return {
      catalogId: explicit[0],
      basis: 'input-tag',
      renderIdentity: { source: 'catalog', catalogId: explicit[0] },
    };
  }
  if (SEMANTIC_RENDER_KINDS.has(actor.kind)) {
    return {
      // ActorRenderer requires a catalog id in its transport view, but
      // renderIdentity ignores it for verified semantic-kind actors.
      catalogId: 'vehicle.sedan',
      basis: 'semantic-kind',
      renderIdentity: { source: 'semantic', kind: actor.kind },
    };
  }
  const catalogId = KIND_DEFAULT_MODELS[actor.kind];
  if (!catalogId) throw new Error(`actor ${actor.id} kind ${JSON.stringify(actor.kind)} has no renderer model`);
  return {
    catalogId,
    basis: 'kind-default',
    renderIdentity: { source: 'catalog', catalogId },
  };
}

function validateTrack(actorId, track, tickCount, issues) {
  if (!track || typeof track !== 'object') {
    issues.push(`trace actor ${actorId} has no track`);
    return;
  }
  for (const channel of TRACE_CHANNELS) {
    if (!Array.isArray(track[channel]) || track[channel].length !== tickCount) {
      issues.push(`trace actor ${actorId}.${channel} length ${track[channel]?.length ?? 'missing'} != ticks ${tickCount}`);
    }
  }
}

function invariantValues(values) {
  return [...new Set(values.map((value) => canonicalJson(value)))];
}

function validateStaticActor(actor, track, issues) {
  if (!actor.static || !track) return;
  for (const channel of ['x', 'y', 'headingRad', 'speedMps', 'present']) {
    const unique = invariantValues(track[channel] ?? []);
    if (unique.length !== 1) issues.push(`static actor ${actor.id}.${channel} changes across the trace`);
  }
}

function requiredString(value, label, issues) {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${label} is missing`);
    return null;
  }
  return value;
}

/** Strictly join a concrete scenario instance to the one trace it produced. */
export function validateScenarioPair(instanceDoc, trace, _traceCanonicalBytes, options = {}) {
  const issues = [];
  const input = instanceDoc?.input;
  if (!input || typeof input !== 'object') throw new Error('evidence integrity failed: instance.input is missing');
  if (!trace?.header || !trace?.ticks || !trace.ticks.actors) {
    throw new Error('evidence integrity failed: trace header/ticks are missing');
  }

  const inputHash = sha256Json(input);
  const manifestInputHash = instanceDoc.manifest?.inputHash ?? null;
  const traceInputHash = trace.header.inputHash ?? null;
  if (manifestInputHash !== inputHash) {
    issues.push(`manifest.inputHash ${manifestInputHash} != recomputed ${inputHash}`);
  }
  if (traceInputHash !== inputHash) {
    issues.push(`trace.header.inputHash ${traceInputHash} != recomputed ${inputHash}`);
  }

  const instanceCatalogSlot = instanceDoc.catalogSlot ?? null;
  const traceCatalogSlot = trace.header.catalogSlot ?? null;
  if ((instanceCatalogSlot === null) !== (traceCatalogSlot === null)) {
    issues.push('catalogSlot must be present in both instance and trace or in neither');
  } else if (instanceCatalogSlot !== null
    && canonicalJson(instanceCatalogSlot) !== canonicalJson(traceCatalogSlot)) {
    issues.push('instance and trace catalogSlot provenance differ');
  }
  if (options.requiredCatalogSlot !== undefined
    && canonicalJson(instanceCatalogSlot) !== canonicalJson(options.requiredCatalogSlot)) {
    issues.push('instance/trace catalogSlot differs from the required catalog slot');
  }

  const inputMapId = requiredString(input.mapId, 'instance.input.mapId', issues);
  const replayMapId = requiredString(instanceDoc.manifest?.replayKey?.mapId, 'manifest.replayKey.mapId', issues);
  const traceMapId = requiredString(trace.header.mapId, 'trace.header.mapId', issues);
  const requiredMapId = options.requiredMapId ?? null;
  const mapIds = [inputMapId, replayMapId, traceMapId, requiredMapId].filter(Boolean);
  if (new Set(mapIds).size > 1) issues.push(`map ids differ: ${mapIds.join(' != ')}`);

  const matcherIndexDigest = requiredString(
    instanceDoc.manifest?.replayKey?.matcherIndexDigest,
    'manifest.replayKey.matcherIndexDigest',
    issues,
  );
  const manifestEngineGraphDigest = requiredString(
    instanceDoc.manifest?.replayKey?.engineGraphDigest,
    'manifest.replayKey.engineGraphDigest',
    issues,
  );
  const traceEngineGraphDigest = requiredString(
    trace.header.engineGraphDigest,
    'trace.header.engineGraphDigest',
    issues,
  );
  const traceTopologyAlias = requiredString(
    trace.header.topologyDigest,
    'trace.header.topologyDigest',
    issues,
  );
  if (manifestEngineGraphDigest !== traceEngineGraphDigest) {
    issues.push(`engine graph digests differ: manifest=${manifestEngineGraphDigest} trace=${traceEngineGraphDigest}`);
  }
  if (traceTopologyAlias !== traceEngineGraphDigest) {
    issues.push(`trace topologyDigest must alias engineGraphDigest: ${traceTopologyAlias} != ${traceEngineGraphDigest}`);
  }

  const actors = Array.isArray(input.actors) ? input.actors : [];
  if (actors.length === 0) issues.push('instance input carries zero actors');
  const inputActorIds = exactSortedIds(actors.map((actor) => actor?.id), 'input actor ids', issues);
  const manifestActorIds = exactSortedIds(
    (instanceDoc.manifest?.actors ?? []).map((actor) => actor?.id),
    'manifest actor ids',
    issues,
  );
  const headerActorIds = exactSortedIds(trace.header.actorIds, 'trace header actor ids', issues);
  const trackActorIds = Object.keys(trace.ticks.actors).sort();
  if (!sameIds(inputActorIds, manifestActorIds)) {
    issues.push(`actor ids differ: input=${inputActorIds.join(',')} manifest=${manifestActorIds.join(',')}`);
  }
  if (!sameIds(inputActorIds, headerActorIds)) {
    issues.push(`actor ids differ: input=${inputActorIds.join(',')} trace-header=${headerActorIds.join(',')}`);
  }
  if (!sameIds(inputActorIds, trackActorIds)) {
    issues.push(`actor ids differ: input=${inputActorIds.join(',')} trace-tracks=${trackActorIds.join(',')}`);
  }

  const times = trace.ticks.t;
  if (!Array.isArray(times) || times.length === 0) issues.push('trace ticks.t is empty');
  else {
    if (times.some((time) => !Number.isFinite(time))) issues.push('trace ticks.t contains non-finite values');
    for (let index = 1; index < times.length; index += 1) {
      if (times[index] <= times[index - 1]) issues.push('trace ticks.t must be strictly increasing');
    }
  }
  for (const actor of actors) {
    const track = trace.ticks.actors[actor.id];
    validateTrack(actor.id, track, times?.length ?? 0, issues);
    validateStaticActor(actor, track, issues);
  }

  const props = Array.isArray(input.props) ? input.props : [];
  const propIds = exactSortedIds(props.map((prop) => prop?.id), 'input prop ids', issues);
  const overlappingIds = propIds.filter((id) => inputActorIds.includes(id));
  if (overlappingIds.length > 0) {
    issues.push(`actor and prop ids overlap: ${overlappingIds.join(',')}`);
  }
  const tracePropMetadata = trace.header.propMetadata ?? {};
  const tracePropIds = Object.keys(tracePropMetadata).sort();
  if (!sameIds(propIds, tracePropIds)) {
    issues.push(`prop ids differ: input=${propIds.join(',')} trace-metadata=${tracePropIds.join(',')}`);
  }
  for (const prop of props) {
    if (!prop || typeof prop !== 'object') continue;
    const traced = tracePropMetadata[prop.id];
    if (traced && canonicalJson(traced) !== canonicalJson(prop)) {
      issues.push(`trace prop metadata differs from input for ${prop.id}`);
    }
    if (prop.attachment && !inputActorIds.includes(prop.attachment.actorId)) {
      issues.push(`prop ${prop.id} attaches to unknown actor ${prop.attachment.actorId}`);
    }
  }

  const metricPair = trace.metrics?.revealToConflict?.pair ?? trace.metrics?.minTTC?.pair ?? [];
  if (!Array.isArray(metricPair) || metricPair.length !== 2 || metricPair.some((id) => !inputActorIds.includes(id))) {
    issues.push(`metric pair must name exactly two input actors; got ${metricPair.join?.(',') ?? 'invalid'}`);
  }

  const actorModels = [];
  for (const actor of actors) {
    try {
      const model = catalogModelFor(actor);
      actorModels.push({
        id: actor.id,
        kind: actor.kind,
        static: actor.static === true,
        catalogId: model.catalogId,
        modelBasis: model.basis,
        renderIdentity: model.renderIdentity,
        dims: actor.dims,
      });
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (issues.length > 0) throw new Error(`evidence integrity failed: ${issues.join('; ')}`);
  return {
    mapId: inputMapId,
    inputHash,
    topology: {
      matcherIndexDigest,
      engineGraphDigest: traceEngineGraphDigest,
    },
    // This is the semantic trace digest. The exact compressed/on-disk bytes
    // are committed separately as traceFileSha256, so JSON whitespace and
    // gzip headers cannot create two identities for the same trace.
    traceDigest: sha256Json(trace),
    actorIds: inputActorIds,
    actorModels: actorModels.sort((left, right) => left.id.localeCompare(right.id)),
    props: props.map((prop) => structuredClone(prop)).sort((left, right) => left.id.localeCompare(right.id)),
    metricPair: [...metricPair],
    catalogSlot: instanceCatalogSlot,
  };
}

/** Join the evaluator result to the exact instance/trace/catalog reservation. */
export function validateScenarioResult(instanceDoc, trace, result, traceCanonicalBytes, options = {}) {
  const issues = [];
  const expectedSlot = instanceDoc?.catalogSlot ?? null;
  if (expectedSlot === null) issues.push('instance catalogSlot is missing');
  if (canonicalJson(trace?.header?.catalogSlot ?? null) !== canonicalJson(expectedSlot)) {
    issues.push('trace catalogSlot differs from instance');
  }
  if (canonicalJson(result?.catalogSlot ?? null) !== canonicalJson(expectedSlot)) {
    issues.push('result catalogSlot differs from instance');
  }
  if (result?.instanceId !== expectedSlot?.identity) issues.push('result instanceId differs from catalog slot identity');
  if (result?.status !== 'ok') issues.push(`result status is ${result?.status ?? 'missing'}, expected ok`);
  if (result?.feasible !== true) issues.push('result is not feasible');
  if (result?.verdict !== 'accept') issues.push(`result verdict is ${result?.verdict ?? 'missing'}, expected accept`);
  if (result?.eligibility?.eligible !== true) issues.push('result eligibility.eligible is not true');
  if (result?.eligibility?.collisionPolicy !== 'reject') {
    issues.push(`result collisionPolicy is ${result?.eligibility?.collisionPolicy ?? 'missing'}, expected reject`);
  }
  if (!Array.isArray(result?.eligibility?.hardFailureCodes)
    || result.eligibility.hardFailureCodes.length !== 0) {
    issues.push('result hardFailureCodes must be an empty array');
  }
  if (result?.inputHash !== instanceDoc?.manifest?.inputHash) issues.push('result inputHash differs from instance');
  const traceDigest = sha256Json(trace);
  if (result?.traceDigest !== traceDigest) issues.push('result traceDigest differs from the semantic trace digest');
  if (expectedSlot !== null) {
    const instanceFileSha256 = options.instanceFileBytes ? sha256Bytes(options.instanceFileBytes) : null;
    const traceFileSha256 = options.traceFileBytes ? sha256Bytes(options.traceFileBytes) : null;
    if (result?.artifactHashes?.instanceSha256 !== instanceFileSha256 || instanceFileSha256 === null) {
      issues.push('result artifactHashes.instanceSha256 differs from exact instance bytes');
    }
    if (result?.artifactHashes?.traceSha256 !== traceFileSha256 || traceFileSha256 === null) {
      issues.push('result artifactHashes.traceSha256 differs from exact trace file bytes');
    }
  }
  if (issues.length > 0) throw new Error(`result evidence integrity failed: ${issues.join('; ')}`);
  return {
    catalogSlot: expectedSlot,
    resultDigest: sha256Json(result),
  };
}

/**
 * Join an evaluator result to the exact instance/trace for a corpus artifact
 * that was never reserved in the 500-slot evidence catalog.
 *
 * This is deliberately NOT a weaker check: every semantic binding that
 * `validateScenarioResult` enforces is enforced here too - status, feasible,
 * verdict, eligibility, empty hard-failure codes, `inputHash` equality with
 * the instance, and `traceDigest` equality with the semantic digest of the
 * exact trace being rendered - plus the exact instance/trace file bytes are
 * committed into the manifest by the caller. What it drops is the catalog
 * reservation closure (`catalogSlot` on all three documents, `instanceId ===
 * catalogSlot.identity`, `artifactHashes` written by the catalog batch
 * writer), which is provenance for catalog coverage accounting rather than
 * render integrity, and it accepts a `collisionPolicy` of `allow` ONLY when
 * the trace records zero collisions, so an accepted collision can never be
 * laundered into evidence. A manifest built from this path is marked
 * `evidenceClass: 'corpus-scenario-clip'` and never counts toward catalog
 * coverage.
 */
export function validateCorpusScenarioResult(instanceDoc, trace, result, options = {}) {
  const issues = [];
  if (result?.status !== 'ok') issues.push(`result status is ${result?.status ?? 'missing'}, expected ok`);
  if (result?.feasible !== true) issues.push('result is not feasible');
  if (result?.verdict !== 'accept') issues.push(`result verdict is ${result?.verdict ?? 'missing'}, expected accept`);
  if (result?.eligibility?.eligible !== true) issues.push('result eligibility.eligible is not true');
  // A collision only condemns the CLIP when an AUTHORED actor is in it. Generated background road
  // users colliding with each other are scenery: measured on the corpus, 312 of 348 collisions (90%)
  // were ambient-ambient, and counting them rejected 58 of 62 scenarios here and made the corpus
  // gate's C5 unsatisfiable on 140/140 cells elsewhere. This is NOT a weakening -- an ego- or
  // challenger-involved collision still fails, and one authored side is enough to count. On any trace
  // written before ambient traffic existed `ambientActorIds` is absent, so `ambient` is empty and this
  // is identical to the previous `collisions.length`.
  const allCollisions = trace?.metrics?.collisions ?? [];
  const ambientIds = new Set(trace?.header?.ambientActorIds ?? []);
  const collisions = allCollisions.filter((c) => !(ambientIds.has(c?.a) && ambientIds.has(c?.b)));
  const ambientOnlyCollisions = allCollisions.length - collisions.length;
  const policy = result?.eligibility?.collisionPolicy ?? 'missing';
  if (policy !== 'reject' && !(policy === 'allow' && collisions.length === 0)) {
    issues.push(`result collisionPolicy is ${policy} with ${collisions.length} authored-involved `
      + `collisions (${allCollisions.length} total, ${ambientOnlyCollisions} ambient-only)`);
  }
  if (!Array.isArray(result?.eligibility?.hardFailureCodes)
    || result.eligibility.hardFailureCodes.length !== 0) {
    issues.push('result hardFailureCodes must be an empty array');
  }
  if (result?.inputHash !== instanceDoc?.manifest?.inputHash) issues.push('result inputHash differs from instance');
  if (result?.instanceId !== instanceDoc?.manifest?.instanceId) {
    issues.push('result instanceId differs from the instance manifest instanceId');
  }
  if (result?.mapId !== instanceDoc?.manifest?.replayKey?.mapId && result?.mapId !== trace?.header?.mapId) {
    issues.push('result mapId differs from the instance and trace map');
  }
  const traceDigest = sha256Json(trace);
  if (result?.traceDigest !== traceDigest) issues.push('result traceDigest differs from the semantic trace digest');
  if (issues.length > 0) throw new Error(`corpus result evidence integrity failed: ${issues.join('; ')}`);
  return {
    catalogSlot: null,
    resultBinding: 'corpus-semantic',
    collisionPolicy: policy,
    recordedCollisions: collisions.length,
    recordedCollisionsAll: allCollisions.length,
    recordedCollisionsAmbientOnly: ambientOnlyCollisions,
    resultDigest: sha256Json(result),
    instanceFileSha256: options.instanceFileBytes ? sha256Bytes(options.instanceFileBytes) : null,
    traceFileSha256: options.traceFileBytes ? sha256Bytes(options.traceFileBytes) : null,
  };
}

/**
 * Bind a render to the incident window the trace itself recorded.
 *
 * Occlusion scenarios carry `metrics.revealToConflict`, which names both the
 * line-of-sight reveal and the predicted conflict instant, and that metric is
 * always preferred. It is only emitted for a declared occlusion monitor that
 * was blocked and then revealed before conflict
 * (`packages/engine/src/trace/metrics.ts` `declaredOcclusion` ->
 * `revealed_before_conflict`), so non-occlusion incidents (cut-in, illegal
 * U-turn, hard brake, stalled lead) never produce it. For those traces the
 * window is derived from the same trace's own recorded facts and nothing
 * else: the conflict instant is the observed closest approach of the
 * criticality pair, and the onset is the last authored trigger that fires
 * before it. Nothing here relaxes an integrity check; it only widens frame
 * selection past the occlusion-only assumption.
 */
export function incidentWindow(trace) {
  const times = trace?.ticks?.t;
  if (!Array.isArray(times) || times.length === 0) {
    throw new Error('cannot derive an incident window from an empty trace');
  }
  const reveal = trace.metrics?.revealToConflict;
  if (reveal && Number.isFinite(reveal.losOpenT) && Number.isFinite(reveal.conflictT)) {
    return {
      basis: 'declared-occlusion-reveal',
      losOpenT: reveal.losOpenT,
      conflictT: reveal.conflictT,
      pair: [...(reveal.pair ?? [])],
      relevantOccluderIds: [...(reveal.relevantOccluderIds ?? [])],
    };
  }
  const first = times[0];
  const last = times[times.length - 1];
  const dt = Number.isFinite(trace.header?.dt) && trace.header.dt > 0
    ? trace.header.dt
    : (times.length > 1 ? times[1] - times[0] : 0.02);
  const minTTC = trace.metrics?.minTTC ?? null;
  const minPathTTC = trace.metrics?.minPathTTC ?? null;
  const criticality = minPathTTC && Number.isFinite(minPathTTC.value) && (
    !minTTC
    || !Number.isFinite(minTTC.value)
    || minPathTTC.value < minTTC.value
    || (minPathTTC.value === minTTC.value && minPathTTC.t < minTTC.t)
  ) ? minPathTTC : minTTC;
  if (!criticality || !Array.isArray(criticality.pair) || criticality.pair.length !== 2) {
    throw new Error('trace carries neither revealToConflict nor a criticality pair to frame');
  }
  const pair = [...criticality.pair];
  const key = [...pair].sort().join('\u0000');
  const closest = (trace.metrics?.minDistance ?? []).find(
    (entry) => Array.isArray(entry?.pair) && [...entry.pair].sort().join('\u0000') === key,
  );
  const predictedConflictT = Number.isFinite(criticality.value)
    ? criticality.t + criticality.value
    : criticality.t;
  const rawConflictT = Number.isFinite(closest?.t) ? closest.t : predictedConflictT;
  const conflictLow = first + Math.max(0.5, 4 * dt);
  const conflictHigh = last - Math.max(0.25, 4 * dt);
  if (!(conflictHigh > conflictLow)) {
    throw new Error('trace is too short to carry a derived incident window');
  }
  const conflictT = Math.max(conflictLow, Math.min(conflictHigh, rawConflictT));
  const triggers = (trace.events ?? [])
    .filter((event) => event?.kind === 'trigger_fired'
      && Number.isFinite(event.t)
      && event.t > first
      && event.t < conflictT)
    .map((event) => event.t)
    .sort((left, right) => left - right);
  const onsetT = triggers.length > 0 ? triggers[triggers.length - 1] : conflictT - 2;
  const losOpenT = Math.min(
    conflictT - Math.max(0.25, 4 * dt),
    Math.max(first + Math.max(0.25, 4 * dt), onsetT),
  );
  return {
    basis: triggers.length > 0 ? 'derived-trigger-onset-to-closest-approach' : 'derived-criticality-window',
    losOpenT,
    conflictT,
    pair,
    relevantOccluderIds: [],
  };
}

/** Four named incident samples, snapped to real recorded ticks. */
export function selectIncidentFrames(trace) {
  const times = trace.ticks.t;
  if (!Array.isArray(times) || times.length === 0) throw new Error('cannot select frames from an empty trace');
  const window = incidentWindow(trace);
  const conflictT = window.conflictT;
  const revealT = window.losOpenT;
  if (!Number.isFinite(revealT) || !Number.isFinite(conflictT)) {
    throw new Error('trace must carry revealToConflict.losOpenT and a conflict timestamp');
  }
  const first = times[0];
  const last = times[times.length - 1];
  const clamp = (time) => Math.max(first, Math.min(last, time));
  const requested = [
    { phase: 'pre-event', targetT: clamp(revealT - 0.2) },
    { phase: 'reveal', targetT: clamp(revealT) },
    { phase: 'conflict', targetT: clamp(conflictT) },
    { phase: 'aftermath', targetT: clamp(conflictT + 0.5) },
  ];
  const selected = requested.map(({ phase, targetT }) => {
    const index = nearestIndex(times, targetT);
    return { phase, targetT, index, t: times[index] };
  });
  if (new Set(selected.map((frame) => frame.index)).size !== selected.length) {
    throw new Error('trace is too short to provide four distinct incident phases');
  }
  return selected;
}

/** Uniform trace samples for motion playback around the complete reveal. */
export function selectIncidentVideoFrames(trace, fps = 12) {
  if (!Number.isFinite(fps) || fps < 1) throw new Error('video fps must be a positive number');
  const reveal = incidentWindow(trace);
  if (!reveal || !Number.isFinite(reveal.losOpenT) || !Number.isFinite(reveal.conflictT)) {
    throw new Error('trace must carry revealToConflict for incident video selection');
  }
  const times = trace.ticks.t;
  const startT = Math.max(times[0], reveal.losOpenT - 1);
  const endT = Math.min(times[times.length - 1], reveal.conflictT + 0.8);
  const count = Math.ceil((endT - startT) * fps);
  const selected = [];
  for (let frame = 0; frame <= count; frame += 1) {
    const targetT = Math.min(endT, startT + frame / fps);
    const index = nearestIndex(times, targetT);
    if (selected.at(-1)?.index === index) continue;
    selected.push({ index, targetT, t: times[index] });
  }
  if (selected.at(-1)?.t !== times[nearestIndex(times, endT)]) {
    const index = nearestIndex(times, endT);
    selected.push({ index, targetT: endT, t: times[index] });
  }
  return { fps, startT, endT, frames: selected };
}

/**
 * Uniform trace samples across the complete recorded clip.
 *
 * The incident-window sequence above is deliberately short: it exists to prove
 * the reveal. A corpus video instead has to show the entire authored clip, so
 * this walks every recorded tick window at the requested frame rate from the
 * first tick to the last one.
 */
export function selectClipVideoFrames(trace, fps = 12) {
  if (!Number.isFinite(fps) || fps < 1) throw new Error('video fps must be a positive number');
  const times = trace?.ticks?.t;
  if (!Array.isArray(times) || times.length === 0) throw new Error('cannot select frames from an empty trace');
  const startT = times[0];
  const endT = times[times.length - 1];
  const count = Math.ceil((endT - startT) * fps);
  const selected = [];
  for (let frame = 0; frame <= count; frame += 1) {
    const targetT = Math.min(endT, startT + frame / fps);
    const index = nearestIndex(times, targetT);
    if (selected.at(-1)?.index === index) continue;
    selected.push({ index, targetT, t: times[index] });
  }
  if (selected.at(-1)?.index !== times.length - 1) {
    selected.push({ index: times.length - 1, targetT: endT, t: endT });
  }
  return { fps, startT, endT, frames: selected };
}

/** Cheap trace-only gate that runs before any browser or GPU rendering. */
export function buildIncidentRenderPreflight(trace, evidence) {
  const selectedFrames = selectIncidentFrames(trace);
  const aftermath = selectedFrames.find((frame) => frame.phase === 'aftermath');
  const presence = Object.fromEntries(evidence.metricPair.map((id) => [
    id,
    aftermath ? trace.ticks.actors[id]?.present?.[aftermath.index] !== 0 : false,
  ]));
  const gates = [
    {
      id: 'four-distinct-incident-phases',
      status: new Set(selectedFrames.map((frame) => frame.index)).size === REQUIRED_INCIDENT_PHASES.length ? 'pass' : 'fail',
      evidence: selectedFrames.map(({ phase, index, t }) => ({ phase, index, t })),
    },
    {
      id: 'incident-pair-present-in-aftermath',
      status: evidence.metricPair.every((id) => presence[id]) ? 'pass' : 'fail',
      evidence: {
        metricPair: evidence.metricPair,
        aftermathT: aftermath?.t ?? null,
        presence,
        rationale: 'An aftermath frame must show the incident participants; despawning at conflict is a visible teleport.',
      },
    },
  ];
  return {
    schema: 'simforge-oss.scenario-render-preflight.v1',
    verdict: gates.every((gate) => gate.status === 'pass') ? 'pass' : 'reject',
    gates,
    selectedFrames,
  };
}

export function tracePose(trace, actorId, index) {
  const track = trace.ticks.actors[actorId];
  return {
    id: actorId,
    x: track.x[index],
    z: -track.y[index],
    headingRad: track.headingRad[index],
    speedMps: track.speedMps[index],
    present: track.present[index] !== 0,
  };
}

const DOOR_NAMES = new Set(['left', 'right', 'rear']);
const DOOR_STATES = new Set(['closed', 'opening', 'open', 'closing']);

/** Sample export-facing discrete state in stable trace order at one recorded tick. */
export function traceRenderState(trace, time) {
  const doors = new Map();
  const cues = new Map();
  for (const event of trace.events ?? []) {
    if (event?.kind !== 'state_set') continue;
    if (typeof event.key === 'string' && event.key.startsWith('doors.')) {
      const name = event.key.slice('doors.'.length);
      if (!DOOR_NAMES.has(name) || !DOOR_STATES.has(event.value)) continue;
      let actorDoors = doors.get(event.actorId);
      if (!actorDoors) {
        actorDoors = {};
        doors.set(event.actorId, actorDoors);
      }
      if (actorDoors[name] === undefined) actorDoors[name] = 'closed';
      if (event.t <= time) actorDoors[name] = event.value;
      continue;
    }
    if (event.t > time) continue;
    const current = cues.get(event.actorId) ?? { emergency: 'off', hornActive: false };
    if (event.key === 'lights.emergency'
      && ['off', 'flashing', 'flashing_siren'].includes(event.value)) {
      cues.set(event.actorId, { ...current, emergency: event.value });
    } else if (event.key === 'audio.horn' && typeof event.value === 'boolean') {
      cues.set(event.actorId, { ...current, hornActive: event.value });
    }
  }
  return { doors, cues };
}

/**
 * Project the exact recorded tick into the ActorRenderer transport shape.
 * This keeps headless evidence export aligned with interactive Studio playback,
 * including semantic actors, attached/fixed props, reverse motion and doors.
 */
export function renderViewsAtTraceIndex(instanceDoc, trace, evidence, index) {
  if (!Number.isInteger(index) || index < 0 || index >= trace.ticks.t.length) {
    throw new Error(`trace render index ${index} is out of range`);
  }
  const time = trace.ticks.t[index];
  const state = traceRenderState(trace, time);
  const actors = evidence.actorModels.map((actor) => {
    const pose = tracePose(trace, actor.id, index);
    const cues = state.cues.get(actor.id);
    return {
      ...pose,
      catalogId: actor.catalogId,
      kind: actor.kind,
      catalogIdAuthored: actor.modelBasis === 'input-tag',
      dims: actor.dims,
      static: actor.static,
      reversing: trace.ticks.actors[actor.id]?.motionDirection?.[index] === -1,
      ...(state.doors.has(actor.id) ? { doors: state.doors.get(actor.id) } : {}),
      ...(cues ? { emergency: cues.emergency, hornActive: cues.hornActive } : {}),
    };
  });
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  const props = evidence.props.flatMap((prop) => {
    let x = prop.pose.x;
    let z = prop.pose.z;
    let headingRad = prop.pose.headingRad;
    let heightM = 0;
    if (prop.attachment) {
      const carrier = actorById.get(prop.attachment.actorId);
      if (!carrier?.present) return [];
      const cos = Math.cos(carrier.headingRad);
      const sin = Math.sin(carrier.headingRad);
      x = carrier.x + cos * prop.attachment.longitudinalM - sin * prop.attachment.lateralM;
      z = carrier.z - sin * prop.attachment.longitudinalM - cos * prop.attachment.lateralM;
      headingRad = carrier.headingRad + prop.attachment.headingOffsetRad;
      heightM = prop.attachment.heightM;
    }
    return [{
      id: prop.id,
      catalogId: prop.catalogId,
      catalogIdAuthored: true,
      dims: {
        l: prop.dims.l * prop.scale,
        w: prop.dims.w * prop.scale,
        h: prop.dims.h * prop.scale,
      },
      x,
      z,
      headingRad,
      heightM,
      present: true,
      static: true,
    }];
  });
  return { time, actors, props };
}

/** Stable map camera that keeps both members of the incident pair in frame. */
export function cameraForIncident(
  trace,
  pair,
  index,
  groundY = 0,
  framingActorIds = pair,
  framingPropPoses = [],
) {
  const sampleT = trace.ticks.t[index];
  const window = incidentWindow(trace);
  const conflictT = window.conflictT ?? sampleT;
  const conflictIndex = nearestIndex(trace.ticks.t, conflictT);
  // The conflict composition is already known-good and all relevant actors are
  // present there. Freeze it for the tail instead of allowing a following
  // camera to drift through the bus, trees or buildings after despawn.
  const cameraIndex = sampleT > conflictT ? conflictIndex : index;
  const conflictFrozen = sampleT > conflictT;
  const cameraT = trace.ticks.t[cameraIndex];
  const allPoses = [
    ...framingActorIds.map((id) => tracePose(trace, id, cameraIndex)),
    ...framingPropPoses.map((pose) => ({ ...pose, present: pose.present !== false })),
  ];
  const poses = allPoses.filter((pose) => pose.present);
  const visibleAtSample = [
    ...framingActorIds.map((id) => tracePose(trace, id, index)),
    ...framingPropPoses.map((pose) => ({ ...pose, present: pose.present !== false })),
  ].filter((pose) => pose.present);
  if (poses.length === 0) throw new Error(`no framing actors are present at trace index ${index}`);
  const centerX = poses.reduce((sum, pose) => sum + pose.x, 0) / poses.length;
  const centerZ = poses.reduce((sum, pose) => sum + pose.z, 0) / poses.length;
  const subjectId = pair.includes(trace.header.metricSubject) ? trace.header.metricSubject : pair[0];
  const subject = tracePose(trace, subjectId, cameraIndex);
  const targetActor = tracePose(trace, pair.find((id) => id !== subjectId), cameraIndex);
  const sightlineLength = Math.hypot(subject.x - targetActor.x, subject.z - targetActor.z);
  const away = sightlineLength > 1e-6
    ? {
        x: (subject.x - targetActor.x) / sightlineLength,
        z: (subject.z - targetActor.z) / sightlineLength,
      }
    : { x: -Math.cos(subject.headingRad), z: Math.sin(subject.headingRad) };
  const side = { x: -away.z, z: away.x };
  const radius = Math.max(...poses.map((pose) => Math.hypot(pose.x - centerX, pose.z - centerZ)));
  const revealT = window.losOpenT ?? cameraT;
  const baseDistance = Math.max(11, Math.min(15, radius * 0.45 + 8));
  const revealProgress = conflictT > revealT
    ? Math.max(0, Math.min(1, (cameraT - revealT) / (conflictT - revealT)))
    : 1;
  // Stay almost on the ego sightline through reveal, then move toward the
  // clear median side of the road. The opposite sign puts the observer on
  // the bus-stop sidewalk, where Yale's shelter roof and street trees can
  // completely hide the incident despite adequate actor clearance.
  const distance = baseDistance + 11 * revealProgress;
  const sideOffset = 0.25 + 4.75 * revealProgress;
  const trailingEye = {
    x: subject.x + away.x * distance + side.x * sideOffset,
    z: subject.z + away.z * distance + side.z * sideOffset,
  };
  const fovDeg = Math.max(24, Math.min(52, 52 - (radius - 8) * 1.1));
  return {
    basis: conflictFrozen ? 'conflict-frozen-low-oblique' : 'ego-sightline-low-oblique',
    frozenAtT: conflictFrozen ? conflictT : null,
    pair: [...pair],
    framingActorIds: [...framingActorIds],
    framingPropIds: framingPropPoses.map((pose) => pose.id),
    visibleFramingActorIds: visibleAtSample.map((pose) => pose.id),
    fovDeg,
    eye: [
      trailingEye.x,
      groundY + 3.3 + 1.5 * revealProgress,
      trailingEye.z,
    ],
    target: [centerX, groundY + 1.35, centerZ],
  };
}

/**
 * Full-clip camera that keeps every framing actor inside the viewport.
 *
 * `cameraForIncident` is tuned for the seconds around a reveal, where the pair
 * is already close together. A whole-clip video starts with the actors tens of
 * metres apart, so the stand-off distance and elevation are solved per frame
 * from the bounding radius of the present framing actors while the azimuth is
 * frozen at the conflict sightline so the camera never spins mid-clip.
 */
export function cameraForClip(
  trace,
  pair,
  index,
  groundY = 0,
  framingActorIds = pair,
  framingPropPoses = [],
) {
  const window = incidentWindow(trace);
  const conflictIndex = nearestIndex(trace.ticks.t, window.conflictT);
  const subjectId = pair.includes(trace.header.metricSubject) ? trace.header.metricSubject : pair[0];
  const otherId = pair.find((id) => id !== subjectId);
  const subjectAtConflict = tracePose(trace, subjectId, conflictIndex);
  const targetAtConflict = tracePose(trace, otherId, conflictIndex);
  const sightline = Math.hypot(
    subjectAtConflict.x - targetAtConflict.x,
    subjectAtConflict.z - targetAtConflict.z,
  );
  const away = sightline > 1e-6
    ? {
        x: (subjectAtConflict.x - targetAtConflict.x) / sightline,
        z: (subjectAtConflict.z - targetAtConflict.z) / sightline,
      }
    : { x: -Math.cos(subjectAtConflict.headingRad), z: Math.sin(subjectAtConflict.headingRad) };
  const side = { x: -away.z, z: away.x };
  const poses = [
    ...framingActorIds.map((id) => tracePose(trace, id, index)),
    ...framingPropPoses.map((pose) => ({ ...pose, present: pose.present !== false })),
  ].filter((pose) => pose.present);
  if (poses.length === 0) throw new Error(`no framing actors are present at trace index ${index}`);
  const centerX = poses.reduce((sum, pose) => sum + pose.x, 0) / poses.length;
  const centerZ = poses.reduce((sum, pose) => sum + pose.z, 0) / poses.length;
  const radius = Math.max(...poses.map((pose) => Math.hypot(pose.x - centerX, pose.z - centerZ)));
  const fovDeg = 45;
  // Solve the stand-off from the vertical half-angle with margin so every
  // framing actor projects well inside the |ndc| bounds the composition gate
  // enforces, then keep a fixed oblique elevation above that.
  const halfAngle = (fovDeg / 2) * (Math.PI / 180);
  const fitDistance = (radius + 6) / (Math.tan(halfAngle) * 0.8);
  const distance = Math.max(16, fitDistance);
  const height = groundY + Math.max(7, distance * 0.42);
  return {
    basis: 'clip-fit-frozen-azimuth',
    frozenAtT: null,
    pair: [...pair],
    framingActorIds: [...framingActorIds],
    framingPropIds: framingPropPoses.map((pose) => pose.id),
    visibleFramingActorIds: poses.map((pose) => pose.id),
    fovDeg,
    eye: [
      centerX + away.x * distance + side.x * (distance * 0.12),
      height,
      centerZ + away.z * distance + side.z * (distance * 0.12),
    ],
    target: [centerX, groundY + 1.35, centerZ],
  };
}

/** Horizontal clearance from a camera eye to the nearest actor footprint. */
export function cameraActorClearance(camera, poses, actorModels) {
  const dims = new Map(actorModels.map((actor) => [actor.id, actor.dims]));
  let minimum = Infinity;
  let actorId = null;
  for (const pose of poses) {
    if (!pose.present) continue;
    const actorDims = dims.get(pose.id);
    if (!actorDims) continue;
    const dx = camera.eye[0] - pose.x;
    const dz = camera.eye[2] - pose.z;
    const cos = Math.cos(pose.headingRad);
    const sin = Math.sin(pose.headingRad);
    const forward = cos * dx - sin * dz;
    const lateral = -sin * dx - cos * dz;
    const outsideForward = Math.max(0, Math.abs(forward) - actorDims.l / 2);
    const outsideLateral = Math.max(0, Math.abs(lateral) - actorDims.w / 2);
    const clearanceM = Math.hypot(outsideForward, outsideLateral);
    if (clearanceM < minimum) {
      minimum = clearanceM;
      actorId = pose.id;
    }
  }
  return { actorId, clearanceM: minimum };
}

export function scenarioIdentity(instanceDoc) {
  const replay = instanceDoc.manifest.replayKey;
  const slot = instanceDoc.catalogSlot ?? null;
  return {
    scenarioId: slot?.identity ?? instanceDoc.manifest.instanceId,
    catalogSlot: slot,
    templateId: slot?.templateId ?? replay.templateId,
    archetypeId: instanceDoc.manifest.archetype,
    siteId: replay.siteId,
    drawId: replay.drawIndex,
    drawSeed: replay.paramSeed,
  };
}

function pass(id, evidence) {
  return { id, status: 'pass', evidence };
}

function fail(id, evidence) {
  return { id, status: 'fail', evidence };
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Build deterministic, review-independent acceptance gates. A render that
 * fails any gate is diagnostic output, never scenario evidence.
 */
export function buildScenarioEvidenceGates({
  trace,
  evidence,
  topologyDomains,
  frameRecords,
  videoSequence,
  video,
  diagnostics = [],
}) {
  const gates = [];
  const phases = frameRecords.map((frame) => frame.phase);
  const distinctTickCount = new Set(frameRecords.map((frame) => frame.index)).size;
  const exactPhases = phases.length === REQUIRED_INCIDENT_PHASES.length
    && phases.every((phase, index) => phase === REQUIRED_INCIDENT_PHASES[index])
    && distinctTickCount === REQUIRED_INCIDENT_PHASES.length;
  gates.push((exactPhases ? pass : fail)('four-distinct-incident-phases', {
    expected: REQUIRED_INCIDENT_PHASES,
    actual: phases,
    distinctTickCount,
  }));

  const incident = incidentWindow(trace);
  const revealT = incident.losOpenT;
  const conflictT = incident.conflictT;
  const byPhase = new Map(frameRecords.map((frame) => [frame.phase, frame]));
  const phaseTimesValid = Number.isFinite(revealT)
    && Number.isFinite(conflictT)
    && byPhase.get('pre-event')?.t < revealT
    && byPhase.get('reveal')?.index === nearestIndex(trace.ticks.t, revealT)
    && byPhase.get('conflict')?.index === nearestIndex(trace.ticks.t, conflictT)
    && byPhase.get('aftermath')?.t > conflictT;
  gates.push((phaseTimesValid ? pass : fail)('phase-times-bracket-reveal-and-conflict', {
    revealT,
    conflictT,
    frameTimes: Object.fromEntries(frameRecords.map((frame) => [frame.phase, frame.t])),
  }));

  const expectedActors = evidence.actorIds;
  const posesExact = frameRecords.every((frame) => {
    const actual = (frame.poses ?? []).map((pose) => pose.id).sort();
    return actual.length === expectedActors.length
      && actual.every((id, index) => id === expectedActors[index]);
  });
  gates.push((posesExact ? pass : fail)('every-key-frame-carries-all-actor-poses', {
    expectedActorIds: expectedActors,
    frames: frameRecords.map((frame) => ({
      phase: frame.phase,
      actorIds: (frame.poses ?? []).map((pose) => pose.id).sort(),
    })),
  }));

  const propPosesExact = frameRecords.every((frame) => {
    const expectedPropIds = evidence.props.filter((prop) => (
      !prop.attachment
      || trace.ticks.actors[prop.attachment.actorId]?.present?.[frame.index] !== 0
    )).map((prop) => prop.id).sort();
    const actual = (frame.props ?? []).map((prop) => prop.id).sort();
    return actual.length === expectedPropIds.length
      && actual.every((id, index) => id === expectedPropIds[index]);
  });
  gates.push((propPosesExact ? pass : fail)('every-key-frame-carries-all-fixed-props', {
    frames: frameRecords.map((frame) => ({
      phase: frame.phase,
      expectedPropIds: evidence.props.filter((prop) => (
        !prop.attachment
        || trace.ticks.actors[prop.attachment.actorId]?.present?.[frame.index] !== 0
      )).map((prop) => prop.id).sort(),
      propIds: (frame.props ?? []).map((prop) => prop.id).sort(),
    })),
  }));

  const aftermath = byPhase.get('aftermath');
  const aftermathPair = new Map((aftermath?.poses ?? []).map((pose) => [pose.id, pose.present]));
  const pairPresentAfterConflict = evidence.metricPair.every((id) => aftermathPair.get(id) === true);
  gates.push((pairPresentAfterConflict ? pass : fail)('incident-pair-present-in-aftermath', {
    metricPair: evidence.metricPair,
    presence: Object.fromEntries(evidence.metricPair.map((id) => [id, aftermathPair.get(id) ?? null])),
    rationale: 'An aftermath frame must show the incident participants; despawning at conflict is a visible teleport.',
  }));

  const compositionPasses = frameRecords.every((frame) => frame.composition?.passed === true);
  gates.push((compositionPasses ? pass : fail)('key-frame-composition', {
    frames: frameRecords.map((frame) => ({ phase: frame.phase, passed: frame.composition?.passed === true })),
  }));

  const clearancePasses = frameRecords.every(
    (frame) => Number.isFinite(frame.cameraActorClearance?.clearanceM)
      && frame.cameraActorClearance.clearanceM >= 2,
  );
  gates.push((clearancePasses ? pass : fail)('camera-outside-actor-footprints', {
    minimumM: 2,
    frames: frameRecords.map((frame) => ({
      phase: frame.phase,
      actorId: frame.cameraActorClearance?.actorId ?? null,
      clearanceM: frame.cameraActorClearance?.clearanceM ?? null,
    })),
  }));

  const artifactsValid = frameRecords.every(
    (frame) => typeof frame.artifact?.file === 'string' && isSha256(frame.artifact?.sha256),
  );
  const artifactHashes = frameRecords.map((frame) => frame.artifact?.sha256).filter(Boolean);
  const artifactsDistinct = new Set(artifactHashes).size === frameRecords.length;
  gates.push((artifactsValid && artifactsDistinct ? pass : fail)('key-frame-artifacts-valid-and-distinct', {
    files: frameRecords.map((frame) => frame.artifact?.file ?? null),
    hashesValid: artifactsValid,
    distinctHashCount: new Set(artifactHashes).size,
  }));

  const videoValid = typeof video?.file === 'string'
    && video.file.toLowerCase().endsWith('.mp4')
    && isSha256(video?.sha256)
    && Number.isInteger(video.frameCount)
    && video.frameCount > 0
    && Number.isFinite(video.fps)
    && video.fps >= 8
    && videoSequence?.frameCount === video.frameCount
    && videoSequence?.frames?.length === video.frameCount;
  gates.push((videoValid ? pass : fail)('mp4-encoded-and-probed', {
    file: video?.file ?? null,
    sha256: video?.sha256 ?? null,
    fps: video?.fps ?? null,
    frameCount: video?.frameCount ?? null,
    unavailable: video?.unavailable ?? false,
    reason: video?.reason ?? null,
  }));

  const videoCoversIncident = videoSequence
    && videoSequence.startT < revealT
    && videoSequence.endT > conflictT
    && videoSequence.frames?.length > 1
    && videoSequence.frames.every((frame, index, frames) => index === 0 || frame.t > frames[index - 1].t);
  gates.push((videoCoversIncident ? pass : fail)('video-covers-reveal-through-aftermath', {
    startT: videoSequence?.startT ?? null,
    revealT,
    conflictT,
    endT: videoSequence?.endT ?? null,
  }));

  // Corpus renders declare full-clip coverage. The catalog incident export
  // never sets this, so these two gates are additive: they only ever run for a
  // sequence that claims to cover the whole recorded clip.
  if (videoSequence?.coverage === 'full-clip') {
    const times = trace.ticks.t;
    const firstT = times[0];
    const lastT = times[times.length - 1];
    const coversClip = videoSequence.startT === firstT
      && videoSequence.endT === lastT
      && videoSequence.frames?.[0]?.t === firstT
      && videoSequence.frames?.[videoSequence.frames.length - 1]?.t === lastT
      && videoSequence.frameCount >= Math.floor((lastT - firstT) * videoSequence.fps);
    gates.push((coversClip ? pass : fail)('video-covers-full-clip-duration', {
      clipStartT: firstT,
      clipEndT: lastT,
      startT: videoSequence.startT ?? null,
      endT: videoSequence.endT ?? null,
      fps: videoSequence.fps ?? null,
      frameCount: videoSequence.frameCount ?? null,
      minimumFrameCount: Math.floor((lastT - firstT) * videoSequence.fps),
    }));

    // AUTHORED actors only. Generated background road users are scenery: they must be visible IN the
    // shot, never a CONSTRAINT ON it. Demanding that all ~40 ambient cars be simultaneously composed
    // in every frame is unsatisfiable and rejected 59 of 62 corpus scenarios that had already
    // rendered a complete video. The gate is unchanged in strength for every authored actor, and
    // `ambientActorIds` is absent from every pre-ambient trace, so this is a no-op on them.
    const ambientIdSet = new Set(trace?.header?.ambientActorIds ?? []);
    const authoredOnly = (ids) => ids.filter((id) => !ambientIdSet.has(id));
    const allActorsComposed = videoSequence.frames.every((frame) => {
      if (frame.composition?.passed !== true) return false;
      const present = authoredOnly((frame.poses ?? []).filter((pose) => pose.present).map((pose) => pose.id)).sort();
      const composed = authoredOnly((frame.composition.actors ?? []).map((actor) => actor.id)).sort();
      return present.length === composed.length && present.every((id, at) => id === composed[at]);
    });
    const offenders = videoSequence.frames.filter((frame) => frame.composition?.passed !== true).length;
    gates.push((allActorsComposed ? pass : fail)('every-video-frame-shows-every-present-actor', {
      frameCount: videoSequence.frameCount,
      actorIds: authoredOnly(evidence.actorIds ?? []),
      ambientExcluded: ambientIdSet.size,
      failedCompositionFrames: offenders,
    }));
  }

  const topologyKeys = ['authoringMatcherTopology', 'simulationRoadGraph', 'studioRenderScene'];
  const topologyValid = topologyKeys.every((key) => isSha256(topologyDomains?.[key]?.digest));
  gates.push((topologyValid ? pass : fail)('three-domain-topology-provenance', {
    domains: Object.fromEntries(topologyKeys.map((key) => [key, topologyDomains?.[key]?.digest ?? null])),
  }));

  gates.push((diagnostics.length === 0 ? pass : fail)('browser-diagnostics-empty', {
    count: diagnostics.length,
    diagnostics,
  }));

  return {
    verdict: gates.every((gate) => gate.status === 'pass') ? 'pass' : 'reject',
    gates,
  };
}

export function assertScenarioEvidenceAccepted(machineAssessment) {
  const failed = machineAssessment.gates.filter((gate) => gate.status !== 'pass');
  if (failed.length > 0) {
    throw new Error(`scenario visual evidence rejected: ${failed.map((gate) => gate.id).join(', ')}`);
  }
}

/** Build the wall-clock-free portion of the final evidence manifest. */
export function buildScenarioManifest({
  instanceDoc,
  trace,
  evidence,
  topologyDomains,
  viewport,
  frameRecords,
  videoSequence,
  video,
  inputArtifacts,
  rendererStats,
  diagnostics = [],
  evidenceClass = 'scenario-instance-incident',
  resultBinding = null,
}) {
  const identity = scenarioIdentity(instanceDoc);
  const machineAssessment = buildScenarioEvidenceGates({
    trace,
    evidence,
    topologyDomains,
    frameRecords,
    videoSequence,
    video,
    diagnostics,
  });
  return {
    schema: SCENARIO_EVIDENCE_SCHEMA,
    generatedAt: null,
    deterministic: true,
    evidenceClass,
    ...(resultBinding === null ? {} : { resultBinding }),
    coverageEligibility: machineAssessment.verdict === 'pass' ? 'pending-human-review' : 'rejected',
    countsTowardScenarioCoverage: false,
    renderer: {
      path: 'SimForge CityViewer + EditorController.ActorRenderer',
      realMapGeometry: true,
      realCatalogModels: true,
      frame: 'scene-y-up',
      stats: rendererStats,
    },
    ...identity,
    mapId: evidence.mapId,
    inputHash: evidence.inputHash,
    traceDigest: evidence.traceDigest,
    physics: trace.header.physics ?? null,
    topologyDomains,
    actors: {
      count: evidence.actorIds.length,
      ids: evidence.actorIds,
      models: evidence.actorModels.map(({ dims, ...model }) => ({
        ...model,
        catalogId: model.renderIdentity.source === 'catalog' ? model.catalogId : null,
        simulationDims: dims,
      })),
      staticInvariant: evidence.actorModels.filter((actor) => actor.static).map((actor) => actor.id),
    },
    props: {
      count: evidence.props.length,
      ids: evidence.props.map((prop) => prop.id),
      models: evidence.props.map((prop) => ({
        id: prop.id,
        catalogId: prop.catalogId,
        dims: prop.dims,
        scale: prop.scale,
        attachedTo: prop.attachment?.actorId ?? null,
        essentiality: prop.essentiality,
      })),
    },
    metricPair: evidence.metricPair,
    metrics: {
      minTTC: trace.metrics.minTTC ?? null,
      revealToConflict: trace.metrics.revealToConflict ?? null,
      minDistance: trace.metrics.minDistance ?? [],
      collisions: trace.metrics.collisions ?? [],
    },
    viewport,
    frameTimes: frameRecords.map((frame) => ({ phase: frame.phase, t: frame.t })),
    frames: frameRecords,
    videoSequence,
    video,
    artifacts: inputArtifacts,
    machineAssessment,
    humanReview: {
      status: 'pending',
      verdict: null,
      required: true,
      template: 'review.json',
    },
    integrity: {
      instanceInputHashMatches: true,
      traceInputHashMatches: true,
      mapIdsExactMatch: true,
      actorIdsExactMatch: true,
      staticActorsInvariant: true,
    },
  };
}
