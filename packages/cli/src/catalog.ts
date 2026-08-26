/**
 * Deterministic, map-grounded authoring catalog for SimForge.
 *
 * A slot is not a claim that a scenario has been simulated or visually
 * accepted. `authored` means that the incident mechanism, actors, event
 * sequence, real map site, operational variant, provenance, and acceptance
 * contract exist. Evidence states advance only when their artifacts exist.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  matchAnchorReport,
  normalizeDerivedMapIndex,
  type DerivedMapIndex,
  type MatchedSite,
} from '@simforge/compiler/node';
import type { ScenarioTemplateV2 } from '@simforge/scenario';

import {
  CATALOG_RESEARCH_SOURCES,
  INCIDENT_DOMAINS,
  INCIDENT_TAXONOMY,
  OPERATIONAL_VARIANTS,
  type IncidentDefinition,
} from './catalog-taxonomy.js';
import { CliError, EXIT } from './errors.js';
import { DEV_ASSETS, KNOWN_MAPS, REPO_ROOT, loadMap } from '@simforge/compiler/node';
import { adaptTemplate } from './adapt.js';
import { materialize, templateId as canonicalTemplateId } from './materialize.js';
import { assertMatchableAnchor, catalogExactMatcherPolicy } from '@simforge/compiler/node';
import { readTemplate } from '@simforge/compiler/node';

export const CATALOG_KIND = 'uniscenarios-scenario-catalog' as const;
export const CATALOG_VERSION = 2 as const;
export const CATALOG_GENERATOR_VERSION = '2.0.0' as const;
export const CATALOG_SLOTS_PER_MAP = 100 as const;
export const CATALOG_MIN_INCIDENT_TYPES_PER_MAP = 3 as const;
export const DEFAULT_CATALOG_NAMESPACE = 'simforge-active-maps-v3' as const;

/** Existing executable templates are implementation provenance, not the taxonomy. */
export const CATALOG_TEMPLATE_SOURCES = [
  { id: 'ltap-opposing', source: 'examples/ltap-opposing.template.json' },
  { id: 'cpnco-parked-row', source: 'examples/cpnco-parked-row.template.json' },
  { id: 'multiple-threat', source: 'examples/multiple-threat.template.json' },
  { id: 'bus-stop-emergence', source: 'examples/bus-stop-emergence.template.json' },
  { id: 'school-dartout', source: 'examples/school-dartout.template.json' },
  { id: 'intersection.cross-traffic-stop-violation', source: 'examples/mechanisms/remaining/cross-traffic-stop-violation.template.json' },
  { id: 'intersection.red-light-late-entry', source: 'examples/mechanisms/remaining/red-light-late-entry.template.json' },
  { id: 'intersection.right-turn-crosswalk', source: 'examples/mechanisms/junction-vru/right-turn-crosswalk.template.json' },
  { id: 'intersection.left-turn-crosswalk', source: 'examples/mechanisms/junction-vru/left-turn-crosswalk.template.json' },
  { id: 'intersection.opposing-turn-encroachment', source: 'examples/mechanisms/remaining/opposing-turn-encroachment.template.json' },
  { id: 'intersection-blocked-box-reveal', source: 'examples/mechanisms/junction-vru/intersection-blocked-box-reveal.template.json' },
  { id: 'vru.adult-midblock-crossing', source: 'examples/mechanisms/junction-vru/adult-midblock-crossing.template.json' },
  { id: 'vru.reversing-pedestrian', source: 'examples/mechanisms/remaining/reversing-pedestrian.template.json' },
  { id: 'vru.cyclist-right-hook', source: 'examples/mechanisms/remaining/cyclist-right-hook.template.json' },
  { id: 'vru.cyclist-crossing-path', source: 'examples/mechanisms/junction-vru/cyclist-crossing-path.template.json' },
  { id: 'vru.dooring-cyclist', source: 'examples/mechanisms/remaining/dooring-cyclist.template.json' },
  { id: 'longitudinal.lead-hard-brake', source: 'examples/mechanisms/corridor/lead-hard-brake.template.json' },
  { id: 'longitudinal.queue-tail', source: 'examples/mechanisms/corridor/queue-tail.template.json' },
  { id: 'longitudinal.cutout-reveals-stopped', source: 'examples/mechanisms/corridor/cutout-reveals-stopped.template.json' },
  { id: 'longitudinal.cut-in-brake', source: 'examples/mechanisms/corridor/cut-in-brake.template.json' },
  { id: 'longitudinal.slow-vulnerable-lead', source: 'examples/mechanisms/remaining/slow-vulnerable-lead.template.json' },
  { id: 'lane-change.sideswipe', source: 'examples/mechanisms/corridor/sideswipe.template.json' },
  { id: 'lane-change.merge-gap-collapse', source: 'examples/mechanisms/corridor/merge-gap-collapse.template.json' },
  { id: 'lane-change.lane-drop-late-merge', source: 'examples/mechanisms/remaining/lane-drop-late-merge.template.json' },
  { id: 'lane-change.oncoming-overtake', source: 'examples/mechanisms/remaining/oncoming-overtake.template.json' },
  { id: 'parking.vehicle-pulls-out', source: 'examples/mechanisms/parking-transit/vehicle-pulls-out.template.json' },
  { id: 'parking.backing-out-vehicle', source: 'examples/mechanisms/parking-transit/backing-out-vehicle.template.json' },
  { id: 'parking.delivery-double-park', source: 'examples/mechanisms/parking-transit/delivery-double-park.template.json' },
  { id: 'parking.driveway-emergence', source: 'examples/mechanisms/parking-transit/driveway-emergence.template.json' },
  { id: 'transit.bus-pullout', source: 'examples/mechanisms/parking-transit/bus-pullout.template.json' },
  { id: 'school.crossing-guard-release', source: 'examples/mechanisms/school-workzone/crossing-guard-release.template.json' },
  { id: 'workzone.lane-shift', source: 'examples/mechanisms/school-workzone/lane-shift.template.json' },
  { id: 'workzone.worker-intrusion', source: 'examples/mechanisms/school-workzone/worker-intrusion.template.json' },
  { id: 'road-departure.curve-loss-control', source: 'examples/mechanisms/obstacle/curve-loss-control.template.json' },
  { id: 'obstacle.fallen-cargo', source: 'examples/mechanisms/obstacle/fallen-cargo.template.json' },
  { id: 'obstacle.animal-crossing', source: 'examples/mechanisms/obstacle/animal-crossing.template.json' },
  { id: 'obstacle.disabled-vehicle', source: 'examples/mechanisms/obstacle/disabled-vehicle.template.json' },
] as const;

export type CatalogSlotStatus =
  | 'authored'
  | 'generated'
  | 'simulated'
  | 'rendered'
  | 'visually-accepted'
  | 'rejected';

export interface CatalogEvidencePaths {
  readonly instance: string;
  readonly trace: string;
  readonly result: string;
  readonly renderManifest: string;
  readonly frame: string;
  readonly video: string;
  readonly visualInspection: string;
}

export interface CatalogTemplateProvenance {
  /** Taxonomy/registry key used to locate the implementation template. */
  readonly id: string;
  /** Canonical replay-key identity derived by the materializer. */
  readonly runtimeTemplateId: string;
  readonly source: string;
  readonly digest: string;
}

export interface CatalogMapProvenance {
  readonly mapId: string;
  readonly mapAssetId: string;
  readonly catalogRevision: string;
  /** Digest of the matcher/map-intel derived index domain. */
  readonly matcherIndexDigest: string;
  /** Independently computed digest of the engine topology graph domain. */
  readonly engineGraphDigest: string;
  readonly locationCatalogDigest: string;
  readonly slots: number;
}

export interface CatalogSiteBinding {
  readonly locationId: string;
  readonly handle: string;
  readonly name: string;
  readonly type: string;
  readonly tags: readonly string[];
  readonly affordances: readonly string[];
  readonly anchorQuality: string;
  readonly confidence: number;
  readonly roadAnchor: {
    readonly rsl: string;
    readonly s: number;
    readonly offsetM: number;
    readonly headingRad: number;
  };
  readonly sourceDigest: string;
}

export interface CatalogAcceptanceCheck {
  readonly id: 'schema' | 'site-grounding' | 'determinism' | 'kinematics' | 'render-integrity' | 'visual-realism';
  readonly kind: 'automated' | 'manual';
  readonly criterion: string;
  readonly state: 'pending' | 'passed' | 'failed';
  readonly evidenceKey: keyof CatalogEvidencePaths | 'catalog';
}

export interface ScenarioCatalogSlot {
  readonly identity: string;
  readonly ordinal: number;
  readonly seed: string;
  readonly mapId: string;
  readonly status: CatalogSlotStatus;
  readonly provenance: {
    readonly namespace: string;
    readonly generatorVersion: string;
    readonly mapCatalogRevision: string;
    readonly matcherIndexDigest: string;
    readonly engineGraphDigest: string;
    readonly locationCatalogDigest: string;
    readonly taxonomyDigest: string;
    readonly templateDigest?: string;
  };
  readonly scenario: {
    readonly incidentId: string;
    readonly title: string;
    readonly domain: string;
    readonly summary: string;
    readonly sourceIds: readonly string[];
  };
  readonly site: CatalogSiteBinding;
  readonly variant: {
    readonly id: string;
    readonly title: string;
    readonly weather: string;
    readonly timeOfDay: string;
    readonly traffic: string;
    readonly visibility: string;
  };
  readonly brief: {
    readonly actors: IncidentDefinition['actors'];
    readonly eventSequence: readonly string[];
    readonly criticality: readonly string[];
    readonly acceptanceCriteria: readonly string[];
  };
  readonly implementation: {
    readonly state: 'authored-design' | 'template-backed';
    readonly templateId?: string;
    readonly templateSource?: string;
    /** Matcher site persisted only after exact catalog-location binding exists. */
    readonly matcherSiteId?: string;
    /** Must equal `site.locationId`; closes the catalog-location/matcher join. */
    readonly matchedLocationId?: string;
    /** Must equal `variant.id` once that operational condition is truly applied. */
    readonly materializedVariantId?: string;
  };
  readonly acceptance: {
    readonly state: 'pending' | 'accepted' | 'rejected';
    readonly checks: readonly CatalogAcceptanceCheck[];
    readonly reviewer: null | { readonly id: string; readonly reviewedAt: string };
  };
  readonly evidencePaths: CatalogEvidencePaths;
  readonly designDigest: string;
}

export interface CatalogProgressCounts {
  readonly target: number;
  readonly planned: number;
  readonly authored: number;
  readonly generated: number;
  readonly simulated: number;
  readonly rendered: number;
  readonly visuallyAccepted: number;
  readonly rejected: number;
}

export interface ScenarioCatalogManifest {
  readonly kind: typeof CATALOG_KIND;
  readonly version: typeof CATALOG_VERSION;
  readonly contract: {
    readonly supportedMaps: readonly string[];
    readonly slotsPerMap: number;
    readonly totalSlots: number;
    readonly minimumIncidentTypesPerMap: number;
    readonly minimumDomainsPerMap: number;
  };
  readonly provenance: {
    readonly generator: '@simforge/cli catalog create';
    readonly generatorVersion: string;
    readonly namespace: string;
    readonly taxonomyDigest: string;
  };
  readonly evidenceRoot: string;
  readonly maps: readonly CatalogMapProvenance[];
  readonly researchSources: typeof CATALOG_RESEARCH_SOURCES;
  readonly taxonomy: typeof INCIDENT_TAXONOMY;
  readonly templates: readonly CatalogTemplateProvenance[];
  readonly slots: readonly ScenarioCatalogSlot[];
  readonly progress: CatalogProgressCounts;
  readonly catalogDigest: string;
}

export interface CatalogIssue {
  readonly code:
    | 'invalid_catalog'
    | 'wrong_map_inventory'
    | 'wrong_slot_count'
    | 'insufficient_taxonomy_breadth'
    | 'duplicate_identity'
    | 'duplicate_seed'
    | 'invalid_identity'
    | 'invalid_seed'
    | 'invalid_provenance'
    | 'invalid_site_binding'
    | 'invalid_acceptance_manifest'
    | 'invalid_evidence_path'
    | 'missing_evidence'
    | 'invalid_progress_counts'
    | 'catalog_digest_mismatch';
  readonly path: string;
  readonly reason: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface CatalogValidationReport {
  readonly ok: boolean;
  readonly kind: 'simforge-catalog-validation';
  readonly version: 2;
  readonly catalogDigest: string | null;
  readonly slots: number;
  readonly maps: Record<string, number>;
  readonly statuses: Record<string, number>;
  readonly incidentTypesByMap: Record<string, number>;
  readonly domainsByMap: Record<string, number>;
  readonly progress: CatalogProgressCounts;
  readonly evidenceChecked: boolean;
  readonly issues: readonly CatalogIssue[];
}

export interface CreateCatalogOptions {
  readonly repoRoot?: string;
  readonly devAssets?: string;
  readonly namespace?: string;
  /** Relative to the catalog file unless verification supplies an override. */
  readonly evidenceRoot?: string;
}

interface RawRoadAnchor {
  readonly rsl?: unknown;
  readonly s?: unknown;
  readonly offsetM?: unknown;
  readonly headingRad?: unknown;
  readonly junctionId?: unknown;
}

interface RawLocation {
  readonly id?: unknown;
  readonly handle?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly tags?: unknown;
  readonly affordances?: unknown;
  readonly anchor?: {
    readonly road?: RawRoadAnchor | null;
    readonly scene?: { readonly x?: unknown; readonly z?: unknown } | null;
  };
  readonly quality?: { readonly anchor?: unknown; readonly confidence?: unknown };
}

interface RawLocationCatalog {
  readonly mapId?: unknown;
  readonly mapAssetId?: unknown;
  readonly catalogRevision?: unknown;
  readonly locations?: unknown;
}

interface DerivedProvenance {
  readonly mapId?: unknown;
  readonly mapAssetId?: unknown;
  readonly catalogRevision?: unknown;
}

interface MapContext {
  readonly provenance: CatalogMapProvenance;
  readonly locations: readonly RawLocation[];
  readonly matcherIndex: DerivedMapIndex;
}

interface ExecutableTemplate {
  readonly provenance: CatalogTemplateProvenance;
  readonly template: ScenarioTemplateV2;
}

interface CatalogLocationSitePair {
  readonly location: RawLocation;
  readonly matcherSiteId?: string;
  readonly matchedLocationId?: string;
  readonly matcherSite?: MatchedSite;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function unzip(bytes: Buffer): Buffer {
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}

function digestPayload(manifest: Omit<ScenarioCatalogManifest, 'catalogDigest'>): string {
  return sha256(JSON.stringify(manifest));
}

/** Immutable authored-coordinate digest. Lifecycle/review state is excluded. */
export function catalogDesignDigest(
  slot: Omit<ScenarioCatalogSlot, 'designDigest'> | ScenarioCatalogSlot,
): string {
  const {
    designDigest: _digest,
    status: _status,
    acceptance: _acceptance,
    ...authored
  } = slot as ScenarioCatalogSlot;
  return sha256(JSON.stringify(authored));
}

function stableLocationDigest(location: RawLocation): string {
  return sha256(JSON.stringify({
    id: location.id,
    handle: location.handle,
    type: location.type,
    tags: location.tags,
    affordances: location.affordances,
    anchor: location.anchor,
    quality: location.quality,
  }));
}

function taxonomyDigest(): string {
  return sha256(JSON.stringify({ sources: CATALOG_RESEARCH_SOURCES, incidents: INCIDENT_TAXONOMY, variants: OPERATIONAL_VARIANTS }));
}

const CANDIDATE_MATERIALIZATION_FINDINGS = new Set([
  'arrival_conflict_unclosed',
  'arrival_unconverged',
  'map_control_missing',
  'movement_priority_missing',
  'movement_stop_missing',
  'no_actors',
  'reference_route_unbuildable',
  'role_unbound',
  'route_turn_mismatch',
  'route_turn_unbindable',
  'route_unbuildable',
  'signal_unbindable',
]);

function catalogSeed(
  namespace: string,
  map: CatalogMapProvenance,
  ordinal: number,
  incident: IncidentDefinition,
  site: CatalogSiteBinding,
  variantId: string,
  taxonomyHash: string,
): string {
  return sha256([
    CATALOG_GENERATOR_VERSION,
    namespace,
    map.mapId,
    map.catalogRevision,
    map.matcherIndexDigest,
    map.engineGraphDigest,
    map.locationCatalogDigest,
    String(ordinal),
    incident.id,
    site.locationId,
    site.sourceDigest,
    variantId,
    taxonomyHash,
  ].join('\0'));
}

function catalogIdentity(mapId: string, ordinal: number, incidentId: string, seed: string): string {
  const mechanism = incidentId.split('.').at(-1)?.replace(/[^a-z0-9]+/g, '-') ?? 'scenario';
  return `${mapId}-${String(ordinal + 1).padStart(3, '0')}-${mechanism}-${seed.slice(0, 12)}`;
}

function evidencePaths(evidenceRoot: string, mapId: string, identity: string): CatalogEvidencePaths {
  const base = path.posix.join(evidenceRoot, mapId, identity);
  return {
    instance: `${base}/instance.json`,
    trace: `${base}/trace.json.gz`,
    result: `${base}/result.json`,
    renderManifest: `${base}/render/manifest.json`,
    frame: `${base}/render/frame.png`,
    video: `${base}/render/video.mp4`,
    visualInspection: `${base}/render/visual-inspection.json`,
  };
}

function assertRelativeRoot(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new CliError('bad_value', '--evidence-root must be a non-empty relative path without ..', {
      path: '--evidence-root',
    });
  }
  return normalized;
}

async function readExecutableTemplates(repoRoot: string): Promise<ExecutableTemplate[]> {
  return Promise.all(CATALOG_TEMPLATE_SOURCES.map(async (entry) => {
    const file = path.join(repoRoot, entry.source);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      throw new CliError('file_not_found', `cannot read catalog template ${entry.source}`, { path: file });
    }
    const template = await readTemplate(file);
    return {
      provenance: {
        id: entry.id,
        runtimeTemplateId: canonicalTemplateId(template),
        source: entry.source,
        digest: sha256(bytes),
      },
      template,
    };
  }));
}

async function readMapContext(devAssets: string, mapId: string): Promise<MapContext> {
  const derivedFile = path.join(devAssets, mapId, 'derived', 'topology-derived.json.gz');
  const locationsFile = path.join(devAssets, mapId, 'derived', 'locations.json.gz');
  const engineFile = path.join(devAssets, mapId, 'topology-index.json.gz');
  let derivedBytes: Buffer;
  let locationBytes: Buffer;
  let engineBytes: Buffer;
  try {
    [derivedBytes, locationBytes, engineBytes] = await Promise.all([
      readFile(derivedFile), readFile(locationsFile), readFile(engineFile),
    ]);
  } catch {
    throw new CliError('missing_map_provenance', `cannot read complete map provenance for ${mapId}`, {
      path: path.join(devAssets, mapId),
      detail: { hint: 'run `pnpm --filter @simforge/maps build:map -- --all`' },
    });
  }

  let derived: DerivedProvenance;
  let catalog: RawLocationCatalog;
  let topology: unknown;
  try {
    derived = JSON.parse(unzip(derivedBytes).toString('utf8')) as DerivedProvenance;
    catalog = JSON.parse(unzip(locationBytes).toString('utf8')) as RawLocationCatalog;
    topology = JSON.parse(unzip(engineBytes).toString('utf8')) as unknown;
  } catch (error) {
    throw new CliError('invalid_map_provenance', error instanceof Error ? error.message : String(error), {
      path: path.join(devAssets, mapId),
    });
  }
  if (
    derived.mapId !== mapId ||
    catalog.mapId !== mapId ||
    typeof catalog.mapAssetId !== 'string' ||
    typeof catalog.catalogRevision !== 'string' ||
    !Array.isArray(catalog.locations)
  ) {
    throw new CliError('invalid_map_provenance', `${mapId} is missing stable map/location provenance`, {
      path: path.join(devAssets, mapId),
      detail: { expectedMapId: mapId },
    });
  }
  if (derived.mapAssetId !== undefined && derived.mapAssetId !== catalog.mapAssetId) {
    throw new CliError('invalid_map_provenance', `${mapId} map asset IDs disagree across provenance domains`, {
      path: path.join(devAssets, mapId),
    });
  }
  const matcherIndex = normalizeDerivedMapIndex(derived as unknown, {
    mapId,
    topology: topology as never,
    locations: catalog as unknown,
  });
  const topologyRecord = isRecord(topology) ? topology : null;
  const topologySource = topologyRecord && isRecord(topologyRecord['source']) ? topologyRecord['source'] : null;
  const engineGraphDigest = topologySource?.['xodrSha256'];
  if (
    typeof matcherIndex.topologyDigest !== 'string' || matcherIndex.topologyDigest.length === 0 ||
    typeof engineGraphDigest !== 'string' || engineGraphDigest.length === 0
  ) {
    throw new CliError('invalid_map_provenance', `${mapId} lacks concrete matcher/engine replay digests`, {
      path: path.join(devAssets, mapId),
    });
  }
  return {
    provenance: {
      mapId,
      mapAssetId: catalog.mapAssetId,
      catalogRevision: catalog.catalogRevision,
      // These are the exact replay domains emitted by MatchedSite and
      // LaneGraph/trace headers. File-byte digests are not interchangeable
      // with the semantic topology digests used by concrete execution.
      matcherIndexDigest: matcherIndex.topologyDigest,
      engineGraphDigest,
      locationCatalogDigest: sha256(unzip(locationBytes)),
      slots: CATALOG_SLOTS_PER_MAP,
    },
    locations: catalog.locations as RawLocation[],
    matcherIndex,
  };
}

function locationMatches(location: RawLocation, incident: IncidentDefinition): boolean {
  if (
    typeof location.id !== 'string' ||
    typeof location.handle !== 'string' ||
    typeof location.name !== 'string' ||
    typeof location.type !== 'string' ||
    !incident.siteTypes.includes(location.type) ||
    !location.anchor?.road ||
    typeof location.anchor.road.rsl !== 'string' ||
    typeof location.anchor.road.s !== 'number' ||
    typeof location.anchor.road.offsetM !== 'number' ||
    typeof location.anchor.road.headingRad !== 'number'
  ) return false;
  const affordances = Array.isArray(location.affordances) ? location.affordances : [];
  return (incident.requiredAffordances ?? []).every((entry) => affordances.includes(entry));
}

function bindSite(location: RawLocation): CatalogSiteBinding {
  const road = location.anchor!.road!;
  return {
    locationId: String(location.id),
    handle: String(location.handle),
    name: String(location.name),
    type: String(location.type),
    tags: Array.isArray(location.tags) ? location.tags.filter((entry): entry is string => typeof entry === 'string') : [],
    affordances: Array.isArray(location.affordances) ? location.affordances.filter((entry): entry is string => typeof entry === 'string') : [],
    anchorQuality: String(location.quality?.anchor ?? 'unknown'),
    confidence: typeof location.quality?.confidence === 'number' ? location.quality.confidence : 0,
    roadAnchor: {
      rsl: String(road.rsl),
      s: Number(road.s),
      offsetM: Number(road.offsetM),
      headingRad: Number(road.headingRad),
    },
    sourceDigest: stableLocationDigest(location),
  };
}

function siteScore(location: RawLocation, incident: IncidentDefinition): number {
  const tags = new Set(Array.isArray(location.tags) ? location.tags : []);
  const preferred = (incident.preferredTags ?? []).filter((tag) => tags.has(tag)).length;
  const exact = location.quality?.anchor === 'exact' ? 2 : 0;
  const confidence = typeof location.quality?.confidence === 'number' ? location.quality.confidence : 0;
  return preferred * 10 + exact + confidence;
}

function laneSection(rsl: string): string | null {
  const parts = rsl.split(':');
  return parts.length === 3 && parts[0] && parts[1] ? `${parts[0]}:${parts[1]}` : null;
}

function pointSegmentDistance(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function pointPolylineDistance(
  point: { x: number; y: number },
  polyline: readonly { x: number; y: number }[],
): number {
  if (polyline.length === 0) return Number.POSITIVE_INFINITY;
  if (polyline.length === 1) return Math.hypot(point.x - polyline[0]!.x, point.y - polyline[0]!.y);
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < polyline.length; index += 1) {
    best = Math.min(best, pointSegmentDistance(point, polyline[index - 1]!, polyline[index]!));
  }
  return best;
}

/**
 * Prove that a persisted matcher site and a raw catalog location describe the
 * same physical reservation. A shared map or road name is deliberately not
 * enough: the location's scene point must close against its pinned lane, and
 * the matched frame must bind that location, its exact junction movement, or
 * its anchored road section.
 */
export function matcherSiteClosesLocation(
  site: MatchedSite,
  value: unknown,
  index: DerivedMapIndex,
): boolean {
  if (!isRecord(value)) return false;
  const anchor = isRecord(value['anchor']) ? value['anchor'] : null;
  const road = anchor && isRecord(anchor['road']) ? anchor['road'] : null;
  const scene = anchor && isRecord(anchor['scene']) ? anchor['scene'] : null;
  const locationId = value['id'];
  const rsl = road?.['rsl'];
  const offsetM = road?.['offsetM'];
  const sceneX = scene?.['x'];
  const sceneZ = scene?.['z'];
  if (
    typeof locationId !== 'string' ||
    typeof rsl !== 'string' ||
    typeof offsetM !== 'number' ||
    typeof sceneX !== 'number' ||
    typeof sceneZ !== 'number'
  ) return false;

  const anchoredLane = index.lanes[rsl];
  const anchoredSection = laneSection(rsl);
  if (!anchoredLane || !anchoredSection) return false;
  const anchorDistance = pointPolylineDistance({ x: sceneX, y: -sceneZ }, anchoredLane.polyline);
  if (!Number.isFinite(anchorDistance) || anchorDistance > Math.abs(offsetM) + 2) return false;

  const pathRsls = new Set(site.frame.referencePath.map((span) => span.laneRsl));
  const featureBound = Object.values(site.featureMatches).some((match) => match.mapFeatureId === locationId);
  const bindsWorkZoneReservation = Object.values(site.featureMatches)
    .some((match) => match.kind === 'work_zone_suitable');
  const pointFeature = index.pointFeatures.find((feature) => feature.id === locationId);
  // A point feature (notably a crosswalk) may be anchored to its own
  // perpendicular road/lane while the matcher frame's vehicle reference path
  // runs through it. Once the location scene point has closed geometrically to
  // its pinned anchor lane above, an exact feature-id match is the authoritative
  // join; requiring the vehicle path to share that road section rejects valid
  // perpendicular crossings.
  if (featureBound) return true;
  // `work_zone_suitable` is a derived corridor reservation represented in the
  // shared point-feature index for lookup convenience. It is not an authored
  // point feature that a template binds by id: exactness is its anchored road
  // segment plus membership in the matcher reference path, checked below.
  // Genuine point features (crossings, bus stops, driveways, school zones,
  // parking and occlusion points) remain identity-bound and cannot fall back
  // to a merely nearby corridor.
  if (pointFeature && (
    pointFeature.kind !== 'work_zone_suitable' || bindsWorkZoneReservation
  )) return false;

  const origin = site.frame.origin.mapFeatureId;
  const junctionId = road!['junctionId'];
  if (origin.startsWith('junction:')) {
    return typeof junctionId === 'string' && origin === `junction:${junctionId}` && pathRsls.has(rsl);
  }
  const anchoredSegment = index.factIndex.segmentIdsByLane[rsl];
  return anchoredSegment !== undefined && origin === anchoredSegment && pathRsls.has(rsl);
}

function acceptanceChecks(): readonly CatalogAcceptanceCheck[] {
  return [
    { id: 'schema', kind: 'automated', criterion: 'Concrete instance passes the versioned scenario schema.', state: 'pending', evidenceKey: 'instance' },
    { id: 'site-grounding', kind: 'automated', criterion: 'Map, matcher index, engine graph, location ID, road anchor, and source digests remain exact.', state: 'pending', evidenceKey: 'catalog' },
    { id: 'determinism', kind: 'automated', criterion: 'Repeated generation and simulation produce identical normalized output for the recorded seed.', state: 'pending', evidenceKey: 'trace' },
    { id: 'kinematics', kind: 'automated', criterion: 'Actor speeds, accelerations, paths, clearances, trigger ordering, and conflict timing pass incident-specific plausibility limits.', state: 'pending', evidenceKey: 'result' },
    { id: 'render-integrity', kind: 'automated', criterion: 'Rendered frames use the pinned map and actors, cover pre-reveal through aftermath, and contain no missing/off-map/overlapping assets.', state: 'pending', evidenceKey: 'renderManifest' },
    { id: 'visual-realism', kind: 'manual', criterion: 'A named reviewer inspects stills and video in Studio and accepts site fit, actor intent, occlusion, timing, motion, continuity, and real-world plausibility.', state: 'pending', evidenceKey: 'visualInspection' },
  ];
}

function acceptanceCriteria(incident: IncidentDefinition): string[] {
  return [
    `The authored sequence is visibly present: ${incident.eventSequence.join(' → ')}`,
    `Critical observables are measured: ${incident.criticality.join(', ')}.`,
    'Every dynamic actor follows a continuous, lane/site-compatible path with plausible speed, acceleration, and response timing.',
    'The conflict is challenging but not created by teleportation, impossible overlap, wrong-way geometry, or an unavoidable initial state.',
    'Pre-reveal, reveal, conflict, and aftermath are visible in the evidence bundle and pass named Studio review.',
  ];
}

function progressFor(slots: readonly ScenarioCatalogSlot[]): CatalogProgressCounts {
  const atLeast = (statuses: readonly CatalogSlotStatus[]) => slots.filter((slot) => statuses.includes(slot.status)).length;
  return {
    target: KNOWN_MAPS.length * CATALOG_SLOTS_PER_MAP,
    planned: 0,
    authored: slots.length,
    generated: atLeast(['generated', 'simulated', 'rendered', 'visually-accepted']),
    simulated: atLeast(['simulated', 'rendered', 'visually-accepted']),
    rendered: atLeast(['rendered', 'visually-accepted']),
    visuallyAccepted: atLeast(['visually-accepted']),
    rejected: atLeast(['rejected']),
  };
}

/**
 * Recompute every derived catalog field after lifecycle changes.
 *
 * Callers may only change source fields (for example `status`). Keeping this in
 * the catalog module prevents an executor from accidentally publishing stale
 * per-slot or manifest digests, or hand-maintained progress counters.
 */
export function refreshScenarioCatalog(
  catalog: ScenarioCatalogManifest,
  slots: readonly ScenarioCatalogSlot[],
): ScenarioCatalogManifest {
  const refreshedSlots = slots.map((slot) => {
    const { designDigest: _ignored, ...withoutDesignDigest } = slot;
    return { ...withoutDesignDigest, designDigest: catalogDesignDigest(slot) };
  });
  const { catalogDigest: _oldDigest, slots: _oldSlots, progress: _oldProgress, ...rest } = catalog;
  const withoutDigest: Omit<ScenarioCatalogManifest, 'catalogDigest'> = {
    ...rest,
    slots: refreshedSlots,
    progress: progressFor(refreshedSlots),
  };
  return { ...withoutDigest, catalogDigest: digestPayload(withoutDigest) };
}

/** Build exactly 100 deterministic, authored, map-grounded incident briefs per map. */
export async function createScenarioCatalog(
  options: CreateCatalogOptions = {},
): Promise<ScenarioCatalogManifest> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const devAssets = options.devAssets ?? (options.repoRoot ? path.join(repoRoot, 'dev-assets') : DEV_ASSETS);
  const namespace = options.namespace ?? DEFAULT_CATALOG_NAMESPACE;
  const root = assertRelativeRoot(options.evidenceRoot ?? 'evidence');
  if (namespace.trim().length === 0) {
    throw new CliError('bad_value', '--namespace must not be empty', { path: '--namespace' });
  }

  const [executableTemplates, contexts] = await Promise.all([
    readExecutableTemplates(repoRoot),
    Promise.all(KNOWN_MAPS.map((mapId) => readMapContext(devAssets, mapId))),
  ]);
  const runtimeBundles = new Map<string, Awaited<ReturnType<typeof loadMap>>>(
    await Promise.all(KNOWN_MAPS.map(async (mapId) => [mapId, await loadMap(mapId)] as const)),
  );
  const templates = executableTemplates.map((entry) => entry.provenance);
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const executableById = new Map(executableTemplates.map((entry) => [entry.provenance.id, entry.template]));
  const taxonomyHash = taxonomyDigest();
  const slots: ScenarioCatalogSlot[] = [];
  const selectedMechanismCoverage = new Set<string>();
  const materializationFailuresByMechanism = new Map<string, Set<string>>();
  const eligibilityByMap: Array<{ mapId: string; incidentIds: string[]; domains: string[] }> = [];
  const materializedBreadthFailures: Array<Record<string, unknown>> = [];

  for (const context of contexts) {
    const map = context.provenance;
    const eligible = (await Promise.all(INCIDENT_TAXONOMY.map(async (incident) => {
      if (incident.mapIds && !incident.mapIds.includes(map.mapId)) return [];
      if (!incident.implementationTemplateId) return [];
      const locations = context.locations
        .filter((location) => locationMatches(location, incident))
        .sort((left, right) => siteScore(right, incident) - siteScore(left, incident) || String(left.id).localeCompare(String(right.id)));
      const template = executableById.get(incident.implementationTemplateId);
      if (!template) return [];
      // This must remain identical to executor replay.  A persisted site is
      // an exact reservation, not a request to re-run the interactive site's
      // diversity/truncation policy.
      const { anchor, roles, notes } = adaptTemplate(template);
      // Same rule as `matchOnMap`: a catalog entry built from a template whose
      // requirement was discarded is a reservation of the wrong place.
      assertMatchableAnchor(notes);
      const matched = matchAnchorReport({
        ...anchor,
        policy: catalogExactMatcherPolicy(anchor.policy ?? {}),
      }, context.matcherIndex, { roles }).sites;
      const candidates: CatalogLocationSitePair[] = locations.flatMap((location) => matched.flatMap((matcherSite) =>
        matcherSiteClosesLocation(matcherSite, location, context.matcherIndex)
          ? [{
              location,
              matcherSiteId: matcherSite.siteId,
              matchedLocationId: String(location.id),
              matcherSite,
            }]
          : [],
      )).sort((left, right) =>
        (siteScore(right.location, incident) + right.matcherSite!.score) -
          (siteScore(left.location, incident) + left.matcherSite!.score) ||
        String(left.location.id).localeCompare(String(right.location.id)) ||
        String(left.matcherSiteId).localeCompare(String(right.matcherSiteId)),
      );
      // Hard eligibility: a taxonomy mechanism is available on this map only
      // when one exact catalog-location/matcher-site pair exists. An unrelated
      // authored location must never occupy an executable delivery slot.
      return candidates.length > 0 ? [{ incident, candidates }] : [];
    }))).flat();
    eligibilityByMap.push({
      mapId: map.mapId,
      incidentIds: eligible.map((entry) => entry.incident.id),
      domains: [...new Set(eligible.map((entry) => entry.incident.domain))],
    });

    const selectedMapMechanisms = new Set<string>();
    for (let ordinal = 0; ordinal < CATALOG_SLOTS_PER_MAP; ordinal += 1) {
      // Use the baseline operational condition for every occurrence. Variant
      // rotation is not a delivery quota and must not displace a stronger
      // truthful exact fit merely to manufacture diversity.
      const runtimeBundle = runtimeBundles.get(map.mapId);
      if (!runtimeBundle) {
        throw new CliError('catalog_internal_ineligible_slot', 'eligible selection lost its template or runtime map bundle', {
          path: `${map.mapId}:${ordinal}`,
          exitCode: EXIT.validationFindings,
        });
      }
      let entry: (typeof eligible)[number] | undefined;
      let variant: (typeof OPERATIONAL_VARIANTS)[number] | undefined;
      let selectedPair: CatalogLocationSitePair | undefined;
      let site: CatalogSiteBinding | undefined;
      let seed: string | undefined;
      const candidateFailures: Array<{ siteId: string; code: string }> = [];
      const entryOrder = Array.from({ length: eligible.length }, (_, incidentOffset) => ({
        entry: eligible[(ordinal + incidentOffset) % eligible.length]!,
        incidentOffset,
      })).sort((left, right) =>
        Number(selectedMechanismCoverage.has(left.entry.incident.id)) - Number(selectedMechanismCoverage.has(right.entry.incident.id)) ||
        (selectedMapMechanisms.size < CATALOG_MIN_INCIDENT_TYPES_PER_MAP
          ? Number(selectedMapMechanisms.has(left.entry.incident.id)) - Number(selectedMapMechanisms.has(right.entry.incident.id))
          : 0) ||
        left.incidentOffset - right.incidentOffset,
      );
      selection: for (const { entry: candidateEntry } of entryOrder) {
        const candidateVariant = OPERATIONAL_VARIANTS[0]!;
        const templateDocument = executableById.get(candidateEntry.incident.implementationTemplateId!);
        if (!templateDocument) continue;
        for (let offset = 0; offset < candidateEntry.candidates.length; offset += 1) {
          // Exact pairs are always attempted strongest-first. Slot identity,
          // ordinal and seed provide occurrence identity; rotating to a weaker
          // physical site for artificial diversity would be less truthful.
          const candidate = candidateEntry.candidates[offset]!;
          if (!candidate.matcherSite) continue;
          const candidateSite = bindSite(candidate.location);
          const candidateSeed = catalogSeed(namespace, map, ordinal, candidateEntry.incident, candidateSite, candidateVariant.id, taxonomyHash);
          try {
            const concrete = materialize(templateDocument, runtimeBundle, candidate.matcherSite, {
              drawIndex: 0,
              seed: candidateSeed,
              variant: candidateVariant,
            });
            if (!concrete.manifest.feasible) {
              candidateFailures.push({ siteId: candidate.matcherSite.siteId, code: 'manifest_infeasible' });
              const failures = materializationFailuresByMechanism.get(candidateEntry.incident.id) ?? new Set<string>();
              const issueSummary = concrete.manifest.issues
                .filter((issue) => issue.severity === 'error')
                .map((issue) => `${issue.code}[${issue.path}]:${issue.reason}`)
                .join('|');
              failures.add(`${map.mapId}:${candidate.matcherSite.siteId}:manifest_infeasible:${issueSummary}`);
              materializationFailuresByMechanism.set(candidateEntry.incident.id, failures);
              continue;
            }
            entry = candidateEntry;
            variant = candidateVariant;
            selectedPair = candidate;
            site = candidateSite;
            seed = candidateSeed;
            break selection;
          } catch (error) {
            // A hard materialization finding makes this exact pair ineligible,
            // not the mechanism itself. Try the next exact pair/incident; if
            // all fail the slot is rejected below with the candidate summary.
            if (error instanceof CliError && (
              error.exitCode === EXIT.validationFindings || CANDIDATE_MATERIALIZATION_FINDINGS.has(error.code)
            )) {
              candidateFailures.push({ siteId: candidate.matcherSite.siteId, code: error.code });
              const failures = materializationFailuresByMechanism.get(candidateEntry.incident.id) ?? new Set<string>();
              failures.add(`${map.mapId}:${candidate.matcherSite.siteId}:${error.code}`);
              materializationFailuresByMechanism.set(candidateEntry.incident.id, failures);
              continue;
            }
            throw error;
          }
        }
      }
      if (!entry || !variant || !selectedPair || !site || !seed) {
        throw new CliError('no_materializable_catalog_pair', 'no exact location/matcher pair can materialize the reserved mechanism and variant', {
          path: `${map.mapId}:${ordinal}`,
          detail: { candidateFailures },
          exitCode: EXIT.validationFindings,
        });
      }
      selectedMapMechanisms.add(entry.incident.id);
      selectedMechanismCoverage.add(entry.incident.id);
      const identity = catalogIdentity(map.mapId, ordinal, entry.incident.id, seed);
      const backedTemplate = templateById.get(entry.incident.implementationTemplateId!);
      if (!backedTemplate || !selectedPair.matcherSiteId || !selectedPair.matchedLocationId) {
        throw new CliError('catalog_internal_ineligible_slot', 'eligible catalog selection lost executable provenance', {
          path: `${map.mapId}:${ordinal}`,
          exitCode: EXIT.validationFindings,
        });
      }
      const withoutDesignDigest: Omit<ScenarioCatalogSlot, 'designDigest'> = {
        identity,
        ordinal,
        seed,
        mapId: map.mapId,
        status: 'authored',
        provenance: {
          namespace,
          generatorVersion: CATALOG_GENERATOR_VERSION,
          mapCatalogRevision: map.catalogRevision,
          matcherIndexDigest: map.matcherIndexDigest,
          engineGraphDigest: map.engineGraphDigest,
          locationCatalogDigest: map.locationCatalogDigest,
          taxonomyDigest: taxonomyHash,
          ...(backedTemplate ? { templateDigest: backedTemplate.digest } : {}),
        },
        scenario: {
          incidentId: entry.incident.id,
          title: entry.incident.title,
          domain: entry.incident.domain,
          summary: entry.incident.summary,
          sourceIds: [...entry.incident.sourceIds],
        },
        site,
        variant: { ...variant },
        brief: {
          actors: entry.incident.actors,
          eventSequence: entry.incident.eventSequence,
          criticality: entry.incident.criticality,
          acceptanceCriteria: acceptanceCriteria(entry.incident),
        },
        implementation: {
          state: 'template-backed',
          templateId: backedTemplate.runtimeTemplateId,
          templateSource: backedTemplate.source,
          matcherSiteId: selectedPair.matcherSiteId,
          matchedLocationId: selectedPair.matchedLocationId,
          materializedVariantId: variant.id,
        },
        acceptance: { state: 'pending', checks: acceptanceChecks(), reviewer: null },
        evidencePaths: evidencePaths(root, map.mapId, identity),
      };
      slots.push({ ...withoutDesignDigest, designDigest: catalogDesignDigest(withoutDesignDigest) });
    }
    if (selectedMapMechanisms.size < CATALOG_MIN_INCIDENT_TYPES_PER_MAP) {
      const unselected = eligible
        .map((candidate) => candidate.incident.id)
        .filter((incidentId) => !selectedMapMechanisms.has(incidentId));
      materializedBreadthFailures.push({
        mapId: map.mapId,
          selectedMechanisms: [...selectedMapMechanisms].sort(),
          unselectedMechanisms: unselected,
          materializationFailures: Object.fromEntries(unselected.map((incidentId) => [
            incidentId,
            [...(materializationFailuresByMechanism.get(incidentId) ?? [])].filter((failure) => failure.startsWith(`${map.mapId}:`)),
          ])),
      });
    }
  }

  if (materializedBreadthFailures.length > 0) {
    throw new CliError('insufficient_map_authorability', 'one or more maps cannot materialize the required exact-pair mechanism breadth', {
      path: devAssets,
      detail: { maps: materializedBreadthFailures },
      exitCode: EXIT.validationFindings,
    });
  }

  const ineligibleMaps = eligibilityByMap.filter((entry) => entry.incidentIds.length < CATALOG_MIN_INCIDENT_TYPES_PER_MAP);
  if (ineligibleMaps.length > 0) {
    throw new CliError('insufficient_map_authorability', 'one or more maps cannot support the required exact-pair breadth', {
      path: devAssets,
      detail: { maps: eligibilityByMap },
      exitCode: EXIT.validationFindings,
    });
  }

  const missingMechanisms = INCIDENT_TAXONOMY.filter((incident) => !selectedMechanismCoverage.has(incident.id));
  if (missingMechanisms.length > 0) {
    throw new CliError('incomplete_mechanism_coverage', 'exact-pair catalog does not cover every intended mechanism', {
      path: 'slots',
      detail: {
        missingMechanisms: missingMechanisms.map((incident) => incident.id),
        materializationFailures: Object.fromEntries(missingMechanisms.map((incident) => [
          incident.id,
          [...(materializationFailuresByMechanism.get(incident.id) ?? [])],
        ])),
      },
      exitCode: EXIT.validationFindings,
    });
  }

  const maps = contexts.map((context) => context.provenance);
  const withoutDigest: Omit<ScenarioCatalogManifest, 'catalogDigest'> = {
    kind: CATALOG_KIND,
    version: CATALOG_VERSION,
    contract: {
      supportedMaps: [...KNOWN_MAPS],
      slotsPerMap: CATALOG_SLOTS_PER_MAP,
      totalSlots: KNOWN_MAPS.length * CATALOG_SLOTS_PER_MAP,
      minimumIncidentTypesPerMap: CATALOG_MIN_INCIDENT_TYPES_PER_MAP,
      minimumDomainsPerMap: 0,
    },
    provenance: {
      generator: '@simforge/cli catalog create',
      generatorVersion: CATALOG_GENERATOR_VERSION,
      namespace,
      taxonomyDigest: taxonomyHash,
    },
    evidenceRoot: root,
    maps,
    researchSources: CATALOG_RESEARCH_SOURCES,
    taxonomy: INCIDENT_TAXONOMY,
    templates,
    slots,
    progress: progressFor(slots),
  };
  return { ...withoutDigest, catalogDigest: digestPayload(withoutDigest) };
}

const ALL_EVIDENCE = [
  'instance', 'trace', 'result', 'renderManifest', 'frame', 'video', 'visualInspection',
] as const satisfies readonly (keyof CatalogEvidencePaths)[];

const REQUIRED_EVIDENCE: Record<CatalogSlotStatus, readonly (keyof CatalogEvidencePaths)[]> = {
  authored: [],
  generated: ['instance'],
  simulated: ['instance', 'trace', 'result'],
  rendered: ['instance', 'trace', 'result', 'renderManifest', 'frame', 'video'],
  'visually-accepted': ALL_EVIDENCE,
  rejected: ['instance', 'result'],
};

function issue(
  issues: CatalogIssue[],
  code: CatalogIssue['code'],
  pathValue: string,
  reason: string,
  expected?: unknown,
  actual?: unknown,
): void {
  issues.push({ code, path: pathValue, reason, ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeEvidencePath(value: unknown, evidenceRoot: string): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || value.split('/').includes('..')) return false;
  return value === evidenceRoot || value.startsWith(`${evidenceRoot}/`);
}

function emptyProgress(): CatalogProgressCounts {
  return { target: 500, planned: 0, authored: 0, generated: 0, simulated: 0, rendered: 0, visuallyAccepted: 0, rejected: 0 };
}

export interface ValidateCatalogOptions {
  /** Path to the manifest; evidence paths are relative to its directory. */
  readonly manifestFile?: string;
  /** Physical evidence-root override, useful when artifacts are mounted elsewhere. */
  readonly evidenceRootOverride?: string;
  /** Require every authored evidence path, not only paths implied by slot status. */
  readonly requireEvidence?: boolean;
  /** Injectable for focused tests. */
  readonly evidenceExists?: (file: string) => boolean;
}

/** Machine verification for authorship, breadth, identity, provenance, and evidence. */
export function validateScenarioCatalog(
  value: unknown,
  options: ValidateCatalogOptions = {},
): CatalogValidationReport {
  const issues: CatalogIssue[] = [];
  if (!isRecord(value)) {
    issue(issues, 'invalid_catalog', '$', 'catalog must be a JSON object');
    return reportFor(null, issues, false);
  }
  const manifest = value as unknown as ScenarioCatalogManifest;
  const slots = Array.isArray(value['slots']) ? value['slots'] : [];
  const evidenceRoot = typeof value['evidenceRoot'] === 'string' ? value['evidenceRoot'] : '';

  if (value['kind'] !== CATALOG_KIND || value['version'] !== CATALOG_VERSION) {
    issue(issues, 'invalid_catalog', '$', `kind/version must be ${CATALOG_KIND}@${CATALOG_VERSION}`);
  }
  const contract = isRecord(value['contract']) ? value['contract'] : {};
  const supported = Array.isArray(contract['supportedMaps']) ? contract['supportedMaps'] : [];
  if (JSON.stringify(supported) !== JSON.stringify([...KNOWN_MAPS])) {
    issue(issues, 'wrong_map_inventory', 'contract.supportedMaps', 'catalog must use the canonical five-map inventory', [...KNOWN_MAPS], supported);
  }
  if (contract['slotsPerMap'] !== CATALOG_SLOTS_PER_MAP || contract['totalSlots'] !== KNOWN_MAPS.length * CATALOG_SLOTS_PER_MAP) {
    issue(issues, 'wrong_slot_count', 'contract', 'contract must declare exactly 100 slots per map and 500 total');
  }
  if (contract['minimumIncidentTypesPerMap'] !== CATALOG_MIN_INCIDENT_TYPES_PER_MAP || contract['minimumDomainsPerMap'] !== 0) {
    issue(issues, 'insufficient_taxonomy_breadth', 'contract', `catalog breadth gates must require at least ${CATALOG_MIN_INCIDENT_TYPES_PER_MAP} incident types per map and no domain quota`);
  }
  if (typeof value['evidenceRoot'] !== 'string' || !isSafeEvidencePath(`${evidenceRoot}/probe`, evidenceRoot)) {
    issue(issues, 'invalid_evidence_path', 'evidenceRoot', 'evidenceRoot must be a safe relative path');
  }

  const taxonomyRows = Array.isArray(value['taxonomy']) ? value['taxonomy'] : [];
  const incidentById = new Map<string, IncidentDefinition>();
  for (const row of taxonomyRows) {
    if (isRecord(row) && typeof row['id'] === 'string') incidentById.set(row['id'], row as unknown as IncidentDefinition);
  }
  const sourceRows = Array.isArray(value['researchSources']) ? value['researchSources'] : [];
  const sourceIds = new Set(sourceRows.flatMap((row) => isRecord(row) && typeof row['id'] === 'string' ? [row['id']] : []));
  const taxonomyHash = sha256(JSON.stringify({ sources: sourceRows, incidents: taxonomyRows, variants: OPERATIONAL_VARIANTS }));
  if (taxonomyRows.length < 30 || new Set(taxonomyRows.flatMap((row) => isRecord(row) && typeof row['domain'] === 'string' ? [row['domain']] : [])).size < INCIDENT_DOMAINS.length) {
    issue(issues, 'insufficient_taxonomy_breadth', 'taxonomy', 'taxonomy must cover at least 30 incident mechanisms across all eight domains');
  }
  const templateRows = Array.isArray(value['templates']) ? value['templates'] : [];
  const templateByRegistryId = new Map<string, Record<string, unknown>>();
  for (const [index, row] of templateRows.entries()) {
    if (
      !isRecord(row) || typeof row['id'] !== 'string' ||
      typeof row['runtimeTemplateId'] !== 'string' || row['runtimeTemplateId'].length === 0 ||
      typeof row['source'] !== 'string' || !/^[0-9a-f]{64}$/.test(String(row['digest']))
    ) {
      issue(issues, 'invalid_provenance', `templates[${index}]`, 'template registry, canonical runtime identity, source, and digest must be complete');
      continue;
    }
    templateByRegistryId.set(row['id'], row);
  }
  const topProvenance = isRecord(value['provenance']) ? value['provenance'] : {};
  if (topProvenance['taxonomyDigest'] !== taxonomyHash || topProvenance['generatorVersion'] !== CATALOG_GENERATOR_VERSION) {
    issue(issues, 'invalid_provenance', 'provenance', 'top-level taxonomy/generator provenance is stale');
  }

  const mapRows = Array.isArray(value['maps']) ? value['maps'] : [];
  const mapById = new Map<string, CatalogMapProvenance>();
  for (const row of mapRows) {
    if (isRecord(row) && typeof row['mapId'] === 'string') mapById.set(row['mapId'], row as unknown as CatalogMapProvenance);
  }
  if (mapRows.length !== KNOWN_MAPS.length || KNOWN_MAPS.some((mapId) => !mapById.has(mapId))) {
    issue(issues, 'wrong_map_inventory', 'maps', 'maps[] must contain each supported map exactly once');
  }
  for (const [mapId, map] of mapById) {
    if (
      !/^[0-9a-f]{64}$/.test(map.matcherIndexDigest) ||
      !/^[0-9a-f]{64}$/.test(map.engineGraphDigest) ||
      !/^[0-9a-f]{64}$/.test(map.locationCatalogDigest) ||
      map.matcherIndexDigest === map.engineGraphDigest
    ) {
      issue(issues, 'invalid_provenance', `maps(map=${mapId})`, 'matcher, engine, and location provenance must be independent digest domains');
    }
  }

  const identities = new Set<string>();
  const seeds = new Set<string>();
  const mapOrdinals = new Map<string, Set<number>>();
  const statusCounts: Record<string, number> = {};
  const mapCounts: Record<string, number> = {};
  const mapIncidents = new Map<string, Set<string>>();
  const mapDomains = new Map<string, Set<string>>();
  const evidenceExists = options.evidenceExists ?? existsSync;
  const physicalRoot = options.evidenceRootOverride
    ? path.resolve(options.evidenceRootOverride)
    : path.dirname(path.resolve(options.manifestFile ?? 'catalog.json'));
  let evidenceChecked = false;

  slots.forEach((raw, index) => {
    const base = `slots[${index}]`;
    if (!isRecord(raw)) {
      issue(issues, 'invalid_catalog', base, 'slot must be an object');
      return;
    }
    const identity = raw['identity'];
    const seed = raw['seed'];
    const mapId = raw['mapId'];
    const ordinal = raw['ordinal'];
    const provenance = isRecord(raw['provenance']) ? raw['provenance'] : {};
    const scenario = isRecord(raw['scenario']) ? raw['scenario'] : {};
    const site = isRecord(raw['site']) ? raw['site'] : {};
    const variant = isRecord(raw['variant']) ? raw['variant'] : {};
    const brief = isRecord(raw['brief']) ? raw['brief'] : {};
    const implementation = isRecord(raw['implementation']) ? raw['implementation'] : {};
    const acceptance = isRecord(raw['acceptance']) ? raw['acceptance'] : {};
    const status = raw['status'];
    const paths = isRecord(raw['evidencePaths']) ? raw['evidencePaths'] : {};

    if (typeof identity !== 'string') issue(issues, 'invalid_identity', `${base}.identity`, 'identity must be a string');
    else if (identities.has(identity)) issue(issues, 'duplicate_identity', `${base}.identity`, `duplicate identity ${identity}`);
    else identities.add(identity);

    if (typeof seed !== 'string' || !/^[0-9a-f]{64}$/.test(seed)) issue(issues, 'invalid_seed', `${base}.seed`, 'seed must be 64 lowercase hexadecimal characters');
    else if (seeds.has(seed)) issue(issues, 'duplicate_seed', `${base}.seed`, `duplicate seed ${seed}`);
    else seeds.add(seed);

    if (typeof mapId === 'string') {
      mapCounts[mapId] = (mapCounts[mapId] ?? 0) + 1;
      if (typeof ordinal === 'number' && Number.isInteger(ordinal)) {
        const ordinals = mapOrdinals.get(mapId) ?? new Set<number>();
        ordinals.add(ordinal);
        mapOrdinals.set(mapId, ordinals);
      }
      if (typeof scenario['incidentId'] === 'string') {
        const set = mapIncidents.get(mapId) ?? new Set<string>();
        set.add(scenario['incidentId']);
        mapIncidents.set(mapId, set);
      }
      if (typeof scenario['domain'] === 'string') {
        const set = mapDomains.get(mapId) ?? new Set<string>();
        set.add(scenario['domain']);
        mapDomains.set(mapId, set);
      }
    }
    if (typeof status === 'string') statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    const map = typeof mapId === 'string' ? mapById.get(mapId) : undefined;
    const incident = typeof scenario['incidentId'] === 'string' ? incidentById.get(scenario['incidentId']) : undefined;
    if (
      !map || !incident ||
      typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= CATALOG_SLOTS_PER_MAP ||
      typeof provenance['namespace'] !== 'string' ||
      provenance['generatorVersion'] !== CATALOG_GENERATOR_VERSION ||
      provenance['mapCatalogRevision'] !== map.catalogRevision ||
      provenance['matcherIndexDigest'] !== map.matcherIndexDigest ||
      provenance['engineGraphDigest'] !== map.engineGraphDigest ||
      provenance['locationCatalogDigest'] !== map.locationCatalogDigest ||
      provenance['taxonomyDigest'] !== taxonomyHash
    ) {
      issue(issues, 'invalid_provenance', base, 'slot map, ordinal, incident, or provenance is incomplete/stale');
    } else if (
      typeof site['locationId'] !== 'string' || typeof site['sourceDigest'] !== 'string' ||
      typeof variant['id'] !== 'string' || !OPERATIONAL_VARIANTS.some((entry) => entry.id === variant['id'])
    ) {
      issue(issues, 'invalid_site_binding', `${base}.site`, 'site binding and operational variant must be complete');
    } else {
      const expectedSeed = catalogSeed(provenance['namespace'], map, ordinal, incident, site as unknown as CatalogSiteBinding, variant['id'], taxonomyHash);
      if (seed !== expectedSeed) issue(issues, 'invalid_seed', `${base}.seed`, 'seed does not match deterministic authored coordinates', expectedSeed, seed);
      const expectedIdentity = catalogIdentity(map.mapId, ordinal, incident.id, expectedSeed);
      if (identity !== expectedIdentity) issue(issues, 'invalid_identity', `${base}.identity`, 'identity does not match deterministic authored coordinates', expectedIdentity, identity);
      if (!incident.siteTypes.includes(String(site['type']))) issue(issues, 'invalid_site_binding', `${base}.site.type`, 'site type is not applicable to incident');
      const affordances = Array.isArray(site['affordances']) ? site['affordances'] : [];
      if ((incident.requiredAffordances ?? []).some((entry) => !affordances.includes(entry))) {
        issue(issues, 'invalid_site_binding', `${base}.site.affordances`, 'site lacks an incident-required affordance');
      }
      if (incident.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) {
        issue(issues, 'invalid_provenance', `${base}.scenario.sourceIds`, 'incident references an unknown research source');
      }
      if (
        scenario['title'] !== incident.title || scenario['domain'] !== incident.domain ||
        !Array.isArray(brief['actors']) || brief['actors'].length < 2 ||
        !Array.isArray(brief['eventSequence']) || brief['eventSequence'].length < 3 ||
        !Array.isArray(brief['criticality']) || brief['criticality'].length < 3 ||
        !Array.isArray(brief['acceptanceCriteria']) || brief['acceptanceCriteria'].length < 5
      ) issue(issues, 'invalid_catalog', `${base}.brief`, 'authored brief must retain complete incident actors, sequence, observables, and acceptance criteria');
      if (incident.implementationTemplateId) {
        if (implementation['state'] === 'template-backed') {
          const registeredTemplate = templateByRegistryId.get(incident.implementationTemplateId);
          if (
            !registeredTemplate ||
            implementation['templateId'] !== registeredTemplate['runtimeTemplateId'] ||
            implementation['templateSource'] !== registeredTemplate['source'] ||
            provenance['templateDigest'] !== registeredTemplate['digest']
          ) {
            issue(issues, 'invalid_provenance', `${base}.implementation`, 'template-backed incident lost registry-to-runtime identity provenance');
          }
          const hasMatcherBinding = implementation['matcherSiteId'] !== undefined || implementation['matchedLocationId'] !== undefined;
          if (hasMatcherBinding && (
            typeof implementation['matcherSiteId'] !== 'string' ||
            !/^[0-9a-f]{16}$/.test(implementation['matcherSiteId']) ||
            implementation['matchedLocationId'] !== site['locationId']
          )) {
            issue(
              issues,
              'invalid_site_binding',
              `${base}.implementation`,
              'template-backed incident must persist one exact matcher-site/catalog-location pair',
            );
          }
          if (hasMatcherBinding && implementation['materializedVariantId'] !== variant['id']) {
            issue(
              issues,
              'invalid_site_binding',
              `${base}.implementation.materializedVariantId`,
              'template-backed execution must apply the exact operational variant reserved by the slot',
              variant['id'],
              implementation['materializedVariantId'],
            );
          }
          if (!hasMatcherBinding) {
            issue(
              issues,
              'invalid_site_binding',
              `${base}.implementation`,
              'delivery catalog slots require an exact persisted matcher-site/catalog-location pair',
            );
          }
        } else if (
          implementation['state'] !== 'authored-design' ||
          implementation['matcherSiteId'] !== undefined ||
          implementation['matchedLocationId'] !== undefined
        ) {
          issue(issues, 'invalid_provenance', `${base}.implementation`, 'unmatched catalog location must remain an authored-only design');
        }
      } else if (
        implementation['state'] !== 'authored-design' ||
        implementation['matcherSiteId'] !== undefined ||
        implementation['matchedLocationId'] !== undefined
      ) {
        issue(issues, 'invalid_provenance', `${base}.implementation`, 'authored-only incident must not claim executable matcher provenance');
      }
    }

    const checks = Array.isArray(acceptance['checks']) ? acceptance['checks'] : [];
    const checkIds = new Set(checks.flatMap((check) => isRecord(check) && typeof check['id'] === 'string' ? [check['id']] : []));
    if (
      checks.length !== 6 ||
      ['schema', 'site-grounding', 'determinism', 'kinematics', 'render-integrity', 'visual-realism'].some((id) => !checkIds.has(id)) ||
      (status === 'visually-accepted' && (acceptance['state'] !== 'accepted' || !isRecord(acceptance['reviewer']) || checks.some((check) => !isRecord(check) || check['state'] !== 'passed')))
    ) issue(issues, 'invalid_acceptance_manifest', `${base}.acceptance`, 'acceptance requires all six gates; visual acceptance additionally requires a reviewer and all checks passed');

    for (const key of ALL_EVIDENCE) {
      if (!isSafeEvidencePath(paths[key], evidenceRoot)) issue(issues, 'invalid_evidence_path', `${base}.evidencePaths.${key}`, 'evidence path must stay under evidenceRoot');
    }
    const required = options.requireEvidence
      ? ALL_EVIDENCE
      : typeof status === 'string' && status in REQUIRED_EVIDENCE
        ? REQUIRED_EVIDENCE[status as CatalogSlotStatus]
        : [];
    if (typeof status !== 'string' || !(status in REQUIRED_EVIDENCE)) issue(issues, 'invalid_catalog', `${base}.status`, 'unknown slot status');
    for (const key of required) {
      const relative = paths[key];
      if (typeof relative !== 'string') continue;
      evidenceChecked = true;
      const physical = options.evidenceRootOverride
        ? path.join(physicalRoot, path.posix.relative(evidenceRoot, relative))
        : path.join(physicalRoot, relative);
      if (!evidenceExists(physical)) issue(issues, 'missing_evidence', `${base}.evidencePaths.${key}`, `required evidence does not exist: ${physical}`);
    }

    if (typeof raw['designDigest'] !== 'string') {
      issue(issues, 'invalid_provenance', `${base}.designDigest`, 'design digest is required');
    } else {
      const expected = catalogDesignDigest(raw as unknown as ScenarioCatalogSlot);
      if (raw['designDigest'] !== expected) issue(issues, 'invalid_provenance', `${base}.designDigest`, 'authored design content does not match its digest', expected, raw['designDigest']);
    }
  });

  if (slots.length !== KNOWN_MAPS.length * CATALOG_SLOTS_PER_MAP) issue(issues, 'wrong_slot_count', 'slots', 'catalog must contain exactly 500 slots', 500, slots.length);
  const templateBackedCount = slots.filter((slot) => isRecord(slot) && isRecord(slot['implementation']) && slot['implementation']['state'] === 'template-backed').length;
  if (templateBackedCount !== slots.length) {
    issue(issues, 'invalid_provenance', 'slots', 'every delivery catalog slot must be template-backed and executable', slots.length, templateBackedCount);
  }
  const coveredIncidentIds = new Set(slots.flatMap((slot) => {
    if (!isRecord(slot) || !isRecord(slot['scenario']) || typeof slot['scenario']['incidentId'] !== 'string') return [];
    return [slot['scenario']['incidentId']];
  }));
  const missingIncidentIds = INCIDENT_TAXONOMY.filter((incident) => !coveredIncidentIds.has(incident.id)).map((incident) => incident.id);
  if (missingIncidentIds.length > 0) {
    issue(issues, 'insufficient_taxonomy_breadth', 'slots', 'catalog must cover every intended mechanism', INCIDENT_TAXONOMY.map((incident) => incident.id), [...coveredIncidentIds]);
  }
  for (const mapId of KNOWN_MAPS) {
    const ordinals = mapOrdinals.get(mapId) ?? new Set<number>();
    if (mapCounts[mapId] !== CATALOG_SLOTS_PER_MAP || ordinals.size !== CATALOG_SLOTS_PER_MAP) {
      issue(issues, 'wrong_slot_count', `slots(map=${mapId})`, 'map must contain each ordinal 0..99 exactly once', CATALOG_SLOTS_PER_MAP, mapCounts[mapId] ?? 0);
    }
    if ((mapIncidents.get(mapId)?.size ?? 0) < CATALOG_MIN_INCIDENT_TYPES_PER_MAP) {
      issue(issues, 'insufficient_taxonomy_breadth', `slots(map=${mapId})`, `map must contain at least ${CATALOG_MIN_INCIDENT_TYPES_PER_MAP} incident mechanisms`);
    }
  }

  const calculatedProgress = progressFor(slots as unknown as ScenarioCatalogSlot[]);
  if (JSON.stringify(value['progress']) !== JSON.stringify(calculatedProgress)) {
    issue(issues, 'invalid_progress_counts', 'progress', 'planned/authored/generated/simulated/rendered/accepted counts must be derived from slot states', calculatedProgress, value['progress']);
  }
  if (typeof value['catalogDigest'] === 'string') {
    const { catalogDigest: _ignored, ...withoutDigest } = manifest;
    const expected = digestPayload(withoutDigest);
    if (value['catalogDigest'] !== expected) issue(issues, 'catalog_digest_mismatch', 'catalogDigest', 'catalog content does not match its digest', expected, value['catalogDigest']);
  } else issue(issues, 'catalog_digest_mismatch', 'catalogDigest', 'catalogDigest is required');

  return {
    ok: issues.length === 0,
    kind: 'simforge-catalog-validation',
    version: 2,
    catalogDigest: typeof value['catalogDigest'] === 'string' ? value['catalogDigest'] : null,
    slots: slots.length,
    maps: mapCounts,
    statuses: statusCounts,
    incidentTypesByMap: Object.fromEntries(KNOWN_MAPS.map((mapId) => [mapId, mapIncidents.get(mapId)?.size ?? 0])),
    domainsByMap: Object.fromEntries(KNOWN_MAPS.map((mapId) => [mapId, mapDomains.get(mapId)?.size ?? 0])),
    progress: calculatedProgress,
    evidenceChecked,
    issues,
  };
}

function reportFor(catalogDigest: string | null, issues: CatalogIssue[], evidenceChecked: boolean): CatalogValidationReport {
  return {
    ok: false,
    kind: 'simforge-catalog-validation',
    version: 2,
    catalogDigest,
    slots: 0,
    maps: {},
    statuses: {},
    incidentTypesByMap: {},
    domainsByMap: {},
    progress: emptyProgress(),
    evidenceChecked,
    issues,
  };
}

export { CATALOG_RESEARCH_SOURCES, INCIDENT_DOMAINS, INCIDENT_TAXONOMY, OPERATIONAL_VARIANTS };
