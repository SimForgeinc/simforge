/**
 * The build orchestrator — the seven-step recipe from
 * `docs/research/location-catalog.md`, plus the derived topology.
 *
 * Order matters and is not arbitrary:
 *
 * ```
 * sources → context (frame, elevation, guid↔rsl, road names)
 *   1. adopt search index                → drafts, source-id table
 *   2. segments (geometric chaining)     → corridor units
 *   3. junction descriptors + conflicts  → needs crosswalk drafts from (1)
 *   4. junction facts back onto (1)      → arm_count, derived_control, ...
 *   5. densify                           → movements need (3), midblock needs (2)
 *   6. handles (whole-map uniqueness)    → needs every draft to exist
 *   7. relations                         → needs handles-independent ids only
 *   8. fact index + declared-fact audit
 * ```
 *
 * Everything is a pure function of the loaded sources: no wall clock reaches an
 * id, no `Map` iteration order reaches an output array, and every fan-out is
 * sorted. That is what makes "rebuild ⇒ identical ids" testable rather than
 * hopeful.
 */

import { asLocationId, type LocationId } from '../types/ids.js';
import type {
  CatalogStats,
  LocationCatalog,
  StudioLocation,
  AnchorQuality,
} from '../types/location.js';
import type { DerivedTopology, DerivedTopologyStats } from '../types/topology.js';
import { adoptSearchIndex } from './adopt.js';
import { anchorFacts, liftAnchor } from './anchor-lift.js';
import { createBuildContext, type BuildContext } from './context.js';
import { densifyBuildingEntrances } from './densify/building-entrances.js';
import { densifyJunctionMovements } from './densify/junction-movements.js';
import { densifyMidblockSegments } from './densify/midblock-segments.js';
import { densifyParkingSpaces } from './densify/parking-spaces.js';
import { densifySchoolZones } from './densify/school-zones.js';
import { densifyWorkZones } from './densify/work-zones.js';
import type { LocationDraft } from './draft.js';
import { assertDeclaredFactsProduced, type FactKeyAudit } from './facts.js';
import { buildFactIndex } from './fact-index.js';
import { assignHandles } from './handles.js';
import { makeLocationIdString, revisionOf } from './hash.js';
import { buildJunctionDescriptors, junctionLocationId } from './junctions.js';
import { buildRelations } from './relations.js';
import { buildSegments } from './segments.js';
import { slugify } from './slug.js';
import { loadMapSources, type MapSources } from './sources.js';
import { compareStrings } from './compare.js';

/** Schema version of `locations.json`. */
export const CATALOG_VERSION = 1;

/** Schema version of `topology-derived.json`. */
export const DERIVED_VERSION = 1;

/** Everything one build produces. */
export interface MapIntelBuild {
  catalog: LocationCatalog;
  derived: DerivedTopology;
  audit: FactKeyAudit;
  /** Search-index kinds we did not adopt, for visibility. */
  skippedKinds: Record<string, number>;
  /** Drafts dropped because another derivation already claimed their id. */
  duplicateIds: number;
}

/** Build from a map directory. */
export async function buildMapIntelFromDir(dir: string): Promise<MapIntelBuild> {
  return buildMapIntel(await loadMapSources(dir));
}

/** Build from already-loaded sources (the fixture path in tests). */
export function buildMapIntel(sources: MapSources): MapIntelBuild {
  const ctx = createBuildContext(sources);
  const mapId = sources.mapId as string;

  // 1 — adopt.
  const adoption = adoptSearchIndex(ctx);
  const drafts: LocationDraft[] = [...adoption.drafts];

  // 2 — segments.
  const segments = buildSegments(ctx);

  // 3 — junction descriptors (crosswalk drafts feed `crossingLocationIds`).
  const crosswalkDrafts = drafts.filter((d) => d.type === 'crosswalk');
  const descriptors = buildJunctionDescriptors(ctx, crosswalkDrafts);

  // 4 — fold descriptor facts back onto the junction records, and synthesise
  //     junctions the search index never described.
  applyJunctionFacts(ctx, drafts, descriptors);

  // 5 — densify.
  drafts.push(...densifyJunctionMovements(ctx, descriptors));
  drafts.push(...densifyMidblockSegments(ctx, segments));
  drafts.push(...densifyParkingSpaces(ctx));
  drafts.push(...densifySchoolZones(ctx));
  drafts.push(...densifyWorkZones(ctx, segments));
  drafts.push(...densifyBuildingEntrances(ctx));

  // Deterministic order for everything downstream; ids are content-derived, so
  // sorting by id is a stable, input-order-independent canonical order.
  drafts.sort((a, b) => compareStrings(a.id as string, b.id as string));

  const unique: LocationDraft[] = [];
  const seenIds = new Set<string>();
  let duplicateIds = 0;
  for (const draft of drafts) {
    if (seenIds.has(draft.id as string)) {
      duplicateIds += 1;
      continue;
    }
    seenIds.add(draft.id as string);
    unique.push(draft);
  }

  // 6 — handles.
  const handleAssignment = assignHandles(ctx, unique);

  const locations: StudioLocation[] = unique.map((draft) => {
    const handle = handleAssignment.handles.get(draft.id as string);
    if (!handle) throw new Error(`map-intel[${mapId}]: no handle assigned for ${draft.id}`);
    return {
      id: draft.id,
      handle,
      name: draft.name,
      type: draft.type,
      ...(draft.subtype ? { subtype: draft.subtype } : {}),
      tags: draft.tags,
      anchor: draft.anchor,
      ...(draft.extent ? { extent: draft.extent } : {}),
      affordances: draft.affordances,
      facts: sortFacts(draft.facts),
      provenance: draft.provenance,
      quality: draft.quality,
    };
  });

  // 7 — relations.
  const relations = buildRelations(ctx, unique, adoption.idBySourceObject, descriptors);

  // 8 — index + audit.
  const factIndex = buildFactIndex(locations, segments, descriptors);
  const audit = assertDeclaredFactsProduced(mapId, locations);

  const catalogRevision = revisionOf(sources.sourceHashes);
  const builtAt = new Date(0).toISOString(); // fixed: build time must not reach the artifact

  const catalog: LocationCatalog = {
    catalogVersion: CATALOG_VERSION,
    catalogRevision,
    mapId: sources.mapId,
    mapAssetId: sources.mapAssetId,
    sourceHashes: Object.fromEntries(Object.entries(sources.sourceHashes).sort()),
    builtAt,
    locations,
    relations,
    stats: catalogStats(locations, relations, handleAssignment.ladderUsage, handleAssignment.collisionsResolved),
  };

  const derived: DerivedTopology = {
    derivedVersion: DERIVED_VERSION,
    catalogRevision,
    mapId: sources.mapId,
    mapAssetId: sources.mapAssetId,
    topologyDigest: sources.sourceHashes['topology-index'] ?? '',
    builtAt,
    segments,
    junctions: descriptors,
    factIndex,
    stats: derivedStats(segments, descriptors),
  };

  return { catalog, derived, audit, skippedKinds: adoption.skippedKinds, duplicateIds };
}

/** Fold junction-descriptor facts into the junction records; synthesise missing ones. */
function applyJunctionFacts(
  ctx: BuildContext,
  drafts: LocationDraft[],
  descriptors: readonly ReturnType<typeof buildJunctionDescriptors>[number][],
): void {
  const mapId = ctx.sources.mapId as string;
  const byId = new Map(drafts.map((d) => [d.id as string, d]));

  for (const descriptor of descriptors) {
    const id = descriptor.locationId as string;
    let draft = byId.get(id);
    if (!draft) {
      // A junction the search index did not describe. It still exists in the
      // road network, so it still has to be addressable.
      const centre = { x: descriptor.centerXY[0], y: descriptor.centerXY[1] };
      const lift = liftAnchor(ctx, centre, {
        onlyRsls: new Set(descriptor.internalLaneRefs.map((r) => r as string)),
        maxDistanceM: 300,
        forceQuality: 'exact',
      });
      const roadNames = [...new Set(descriptor.arms.map((a) => a.roadName).filter(Boolean))].sort();
      const identityKey = `junction:${descriptor.junctionId}`;
      draft = {
        id: asLocationId(makeLocationIdString(mapId, 'junction', identityKey)),
        name: roadNames.length >= 2 ? `${roadNames[0]} @ ${roadNames[1]}` : `${roadNames[0] ?? 'Unnamed'} junction`,
        type: 'junction',
        tags: ['JUNCTION'],
        anchor: lift.anchor,
        affordances: ['conflictPoint', 'route', 'vehicleSpawn'],
        facts: { ...anchorFacts(lift.anchor) },
        provenance: [
          { source: 'topology-index', ref: descriptor.junctionId as string, confidence: 1 },
        ],
        quality: { anchor: lift.quality, confidence: 0.9 },
        naming: {
          stems:
            roadNames.length >= 2
              ? [slugify(`${roadNames[0]}-at-${roadNames[1]}`)]
              : [slugify(roadNames[0] ?? 'junction')],
          roadNames,
        },
        identityKey,
      };
      drafts.push(draft);
      byId.set(id, draft);
    }

    const hasOpposing = descriptor.conflictPairs.some((p) => p.relation === 'opposing');
    Object.assign(draft.facts, {
      arm_count: descriptor.armCount,
      derived_control: descriptor.control,
      conflict_pair_count: descriptor.conflictPairs.length,
      has_opposing_conflict: hasOpposing,
      junction_size_m: descriptor.sizeM,
      internal_lane_count: descriptor.internalLaneRefs.length,
      approach_lane_count: descriptor.approaches.length,
    });
    const derivedTags = new Set(draft.tags);
    derivedTags.add(`CONTROL_${descriptor.control.toUpperCase()}`);
    derivedTags.add(`ARMS_${descriptor.armCount}`);
    if (descriptor.conflictPairs.some((p) => p.turnA === 'Left' || p.turnB === 'Left')) {
      derivedTags.add('LEFT_TURN_CONFLICT');
    }
    draft.tags = [...derivedTags].sort();
  }
}

function sortFacts(facts: Record<string, unknown>): Record<string, never> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(facts).sort()) out[key] = facts[key];
  return out as Record<string, never>;
}

function catalogStats(
  locations: readonly StudioLocation[],
  relations: readonly { from: LocationId }[],
  ladderUsage: Record<string, number>,
  collisionsResolved: number,
): CatalogStats {
  const byType: Record<string, number> = {};
  const anchorQuality: Record<AnchorQuality, number> = {
    exact: 0,
    projected: 0,
    inferred: 0,
    unanchored: 0,
  };
  for (const loc of locations) {
    byType[loc.type] = (byType[loc.type] ?? 0) + 1;
    anchorQuality[loc.quality.anchor] += 1;
  }
  return {
    locationCount: locations.length,
    byType: Object.fromEntries(Object.entries(byType).sort()),
    anchorQuality,
    relationCount: relations.length,
    handleCollisionsResolved: collisionsResolved,
    handleLadderUsage: Object.fromEntries(Object.entries(ladderUsage).sort()),
  };
}

function derivedStats(
  segments: readonly { lengthM: number }[],
  descriptors: readonly ReturnType<typeof buildJunctionDescriptors>[number][],
): DerivedTopologyStats {
  const conflictPairsByRelation: Record<string, number> = {};
  const junctionsByControl: Record<string, number> = {};
  let conflictPairCount = 0;
  for (const d of descriptors) {
    junctionsByControl[d.control] = (junctionsByControl[d.control] ?? 0) + 1;
    for (const pair of d.conflictPairs) {
      conflictPairCount += 1;
      conflictPairsByRelation[pair.relation] = (conflictPairsByRelation[pair.relation] ?? 0) + 1;
    }
  }
  return {
    segmentCount: segments.length,
    junctionCount: descriptors.length,
    conflictPairCount,
    conflictPairsByRelation: Object.fromEntries(Object.entries(conflictPairsByRelation).sort()),
    junctionsByControl: Object.fromEntries(Object.entries(junctionsByControl).sort()),
    totalSegmentLengthM: Math.round(segments.reduce((a, s) => a + s.lengthM, 0)),
  };
}

export { junctionLocationId };
