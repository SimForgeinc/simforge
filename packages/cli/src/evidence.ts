/**
 * Evidence integrity checks.
 *
 * A batch result is only admissible evidence when the concrete instance and the
 * trace were produced from the same `SimScenarioInput`. The join key is the
 * engine input hash: `sha256(canonicalJson(input))` in the instance manifest
 * must match `trace.header.inputHash`. If it does not, the trace metrics prove a
 * different scenario and the cell must not be accepted or promoted.
 */

import { contentHash, resolvePhysicsConfig, type MotionPhysicsMode, type SimTrace } from '@simforge-oss/engine';

import type { InstanceFile } from '@simforge-oss/compiler/node';

export interface EvidenceHashIssue {
  readonly code:
    | 'instance_input_hash_mismatch'
    | 'trace_input_hash_mismatch'
    | 'instance_map_id_mismatch'
    | 'trace_map_id_mismatch'
    | 'instance_actor_ids_mismatch'
    | 'trace_actor_ids_mismatch'
    | 'trace_actor_tracks_mismatch'
    | 'matcher_index_digest_missing'
    | 'engine_graph_digest_missing'
    | 'trace_engine_graph_digest_mismatch'
    | 'trace_topology_alias_mismatch'
    | 'catalog_provenance_mismatch'
    | 'catalog_provenance_invalid'
    | 'operational_conditions_mismatch'
    | 'physics_mode_mismatch';
  readonly reason: string;
  readonly expected: string;
  readonly actual: string | null;
}

export interface EvidenceHashReport {
  readonly ok: boolean;
  readonly recomputedInputHash: string;
  readonly manifestInputHash: string | null;
  readonly traceInputHash: string | null;
  readonly inputActorIds: string[];
  readonly traceActorIds: string[];
  readonly traceTrackActorIds: string[];
  readonly actorIds: string[];
  readonly actorCount: number;
  readonly inputMapId: string;
  readonly manifestMapId: string | null;
  readonly traceMapId: string | null;
  readonly matcherIndexDigest: string | null;
  readonly manifestEngineGraphDigest: string | null;
  readonly traceEngineGraphDigest: string | null;
  /** Present when a trace was available; legacy failure reports may omit it. */
  readonly physicsMode?: MotionPhysicsMode | null;
  /** `legacy-kinematic` is replayed as recorded and is never relabeled. */
  readonly physicsProvenance?: 'matched' | 'legacy-kinematic' | 'mismatch';
  readonly issues: EvidenceHashIssue[];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sortedUniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').sort();
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameCanonicalContent(a: unknown, b: unknown): boolean {
  return contentHash(a) === contentHash(b);
}

/** 0.3.0 is the controlled migration where omitted physics became dynamic-v1. */
function isPreDynamicDefaultTrace(trace: SimTrace): boolean {
  if ((trace.header?.traceVersion ?? 1) < 2) return true;
  const version = trace.header?.physics?.solverVersion ?? trace.header?.engineVersion;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major === 0 && minor < 3;
}

export function verifyEvidenceHashes(instance: InstanceFile, trace: SimTrace): EvidenceHashReport {
  const recomputedInputHash = contentHash(instance.input);
  const manifestInputHash = instance.manifest?.inputHash ?? null;
  const traceInputHash = trace.header?.inputHash ?? null;
  const inputActorIds = [...instance.input.actors.map((a) => a.id)].sort();
  const manifest = instance.manifest as unknown as Record<string, unknown> | undefined;
  const replayKey = manifest?.['replayKey'] as Record<string, unknown> | undefined;
  const manifestActors = manifest?.['actors'] as Array<Record<string, unknown>> | undefined;
  const manifestActorIds = sortedUniqueStrings(manifestActors?.map((actor) => actor['id']));
  const actorIds = sortedUniqueStrings(trace.header?.actorIds);
  const traceTrackActorIds = Object.keys(trace.ticks?.actors ?? {}).sort();
  const inputMapId = instance.input.mapId;
  const manifestMapId = stringOrNull(replayKey?.['mapId']);
  const traceMapId = stringOrNull(trace.header?.mapId);
  const matcherIndexDigest = stringOrNull(replayKey?.['matcherIndexDigest']);
  const manifestEngineGraphDigest = stringOrNull(replayKey?.['engineGraphDigest']);
  const traceEngineGraphDigest = stringOrNull(trace.header?.engineGraphDigest);
  const traceTopologyAlias = stringOrNull(trace.header?.topologyDigest);
  const instanceCatalogSlot = instance.catalogSlot;
  const traceCatalogSlot = trace.header?.catalogSlot;
  const operationalVariant = manifest?.['operationalVariant'] as Record<string, unknown> | null | undefined;
  const manifestConcreteConditions = operationalVariant?.['concrete'];
  const inputOperationalConditions = instance.input.operationalConditions;
  const traceOperationalConditions = trace.header?.operationalConditions;
  const expectedPhysicsMode = resolvePhysicsConfig(instance.input).mode;
  // Trace v1 predates the field and had one possible meaning: kinematic-v1.
  const physicsMode: MotionPhysicsMode | null = trace.header?.physics?.mode
    ?? ((trace.header?.traceVersion ?? 1) < 2 ? 'kinematic-v1' : null);
  const legacyKinematic = instance.input.physics === undefined
    && physicsMode === 'kinematic-v1'
    && isPreDynamicDefaultTrace(trace);
  const physicsProvenance: EvidenceHashReport['physicsProvenance'] = legacyKinematic
    ? 'legacy-kinematic'
    : physicsMode === expectedPhysicsMode ? 'matched' : 'mismatch';
  const issues: EvidenceHashIssue[] = [];

  if (physicsProvenance === 'mismatch') {
    issues.push({
      code: 'physics_mode_mismatch',
      reason: 'trace physics mode must match the input selection/current default, except immutable pre-0.3 omitted-input traces which remain recorded kinematic evidence',
      expected: expectedPhysicsMode,
      actual: physicsMode,
    });
  }

  if (manifestInputHash !== recomputedInputHash) {
    issues.push({
      code: 'instance_input_hash_mismatch',
      reason: 'instance manifest inputHash does not match sha256(canonicalJson(instance.input))',
      expected: recomputedInputHash,
      actual: manifestInputHash,
    });
  }
  if (traceInputHash !== recomputedInputHash) {
    issues.push({
      code: 'trace_input_hash_mismatch',
      reason: 'trace header inputHash does not match sha256(canonicalJson(instance.input))',
      expected: recomputedInputHash,
      actual: traceInputHash,
    });
  }

  if (manifestMapId !== inputMapId) {
    issues.push({
      code: 'instance_map_id_mismatch',
      reason: 'instance manifest replayKey.mapId must exactly match instance input.mapId',
      expected: inputMapId,
      actual: manifestMapId,
    });
  }
  if (traceMapId !== inputMapId) {
    issues.push({
      code: 'trace_map_id_mismatch',
      reason: 'trace header mapId must exactly match instance input.mapId',
      expected: inputMapId,
      actual: traceMapId,
    });
  }
  if (!sameStrings(manifestActorIds, inputActorIds)) {
    issues.push({
      code: 'instance_actor_ids_mismatch',
      reason: 'instance manifest actor ids must exactly match sorted instance input actor ids',
      expected: inputActorIds.join(','),
      actual: manifestActorIds.join(','),
    });
  }
  if (!sameStrings(actorIds, inputActorIds)) {
    issues.push({
      code: 'trace_actor_ids_mismatch',
      reason: 'trace header actorIds must exactly match sorted instance input actor ids',
      expected: inputActorIds.join(','),
      actual: actorIds.join(','),
    });
  }
  if (!sameStrings(traceTrackActorIds, inputActorIds)) {
    issues.push({
      code: 'trace_actor_tracks_mismatch',
      reason: 'trace tick actor tracks must exactly match sorted instance input actor ids',
      expected: inputActorIds.join(','),
      actual: traceTrackActorIds.join(','),
    });
  }

  // Matcher/map-intel and engine topology are separate provenance domains.
  // Only the engine digest may be joined to a trace; the matcher digest proves
  // site selection and must be present independently rather than substituted.
  if (matcherIndexDigest === null) {
    issues.push({
      code: 'matcher_index_digest_missing',
      reason: 'instance replay key must declare matcherIndexDigest separately from engine topology',
      expected: 'non-empty matcher/map-intel digest',
      actual: null,
    });
  }
  if (manifestEngineGraphDigest === null) {
    issues.push({
      code: 'engine_graph_digest_missing',
      reason: 'instance replay key must declare the engineGraphDigest used for simulation',
      expected: 'non-empty engine graph digest',
      actual: null,
    });
  }
  if (traceEngineGraphDigest !== manifestEngineGraphDigest) {
    issues.push({
      code: 'trace_engine_graph_digest_mismatch',
      reason: 'trace engineGraphDigest must match the instance replay key engineGraphDigest',
      expected: manifestEngineGraphDigest ?? '',
      actual: traceEngineGraphDigest,
    });
  }
  if (traceTopologyAlias !== traceEngineGraphDigest) {
    issues.push({
      code: 'trace_topology_alias_mismatch',
      reason: 'deprecated trace topologyDigest must remain an exact alias of engineGraphDigest',
      expected: traceEngineGraphDigest ?? '',
      actual: traceTopologyAlias,
    });
  }
  if (JSON.stringify(traceCatalogSlot) !== JSON.stringify(instanceCatalogSlot)) {
    issues.push({
      code: 'catalog_provenance_mismatch',
      reason: 'trace header catalogSlot must exactly match the instance catalogSlot closure',
      expected: JSON.stringify(instanceCatalogSlot ?? null),
      actual: JSON.stringify(traceCatalogSlot ?? null) ?? null,
    });
  }
  if (instanceCatalogSlot !== undefined) {
    const invalidCatalogClosure =
      instanceCatalogSlot.mapId !== inputMapId ||
      instanceCatalogSlot.selectedMatcherSiteId !== stringOrNull(replayKey?.['siteId']) ||
      instanceCatalogSlot.attemptSeed !== stringOrNull(replayKey?.['paramSeed']) ||
      instanceCatalogSlot.templateId !== stringOrNull(replayKey?.['templateId']) ||
      instanceCatalogSlot.provenance.matcherIndexDigest !== matcherIndexDigest ||
      instanceCatalogSlot.provenance.engineGraphDigest !== manifestEngineGraphDigest ||
      instanceCatalogSlot.selectedLocationId.length === 0 ||
      instanceCatalogSlot.variant.id.length === 0 ||
      instanceCatalogSlot.identity.length === 0 ||
      !/^[0-9a-f]{64}$/.test(instanceCatalogSlot.seed) ||
      !/^[0-9a-f]{64}$/.test(instanceCatalogSlot.attemptSeed) ||
      !/^[0-9a-f]{64}$/.test(instanceCatalogSlot.designDigest);
    if (invalidCatalogClosure) {
      issues.push({
        code: 'catalog_provenance_invalid',
        reason: 'catalog closure must agree with the concrete replay key, map, selected matcher site, template, and deterministic seeds',
        expected: JSON.stringify({
          mapId: inputMapId,
          siteId: stringOrNull(replayKey?.['siteId']),
          paramSeed: stringOrNull(replayKey?.['paramSeed']),
          templateId: stringOrNull(replayKey?.['templateId']),
          matcherIndexDigest,
          engineGraphDigest: manifestEngineGraphDigest,
        }),
        actual: JSON.stringify(instanceCatalogSlot),
      });
    }
    const { concrete: _concrete, ...manifestVariant } = operationalVariant ?? {};
    const conditionsClose =
      sameCanonicalContent(manifestVariant, instanceCatalogSlot.variant) &&
      sameCanonicalContent(manifestConcreteConditions, inputOperationalConditions) &&
      sameCanonicalContent(traceOperationalConditions, inputOperationalConditions);
    if (!conditionsClose) {
      issues.push({
        code: 'operational_conditions_mismatch',
        reason: 'catalog variant source fields and applied concrete conditions must close exactly through manifest, input, and trace',
        expected: JSON.stringify({ variant: instanceCatalogSlot.variant, concrete: inputOperationalConditions }),
        actual: JSON.stringify({ manifest: operationalVariant ?? null, trace: traceOperationalConditions ?? null }),
      });
    }
  } else if (!sameCanonicalContent(traceOperationalConditions, inputOperationalConditions)) {
    issues.push({
      code: 'operational_conditions_mismatch',
      reason: 'trace operational conditions must exactly match the hash-covered input conditions',
      expected: JSON.stringify(inputOperationalConditions),
      actual: JSON.stringify(traceOperationalConditions ?? null),
    });
  }

  return {
    ok: issues.length === 0,
    recomputedInputHash,
    manifestInputHash,
    traceInputHash,
    inputActorIds,
    traceActorIds: actorIds,
    traceTrackActorIds,
    actorIds,
    actorCount: actorIds.length,
    inputMapId,
    manifestMapId,
    traceMapId,
    matcherIndexDigest,
    manifestEngineGraphDigest,
    traceEngineGraphDigest,
    physicsMode,
    physicsProvenance,
    issues,
  };
}
