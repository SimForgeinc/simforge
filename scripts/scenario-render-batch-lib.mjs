import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  REQUIRED_INCIDENT_PHASES,
  SCENARIO_EVIDENCE_SCHEMA,
  canonicalJson,
  selectIncidentFrames,
  selectIncidentVideoFrames,
  validateScenarioPair,
  validateScenarioResult,
} from './export-render-lib.mjs';
import {
  SCENARIO_REVIEW_SCHEMA,
  adjudicateScenarioReview,
  createScenarioReviewTemplate,
} from './scenario-review-ledger-lib.mjs';

export const SCENARIO_RENDER_BATCH_SCHEMA = 'simforge-oss.scenario-render-review-batch.v1';

export const REQUIRED_MACHINE_GATES = [
  'four-distinct-incident-phases',
  'phase-times-bracket-reveal-and-conflict',
  'every-key-frame-carries-all-actor-poses',
  'incident-pair-present-in-aftermath',
  'key-frame-composition',
  'camera-outside-actor-footprints',
  'key-frame-artifacts-valid-and-distinct',
  'mp4-encoded-and-probed',
  'video-covers-reveal-through-aftermath',
  'three-domain-topology-provenance',
  'browser-diagnostics-empty',
];

const TERMINAL_RENDER_STATUSES = new Set([
  'rendered-pending-review',
  'accepted',
  'rejected',
  'invalid-review',
]);

const RESUMABLE_RENDER_STATUSES = new Set([
  'ready-to-render',
  'interrupted',
  'cancelled',
  'render-failed',
  'invalid-evidence',
]);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function exactMapCounts(catalog) {
  return Object.fromEntries(catalog.maps.map((map) => [map.mapId, map.slots]));
}

/** Validate the scaling contract before any browser process is launched. */
export function validateBatchCatalog(catalog) {
  const issues = [];
  // historical name retained for stored-data compat
  if (catalog?.kind !== 'uniscenarios-scenario-catalog') issues.push('catalog kind is invalid');
  if (!Array.isArray(catalog?.maps) || catalog.maps.length !== 5) issues.push('exactly five maps are required');
  if (!Array.isArray(catalog?.slots) || catalog.slots.length !== 500) issues.push('exactly 500 slots are required');
  if (catalog?.progress?.target !== 500) issues.push('catalog progress target must be 500');
  const identities = new Set();
  const ordinals = new Set();
  const counts = new Map();
  for (const slot of catalog?.slots ?? []) {
    if (typeof slot?.identity !== 'string' || slot.identity.length === 0) issues.push('slot identity is missing');
    if (identities.has(slot?.identity)) issues.push(`duplicate slot identity ${slot.identity}`);
    identities.add(slot?.identity);
    if (!Number.isInteger(slot?.ordinal) || slot.ordinal < 0) issues.push(`slot ${slot?.identity} ordinal is invalid`);
    const ordinalKey = `${slot?.mapId}:${slot?.ordinal}`;
    if (ordinals.has(ordinalKey)) issues.push(`duplicate slot ordinal ${ordinalKey}`);
    ordinals.add(ordinalKey);
    counts.set(slot?.mapId, (counts.get(slot?.mapId) ?? 0) + 1);
    for (const key of ['instance', 'trace', 'result', 'renderManifest', 'frame', 'video', 'visualInspection']) {
      if (typeof slot?.evidencePaths?.[key] !== 'string' || slot.evidencePaths[key].length === 0) {
        issues.push(`slot ${slot?.identity} evidencePaths.${key} is missing`);
      }
    }
    if (!isSha256(slot?.seed)) issues.push(`slot ${slot?.identity} seed is not sha256`);
    if (!isSha256(slot?.designDigest)) issues.push(`slot ${slot?.identity} designDigest is not sha256`);
    if (slot?.implementation?.state !== 'template-backed') {
      issues.push(`slot ${slot?.identity} is not template-backed`);
    }
    if (slot?.implementation?.materializedVariantId !== slot?.variant?.id) {
      issues.push(`slot ${slot?.identity} materialized variant does not match the selected variant`);
    }
    if (typeof slot?.implementation?.templateId !== 'string' || slot.implementation.templateId.length === 0) {
      issues.push(`slot ${slot?.identity} templateId is missing`);
    }
    if (typeof slot?.site?.locationId !== 'string' || slot.site.locationId.length === 0) {
      issues.push(`slot ${slot?.identity} selected location is missing`);
    }
    if (typeof slot?.implementation?.matcherSiteId !== 'string'
      || slot.implementation.matcherSiteId.length === 0) {
      issues.push(`slot ${slot?.identity} selected matcher site is missing`);
    }
    if (slot?.implementation?.matchedLocationId !== slot?.site?.locationId) {
      issues.push(`slot ${slot?.identity} matcher binding does not close to the selected location`);
    }
  }
  for (const map of catalog?.maps ?? []) {
    if (map.slots !== 100 || counts.get(map.mapId) !== 100) {
      issues.push(`map ${map.mapId} must contain exactly 100 slots`);
    }
  }
  if (issues.length > 0) throw new Error(`invalid 500-scenario catalog: ${issues.join('; ')}`);
  return { total: 500, byMap: exactMapCounts(catalog) };
}

function entryFromSlot(slot, catalogOrdinal, provenance) {
  const catalogReservation = {
    identity: slot.identity,
    seed: slot.seed,
    designDigest: slot.designDigest,
    mapId: slot.mapId,
    incidentId: slot.scenario.incidentId,
    selectedLocationId: slot.site.locationId,
    selectedMatcherSiteId: slot.implementation.matcherSiteId,
    variant: slot.variant,
    provenance: slot.provenance,
    templateId: slot.implementation.templateId,
  };
  return {
    ordinal: catalogOrdinal,
    mapOrdinal: slot.ordinal,
    scenarioId: slot.identity,
    mapId: slot.mapId,
    seed: slot.seed,
    designDigest: slot.designDigest,
    expectedTopology: {
      matcherIndexDigest: slot.provenance.matcherIndexDigest,
      engineGraphDigest: slot.provenance.engineGraphDigest,
    },
    catalogReservation,
    reviewProvenance: provenance.rendererSources,
    evidencePaths: {
      instance: slot.evidencePaths.instance,
      trace: slot.evidencePaths.trace,
      result: slot.evidencePaths.result,
      renderManifest: slot.evidencePaths.renderManifest,
      frame: slot.evidencePaths.frame,
      video: slot.evidencePaths.video,
      visualInspection: slot.evidencePaths.visualInspection,
    },
    status: 'uninspected',
    renderAttempts: 0,
    lastAttempt: null,
    evidence: null,
    review: null,
    countsTowardScenarioCoverage: false,
    issues: [],
  };
}

export function createBatchLedger(catalog, provenance, config) {
  validateBatchCatalog(catalog);
  const mapOrder = new Map(catalog.maps.map((map, index) => [map.mapId, index]));
  const entries = [...catalog.slots]
    .sort((left, right) => mapOrder.get(left.mapId) - mapOrder.get(right.mapId)
      || left.ordinal - right.ordinal
      || left.identity.localeCompare(right.identity))
    .map((slot, catalogOrdinal) => entryFromSlot(slot, catalogOrdinal, provenance));
  return {
    schema: SCENARIO_RENDER_BATCH_SCHEMA,
    provenance,
    config,
    entries,
    summary: summarizeBatchEntries(entries, catalog.maps),
  };
}

/** Resume only when the exact catalog, renderer implementation, and settings match. */
export function resumeBatchLedger(existing, catalog, provenance, config) {
  if (existing?.schema !== SCENARIO_RENDER_BATCH_SCHEMA || !Array.isArray(existing.entries)) {
    throw new Error('existing render/review batch ledger is invalid');
  }
  const expected = createBatchLedger(catalog, provenance, config);
  if (canonicalJson(existing.provenance) !== canonicalJson(provenance)) {
    throw new Error('cannot resume: catalog or renderer provenance changed');
  }
  if (canonicalJson(existing.config) !== canonicalJson(config)) {
    throw new Error('cannot resume: render settings changed');
  }
  const previous = new Map(existing.entries.map((entry) => [entry.scenarioId, entry]));
  expected.entries = expected.entries.map((entry) => {
    const old = previous.get(entry.scenarioId);
    if (!old) return entry;
    const immutable = ['ordinal', 'mapOrdinal', 'scenarioId', 'mapId', 'seed', 'designDigest', 'expectedTopology', 'catalogReservation', 'reviewProvenance', 'evidencePaths'];
    for (const key of immutable) {
      if (canonicalJson(old[key]) !== canonicalJson(entry[key])) {
        throw new Error(`cannot resume: slot ${entry.scenarioId} ${key} changed`);
      }
    }
    return {
      ...entry,
      status: old.status ?? entry.status,
      renderAttempts: old.renderAttempts ?? 0,
      lastAttempt: old.lastAttempt ?? null,
      evidence: old.evidence ?? null,
      review: old.review ?? null,
      countsTowardScenarioCoverage: old.countsTowardScenarioCoverage === true,
      issues: Array.isArray(old.issues) ? old.issues : [],
    };
  });
  expected.summary = summarizeBatchEntries(expected.entries, catalog.maps);
  return expected;
}

function resolveEvidencePath(repositoryRoot, relativeFile, label) {
  const root = path.resolve(repositoryRoot);
  const resolved = path.resolve(root, relativeFile);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the repository root`);
  }
  return resolved;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function digestFile(file) {
  return sha256(await readFile(file));
}

async function verifyArtifact(root, artifact, label) {
  if (typeof artifact?.file !== 'string' || !isSha256(artifact?.sha256)) {
    throw new Error(`${label} is missing a valid file and sha256`);
  }
  const resolved = path.resolve(root, artifact.file);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the render directory`);
  }
  const actual = await digestFile(resolved);
  if (actual !== artifact.sha256) throw new Error(`${label} digest mismatch`);
}

function verifyMachineManifest(entry, manifest) {
  const issues = [];
  if (manifest?.schema !== SCENARIO_EVIDENCE_SCHEMA) issues.push('render manifest schema is invalid');
  if (manifest?.evidenceClass !== 'scenario-instance-incident') issues.push('render is not incident evidence');
  if (manifest?.scenarioId !== entry.scenarioId) issues.push('render scenarioId differs from catalog slot');
  if (manifest?.mapId !== entry.mapId) issues.push('render mapId differs from catalog slot');
  const manifestSlot = manifest?.catalogSlot;
  if (!isSha256(manifestSlot?.attemptSeed)) issues.push('render catalogSlot attemptSeed is missing');
  for (const [key, expected] of Object.entries(entry.catalogReservation)) {
    if (canonicalJson(manifestSlot?.[key]) !== canonicalJson(expected)) {
      issues.push(`render catalogSlot ${key} differs from catalog reservation`);
    }
  }
  if (!isSha256(manifest?.inputHash) || !isSha256(manifest?.traceDigest)) {
    issues.push('render input/trace provenance hashes are missing');
  }
  if (manifest?.topologyDomains?.authoringMatcherTopology?.digest !== entry.expectedTopology.matcherIndexDigest) {
    issues.push('matcher topology digest differs from catalog slot');
  }
  if (manifest?.topologyDomains?.simulationRoadGraph?.digest !== entry.expectedTopology.engineGraphDigest) {
    issues.push('engine graph digest differs from catalog slot');
  }
  const phases = (manifest?.frames ?? []).map((frame) => frame.phase);
  if (phases.length !== REQUIRED_INCIDENT_PHASES.length
    || !phases.every((phase, index) => phase === REQUIRED_INCIDENT_PHASES[index])) {
    issues.push('exact deterministic incident phases are missing');
  }
  if (manifest?.machineAssessment?.verdict !== 'pass') issues.push('machine assessment did not pass');
  const gateMap = new Map((manifest?.machineAssessment?.gates ?? []).map((gate) => [gate.id, gate.status]));
  for (const gate of REQUIRED_MACHINE_GATES) {
    if (gateMap.get(gate) !== 'pass') issues.push(`required machine gate ${gate} did not pass`);
  }
  if (gateMap.size !== REQUIRED_MACHINE_GATES.length
    || (manifest?.machineAssessment?.gates ?? []).length !== REQUIRED_MACHINE_GATES.length) {
    issues.push('machine gate set contains missing, duplicate, or unknown gates');
  }
  if (typeof manifest?.video?.file !== 'string'
    || !manifest.video.file.toLowerCase().endsWith('.mp4')
    || !isSha256(manifest.video.sha256)) {
    issues.push('MP4 evidence is missing');
  }
  return issues;
}

function verifyTraceSelections(manifest, trace) {
  const issues = [];
  let expectedFrames;
  let expectedVideo;
  try {
    expectedFrames = selectIncidentFrames(trace);
    expectedVideo = selectIncidentVideoFrames(trace, manifest?.videoSequence?.fps);
  } catch (error) {
    return [error.message];
  }
  const actualFrames = manifest?.frames ?? [];
  for (let index = 0; index < expectedFrames.length; index += 1) {
    const expected = expectedFrames[index];
    const actual = actualFrames[index];
    if (actual?.phase !== expected.phase
      || actual?.index !== expected.index
      || actual?.requestedT !== expected.targetT
      || actual?.t !== expected.t) {
      issues.push(`frame ${expected.phase} is not the deterministic selected trace tick`);
    }
  }
  const sequence = manifest?.videoSequence;
  if (sequence?.startT !== expectedVideo.startT
    || sequence?.endT !== expectedVideo.endT
    || sequence?.fps !== expectedVideo.fps
    || sequence?.frameCount !== expectedVideo.frames.length) {
    issues.push('video sequence does not match the deterministic trace selection');
  } else if (!Array.isArray(sequence.frames)
    || sequence.frames.length !== expectedVideo.frames.length
    || !sequence.frames.every((frame, index) => (
      frame.index === expectedVideo.frames[index].index
      && frame.requestedT === expectedVideo.frames[index].targetT
      && frame.t === expectedVideo.frames[index].t
    ))) {
    issues.push('video frames do not match the deterministic selected trace ticks');
  }
  if (manifest?.video?.fps !== expectedVideo.fps
    || manifest?.video?.frameCount !== expectedVideo.frames.length
    || manifest?.video?.durationSeconds !== expectedVideo.frames.length / expectedVideo.fps) {
    issues.push('MP4 metadata does not match its deterministic video sequence');
  }
  return issues;
}

function pendingReviewIssues(manifest, review, context) {
  const issues = [];
  const expected = createScenarioReviewTemplate(manifest, review?.manifest?.file ?? 'manifest.json', context);
  if (review?.schema !== SCENARIO_REVIEW_SCHEMA) issues.push('pending review schema is invalid');
  if (review?.manifest?.sha256 !== sha256(Buffer.from(canonicalJson(manifest)))) {
    issues.push('pending review does not bind the exact manifest');
  }
  if (review?.manifest?.scenarioId !== manifest.scenarioId) {
    issues.push('pending review scenarioId differs from manifest');
  }
  if (review?.manifest?.inputHash !== manifest.inputHash
    || review?.manifest?.traceDigest !== manifest.traceDigest
    || canonicalJson(review?.manifest?.catalogSlot ?? null) !== canonicalJson(manifest?.catalogSlot ?? null)) {
    issues.push('pending review identity binding differs from manifest');
  }
  const expectedFrames = manifest.frames.map((frame) => ({
    phase: frame.phase,
    file: frame.artifact.file,
    sha256: frame.artifact.sha256,
  }));
  const actualFrames = review?.inspection?.frames ?? [];
  if (actualFrames.length !== expectedFrames.length || !actualFrames.every((frame, index) => (
    frame.phase === expectedFrames[index].phase
      && frame.file === expectedFrames[index].file
      && frame.sha256 === expectedFrames[index].sha256
      && frame.observedSha256 === null
  ))) {
    issues.push('pending review frame bindings are invalid');
  }
  if (review?.inspection?.video?.file !== manifest.video.file
    || review?.inspection?.video?.sha256 !== manifest.video.sha256
    || review?.inspection?.video?.observedSha256 !== null) {
    issues.push('pending review MP4 binding is invalid');
  }
  if (canonicalJson(review?.sourceEvidence) !== canonicalJson(expected.sourceEvidence)
    || canonicalJson(review?.rendererProvenance) !== canonicalJson(expected.rendererProvenance)
    || review?.requirementsSha256 !== expected.requirementsSha256) {
    issues.push('pending review source, applicability, or renderer provenance binding is stale');
  }
  if (canonicalJson(review?.inspection?.checklist) !== canonicalJson(expected.inspection.checklist)) {
    issues.push('pending review checklist binding is invalid');
  }
  return issues;
}

function parseMaybeGzipJson(bytes, label) {
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  try {
    return JSON.parse(plain.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

/** Re-read all bytes. Ledger state alone is never evidence. */
export async function inspectBatchEntry(entry, repositoryRoot) {
  const instanceFile = resolveEvidencePath(repositoryRoot, entry.evidencePaths.instance, 'instance');
  const traceFile = resolveEvidencePath(repositoryRoot, entry.evidencePaths.trace, 'trace');
  const resultFile = resolveEvidencePath(repositoryRoot, entry.evidencePaths.result, 'result');
  const manifestFile = resolveEvidencePath(repositoryRoot, entry.evidencePaths.renderManifest, 'render manifest');
  const frameFile = resolveEvidencePath(repositoryRoot, entry.evidencePaths.frame, 'primary frame');
  const videoFile = resolveEvidencePath(repositoryRoot, entry.evidencePaths.video, 'video');
  const reviewFile = resolveEvidencePath(repositoryRoot, entry.evidencePaths.visualInspection, 'visual inspection');
  const next = {
    ...entry,
    evidence: null,
    review: null,
    countsTowardScenarioCoverage: false,
    issues: [],
  };
  let inputDigests;
  let instanceBytes;
  let traceBytes;
  let resultBytes;
  try {
    [instanceBytes, traceBytes, resultBytes] = await Promise.all([
      readFile(instanceFile),
      readFile(traceFile),
      readFile(resultFile),
    ]);
    inputDigests = {
      instanceSha256: sha256(instanceBytes),
      traceFileSha256: sha256(traceBytes),
      resultSha256: sha256(resultBytes),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      next.status = 'missing-inputs';
      next.issues = ['instance, trace, and result are all required before rendering'];
      return next;
    }
    throw error;
  }

  let instanceDoc;
  let trace;
  let result;
  try {
    instanceDoc = parseMaybeGzipJson(instanceBytes, 'instance evidence');
    trace = parseMaybeGzipJson(traceBytes, 'trace evidence');
    result = parseMaybeGzipJson(resultBytes, 'result evidence');
  } catch (error) {
    next.status = 'rejected-input';
    next.issues = [error.message];
    return next;
  }
  const closureIssues = [];
  const artifactSlots = [instanceDoc?.catalogSlot, trace?.header?.catalogSlot, result?.catalogSlot];
  if (artifactSlots.some((slot) => canonicalJson(slot ?? null) !== canonicalJson(artifactSlots[0] ?? null))) {
    closureIssues.push('instance, trace, and result catalogSlot provenance differ');
  }
  const actualSlot = artifactSlots[0];
  if (!isSha256(actualSlot?.attemptSeed)) closureIssues.push('catalogSlot attemptSeed is missing');
  for (const [key, expected] of Object.entries(entry.catalogReservation)) {
    if (canonicalJson(actualSlot?.[key]) !== canonicalJson(expected)) {
      closureIssues.push(`catalogSlot ${key} differs from the reserved catalog slot`);
    }
  }
  if (result?.status !== 'ok' || result?.feasible !== true || result?.verdict !== 'accept') {
    closureIssues.push(`result is not hard-eligible: status=${result?.status ?? 'missing'} feasible=${String(result?.feasible)} verdict=${result?.verdict ?? 'missing'}`);
  }
  if (result?.eligibility?.eligible !== true
    || result?.eligibility?.collisionPolicy !== 'reject'
    || !Array.isArray(result?.eligibility?.hardFailureCodes)
    || result.eligibility.hardFailureCodes.length !== 0) {
    closureIssues.push(
      `result is not catalog hard-eligible: eligible=${String(result?.eligibility?.eligible)}`
      + ` collisionPolicy=${result?.eligibility?.collisionPolicy ?? 'missing'}`
      + ` hardFailureCodes=${JSON.stringify(result?.eligibility?.hardFailureCodes ?? null)}`,
    );
  }
  if (result?.artifactHashes?.instanceSha256 !== inputDigests.instanceSha256) {
    closureIssues.push('result artifactHashes.instanceSha256 differs from exact instance bytes');
  }
  if (result?.artifactHashes?.traceSha256 !== inputDigests.traceFileSha256) {
    closureIssues.push('result artifactHashes.traceSha256 differs from exact trace file bytes');
  }
  if (result?.instanceId !== entry.scenarioId) closureIssues.push('result instanceId differs from catalog slot');
  if (result?.inputHash !== instanceDoc?.manifest?.inputHash) closureIssues.push('result inputHash differs from instance');
  if (result?.traceDigest !== sha256(Buffer.from(canonicalJson(trace)))) {
    closureIssues.push('result traceDigest differs from trace canonical bytes');
  }
  let pairEvidence;
  try {
    pairEvidence = validateScenarioPair(instanceDoc, trace, Buffer.from(canonicalJson(trace)), {
      requiredCatalogSlot: actualSlot,
      requiredMapId: entry.mapId,
    });
    validateScenarioResult(instanceDoc, trace, result, Buffer.from(canonicalJson(trace)), {
      instanceFileBytes: instanceBytes,
      traceFileBytes: traceBytes,
    });
  } catch (error) {
    closureIssues.push(error.message);
  }
  if (closureIssues.length > 0) {
    next.status = 'rejected-input';
    next.issues = closureIssues;
    return next;
  }
  // A failed/cancelled attempt must remain explicit even if an older valid
  // bundle is still present at the deterministic output path. Likewise, a
  // process that died while marked rendering is interrupted until retried;
  // only markRenderFinished's zero exit code authorizes reconciliation of the
  // newly written manifest.
  if (entry.status === 'render-failed' || entry.status === 'cancelled') {
    next.status = entry.status;
    next.evidence = inputDigests;
    next.issues = [...(entry.issues ?? [])];
    return next;
  }
  if (entry.status === 'rendering' && entry.lastAttempt?.exitCode !== 0) {
    next.status = 'interrupted';
    next.evidence = inputDigests;
    next.issues = ['render attempt did not record successful completion'];
    return next;
  }
  let manifest;
  try {
    manifest = await readOptionalJson(manifestFile);
  } catch (error) {
    next.status = 'invalid-evidence';
    next.issues = [`render manifest is unreadable: ${error.message}`];
    return next;
  }
  if (manifest === null) {
    next.status = entry.status === 'rendering' ? 'interrupted'
      : entry.status === 'render-failed' || entry.status === 'cancelled' ? entry.status
        : 'ready-to-render';
    next.evidence = inputDigests;
    next.issues = next.status === 'render-failed' || next.status === 'cancelled'
      ? [...(entry.issues ?? [])]
      : [];
    return next;
  }

  const renderRoot = path.dirname(manifestFile);
  const issues = verifyMachineManifest(entry, manifest);
  if (canonicalJson(manifest?.catalogSlot ?? null) !== canonicalJson(actualSlot ?? null)) {
    issues.push('render manifest catalogSlot differs from instance/trace/result');
  }
  if (manifest?.inputHash !== pairEvidence.inputHash) issues.push('render inputHash differs from recomputed instance inputHash');
  if (manifest?.traceDigest !== pairEvidence.traceDigest) issues.push('render traceDigest differs from recomputed semantic trace digest');
  issues.push(...verifyTraceSelections(manifest, trace));
  const reservedPrimaryFrame = path.relative(renderRoot, frameFile);
  const reservedVideo = path.relative(renderRoot, videoFile);
  const conflictFrame = (manifest?.frames ?? []).find((frame) => frame.phase === 'conflict');
  if (conflictFrame?.artifact?.file !== reservedPrimaryFrame) {
    issues.push('conflict frame does not occupy the catalog-reserved primary frame path');
  }
  if (manifest?.video?.file !== reservedVideo) {
    issues.push('MP4 does not occupy the catalog-reserved video path');
  }
  try {
    await Promise.all([
      ...(manifest.frames ?? []).map((frame) => verifyArtifact(renderRoot, frame.artifact, `frame ${frame.phase}`)),
      verifyArtifact(renderRoot, manifest.video, 'video'),
      ...Object.entries(manifest.artifacts ?? {}).map(([name, artifact]) => verifyArtifact(renderRoot, artifact, `source ${name}`)),
    ]);
  } catch (error) {
    issues.push(error.message);
  }
  if (manifest?.artifacts?.instance?.sha256 !== inputDigests.instanceSha256) {
    issues.push('render source instance digest differs from current instance');
  }
  if (manifest?.artifacts?.traceFile?.sha256 !== inputDigests.traceFileSha256) {
    issues.push('render source trace digest differs from current trace file');
  }
  if (manifest?.artifacts?.result?.sha256 !== inputDigests.resultSha256) {
    issues.push('render source result digest differs from current result');
  }
  const manifestSha256 = sha256(Buffer.from(canonicalJson(manifest)));
  next.evidence = {
    ...inputDigests,
    manifestSha256,
    inputHash: manifest.inputHash ?? null,
    traceDigest: manifest.traceDigest ?? null,
    frames: (manifest.frames ?? []).map((frame) => ({
      phase: frame.phase,
      file: frame.artifact?.file ?? null,
      sha256: frame.artifact?.sha256 ?? null,
    })),
    video: manifest.video ?? null,
    machineVerdict: manifest.machineAssessment?.verdict ?? null,
  };
  if (issues.length > 0) {
    next.status = 'invalid-evidence';
    next.issues = issues;
    return next;
  }

  let reviewContext;
  try {
    reviewContext = {
      instanceDoc,
      trace,
      ...inputDigests,
      rendererSources: entry.reviewProvenance,
    };
  } catch (error) {
    next.status = 'invalid-evidence';
    next.issues = [error.message];
    return next;
  }

  let review;
  try {
    review = await readOptionalJson(reviewFile);
  } catch (error) {
    next.status = 'invalid-review';
    next.issues = [`visual inspection is unreadable: ${error.message}`];
    return next;
  }
  if (review === null) {
    next.status = 'rendered-pending-review';
    return next;
  }
  if (review?.inspection?.verdict === null) {
    const pendingIssues = pendingReviewIssues(manifest, review, reviewContext);
    if (pendingIssues.length > 0) {
      next.status = 'invalid-review';
      next.issues = pendingIssues;
      return next;
    }
    next.status = 'rendered-pending-review';
    next.review = {
      schema: review.schema,
      manifestSha256: review.manifest.sha256,
      scenarioId: review.manifest.scenarioId,
      catalogSlot: review.manifest.catalogSlot ?? null,
      inputHash: review.manifest.inputHash,
      traceDigest: review.manifest.traceDigest,
      reviewer: review.inspection.reviewer ?? null,
      completedAt: review.inspection.completedAt ?? null,
      verdict: null,
    };
    return next;
  }
  const decision = adjudicateScenarioReview(manifest, review, reviewContext);
  next.review = {
    schema: review?.schema ?? null,
    manifestSha256: review?.manifest?.sha256 ?? null,
    scenarioId: review?.manifest?.scenarioId ?? null,
    catalogSlot: review?.manifest?.catalogSlot ?? null,
    inputHash: review?.manifest?.inputHash ?? null,
    traceDigest: review?.manifest?.traceDigest ?? null,
    reviewer: review?.inspection?.reviewer ?? null,
    completedAt: review?.inspection?.completedAt ?? null,
    verdict: review?.inspection?.verdict ?? null,
  };
  if (decision.status === 'invalid') {
    next.status = 'invalid-review';
    next.issues = decision.reasons;
    return next;
  }
  next.status = decision.status;
  next.countsTowardScenarioCoverage = decision.countsTowardScenarioCoverage;
  return next;
}

export async function reconcileBatchLedger(ledger, catalog, repositoryRoot) {
  const entries = [];
  for (const entry of ledger.entries) entries.push(await inspectBatchEntry(entry, repositoryRoot));
  const acceptedByEvidence = new Map();
  for (const entry of entries.filter((candidate) => candidate.countsTowardScenarioCoverage)) {
    const key = `${entry.evidence?.inputHash ?? ''}:${entry.evidence?.traceDigest ?? ''}`;
    const group = acceptedByEvidence.get(key) ?? [];
    group.push(entry);
    acceptedByEvidence.set(key, group);
  }
  for (const duplicates of acceptedByEvidence.values()) {
    if (duplicates.length < 2) continue;
    for (const duplicate of duplicates) {
      duplicate.status = 'invalid-evidence';
      duplicate.countsTowardScenarioCoverage = false;
      duplicate.issues = [
        `instance/trace evidence is also claimed by: ${duplicates
          .filter((candidate) => candidate.scenarioId !== duplicate.scenarioId)
          .map((candidate) => candidate.scenarioId)
          .sort()
          .join(', ')}`,
      ];
    }
  }
  return {
    ...ledger,
    entries,
    summary: summarizeBatchEntries(entries, catalog.maps),
  };
}

export function summarizeBatchEntries(entries, maps) {
  const summarize = (selected, expected) => {
    const count = (status) => selected.filter((entry) => entry.status === status).length;
    const accepted = selected.filter((entry) => entry.countsTowardScenarioCoverage === true).length;
    return {
      expected,
      inspected: selected.filter((entry) => entry.status !== 'uninspected').length,
      missingInputs: count('missing-inputs'),
      readyToRender: count('ready-to-render') + count('interrupted') + count('cancelled')
        + count('render-failed') + count('invalid-evidence'),
      interrupted: count('interrupted'),
      cancelled: count('cancelled'),
      renderFailed: count('render-failed'),
      rejectedInputs: count('rejected-input'),
      rendering: count('rendering'),
      rendered: selected.filter((entry) => TERMINAL_RENDER_STATUSES.has(entry.status)).length,
      pendingReview: count('rendered-pending-review'),
      accepted,
      rejected: count('rejected'),
      invalidEvidence: count('invalid-evidence'),
      invalidReview: count('invalid-review'),
      uninspected: count('uninspected'),
      remainingToAccept: expected - accepted,
      complete: accepted === expected,
    };
  };
  const byMap = Object.fromEntries(maps.map((map) => [
    map.mapId,
    summarize(entries.filter((entry) => entry.mapId === map.mapId), map.slots),
  ]));
  return {
    ...summarize(entries, maps.reduce((sum, map) => sum + map.slots, 0)),
    byMap,
  };
}

export function renderCandidates(ledger, limit = Infinity) {
  return ledger.entries
    .filter((entry) => RESUMABLE_RENDER_STATUSES.has(entry.status))
    .sort((left, right) => left.ordinal - right.ordinal || left.scenarioId.localeCompare(right.scenarioId))
    .slice(0, limit);
}

export function markRenderStarted(entry, at) {
  return {
    ...entry,
    status: 'rendering',
    renderAttempts: (entry.renderAttempts ?? 0) + 1,
    lastAttempt: { startedAt: at, finishedAt: null, exitCode: null, error: null },
    countsTowardScenarioCoverage: false,
    issues: [],
  };
}

export function markRenderFailed(entry, at, exitCode, error) {
  return {
    ...entry,
    status: 'render-failed',
    lastAttempt: {
      ...(entry.lastAttempt ?? {}),
      finishedAt: at,
      exitCode,
      error: String(error ?? 'renderer failed').slice(0, 2000),
    },
    countsTowardScenarioCoverage: false,
    issues: [String(error ?? 'renderer failed').slice(0, 2000)],
  };
}

export function markRenderCancelled(entry, at, reason = 'render batch cancelled') {
  return {
    ...entry,
    status: 'cancelled',
    lastAttempt: {
      ...(entry.lastAttempt ?? {}),
      finishedAt: at,
      exitCode: 130,
      error: reason,
    },
    countsTowardScenarioCoverage: false,
    issues: [reason],
  };
}

export function markRenderFinished(entry, at) {
  return {
    ...entry,
    lastAttempt: {
      ...(entry.lastAttempt ?? {}),
      finishedAt: at,
      exitCode: 0,
      error: null,
    },
  };
}

export function batchProgressExitCode(summary) {
  return summary.invalidEvidence > 0 || summary.invalidReview > 0 ? 2 : 0;
}
