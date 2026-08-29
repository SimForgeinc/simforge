import { createHash } from 'node:crypto';

import {
  REQUIRED_INCIDENT_PHASES,
  SCENARIO_EVIDENCE_SCHEMA,
  canonicalJson,
} from './export-render-lib.mjs';

export const SCENARIO_REVIEW_SCHEMA = 'simforge-oss.scenario-visual-review.v2';
export const SCENARIO_REVIEW_LEDGER_SCHEMA = 'simforge-oss.scenario-visual-review-ledger.v2';

/** Files whose bytes determine what a reviewer actually sees. */
export const SCENARIO_REVIEW_PROVENANCE_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'scripts/export-render.mjs',
  'scripts/export-render-lib.mjs',
  'scripts/render-scenario-batch.mjs',
  'scripts/review-scenario-evidence.mjs',
  'scripts/scenario-review-ledger-lib.mjs',
  'scripts/scenario-render-batch-lib.mjs',
  'packages/viewer/src/camera-controls.ts',
  'packages/viewer/src/environment.ts',
  'packages/viewer/src/frame-stats.ts',
  'packages/viewer/src/gltf.ts',
  'packages/viewer/src/ground-index.ts',
  'packages/viewer/src/index.ts',
  'packages/viewer/src/manifest.ts',
  'packages/viewer/src/materials.ts',
  'packages/viewer/src/shadow-atlas.ts',
  'packages/viewer/src/streaming.ts',
  'packages/viewer/src/types.ts',
  'packages/viewer/src/vegetation.ts',
  'packages/viewer/src/viewer.ts',
  'packages/asset-catalog/src/catalog.ts',
  'packages/asset-catalog/src/composites.ts',
  'packages/asset-catalog/src/geometry.ts',
  'packages/asset-catalog/src/index.ts',
  'packages/asset-catalog/src/materials.ts',
  'packages/asset-catalog/src/registry.ts',
  'packages/asset-catalog/src/schema.ts',
  'packages/asset-catalog/src/types.ts',
  'packages/asset-catalog/src/builders/construction.ts',
  'packages/asset-catalog/src/builders/hazards.ts',
  'packages/asset-catalog/src/builders/pedestrians.ts',
  'packages/asset-catalog/src/builders/street.ts',
  'packages/asset-catalog/src/builders/vehicles.ts',
];

export const SCENARIO_REVIEW_CRITERIA = [
  'semantic-actor-fidelity',
  'visible-static-props-and-occlusion',
  'articulated-actions-and-doors',
  'four-distinct-phases',
  'camera-suitability',
  'motion-continuity',
  'stable-aftermath',
];

function sha256Json(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function exactPhaseFrames(manifest) {
  const frames = manifest?.frames ?? [];
  return frames.length === REQUIRED_INCIDENT_PHASES.length
    && frames.every((frame, index) => frame.phase === REQUIRED_INCIDENT_PHASES[index]);
}

function normalizedRendererSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .map((source) => ({ file: source?.file, sha256: source?.sha256 }))
    .filter((source) => typeof source.file === 'string' && source.file.length > 0 && isSha256(source.sha256))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function sourceBinding(manifest, context, key) {
  const declared = manifest?.artifacts?.[key];
  const override = key === 'instance' ? context?.instanceSha256
    : key === 'traceFile' ? context?.traceFileSha256
      : context?.resultSha256;
  return {
    file: declared?.file ?? null,
    sha256: override ?? declared?.sha256 ?? null,
  };
}

function semanticFacts(manifest, context = {}) {
  const input = context.instanceDoc?.input;
  const trace = context.trace;
  const manifestModels = Array.isArray(manifest?.actors?.models) ? manifest.actors.models : [];
  const actors = Array.isArray(input?.actors) ? input.actors : manifestModels;
  const actorFacts = actors.map((actor) => ({
    id: actor?.id ?? null,
    kind: actor?.kind ?? null,
    static: actor?.static === true,
    catalogId: (actor?.tags ?? []).find?.((tag) => typeof tag === 'string' && tag.startsWith('catalog:'))?.slice(8)
      ?? actor?.catalogId
      ?? null,
  })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const staticActorIds = actorFacts.filter((actor) => actor.static).map((actor) => actor.id);
  const occluders = Array.isArray(input?.occluders) ? input.occluders : [];
  const occlusionPairs = Array.isArray(input?.occlusionPairs) ? input.occlusionPairs : [];
  const interactions = Array.isArray(input?.interactions) ? input.interactions : [];
  const articulatedInteractions = interactions.filter((interaction) => interaction?.verb === 'set'
    && /^(doors|pose)\./.test(interaction?.target?.key ?? ''))
    .map((interaction) => ({
      id: interaction.id,
      actorId: interaction.actorId,
      key: interaction.target.key,
    }));
  const articulatedEvents = (trace?.events ?? []).filter((event) => event?.kind === 'state_set'
    && /^(doors|pose)\./.test(event?.key ?? ''))
    .map((event) => ({ actorId: event.actorId, key: event.key, t: event.t }));
  return {
    actors: actorFacts,
    staticActorIds,
    occluderIds: occluders.map((occluder) => occluder?.id ?? null),
    occlusionPairs: occlusionPairs.map((pair) => ({
      observer: pair?.observer ?? null,
      target: pair?.target ?? null,
      occluderId: pair?.occluderId ?? null,
    })),
    articulatedInteractions,
    articulatedEvents,
    semanticInputsAvailable: Boolean(input && trace),
  };
}

function checklistContract(manifest, context = {}) {
  const facts = semanticFacts(manifest, context);
  const frames = (manifest?.frames ?? []).map((frame) => ({
    phase: frame?.phase ?? null,
    t: frame?.t ?? null,
    sha256: frame?.artifact?.sha256 ?? null,
  }));
  const aftermath = (manifest?.frames ?? []).find((frame) => frame?.phase === 'aftermath');
  const staticApplicable = facts.staticActorIds.length > 0
    || facts.occluderIds.length > 0
    || facts.occlusionPairs.length > 0;
  const articulationApplicable = facts.articulatedInteractions.length > 0 || facts.articulatedEvents.length > 0;
  const definitions = [
    {
      id: 'semantic-actor-fidelity',
      applicable: true,
      prompt: 'Every actor has the intended semantic model, scale, role, pose, and orientation.',
      basis: { actors: facts.actors },
    },
    {
      id: 'visible-static-props-and-occlusion',
      applicable: staticApplicable,
      prompt: 'Required static actors or props are visible and the authored occlusion/reveal relationship reads correctly.',
      basis: {
        staticActorIds: facts.staticActorIds,
        occluderIds: facts.occluderIds,
        occlusionPairs: facts.occlusionPairs,
      },
    },
    {
      id: 'articulated-actions-and-doors',
      applicable: articulationApplicable,
      prompt: 'Authored articulated actions and door state changes are visible at the correct time and on the correct actor.',
      basis: {
        interactions: facts.articulatedInteractions,
        observedTraceEvents: facts.articulatedEvents,
      },
    },
    {
      id: 'four-distinct-phases',
      applicable: true,
      prompt: 'Pre-event, reveal, conflict, and aftermath are visually distinct and occur in that order.',
      basis: { frames },
    },
    {
      id: 'camera-suitability',
      applicable: true,
      prompt: 'The incident, relevant actors, static context, and occlusion relationship remain readable without obstructive framing.',
      basis: {
        viewport: manifest?.viewport ?? null,
        cameras: (manifest?.frames ?? []).map((frame) => ({ phase: frame?.phase, camera: frame?.camera ?? null })),
      },
    },
    {
      id: 'motion-continuity',
      applicable: true,
      prompt: 'The exact reviewed video has continuous, plausible motion with no jumps, teleports, frozen actors, or camera discontinuities.',
      basis: {
        video: manifest?.video ?? null,
        videoSequence: manifest?.videoSequence ? {
          startT: manifest.videoSequence.startT,
          endT: manifest.videoSequence.endT,
          frameCount: manifest.videoSequence.frameCount,
        } : null,
      },
    },
    {
      id: 'stable-aftermath',
      applicable: true,
      prompt: 'The aftermath is stable: incident participants remain legible and no actor, prop, or articulated state visibly snaps or disappears.',
      basis: {
        phase: aftermath?.phase ?? null,
        t: aftermath?.t ?? null,
        poses: aftermath?.poses ?? null,
      },
    },
  ];
  return definitions.map((criterion) => ({
    id: criterion.id,
    required: true,
    applicable: criterion.applicable,
    prompt: criterion.prompt,
    basisSha256: sha256Json(criterion.basis),
  }));
}

function reviewContract(manifest, context = {}) {
  const instance = sourceBinding(manifest, context, 'instance');
  const traceFile = sourceBinding(manifest, context, 'traceFile');
  const result = sourceBinding(manifest, context, 'result');
  const rendererSources = normalizedRendererSources(context.rendererSources);
  const checklist = checklistContract(manifest, context);
  const binding = {
    manifestSha256: sha256Json(manifest),
    catalogSlot: manifest?.catalogSlot ?? null,
    inputHash: manifest?.inputHash ?? null,
    traceDigest: manifest?.traceDigest ?? null,
    instance,
    traceFile,
    result,
    rendererSources,
    checklist: checklist.map(({ prompt: _prompt, ...criterion }) => criterion),
  };
  return {
    instance,
    traceFile,
    result,
    rendererSources,
    rendererSourcesSha256: sha256Json(rendererSources),
    checklist,
    requirementsSha256: sha256Json(binding),
  };
}

/**
 * Keep map-orbit, stress, editor, and renderer-smoke artifacts outside the
 * scenario review namespace even when they happen to contain actors.
 */
export function classifyVisualArtifact(manifest) {
  const reasons = [];
  if (manifest?.schema !== SCENARIO_EVIDENCE_SCHEMA) {
    reasons.push(`schema ${manifest?.schema ?? 'missing'} is not ${SCENARIO_EVIDENCE_SCHEMA}`);
  }
  if (manifest?.evidenceClass !== 'scenario-instance-incident') {
    reasons.push(`evidenceClass ${manifest?.evidenceClass ?? 'missing'} is not scenario-instance-incident`);
  }
  const hasOrbitCapture = manifest?.renderer?.cameraMode === 'orbit'
    || manifest?.cameraMode === 'orbit'
    || (manifest?.frames ?? []).some((frame) => frame?.cameraMode === 'orbit');
  if (hasOrbitCapture) reasons.push('orbit captures are renderer diagnostics, not scenario evidence');
  const purpose = `${manifest?.purpose ?? ''} ${manifest?.kind ?? ''}`.toLowerCase();
  if (purpose.includes('stress') || purpose.includes('smoke')) {
    reasons.push('stress/smoke captures are diagnostics, not scenario evidence');
  }
  if (typeof manifest?.scenarioId !== 'string' || manifest.scenarioId.length === 0) reasons.push('scenarioId is missing');
  if (!exactPhaseFrames(manifest)) reasons.push('exact pre-event/reveal/conflict/aftermath frames are missing');
  if (typeof manifest?.video?.file !== 'string'
    || !manifest.video.file.toLowerCase().endsWith('.mp4')
    || !isSha256(manifest?.video?.sha256)) {
    reasons.push('an MP4 artifact and digest are required');
  }
  if (manifest?.machineAssessment?.verdict !== 'pass') reasons.push('machine assessment did not pass');
  return {
    kind: reasons.length === 0 ? 'scenario-review-candidate' : 'diagnostic-only',
    eligibleForHumanScenarioReview: reasons.length === 0,
    reasons,
  };
}

export function createScenarioReviewTemplate(manifest, manifestFile = 'manifest.json', context = {}) {
  const classification = classifyVisualArtifact(manifest);
  const contract = reviewContract(manifest, context);
  return {
    schema: SCENARIO_REVIEW_SCHEMA,
    manifest: {
      file: manifestFile,
      sha256: sha256Json(manifest),
      scenarioId: manifest?.scenarioId ?? null,
      inputHash: manifest?.inputHash ?? null,
      traceDigest: manifest?.traceDigest ?? null,
      catalogSlot: manifest?.catalogSlot ?? null,
    },
    sourceEvidence: {
      instance: contract.instance,
      traceFile: contract.traceFile,
      result: contract.result,
    },
    rendererProvenance: {
      sources: contract.rendererSources,
      sha256: contract.rendererSourcesSha256,
    },
    requirementsSha256: contract.requirementsSha256,
    classification,
    inspection: {
      reviewer: null,
      completedAt: null,
      verdict: null,
      environment: {
        application: 'SimForge Studio',
        surface: 'browser',
        studioUrl: null,
        sessionId: null,
      },
      notes: [],
      frames: (manifest?.frames ?? []).map((frame) => ({
        phase: frame.phase,
        file: frame.artifact?.file ?? null,
        sha256: frame.artifact?.sha256 ?? null,
        observedSha256: null,
      })),
      video: {
        file: manifest?.video?.file ?? null,
        sha256: manifest?.video?.sha256 ?? null,
        observedSha256: null,
      },
      checklist: contract.checklist.map((criterion) => ({ ...criterion, status: 'unchecked' })),
    },
    decision: {
      status: 'pending',
      countsTowardScenarioCoverage: false,
      reasons: classification.reasons,
    },
  };
}

function exactReviewedArtifacts(manifest, review) {
  const expectedFrames = manifest.frames.map((frame) => ({
    phase: frame.phase,
    file: frame.artifact.file,
    sha256: frame.artifact.sha256,
  }));
  const actualFrames = review?.inspection?.frames ?? [];
  const framesMatch = actualFrames.length === expectedFrames.length
    && actualFrames.every((frame, index) => frame.phase === expectedFrames[index].phase
      && frame.file === expectedFrames[index].file
      && frame.sha256 === expectedFrames[index].sha256
      && frame.observedSha256 === expectedFrames[index].sha256);
  const expectedVideo = manifest.video;
  const actualVideo = review?.inspection?.video;
  const videoMatches = actualVideo?.file === expectedVideo.file
    && actualVideo.sha256 === expectedVideo.sha256
    && actualVideo.observedSha256 === expectedVideo.sha256;
  return { framesMatch, videoMatches };
}

function inspectChecklist(contract, review) {
  const actual = review?.inspection?.checklist ?? [];
  if (actual.length !== contract.checklist.length) {
    return { valid: false, failed: [], reason: 'review checklist does not contain the exact required criteria' };
  }
  const failed = [];
  for (let index = 0; index < contract.checklist.length; index += 1) {
    const expected = contract.checklist[index];
    const criterion = actual[index];
    if (criterion?.id !== expected.id
      || criterion?.required !== expected.required
      || criterion?.applicable !== expected.applicable
      || criterion?.prompt !== expected.prompt
      || criterion?.basisSha256 !== expected.basisSha256
      || !['unchecked', 'pass', 'fail'].includes(criterion?.status)) {
      return { valid: false, failed: [], reason: `review checklist binding differs at ${expected.id}` };
    }
    if (expected.required && expected.applicable && criterion.status !== 'pass') failed.push(expected.id);
  }
  return { valid: true, failed, reason: null };
}

export function adjudicateScenarioReview(manifest, review, context = {}) {
  const reasons = [];
  const classification = classifyVisualArtifact(manifest);
  const contract = reviewContract(manifest, context);
  if (!classification.eligibleForHumanScenarioReview) reasons.push(...classification.reasons);
  if (review?.schema !== SCENARIO_REVIEW_SCHEMA) reasons.push('review schema is invalid or stale');
  if (review?.manifest?.sha256 !== sha256Json(manifest)) reasons.push('review does not bind the exact manifest');
  if (review?.manifest?.scenarioId !== manifest?.scenarioId) reasons.push('review scenarioId differs from manifest');
  if (review?.manifest?.inputHash !== manifest?.inputHash) reasons.push('review inputHash differs from manifest');
  if (review?.manifest?.traceDigest !== manifest?.traceDigest) reasons.push('review traceDigest differs from manifest');
  if (canonicalJson(review?.manifest?.catalogSlot ?? null) !== canonicalJson(manifest?.catalogSlot ?? null)) {
    reasons.push('review catalogSlot differs from manifest');
  }
  if (!isSha256(contract.instance.sha256) || !isSha256(contract.traceFile.sha256)) {
    reasons.push('exact instance and trace file digests are required');
  }
  if (manifest?.catalogSlot && !isSha256(contract.result.sha256)) {
    reasons.push('exact result digest is required for catalog evidence');
  }
  if (!context?.instanceDoc?.input || !context?.trace) {
    reasons.push('parsed instance and trace semantics are required to derive checklist applicability');
  }
  if (contract.instance.sha256 !== manifest?.artifacts?.instance?.sha256
    || contract.traceFile.sha256 !== manifest?.artifacts?.traceFile?.sha256
    || (manifest?.catalogSlot && contract.result.sha256 !== manifest?.artifacts?.result?.sha256)) {
    reasons.push('instance/trace/result context differs from the hash-closed render manifest');
  }
  if (canonicalJson(review?.sourceEvidence) !== canonicalJson({
    instance: contract.instance,
    traceFile: contract.traceFile,
    result: contract.result,
  })) reasons.push('review does not bind the exact instance and trace artifacts');
  const missingRendererSources = SCENARIO_REVIEW_PROVENANCE_FILES.filter(
    (file) => !contract.rendererSources.some((source) => source.file === file),
  );
  if (missingRendererSources.length > 0) {
    reasons.push(`renderer/Studio source provenance is incomplete: ${missingRendererSources.join(', ')}`);
  }
  if (review?.rendererProvenance?.sha256 !== contract.rendererSourcesSha256
    || canonicalJson(review?.rendererProvenance?.sources) !== canonicalJson(contract.rendererSources)) {
    reasons.push('review renderer/Studio source provenance is missing or stale');
  }
  if (review?.requirementsSha256 !== contract.requirementsSha256) {
    reasons.push('review checklist applicability is not bound to the exact manifest/instance/trace');
  }
  if (typeof review?.inspection?.reviewer !== 'string' || review.inspection.reviewer.trim().length === 0) {
    reasons.push('reviewer is required');
  }
  if (typeof review?.inspection?.completedAt !== 'string'
    || !Number.isFinite(Date.parse(review.inspection.completedAt))) {
    reasons.push('completedAt must be an ISO timestamp');
  }
  if (!['accepted', 'rejected'].includes(review?.inspection?.verdict)) {
    reasons.push('review verdict must be accepted or rejected');
  }
  const environment = review?.inspection?.environment;
  if (environment?.application !== 'SimForge Studio' || environment?.surface !== 'browser') {
    reasons.push('review must be performed in the SimForge Studio browser surface');
  }
  if (typeof environment?.studioUrl !== 'string' || !/^https?:\/\//.test(environment.studioUrl)) {
    reasons.push('review must record the inspected Studio URL');
  }
  if (typeof environment?.sessionId !== 'string' || environment.sessionId.trim().length === 0) {
    reasons.push('review must record a browser inspection session id');
  }
  const artifacts = exactReviewedArtifacts(manifest, review);
  if (!artifacts.framesMatch) reasons.push('all four exact observed key-frame digests are required');
  if (!artifacts.videoMatches) reasons.push('the exact observed MP4 digest is required');
  const checklist = inspectChecklist(contract, review);
  if (!checklist.valid) reasons.push(checklist.reason);
  if (reasons.length > 0) return { status: 'invalid', countsTowardScenarioCoverage: false, reasons };
  const accepted = review.inspection.verdict === 'accepted' && checklist.failed.length === 0;
  return {
    status: accepted ? 'accepted' : 'rejected',
    countsTowardScenarioCoverage: accepted,
    reasons: checklist.failed.map((id) => `required criterion ${id} did not pass`),
  };
}

export function upsertScenarioReview(ledger, manifest, review, context = {}) {
  const decision = adjudicateScenarioReview(manifest, review, context);
  if (decision.status === 'invalid') {
    throw new Error(`invalid scenario visual review: ${decision.reasons.join('; ')}`);
  }
  const base = ledger ?? {
    schema: SCENARIO_REVIEW_LEDGER_SCHEMA,
    rendererProvenance: review.rendererProvenance,
    entries: [],
  };
  if (base.schema !== SCENARIO_REVIEW_LEDGER_SCHEMA || !Array.isArray(base.entries)) {
    throw new Error('invalid scenario visual review ledger');
  }
  if (canonicalJson(base.rendererProvenance) !== canonicalJson(review.rendererProvenance)) {
    throw new Error('cannot reuse scenario visual review ledger after renderer/Studio source provenance changed');
  }
  const entry = {
    scenarioId: manifest.scenarioId,
    mapId: manifest.mapId,
    inputHash: manifest.inputHash,
    traceDigest: manifest.traceDigest,
    catalogSlot: manifest.catalogSlot ?? null,
    renderManifestSha256: sha256Json(manifest),
    sourceEvidence: review.sourceEvidence,
    rendererProvenance: review.rendererProvenance,
    requirementsSha256: review.requirementsSha256,
    reviewer: review.inspection.reviewer,
    completedAt: review.inspection.completedAt,
    environment: review.inspection.environment,
    verdict: decision.status,
    notes: review.inspection.notes ?? [],
    checklist: review.inspection.checklist,
    frameArtifacts: review.inspection.frames.map(({ observedSha256: _observedSha256, ...frame }) => frame),
    videoArtifact: {
      file: review.inspection.video.file,
      sha256: review.inspection.video.sha256,
    },
    countsTowardScenarioCoverage: decision.countsTowardScenarioCoverage,
  };
  const entries = base.entries.filter((item) => item.scenarioId !== manifest.scenarioId);
  if (entry.countsTowardScenarioCoverage && entries.some(
    (item) => item.countsTowardScenarioCoverage
      && item.inputHash === entry.inputHash
      && item.traceDigest === entry.traceDigest,
  )) {
    throw new Error('the same instance/trace evidence is already counted under another scenarioId');
  }
  entries.push(entry);
  entries.sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
  const mapIds = [...new Set(entries.map((item) => item.mapId))].sort();
  return {
    schema: SCENARIO_REVIEW_LEDGER_SCHEMA,
    rendererProvenance: review.rendererProvenance,
    entries,
    summary: {
      reviewed: entries.length,
      accepted: entries.filter((item) => item.countsTowardScenarioCoverage).length,
      rejected: entries.filter((item) => item.verdict === 'rejected').length,
      byMap: Object.fromEntries(mapIds.map((mapId) => {
        const mapEntries = entries.filter((item) => item.mapId === mapId);
        return [mapId, {
          reviewed: mapEntries.length,
          accepted: mapEntries.filter((item) => item.countsTowardScenarioCoverage).length,
          rejected: mapEntries.filter((item) => item.verdict === 'rejected').length,
        }];
      })),
    },
  };
}
